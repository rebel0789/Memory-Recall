use crate::{inspect_index, HealthStatus, IndexHealth, SourceIndex, SourceIndexOptions};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

const HASH_BUFFER_BYTES: usize = 64 * 1024;
const DATABASE_PARTS: [&str; 3] = ["", "-wal", "-shm"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexRepairPlan {
    pub fingerprint: String,
    pub database_fingerprint: String,
    pub source_status: HealthStatus,
    pub reason_codes: Vec<String>,
    pub action: String,
    pub backup_file_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDoctorReport {
    pub health: IndexHealth,
    pub last_valid_generation_readable: bool,
    pub repair_required: bool,
    pub repair_plan: Option<IndexRepairPlan>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexRepairReceipt {
    pub plan_fingerprint: String,
    pub previous_status: HealthStatus,
    pub active_generation: i64,
    pub backup_file_name: String,
    pub backup_cleanup_performed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepairPlanSeed<'a> {
    database_fingerprint: &'a str,
    repository_identity: &'a str,
    engine_version: &'a str,
    source_status: HealthStatus,
    reason_codes: &'a [String],
    action: &'static str,
}

pub fn doctor_index(path: &Path, options: &SourceIndexOptions) -> Result<IndexDoctorReport> {
    super::validate_options(options)?;
    let health = inspect_index(path, options);
    let last_valid_generation_readable = health.active_generation.is_some_and(|generation_id| {
        SourceIndex::open_read_only(path, options)
            .and_then(|index| index.load_generation(generation_id))
            .is_ok()
    });
    let repair_required = !matches!(health.status, HealthStatus::Absent | HealthStatus::Ready);
    let repair_plan = if repair_required && path.is_file() {
        Some(build_repair_plan(path, options, &health)?)
    } else {
        None
    };
    Ok(IndexDoctorReport {
        health,
        last_valid_generation_readable,
        repair_required,
        repair_plan,
    })
}

pub fn repair_index(
    path: &Path,
    options: &SourceIndexOptions,
    confirmation: &str,
    replacement: &crate::GenerationInput,
) -> Result<IndexRepairReceipt> {
    reject_unsafe_repair_path(path)?;
    let report = doctor_index(path, options)?;
    let plan = report
        .repair_plan
        .ok_or_else(|| anyhow::anyhow!("source_index_repair_not_required"))?;
    if confirmation != plan.fingerprint {
        bail!("source_index_repair_confirmation_mismatch");
    }
    if database_bundle_fingerprint(path)? != plan.database_fingerprint {
        bail!("source_index_repair_plan_stale");
    }

    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("source_index_repair_parent_required"))?;
    let short_fingerprint = &plan.fingerprint[7..23];
    let backup_path = parent.join(&plan.backup_file_name);
    let candidate_path = parent.join(format!(
        ".memory-recall-source-index-{short_fingerprint}.candidate.sqlite"
    ));
    if database_bundle_exists(&backup_path) || database_bundle_exists(&candidate_path) {
        bail!("source_index_repair_artifact_exists");
    }

    let candidate_result = (|| -> Result<()> {
        let mut candidate = SourceIndex::open(&candidate_path, options)?;
        candidate.commit_generation(replacement)?;
        drop(candidate);
        let candidate_report = doctor_index(&candidate_path, options)?;
        if candidate_report.health.status != HealthStatus::Ready
            || !candidate_report.last_valid_generation_readable
        {
            bail!("source_index_repair_candidate_invalid");
        }
        Ok(())
    })();
    if candidate_result.is_err() {
        remove_database_bundle(&candidate_path)?;
        bail!("source_index_repair_candidate_failed");
    }

    if database_bundle_fingerprint(path)? != plan.database_fingerprint {
        remove_database_bundle(&candidate_path)?;
        bail!("source_index_repair_plan_stale");
    }
    move_database_bundle(path, &backup_path)?;
    if database_bundle_fingerprint(&backup_path)? != plan.database_fingerprint {
        move_database_bundle(&backup_path, path)
            .map_err(|_| anyhow::anyhow!("source_index_repair_rollback_failed"))?;
        remove_database_bundle(&candidate_path)?;
        bail!("source_index_repair_source_changed");
    }
    if move_database_bundle(&candidate_path, path).is_err() {
        remove_database_bundle(path)?;
        move_database_bundle(&backup_path, path)
            .map_err(|_| anyhow::anyhow!("source_index_repair_rollback_failed"))?;
        remove_database_bundle(&candidate_path)?;
        bail!("source_index_repair_swap_failed");
    }

    let verified = doctor_index(path, options);
    let active_generation = match verified {
        Ok(report)
            if report.health.status == HealthStatus::Ready
                && report.last_valid_generation_readable =>
        {
            report.health.active_generation
        }
        _ => None,
    };
    let Some(active_generation) = active_generation else {
        restore_backup(path, &backup_path, &candidate_path)?;
        bail!("source_index_repair_verification_failed");
    };

    Ok(IndexRepairReceipt {
        plan_fingerprint: plan.fingerprint,
        previous_status: plan.source_status,
        active_generation,
        backup_file_name: plan.backup_file_name,
        backup_cleanup_performed: false,
    })
}

fn build_repair_plan(
    path: &Path,
    options: &SourceIndexOptions,
    health: &IndexHealth,
) -> Result<IndexRepairPlan> {
    let database_fingerprint = database_bundle_fingerprint(path)?;
    let seed = RepairPlanSeed {
        database_fingerprint: &database_fingerprint,
        repository_identity: &options.repository_identity,
        engine_version: &options.engine_version,
        source_status: health.status,
        reason_codes: &health.reason_codes,
        action: "rebuild",
    };
    let fingerprint = format!(
        "sha256:{}",
        hex::encode(Sha256::digest(serde_json::to_vec(&seed)?))
    );
    let backup_file_name = format!(".memory-recall-source-index-{}.bak", &fingerprint[7..23]);
    Ok(IndexRepairPlan {
        fingerprint,
        database_fingerprint,
        source_status: health.status,
        reason_codes: health.reason_codes.clone(),
        action: "rebuild".to_string(),
        backup_file_name,
    })
}

fn reject_unsafe_repair_path(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| anyhow::anyhow!("source_index_repair_source_missing"))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        bail!("source_index_repair_path_invalid");
    }
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("source_index_repair_parent_required"))?;
    if fs::symlink_metadata(parent).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        bail!("source_index_repair_parent_invalid");
    }
    Ok(())
}

fn database_bundle_fingerprint(path: &Path) -> Result<String> {
    if !path.is_file() {
        bail!("source_index_repair_source_missing");
    }
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    for suffix in DATABASE_PARTS {
        let part = database_part(path, suffix);
        if !part.exists() {
            continue;
        }
        let metadata = fs::symlink_metadata(&part)
            .map_err(|_| anyhow::anyhow!("source_index_repair_fingerprint_failed"))?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            bail!("source_index_repair_path_invalid");
        }
        hasher.update(suffix.as_bytes());
        hasher.update(metadata.len().to_le_bytes());
        let mut file = File::open(&part)
            .map_err(|_| anyhow::anyhow!("source_index_repair_fingerprint_failed"))?;
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|_| anyhow::anyhow!("source_index_repair_fingerprint_failed"))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
    }
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn database_bundle_exists(path: &Path) -> bool {
    DATABASE_PARTS
        .into_iter()
        .any(|suffix| database_part(path, suffix).exists())
}

fn move_database_bundle(source: &Path, destination: &Path) -> Result<()> {
    if !source.is_file() || database_bundle_exists(destination) {
        bail!("source_index_repair_move_invalid");
    }
    let parts = DATABASE_PARTS
        .into_iter()
        .filter_map(|suffix| {
            let source_part = database_part(source, suffix);
            source_part
                .exists()
                .then(|| (source_part, database_part(destination, suffix)))
        })
        .collect::<Vec<_>>();
    let mut moved = Vec::new();
    for (source_part, destination_part) in &parts {
        if fs::rename(source_part, destination_part).is_err() {
            let mut rollback_failed = false;
            for (rollback_source, rollback_destination) in moved.into_iter().rev() {
                rollback_failed |= fs::rename(rollback_destination, rollback_source).is_err();
            }
            if rollback_failed {
                bail!("source_index_repair_rollback_failed");
            }
            bail!("source_index_repair_move_failed");
        }
        moved.push((source_part, destination_part));
    }
    Ok(())
}

fn restore_backup(path: &Path, backup_path: &Path, candidate_path: &Path) -> Result<()> {
    remove_database_bundle(candidate_path)?;
    remove_database_bundle(path)?;
    move_database_bundle(backup_path, path)
        .map_err(|_| anyhow::anyhow!("source_index_repair_rollback_failed"))
}

fn remove_database_bundle(path: &Path) -> Result<()> {
    for suffix in DATABASE_PARTS {
        let part = database_part(path, suffix);
        match fs::symlink_metadata(&part) {
            Ok(metadata) if metadata.file_type().is_file() => fs::remove_file(part)
                .map_err(|_| anyhow::anyhow!("source_index_repair_cleanup_failed"))?,
            Ok(_) => bail!("source_index_repair_cleanup_failed"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => bail!("source_index_repair_cleanup_failed"),
        }
    }
    Ok(())
}

fn database_part(path: &Path, suffix: &str) -> PathBuf {
    if suffix.is_empty() {
        return path.to_path_buf();
    }
    let mut value: OsString = path.as_os_str().to_owned();
    value.push(suffix);
    PathBuf::from(value)
}
