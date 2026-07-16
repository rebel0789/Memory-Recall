use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

pub const SCHEMA_VERSION: i64 = 1;
const MIGRATION_ID: &str = "0001_source_index";
const MIGRATION_SQL: &str = r#"
CREATE TABLE index_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  repository_identity TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  ignore_fingerprint TEXT,
  active_generation INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE index_migrations (
  migration_id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;
CREATE TABLE index_generations (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES index_generations(id),
  state TEXT NOT NULL CHECK (state IN ('staging', 'committed', 'failed')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  committed_at TEXT,
  file_count INTEGER NOT NULL DEFAULT 0,
  node_count INTEGER NOT NULL DEFAULT 0,
  edge_count INTEGER NOT NULL DEFAULT 0,
  unresolved_count INTEGER NOT NULL DEFAULT 0,
  structural_fingerprint TEXT
) STRICT;
CREATE TABLE index_files (
  generation_id INTEGER NOT NULL REFERENCES index_generations(id) ON DELETE CASCADE,
  locator TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  language TEXT NOT NULL,
  parse_state TEXT NOT NULL,
  diagnostic_count INTEGER NOT NULL DEFAULT 0,
  owner_identity TEXT NOT NULL,
  PRIMARY KEY (generation_id, locator)
) WITHOUT ROWID, STRICT;
CREATE TABLE index_nodes (
  generation_id INTEGER NOT NULL REFERENCES index_generations(id) ON DELETE CASCADE,
  canonical_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  language_kind TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  locator TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  content_hash TEXT,
  visibility TEXT NOT NULL,
  PRIMARY KEY (generation_id, canonical_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE index_edges (
  generation_id INTEGER NOT NULL REFERENCES index_generations(id) ON DELETE CASCADE,
  canonical_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  locator TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  resolver TEXT NOT NULL,
  resolver_version TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  resolution_class TEXT NOT NULL,
  stale INTEGER NOT NULL CHECK (stale IN (0, 1)),
  PRIMARY KEY (generation_id, canonical_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE index_unresolved (
  generation_id INTEGER NOT NULL REFERENCES index_generations(id) ON DELETE CASCADE,
  canonical_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  relationship_kind TEXT NOT NULL,
  target_text_hash TEXT NOT NULL,
  locator TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  reason_code TEXT NOT NULL,
  confidence_class TEXT NOT NULL,
  PRIMARY KEY (generation_id, canonical_id)
) WITHOUT ROWID, STRICT;
CREATE TABLE index_coverage (
  generation_id INTEGER NOT NULL REFERENCES index_generations(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  capability TEXT NOT NULL,
  represented_count INTEGER NOT NULL,
  omitted_count INTEGER NOT NULL,
  failed_count INTEGER NOT NULL,
  reason_code TEXT,
  PRIMARY KEY (generation_id, language, capability)
) WITHOUT ROWID, STRICT;
CREATE TABLE index_health (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  integrity_status TEXT NOT NULL,
  interrupted_generation INTEGER,
  last_successful_refresh_at TEXT,
  repair_reason_code TEXT,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX index_nodes_name ON index_nodes (generation_id, qualified_name, canonical_id);
CREATE INDEX index_nodes_locator ON index_nodes (generation_id, locator, canonical_id);
CREATE INDEX index_edges_source ON index_edges (generation_id, source_id, kind, canonical_id);
CREATE INDEX index_edges_target ON index_edges (generation_id, target_id, kind, canonical_id);
"#;

#[derive(Debug, Clone)]
pub struct SourceIndexOptions {
    pub repository_identity: String,
    pub engine_version: String,
}

impl SourceIndexOptions {
    pub fn new(repository_identity: impl Into<String>, engine_version: impl Into<String>) -> Self {
        Self {
            repository_identity: repository_identity.into(),
            engine_version: engine_version.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthStatus {
    Absent,
    Ready,
    Stale,
    MigrationRequired,
    Interrupted,
    Corrupt,
    WrongRepository,
    UnsupportedSchema,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexHealth {
    pub status: HealthStatus,
    pub reason_codes: Vec<String>,
    pub active_generation: Option<i64>,
    pub schema_version: Option<i64>,
}

pub struct SourceIndex {
    connection: Connection,
    _path: PathBuf,
}

impl SourceIndex {
    pub fn open(path: &Path, options: &SourceIndexOptions) -> Result<Self> {
        validate_options(options)?;
        let parent = path.parent().context("source_index_parent_required")?;
        fs::create_dir_all(parent).context("source_index_parent_create_failed")?;
        secure_permissions(parent, 0o700)?;
        let connection = Connection::open(path).context("source_index_open_failed")?;
        configure_writer(&connection)?;
        migrate(&connection, options)?;
        secure_permissions(path, 0o600)?;
        validate_current(&connection, options)?;
        Ok(Self {
            connection,
            _path: path.to_path_buf(),
        })
    }

    pub fn open_read_only(path: &Path, options: &SourceIndexOptions) -> Result<Self> {
        validate_options(options)?;
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .context("source_index_read_only_open_failed")?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .context("source_index_foreign_keys_failed")?;
        validate_current(&connection, options)?;
        Ok(Self {
            connection,
            _path: path.to_path_buf(),
        })
    }

    pub fn schema_version(&self) -> i64 {
        self.connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap_or_default()
    }

    pub fn active_generation(&self) -> Option<i64> {
        self.connection
            .query_row(
                "SELECT active_generation FROM index_metadata WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .ok()
            .flatten()
            .flatten()
    }

    pub fn journal_mode(&self) -> String {
        self.connection
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap_or_else(|_| "unknown".to_string())
    }

    pub fn foreign_keys_enabled(&self) -> bool {
        self.connection
            .pragma_query_value(None, "foreign_keys", |row| row.get::<_, i64>(0))
            .is_ok_and(|value| value == 1)
    }
}

pub fn inspect_index(path: &Path, options: &SourceIndexOptions) -> IndexHealth {
    if !path.is_file() {
        return health(HealthStatus::Absent, "source_index_absent", None, None);
    }
    let connection = match Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(connection) => connection,
        Err(_) => return health(HealthStatus::Corrupt, "source_index_corrupt", None, None),
    };
    let schema_version =
        match connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)) {
            Ok(version) => version,
            Err(_) => return health(HealthStatus::Corrupt, "source_index_corrupt", None, None),
        };
    if schema_version > SCHEMA_VERSION {
        return health(
            HealthStatus::UnsupportedSchema,
            "source_index_schema_newer",
            None,
            Some(schema_version),
        );
    }
    if schema_version < SCHEMA_VERSION {
        return health(
            HealthStatus::MigrationRequired,
            "source_index_migration_required",
            None,
            Some(schema_version),
        );
    }
    let integrity =
        connection.pragma_query_value(None, "quick_check", |row| row.get::<_, String>(0));
    if !integrity.is_ok_and(|value| value == "ok") {
        return health(
            HealthStatus::Corrupt,
            "source_index_integrity_failed",
            None,
            Some(schema_version),
        );
    }
    let metadata = connection.query_row(
        "SELECT repository_identity, engine_version, active_generation FROM index_metadata WHERE singleton = 1",
        [],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<i64>>(2)?)),
    );
    let (repository_identity, engine_version, active_generation) = match metadata {
        Ok(metadata) => metadata,
        Err(_) => {
            return health(
                HealthStatus::Corrupt,
                "source_index_metadata_invalid",
                None,
                Some(schema_version),
            )
        }
    };
    if repository_identity != options.repository_identity {
        return health(
            HealthStatus::WrongRepository,
            "source_index_wrong_repository",
            active_generation,
            Some(schema_version),
        );
    }
    if !migration_checksum_valid(&connection) {
        return health(
            HealthStatus::Corrupt,
            "source_index_migration_checksum_invalid",
            active_generation,
            Some(schema_version),
        );
    }
    let staging_count = connection
        .query_row(
            "SELECT COUNT(*) FROM index_generations WHERE state = 'staging'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(1);
    if staging_count > 0 {
        return health(
            HealthStatus::Interrupted,
            "source_index_interrupted_generation",
            active_generation,
            Some(schema_version),
        );
    }
    if engine_version != options.engine_version {
        return health(
            HealthStatus::Stale,
            "source_index_engine_changed",
            active_generation,
            Some(schema_version),
        );
    }
    health(
        HealthStatus::Ready,
        "source_index_ready",
        active_generation,
        Some(schema_version),
    )
}

fn configure_writer(connection: &Connection) -> Result<()> {
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .context("source_index_foreign_keys_failed")?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .context("source_index_wal_failed")?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .context("source_index_sync_failed")?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .context("source_index_busy_timeout_failed")?;
    Ok(())
}

fn migrate(connection: &Connection, options: &SourceIndexOptions) -> Result<()> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > SCHEMA_VERSION {
        bail!("source_index_schema_newer");
    }
    if version == 0 {
        let transaction = connection.unchecked_transaction()?;
        transaction.execute_batch(MIGRATION_SQL)?;
        let timestamp = timestamp_token();
        transaction.execute(
            "INSERT INTO index_migrations (migration_id, checksum, applied_at) VALUES (?1, ?2, ?3)",
            params![MIGRATION_ID, migration_checksum(), timestamp],
        )?;
        transaction.execute(
            "INSERT INTO index_metadata (singleton, schema_version, repository_identity, engine_version, created_at, updated_at) VALUES (1, ?1, ?2, ?3, ?4, ?4)",
            params![SCHEMA_VERSION, options.repository_identity, options.engine_version, timestamp],
        )?;
        transaction.execute(
            "INSERT INTO index_health (singleton, integrity_status, updated_at) VALUES (1, 'ready', ?1)",
            params![timestamp],
        )?;
        transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        transaction.commit()?;
    }
    Ok(())
}

fn validate_current(connection: &Connection, options: &SourceIndexOptions) -> Result<()> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version != SCHEMA_VERSION {
        bail!(if version > SCHEMA_VERSION {
            "source_index_schema_newer"
        } else {
            "source_index_migration_required"
        });
    }
    let integrity: String = connection.pragma_query_value(None, "quick_check", |row| row.get(0))?;
    if integrity != "ok" {
        bail!("source_index_integrity_failed");
    }
    let repository_identity: String = connection.query_row(
        "SELECT repository_identity FROM index_metadata WHERE singleton = 1",
        [],
        |row| row.get(0),
    )?;
    if repository_identity != options.repository_identity {
        bail!("source_index_wrong_repository");
    }
    if !migration_checksum_valid(connection) {
        bail!("source_index_migration_checksum_invalid");
    }
    Ok(())
}

fn migration_checksum_valid(connection: &Connection) -> bool {
    connection
        .query_row(
            "SELECT checksum FROM index_migrations WHERE migration_id = ?1",
            [MIGRATION_ID],
            |row| row.get::<_, String>(0),
        )
        .is_ok_and(|checksum| checksum == migration_checksum())
}

fn migration_checksum() -> String {
    format!(
        "sha256:{}",
        hex::encode(Sha256::digest(MIGRATION_SQL.as_bytes()))
    )
}

fn validate_options(options: &SourceIndexOptions) -> Result<()> {
    let identity = options.repository_identity.as_bytes();
    if identity.len() != 71
        || !options.repository_identity.starts_with("sha256:")
        || !identity[7..].iter().all(u8::is_ascii_hexdigit)
    {
        bail!("source_index_repository_identity_invalid");
    }
    let parts = options.engine_version.split('.').collect::<Vec<_>>();
    if parts.len() != 3
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        bail!("source_index_engine_version_invalid");
    }
    Ok(())
}

fn health(
    status: HealthStatus,
    reason: &str,
    active_generation: Option<i64>,
    schema_version: Option<i64>,
) -> IndexHealth {
    IndexHealth {
        status,
        reason_codes: vec![reason.to_string()],
        active_generation,
        schema_version,
    }
}

fn timestamp_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs());
    format!("unix:{seconds}")
}

fn secure_permissions(path: &Path, mode: u32) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
            .context("source_index_permissions_failed")?;
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
    Ok(())
}
