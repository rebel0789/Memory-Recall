use oaf_index::{
    doctor_index, normalized_generation_fingerprint, repair_index, FileRecord, GenerationInput,
    HealthStatus, NodeRecord, SourceIndex, SourceIndexOptions,
};
use rusqlite::Connection;
use std::fs::{self, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use tempfile::tempdir;

const REPOSITORY_ID: &str =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_REPOSITORY_ID: &str =
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_BEFORE: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const HASH_AFTER: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

fn options() -> SourceIndexOptions {
    SourceIndexOptions::new(REPOSITORY_ID, "2.0.0")
}

fn generation(content_hash: &str, created_at: &str) -> GenerationInput {
    let locator = "workspace://src/app.ts";
    let mut generation = GenerationInput {
        reason: "repair_rebuild".into(),
        created_at: created_at.into(),
        structural_fingerprint: REPOSITORY_ID.into(),
        ignore_fingerprint: None,
        files: vec![FileRecord {
            locator: locator.into(),
            content_hash: content_hash.into(),
            byte_size: 32,
            language: "typescript".into(),
            parse_state: "parsed".into(),
            diagnostic_count: 0,
            owner_identity: "node_app".into(),
        }],
        nodes: vec![NodeRecord {
            canonical_id: "node_app".into(),
            kind: "function".into(),
            language_kind: "function_declaration".into(),
            qualified_name: "src/app.ts::app".into(),
            locator: format!("{locator}#L1-L1"),
            start_line: 1,
            end_line: 1,
            content_hash: Some(content_hash.into()),
            visibility: "exported".into(),
        }],
        edges: Vec::new(),
        unresolved: Vec::new(),
        coverage: Vec::new(),
        diagnostics: Vec::new(),
    };
    generation.structural_fingerprint = normalized_generation_fingerprint(&generation).unwrap();
    generation
}

fn create_ready(path: &std::path::Path) -> GenerationInput {
    let current = generation(HASH_BEFORE, "2026-07-16T00:00:00.000Z");
    let mut index = SourceIndex::open(path, &options()).unwrap();
    index.commit_generation(&current).unwrap();
    current
}

fn insert_staging(path: &std::path::Path) {
    let connection = Connection::open(path).unwrap();
    connection
        .execute(
            "INSERT INTO index_generations (id, state, reason, created_at) VALUES (99, 'staging', 'interrupted', '2026-07-16T00:00:00.000Z')",
            [],
        )
        .unwrap();
}

#[test]
fn doctor_is_read_only_sanitized_and_classifies_failure_fixtures() {
    let root = tempdir().unwrap();
    let missing = root.path().join("missing.sqlite");
    let absent = doctor_index(&missing, &options()).unwrap();
    assert_eq!(absent.health.status, HealthStatus::Absent);
    assert!(!absent.repair_required);
    assert!(absent.repair_plan.is_none());
    assert!(!missing.exists());

    let interrupted = root.path().join("interrupted.sqlite");
    create_ready(&interrupted);
    insert_staging(&interrupted);
    let before = fs::read(&interrupted).unwrap();
    let before_modified = fs::metadata(&interrupted).unwrap().modified().unwrap();
    let report = doctor_index(&interrupted, &options()).unwrap();
    let repeated_report = doctor_index(&interrupted, &options()).unwrap();
    assert_eq!(report.repair_plan, repeated_report.repair_plan);
    assert_eq!(report.health.status, HealthStatus::Interrupted);
    assert!(report.last_valid_generation_readable);
    assert!(report.repair_required);
    assert!(report
        .repair_plan
        .as_ref()
        .unwrap()
        .fingerprint
        .starts_with("sha256:"));
    assert_eq!(fs::read(&interrupted).unwrap(), before);
    assert_eq!(
        fs::metadata(&interrupted).unwrap().modified().unwrap(),
        before_modified
    );
    let serialized = serde_json::to_string(&report).unwrap();
    assert!(!serialized.contains(root.path().to_string_lossy().as_ref()));
    assert!(!serialized.contains("database disk image"));

    let stale_path = root.path().join("stale.sqlite");
    create_ready(&stale_path);
    let stale = doctor_index(
        &stale_path,
        &SourceIndexOptions::new(REPOSITORY_ID, "1.1.2"),
    )
    .unwrap();
    assert_eq!(stale.health.status, HealthStatus::Stale);
    assert!(stale.last_valid_generation_readable);

    let wrong_repository = doctor_index(
        &interrupted,
        &SourceIndexOptions::new(OTHER_REPOSITORY_ID, "2.0.0"),
    )
    .unwrap();
    assert_eq!(
        wrong_repository.health.status,
        HealthStatus::WrongRepository
    );

    let missing_tables = root.path().join("missing-tables.sqlite");
    let connection = Connection::open(&missing_tables).unwrap();
    connection.pragma_update(None, "user_version", 1).unwrap();
    drop(connection);
    assert_eq!(
        doctor_index(&missing_tables, &options())
            .unwrap()
            .health
            .status,
        HealthStatus::Corrupt
    );

    let previous_schema = root.path().join("previous-schema.sqlite");
    Connection::open(&previous_schema).unwrap().close().unwrap();
    assert_eq!(
        doctor_index(&previous_schema, &options())
            .unwrap()
            .health
            .status,
        HealthStatus::MigrationRequired
    );
    let connection = Connection::open(&previous_schema).unwrap();
    let table_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(table_count, 0);

    let checksum = root.path().join("checksum.sqlite");
    create_ready(&checksum);
    let connection = Connection::open(&checksum).unwrap();
    connection
        .execute(
            "UPDATE index_migrations SET checksum = ?1",
            [OTHER_REPOSITORY_ID],
        )
        .unwrap();
    drop(connection);
    assert_eq!(
        doctor_index(&checksum, &options())
            .unwrap()
            .health
            .reason_codes,
        ["source_index_migration_checksum_invalid"]
    );

    let future = root.path().join("future.sqlite");
    let connection = Connection::open(&future).unwrap();
    connection.pragma_update(None, "user_version", 99).unwrap();
    drop(connection);
    assert_eq!(
        doctor_index(&future, &options()).unwrap().health.status,
        HealthStatus::UnsupportedSchema
    );

    let corrupt = root.path().join("corrupt.sqlite");
    fs::write(&corrupt, b"not a sqlite database").unwrap();
    assert_eq!(
        doctor_index(&corrupt, &options()).unwrap().health.status,
        HealthStatus::Corrupt
    );

    let corrupt_page = root.path().join("corrupt-page.sqlite");
    create_ready(&corrupt_page);
    let mut file = OpenOptions::new().write(true).open(&corrupt_page).unwrap();
    file.seek(SeekFrom::Start(8_192)).unwrap();
    file.write_all(&[0xff; 128]).unwrap();
    file.sync_all().unwrap();
    assert_eq!(
        doctor_index(&corrupt_page, &options())
            .unwrap()
            .health
            .status,
        HealthStatus::Corrupt
    );
}

#[test]
fn repair_requires_the_exact_plan_and_failed_candidate_leaves_source_untouched() {
    let root = tempdir().unwrap();
    let path = root.path().join("index.sqlite");
    create_ready(&path);
    insert_staging(&path);
    let report = doctor_index(&path, &options()).unwrap();
    let plan = report.repair_plan.unwrap();
    let before = fs::read(&path).unwrap();

    let replacement = generation(HASH_AFTER, "2026-07-16T00:01:00.000Z");
    assert!(repair_index(&path, &options(), REPOSITORY_ID, &replacement).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(!root.path().join(&plan.backup_file_name).exists());

    let mut invalid = replacement;
    invalid.structural_fingerprint = "invalid".into();
    assert!(repair_index(&path, &options(), &plan.fingerprint, &invalid).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(!root.path().join(&plan.backup_file_name).exists());
    assert!(!fs::read_dir(root.path()).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .contains("candidate")));
}

#[test]
fn successful_repair_preserves_readable_backup_and_never_touches_memory_store() {
    let root = tempdir().unwrap();
    let path = root.path().join("index.sqlite");
    let previous = create_ready(&path);
    insert_staging(&path);
    let memory_path = root.path().join("memory.sqlite");
    fs::write(&memory_path, b"governed-memory-sentinel").unwrap();
    let report = doctor_index(&path, &options()).unwrap();
    let plan = report.repair_plan.unwrap();
    let replacement = generation(HASH_AFTER, "2026-07-16T00:01:00.000Z");

    let receipt = repair_index(&path, &options(), &plan.fingerprint, &replacement).unwrap();
    assert_eq!(receipt.previous_status, HealthStatus::Interrupted);
    assert!(!receipt.backup_cleanup_performed);
    assert_eq!(receipt.backup_file_name, plan.backup_file_name);
    assert_eq!(
        doctor_index(&path, &options()).unwrap().health.status,
        HealthStatus::Ready
    );
    let current = SourceIndex::open_read_only(&path, &options()).unwrap();
    assert_eq!(
        current
            .load_active_generation()
            .unwrap()
            .unwrap()
            .input
            .structural_fingerprint,
        replacement.structural_fingerprint
    );

    let backup_path = root.path().join(&receipt.backup_file_name);
    assert!(backup_path.is_file());
    let backup = SourceIndex::open_read_only(&backup_path, &options()).unwrap();
    assert_eq!(
        backup
            .load_active_generation()
            .unwrap()
            .unwrap()
            .input
            .structural_fingerprint,
        previous.structural_fingerprint
    );
    assert_eq!(fs::read(&memory_path).unwrap(), b"governed-memory-sentinel");
    assert!(repair_index(&path, &options(), &plan.fingerprint, &replacement).is_err());
}

#[cfg(unix)]
#[test]
fn repair_rejects_symlinked_index_paths() {
    use std::os::unix::fs::symlink;

    let root = tempdir().unwrap();
    let real = root.path().join("real.sqlite");
    create_ready(&real);
    insert_staging(&real);
    let linked = root.path().join("linked.sqlite");
    symlink(&real, &linked).unwrap();
    assert!(doctor_index(&linked, &options()).is_err());
    let replacement = generation(HASH_AFTER, "2026-07-16T00:01:00.000Z");
    assert!(repair_index(&linked, &options(), REPOSITORY_ID, &replacement).is_err());
}
