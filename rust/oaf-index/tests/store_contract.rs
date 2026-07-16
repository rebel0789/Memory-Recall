use oaf_index::{inspect_index, HealthStatus, SourceIndex, SourceIndexOptions, SCHEMA_VERSION};
use rusqlite::Connection;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::Duration;
use tempfile::tempdir;

fn options() -> SourceIndexOptions {
    SourceIndexOptions::new(
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "1.1.1",
    )
}

#[test]
fn creates_separate_secure_index_with_current_migration() {
    let root = tempdir().unwrap();
    let path = root.path().join(".local/source-index/index.v1.sqlite");
    let index = SourceIndex::open(&path, &options()).unwrap();
    assert_eq!(index.schema_version(), SCHEMA_VERSION);
    assert_eq!(index.active_generation(), None);
    assert_eq!(index.journal_mode(), "wal");
    assert!(index.foreign_keys_enabled());
    drop(index);

    let connection = Connection::open(&path).unwrap();
    let migration_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM index_migrations", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(migration_count, 1);
    for table in [
        "index_metadata",
        "index_migrations",
        "index_generations",
        "index_files",
        "index_nodes",
        "index_edges",
        "index_unresolved",
        "index_coverage",
        "index_diagnostics",
        "index_health",
    ] {
        let exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(exists, 1, "{table}");
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn read_only_open_never_creates_or_migrates() {
    let root = tempdir().unwrap();
    let missing = root.path().join("missing.sqlite");
    assert!(SourceIndex::open_read_only(&missing, &options()).is_err());
    assert!(!missing.exists());

    let legacy = root.path().join("legacy.sqlite");
    Connection::open(&legacy).unwrap().close().unwrap();
    assert!(SourceIndex::open_read_only(&legacy, &options()).is_err());
    let connection = Connection::open(&legacy).unwrap();
    let table_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(table_count, 0);
}

#[test]
fn health_is_explicit_for_identity_schema_interruption_and_corruption() {
    let root = tempdir().unwrap();
    let missing = root.path().join("missing.sqlite");
    assert_eq!(
        inspect_index(&missing, &options()).status,
        HealthStatus::Absent
    );

    let path = root.path().join("index.sqlite");
    SourceIndex::open(&path, &options()).unwrap();
    assert_eq!(inspect_index(&path, &options()).status, HealthStatus::Ready);

    let wrong = SourceIndexOptions::new(
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "1.1.1",
    );
    assert_eq!(
        inspect_index(&path, &wrong).status,
        HealthStatus::WrongRepository
    );

    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "INSERT INTO index_generations (id, state, reason, created_at) VALUES (1, 'staging', 'test', '2026-07-16T00:00:00.000Z')",
            [],
        )
        .unwrap();
    drop(connection);
    assert_eq!(
        inspect_index(&path, &options()).status,
        HealthStatus::Interrupted
    );

    let newer = root.path().join("newer.sqlite");
    let connection = Connection::open(&newer).unwrap();
    connection.pragma_update(None, "user_version", 99).unwrap();
    drop(connection);
    assert_eq!(
        inspect_index(&newer, &options()).status,
        HealthStatus::UnsupportedSchema
    );

    let corrupt = root.path().join("corrupt.sqlite");
    fs::write(&corrupt, b"not a sqlite database").unwrap();
    assert_eq!(
        inspect_index(&corrupt, &options()).status,
        HealthStatus::Corrupt
    );
}

#[test]
fn killed_uncommitted_writer_leaves_the_current_index_valid() {
    let root = tempdir().unwrap();
    let path = root.path().join("index.sqlite");
    SourceIndex::open(&path, &options()).unwrap();

    let mut child = Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg("crash_writer_helper")
        .arg("--nocapture")
        .env("OAF_INDEX_CRASH_PATH", &path)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut reader = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    loop {
        line.clear();
        assert!(reader.read_line(&mut line).unwrap() > 0);
        if line.contains("OAF_INDEX_WRITER_READY") {
            break;
        }
    }
    child.kill().unwrap();
    child.wait().unwrap();

    assert_eq!(inspect_index(&path, &options()).status, HealthStatus::Ready);
    let connection = Connection::open(&path).unwrap();
    let generation_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM index_generations", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(generation_count, 0);
}

#[test]
fn crash_writer_helper() {
    let Ok(path) = std::env::var("OAF_INDEX_CRASH_PATH") else {
        return;
    };
    let connection = Connection::open(path).unwrap();
    connection.execute_batch("BEGIN IMMEDIATE").unwrap();
    connection
        .execute(
            "INSERT INTO index_generations (id, state, reason, created_at) VALUES (99, 'staging', 'crash-test', '2026-07-16T00:00:00.000Z')",
            [],
        )
        .unwrap();
    println!("OAF_INDEX_WRITER_READY");
    std::io::stdout().flush().unwrap();
    std::thread::sleep(Duration::from_secs(30));
}
