use super::{
    open_read_only_connection, repository_identity_hash, secure_permissions, QueryBounds,
    SourceIndex, SourceIndexOptions,
};
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

pub const REPOSITORY_REGISTRY_SCHEMA_VERSION: i64 = 1;
pub const REPOSITORY_REGISTRY_LOCATOR: &str = "workspace://.local/source-index/registry.v1.sqlite";
pub const REPOSITORY_REGISTRY_RELATIVE_PATH: &str = ".local/source-index/registry.v1.sqlite";
pub const REPOSITORY_INDEX_RELATIVE_PATH: &str = ".local/source-index/index.v1.sqlite";
pub const REPOSITORY_SEARCH_MAX_REPOSITORIES: usize = 8;
pub const REPOSITORY_SEARCH_MAX_PER_REPOSITORY: usize = 25;
pub const REPOSITORY_SEARCH_MAX_RESULTS: usize = 50;
pub const REPOSITORY_SEARCH_MAX_DEADLINE_MS: u64 = 2_000;
pub const REPOSITORY_SEARCH_MAX_OUTPUT_BYTES: usize = 1_048_576;

const REGISTRY_SQL: &str = r#"
CREATE TABLE registry_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  fleet_root_identity_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE registered_repositories (
  repository_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  root_locator TEXT NOT NULL UNIQUE,
  repository_identity_hash TEXT NOT NULL UNIQUE,
  registered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
) STRICT;
CREATE INDEX registered_repositories_seen
  ON registered_repositories (last_seen_at DESC, repository_id);
"#;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredRepository {
    pub repository_id: String,
    pub display_name: String,
    pub root_locator: String,
    pub index_locator: String,
    pub repository_identity_hash: String,
    pub active_generation: Option<i64>,
    pub state: String,
    pub freshness: String,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualifiedRepositoryNode {
    pub id: String,
    pub native_id: String,
    pub repository_id: String,
    pub kind: String,
    pub label: String,
    pub locator: String,
    pub confidence: f64,
    pub generation: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerRepositorySearch {
    pub repository_id: String,
    pub state: String,
    pub result_count: usize,
    pub truncated: bool,
    pub reason_codes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySearchOutput {
    pub repositories: Vec<RegisteredRepository>,
    pub results: Vec<QualifiedRepositoryNode>,
    pub per_repository: Vec<PerRepositorySearch>,
    pub partial: bool,
    pub truncated: bool,
    pub opened_repository_count: usize,
}

#[derive(Debug, Clone)]
struct RegistryRow {
    repository_id: String,
    display_name: String,
    root_locator: String,
    repository_identity_hash: String,
    last_seen_at: String,
}

pub struct RepositoryRegistry {
    connection: Connection,
    fleet_root: PathBuf,
    workspace_id: String,
    engine_version: String,
}

impl RepositoryRegistry {
    pub fn open(fleet_root: &Path, workspace_id: &str, engine_version: &str) -> Result<Self> {
        validate_registry_options(workspace_id, engine_version)?;
        let fleet_root = fleet_root
            .canonicalize()
            .context("repository_fleet_root_invalid")?;
        let path = fleet_root.join(REPOSITORY_REGISTRY_RELATIVE_PATH);
        let parent = path
            .parent()
            .context("repository_registry_parent_required")?;
        fs::create_dir_all(parent).context("repository_registry_parent_create_failed")?;
        secure_permissions(parent, 0o700)?;
        let connection = Connection::open(&path).context("repository_registry_open_failed")?;
        configure_writer(&connection)?;
        migrate_registry(&connection, &fleet_root, workspace_id)?;
        secure_permissions(&path, 0o600)?;
        validate_registry(&connection, &fleet_root, workspace_id)?;
        Ok(Self {
            connection,
            fleet_root,
            workspace_id: workspace_id.to_string(),
            engine_version: engine_version.to_string(),
        })
    }

    pub fn open_read_only(
        fleet_root: &Path,
        workspace_id: &str,
        engine_version: &str,
    ) -> Result<Self> {
        validate_registry_options(workspace_id, engine_version)?;
        let fleet_root = fleet_root
            .canonicalize()
            .context("repository_fleet_root_invalid")?;
        let path = fleet_root.join(REPOSITORY_REGISTRY_RELATIVE_PATH);
        let connection = open_read_only_connection(&path)
            .context("repository_registry_read_only_open_failed")?;
        connection
            .pragma_update(None, "query_only", "ON")
            .context("repository_registry_query_only_failed")?;
        validate_registry(&connection, &fleet_root, workspace_id)?;
        Ok(Self {
            connection,
            fleet_root,
            workspace_id: workspace_id.to_string(),
            engine_version: engine_version.to_string(),
        })
    }

    pub fn register(
        &mut self,
        display_name: &str,
        root_locator: &str,
    ) -> Result<RegisteredRepository> {
        validate_display_name(display_name)?;
        let (normalized_locator, repository_root) =
            resolve_repository_root(&self.fleet_root, root_locator)?;
        let identity = repository_identity_hash(&repository_root, &self.workspace_id);
        let options = SourceIndexOptions::new(&identity, &self.engine_version);
        let index_path = repository_root.join(REPOSITORY_INDEX_RELATIVE_PATH);
        let index = SourceIndex::open_read_only(&index_path, &options)
            .context("repository_index_unavailable")?;
        let active_generation = index
            .active_generation()
            .context("repository_index_active_generation_missing")?;
        drop(index);
        let repository_id =
            derive_repository_id(&self.workspace_id, &normalized_locator, &identity);
        let timestamp = registry_timestamp();
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO registered_repositories (repository_id, display_name, root_locator, repository_identity_hash, registered_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5) ON CONFLICT(repository_id) DO UPDATE SET display_name = excluded.display_name, last_seen_at = excluded.last_seen_at",
            params![repository_id, display_name.trim(), normalized_locator, identity, timestamp],
        ).context("repository_registry_write_failed")?;
        transaction.execute(
            "UPDATE registry_metadata SET updated_at = ?1 WHERE singleton = 1",
            params![timestamp],
        )?;
        transaction.commit()?;
        Ok(RegisteredRepository {
            repository_id,
            display_name: display_name.trim().to_string(),
            root_locator: normalized_locator.clone(),
            index_locator: index_locator(&normalized_locator),
            repository_identity_hash: identity,
            active_generation: Some(active_generation),
            state: "ready".to_string(),
            freshness: "unverified".to_string(),
            last_seen_at: timestamp,
        })
    }

    pub fn list(&self, limit: usize) -> Result<Vec<RegisteredRepository>> {
        if !(1..=64).contains(&limit) {
            bail!("repository_list_limit_invalid");
        }
        let rows = self.load_rows(limit, None)?;
        Ok(rows.into_iter().map(|row| self.inspect_row(row)).collect())
    }

    pub fn search(
        &self,
        query: &str,
        repository_ids: &[String],
        per_repository_limit: usize,
        limit: usize,
        deadline_ms: u64,
    ) -> Result<RepositorySearchOutput> {
        validate_search(
            query,
            repository_ids,
            per_repository_limit,
            limit,
            deadline_ms,
        )?;
        let started = Instant::now();
        let wanted = repository_ids.iter().cloned().collect::<BTreeSet<_>>();
        let rows = self.load_rows(REPOSITORY_SEARCH_MAX_REPOSITORIES, Some(&wanted))?;
        let found = rows
            .iter()
            .map(|row| row.repository_id.clone())
            .collect::<BTreeSet<_>>();
        if found != wanted {
            bail!("repository_not_registered");
        }
        let by_id = rows
            .into_iter()
            .map(|row| (row.repository_id.clone(), row))
            .collect::<BTreeMap<_, _>>();
        let mut repositories = Vec::with_capacity(repository_ids.len());
        let mut results = Vec::new();
        let mut per_repository = Vec::with_capacity(repository_ids.len());
        let mut opened_repository_count = 0usize;
        let mut partial = false;
        let mut truncated = false;

        for repository_id in repository_ids {
            if started.elapsed() >= Duration::from_millis(deadline_ms) {
                partial = true;
                if let Some(row) = by_id.get(repository_id) {
                    repositories.push(repository_from_row(row, None));
                }
                per_repository.push(PerRepositorySearch {
                    repository_id: repository_id.clone(),
                    state: "unavailable".to_string(),
                    result_count: 0,
                    truncated: false,
                    reason_codes: vec!["repository_search_deadline_exceeded".to_string()],
                });
                continue;
            }
            let row = by_id
                .get(repository_id)
                .cloned()
                .context("repository_not_registered")?;
            let remaining_ms = deadline_ms.saturating_sub(elapsed_ms(started)).max(1);
            let query_result = self.query_row(&row, query, per_repository_limit, remaining_ms);
            match query_result {
                Ok((generation, nodes, repository_truncated)) => {
                    opened_repository_count += 1;
                    repositories.push(repository_from_row(&row, Some(generation)));
                    let projected = nodes
                        .into_iter()
                        .filter(|node| {
                            valid_prefixed_hex(&node.canonical_id, "cinode_")
                                && valid_result_locator(&node.locator)
                        })
                        .map(|node| {
                            let kind = safe_result_code(&node.kind);
                            let label = result_label(&node);
                            QualifiedRepositoryNode {
                                id: derive_qualified_node_id(repository_id, &node.canonical_id),
                                native_id: node.canonical_id,
                                repository_id: repository_id.clone(),
                                kind,
                                label,
                                locator: node.locator,
                                confidence: 1.0,
                                generation,
                            }
                        })
                        .collect::<Vec<_>>();
                    let result_count = projected.len();
                    results.extend(projected);
                    truncated |= repository_truncated;
                    per_repository.push(PerRepositorySearch {
                        repository_id: repository_id.clone(),
                        state: "ready".to_string(),
                        result_count,
                        truncated: repository_truncated,
                        reason_codes: Vec::new(),
                    });
                }
                Err(error) => {
                    partial = true;
                    repositories.push(repository_from_row(&row, None));
                    per_repository.push(PerRepositorySearch {
                        repository_id: repository_id.clone(),
                        state: "unavailable".to_string(),
                        result_count: 0,
                        truncated: false,
                        reason_codes: vec![safe_repository_reason(&error).to_string()],
                    });
                }
            }
        }

        results.sort_by(|left, right| {
            left.label
                .to_lowercase()
                .cmp(&right.label.to_lowercase())
                .then_with(|| left.repository_id.cmp(&right.repository_id))
                .then_with(|| left.native_id.cmp(&right.native_id))
        });
        if results.len() > limit {
            results.truncate(limit);
            truncated = true;
        }
        repositories.sort_by(|left, right| left.repository_id.cmp(&right.repository_id));
        per_repository.sort_by(|left, right| left.repository_id.cmp(&right.repository_id));
        let output = RepositorySearchOutput {
            repositories,
            results,
            per_repository,
            partial,
            truncated,
            opened_repository_count,
        };
        if serde_json::to_vec(&output)?.len() > REPOSITORY_SEARCH_MAX_OUTPUT_BYTES {
            bail!("repository_search_output_too_large");
        }
        Ok(output)
    }

    fn load_rows(
        &self,
        limit: usize,
        repository_ids: Option<&BTreeSet<String>>,
    ) -> Result<Vec<RegistryRow>> {
        let mut statement = self.connection.prepare(
            "SELECT repository_id, display_name, root_locator, repository_identity_hash, last_seen_at FROM registered_repositories ORDER BY repository_id",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok(RegistryRow {
                    repository_id: row.get(0)?,
                    display_name: row.get(1)?,
                    root_locator: row.get(2)?,
                    repository_identity_hash: row.get(3)?,
                    last_seen_at: row.get(4)?,
                })
            })?
            .filter_map(|row| match row {
                Ok(row) if repository_ids.is_none_or(|ids| ids.contains(&row.repository_id)) => {
                    Some(Ok(row))
                }
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            })
            .take(limit)
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    fn inspect_row(&self, row: RegistryRow) -> RegisteredRepository {
        let resolved = resolve_repository_root(&self.fleet_root, &row.root_locator);
        let active_generation = resolved
            .ok()
            .and_then(|(_, root)| {
                let options =
                    SourceIndexOptions::new(&row.repository_identity_hash, &self.engine_version);
                SourceIndex::open_read_only(&root.join(REPOSITORY_INDEX_RELATIVE_PATH), &options)
                    .ok()
            })
            .and_then(|index| index.active_generation());
        RegisteredRepository {
            repository_id: row.repository_id,
            display_name: row.display_name,
            root_locator: row.root_locator.clone(),
            index_locator: index_locator(&row.root_locator),
            repository_identity_hash: row.repository_identity_hash,
            active_generation,
            state: if active_generation.is_some() {
                "ready".to_string()
            } else {
                "unavailable".to_string()
            },
            freshness: "unverified".to_string(),
            last_seen_at: row.last_seen_at,
        }
    }

    fn query_row(
        &self,
        row: &RegistryRow,
        query: &str,
        per_repository_limit: usize,
        timeout_ms: u64,
    ) -> Result<(i64, Vec<super::NodeRecord>, bool)> {
        let (_, root) = resolve_repository_root(&self.fleet_root, &row.root_locator)?;
        let options = SourceIndexOptions::new(&row.repository_identity_hash, &self.engine_version);
        let index =
            SourceIndex::open_read_only(&root.join(REPOSITORY_INDEX_RELATIVE_PATH), &options)?;
        let generation = index
            .active_generation()
            .context("repository_index_active_generation_missing")?;
        let page = index.find_nodes(
            query,
            &QueryBounds {
                limit: per_repository_limit,
                max_depth: 1,
                max_output_bytes: REPOSITORY_SEARCH_MAX_OUTPUT_BYTES,
                timeout_ms: timeout_ms.min(REPOSITORY_SEARCH_MAX_DEADLINE_MS),
                cursor: None,
            },
        )?;
        let truncated = page.next_cursor.is_some();
        Ok((generation, page.items, truncated))
    }
}

pub fn derive_repository_id(
    workspace_id: &str,
    root_locator: &str,
    repository_identity_hash: &str,
) -> String {
    prefixed_digest(
        "repo_",
        &[
            workspace_id.as_bytes(),
            root_locator.as_bytes(),
            repository_identity_hash.as_bytes(),
        ],
    )
}

pub fn derive_qualified_node_id(repository_id: &str, native_id: &str) -> String {
    prefixed_digest("mrnode_", &[repository_id.as_bytes(), native_id.as_bytes()])
}

fn prefixed_digest(prefix: &str, parts: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            hasher.update([0]);
        }
        hasher.update(part);
    }
    format!("{prefix}{}", &hex::encode(hasher.finalize())[..32])
}

fn configure_writer(connection: &Connection) -> Result<()> {
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "journal_mode", "DELETE")?;
    connection.pragma_update(None, "synchronous", "FULL")?;
    connection.busy_timeout(Duration::from_secs(5))?;
    Ok(())
}

fn migrate_registry(connection: &Connection, fleet_root: &Path, workspace_id: &str) -> Result<()> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > REPOSITORY_REGISTRY_SCHEMA_VERSION {
        bail!("repository_registry_schema_newer");
    }
    if version == 0 {
        let transaction = connection.unchecked_transaction()?;
        transaction.execute_batch(REGISTRY_SQL)?;
        let timestamp = registry_timestamp();
        transaction.execute(
            "INSERT INTO registry_metadata (singleton, schema_version, workspace_id, fleet_root_identity_hash, created_at, updated_at) VALUES (1, ?1, ?2, ?3, ?4, ?4)",
            params![REPOSITORY_REGISTRY_SCHEMA_VERSION, workspace_id, repository_identity_hash(fleet_root, workspace_id), timestamp],
        )?;
        transaction.pragma_update(None, "user_version", REPOSITORY_REGISTRY_SCHEMA_VERSION)?;
        transaction.commit()?;
    }
    Ok(())
}

fn validate_registry(connection: &Connection, fleet_root: &Path, workspace_id: &str) -> Result<()> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version != REPOSITORY_REGISTRY_SCHEMA_VERSION {
        bail!(if version > REPOSITORY_REGISTRY_SCHEMA_VERSION {
            "repository_registry_schema_newer"
        } else {
            "repository_registry_migration_required"
        });
    }
    let metadata = connection
        .query_row(
            "SELECT schema_version, workspace_id, fleet_root_identity_hash FROM registry_metadata WHERE singleton = 1",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        )
        .optional()?;
    let expected_identity = repository_identity_hash(fleet_root, workspace_id);
    match metadata {
        Some((schema, stored_workspace, stored_identity))
            if schema == REPOSITORY_REGISTRY_SCHEMA_VERSION
                && stored_workspace == workspace_id
                && stored_identity == expected_identity =>
        {
            Ok(())
        }
        Some(_) => bail!("repository_registry_wrong_workspace"),
        None => bail!("repository_registry_metadata_missing"),
    }
}

fn resolve_repository_root(fleet_root: &Path, locator: &str) -> Result<(String, PathBuf)> {
    let suffix = locator
        .strip_prefix("workspace://")
        .context("repository_root_locator_invalid")?;
    if suffix.is_empty()
        || suffix.len() > 512
        || suffix.contains('\\')
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_./@+-".contains(&byte))
    {
        bail!("repository_root_locator_invalid");
    }
    let mut relative = PathBuf::new();
    for component in Path::new(suffix).components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => relative.push(part),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                bail!("repository_root_locator_invalid")
            }
        }
    }
    let normalized = if relative.as_os_str().is_empty() {
        "workspace://.".to_string()
    } else {
        format!("workspace://{}", relative.to_string_lossy())
    };
    let candidate = fleet_root.join(&relative);
    let canonical = candidate
        .canonicalize()
        .context("repository_root_unavailable")?;
    if !canonical.starts_with(fleet_root) || !canonical.is_dir() {
        bail!("repository_root_outside_workspace");
    }
    Ok((normalized, canonical))
}

fn index_locator(root_locator: &str) -> String {
    if root_locator == "workspace://." {
        format!("workspace://./{REPOSITORY_INDEX_RELATIVE_PATH}")
    } else {
        format!(
            "{}/{}",
            root_locator.trim_end_matches('/'),
            REPOSITORY_INDEX_RELATIVE_PATH
        )
    }
}

fn validate_registry_options(workspace_id: &str, engine_version: &str) -> Result<()> {
    if workspace_id.is_empty()
        || workspace_id.len() > 128
        || !workspace_id.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || (index > 0 && (byte.is_ascii_digit() || matches!(byte, b'_' | b'-')))
        })
    {
        bail!("repository_workspace_id_invalid");
    }
    let version = engine_version.split('.').collect::<Vec<_>>();
    if version.len() != 3
        || version
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        bail!("repository_engine_version_invalid");
    }
    Ok(())
}

fn validate_display_name(value: &str) -> Result<()> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > 80
        || !trimmed
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        || !trimmed
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b" _.-".contains(&byte))
    {
        bail!("repository_display_name_invalid");
    }
    Ok(())
}

fn validate_search(
    query: &str,
    repository_ids: &[String],
    per_repository_limit: usize,
    limit: usize,
    deadline_ms: u64,
) -> Result<()> {
    let unique = repository_ids.iter().collect::<BTreeSet<_>>();
    if query.trim().is_empty()
        || query.len() > 160
        || !query
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.$:/#@ -".contains(&byte))
        || repository_ids.is_empty()
        || repository_ids.len() > REPOSITORY_SEARCH_MAX_REPOSITORIES
        || unique.len() != repository_ids.len()
        || repository_ids
            .iter()
            .any(|id| !valid_prefixed_hex(id, "repo_"))
        || !(1..=REPOSITORY_SEARCH_MAX_PER_REPOSITORY).contains(&per_repository_limit)
        || !(1..=REPOSITORY_SEARCH_MAX_RESULTS).contains(&limit)
        || !(1..=REPOSITORY_SEARCH_MAX_DEADLINE_MS).contains(&deadline_ms)
    {
        bail!("repository_search_request_invalid");
    }
    Ok(())
}

fn valid_prefixed_hex(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|suffix| {
        suffix.len() == 32
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn valid_result_locator(value: &str) -> bool {
    value.starts_with("workspace://")
        && value.len() <= 512
        && !value.contains("..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.$:/#@+-".contains(&byte))
}

fn safe_result_code(value: &str) -> String {
    let output = value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'_' | b'-' | b'.')
            {
                char::from(byte)
            } else {
                '_'
            }
        })
        .take(128)
        .collect::<String>();
    if output
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_lowercase)
    {
        output
    } else {
        "index_internal_error".to_string()
    }
}

fn result_label(node: &super::NodeRecord) -> String {
    let concise = if node.kind == "file" {
        node.qualified_name.as_str()
    } else {
        node.qualified_name
            .rsplit("::")
            .next()
            .unwrap_or(&node.qualified_name)
    };
    let output = concise
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || "_.$:/#@ +()<>, -".contains(character) {
                character
            } else {
                '_'
            }
        })
        .take(160)
        .collect::<String>();
    if output.trim().is_empty() {
        "unknown".to_string()
    } else {
        output
    }
}

fn safe_repository_reason(error: &anyhow::Error) -> &'static str {
    let text = format!("{error:#}");
    if text.contains("deadline") {
        "repository_search_deadline_exceeded"
    } else if text.contains("wrong_repository") {
        "repository_index_identity_mismatch"
    } else {
        "repository_index_unavailable"
    }
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn repository_from_row(row: &RegistryRow, active_generation: Option<i64>) -> RegisteredRepository {
    RegisteredRepository {
        repository_id: row.repository_id.clone(),
        display_name: row.display_name.clone(),
        root_locator: row.root_locator.clone(),
        index_locator: index_locator(&row.root_locator),
        repository_identity_hash: row.repository_identity_hash.clone(),
        active_generation,
        state: if active_generation.is_some() {
            "ready".to_string()
        } else {
            "unavailable".to_string()
        },
        freshness: "unverified".to_string(),
        last_seen_at: row.last_seen_at.clone(),
    }
}

fn registry_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs());
    let days = i64::try_from(seconds / 86_400).unwrap_or(i64::MAX);
    let day_seconds = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = day_seconds / 3_600;
    let minute = (day_seconds % 3_600) / 60;
    let second = day_seconds % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}
