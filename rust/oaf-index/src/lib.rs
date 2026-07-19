use anyhow::{bail, Context, Result};
use rusqlite::{
    params, params_from_iter, types::Value as SqlValue, Connection, OpenFlags, OptionalExtension,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

mod doctor;
pub use doctor::*;
mod model;
pub use model::*;
pub mod registry;
pub use registry::*;
mod watcher;
pub use watcher::*;

pub const SCHEMA_VERSION: i64 = 1;
pub const COMMUNITY_ALGORITHM_VERSION: &str = "label-propagation-v1";
pub const PROCESS_ALGORITHM_VERSION: &str = "entry-path-v1";
fn projection_cursor(kind: u8, generation: i64, offset: usize) -> String {
    format!("cinode_{kind:02x}{:014x}{offset:016x}", generation.max(0))
}
fn projection_offset(cursor: Option<&String>, kind: u8, generation: i64) -> Result<usize> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    let suffix = cursor
        .strip_prefix("cinode_")
        .context("source_index_projection_cursor_invalid")?;
    if suffix.len() != 32
        || !suffix.bytes().all(|b| b.is_ascii_hexdigit())
        || suffix[..2] != format!("{kind:02x}")
        || u64::from_str_radix(&suffix[2..16], 16).ok() != Some(generation.max(0) as u64)
    {
        bail!("source_index_projection_cursor_stale");
    }
    usize::from_str_radix(&suffix[16..], 16).context("source_index_projection_cursor_invalid")
}
const COMMUNITY_MAX_PASSES: usize = 8;
const COMMUNITY_SCAN_NODE_LIMIT: usize = 5_000;
const COMMUNITY_SCAN_EDGE_LIMIT: usize = 20_000;
const PROCESS_MIN_CONFIDENCE: f64 = 0.75;
const PROCESS_ENTRY_KINDS: &[&str] = &["entry_point", "handles_route"];
const PROCESS_STEP_KINDS: &[&str] = &[
    "calls",
    "constructs",
    "depends_on",
    "emits",
    "handles_route",
    "listens",
    "process_step",
    "reads",
    "writes",
];
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
  diagnostic_count INTEGER NOT NULL DEFAULT 0,
  structural_fingerprint TEXT,
  ignore_fingerprint TEXT
) STRICT;
CREATE TABLE index_files (
  generation_id INTEGER NOT NULL REFERENCES index_generations(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
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
  ordinal INTEGER NOT NULL,
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
  ordinal INTEGER NOT NULL,
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
  ordinal INTEGER NOT NULL,
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
  ordinal INTEGER NOT NULL,
  language TEXT NOT NULL,
  capability TEXT NOT NULL,
  represented_count INTEGER NOT NULL,
  omitted_count INTEGER NOT NULL,
  failed_count INTEGER NOT NULL,
  reason_code TEXT,
  PRIMARY KEY (generation_id, language, capability)
) WITHOUT ROWID, STRICT;
CREATE TABLE index_diagnostics (
  generation_id INTEGER NOT NULL REFERENCES index_generations(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  canonical_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  code TEXT NOT NULL,
  locator TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  message_hash TEXT NOT NULL,
  PRIMARY KEY (generation_id, canonical_id)
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

pub fn repository_identity_hash(root: &Path, workspace_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(root.as_os_str().to_string_lossy().as_bytes());
    hasher.update([0]);
    hasher.update(workspace_id.as_bytes());
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
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

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct IndexHealth {
    pub status: HealthStatus,
    pub reason_codes: Vec<String>,
    pub active_generation: Option<i64>,
    pub schema_version: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ActiveGenerationMetadata {
    pub summary: GenerationSummary,
    pub files: Vec<FileRecord>,
    pub coverage: Vec<CoverageRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityProjection {
    pub id: String,
    pub label: String,
    pub path_prefix: String,
    pub node_ids: Vec<String>,
    pub relationship_ids: Vec<String>,
    pub represented_node_count: usize,
    pub represented_relationship_count: usize,
    pub generation: i64,
    pub algorithm_version: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessProjection {
    pub id: String,
    pub label: String,
    pub entry_node_id: String,
    pub entry_relationship_id: String,
    pub sink_node_id: String,
    pub sink_kind: String,
    pub node_ids: Vec<String>,
    pub relationship_ids: Vec<String>,
    pub confidence: f64,
    pub generation: i64,
    pub algorithm_version: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct GraphProjection<T> {
    pub items: Vec<T>,
    pub nodes: Vec<NodeRecord>,
    pub edges: Vec<EdgeRecord>,
    pub truncated: bool,
    pub next_cursor: Option<String>,
}

pub struct SourceIndex {
    connection: Connection,
    _path: PathBuf,
    engine_version: String,
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
            engine_version: options.engine_version.clone(),
        })
    }

    pub fn open_read_only(path: &Path, options: &SourceIndexOptions) -> Result<Self> {
        validate_options(options)?;
        let connection =
            open_read_only_connection(path).context("source_index_read_only_open_failed")?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .context("source_index_foreign_keys_failed")?;
        connection
            .pragma_update(None, "query_only", "ON")
            .context("source_index_query_only_failed")?;
        validate_current(&connection, options)?;
        Ok(Self {
            connection,
            _path: path.to_path_buf(),
            engine_version: options.engine_version.clone(),
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

    pub fn commit_generation(&mut self, input: &GenerationInput) -> Result<GenerationSummary> {
        validate_generation(input)?;
        let transaction = self.connection.transaction()?;
        let parent_id = transaction.query_row(
            "SELECT active_generation FROM index_metadata WHERE singleton = 1",
            [],
            |row| row.get::<_, Option<i64>>(0),
        )?;
        let generation_id = transaction.query_row(
            "SELECT COALESCE(MAX(id), 0) + 1 FROM index_generations",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        transaction.execute(
            "INSERT INTO index_generations (id, parent_id, state, reason, created_at, structural_fingerprint, ignore_fingerprint) VALUES (?1, ?2, 'staging', ?3, ?4, ?5, ?6)",
            params![generation_id, parent_id, input.reason, input.created_at, input.structural_fingerprint, input.ignore_fingerprint],
        )?;
        insert_generation_records(&transaction, generation_id, input)?;
        let committed_at = timestamp_token();
        let file_count = count_i64(input.files.len())?;
        let node_count = count_i64(input.nodes.len())?;
        let edge_count = count_i64(input.edges.len())?;
        let unresolved_count = count_i64(input.unresolved.len())?;
        let diagnostic_count = count_i64(input.diagnostics.len())?;
        transaction.execute(
            "UPDATE index_generations SET state = 'committed', committed_at = ?2, file_count = ?3, node_count = ?4, edge_count = ?5, unresolved_count = ?6, diagnostic_count = ?7 WHERE id = ?1 AND state = 'staging'",
            params![generation_id, committed_at, file_count, node_count, edge_count, unresolved_count, diagnostic_count],
        )?;
        transaction.execute(
            "UPDATE index_metadata SET active_generation = ?1, ignore_fingerprint = ?2, engine_version = ?3, updated_at = ?4 WHERE singleton = 1",
            params![generation_id, input.ignore_fingerprint, self.engine_version, committed_at],
        )?;
        transaction.execute(
            "UPDATE index_health SET integrity_status = 'ready', interrupted_generation = NULL, last_successful_refresh_at = ?1, repair_reason_code = NULL, updated_at = ?1 WHERE singleton = 1",
            [&committed_at],
        )?;
        transaction.execute(
            "UPDATE index_generations SET parent_id = NULL WHERE state = 'committed' AND id != ?1",
            [generation_id],
        )?;
        transaction.execute(
            "DELETE FROM index_generations WHERE state = 'committed' AND id NOT IN (SELECT id FROM index_generations WHERE state = 'committed' ORDER BY id DESC LIMIT 2)",
            [],
        )?;
        transaction.commit()?;
        let (busy, log_frames, checkpointed_frames) =
            self.connection
                .query_row("PRAGMA wal_checkpoint(FULL)", [], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })?;
        if busy != 0 || log_frames != checkpointed_frames {
            bail!("source_index_checkpoint_incomplete");
        }
        Ok(GenerationSummary {
            id: generation_id,
            parent_id,
            reason: input.reason.clone(),
            created_at: input.created_at.clone(),
            committed_at,
            file_count,
            node_count,
            edge_count,
            unresolved_count,
            diagnostic_count,
            structural_fingerprint: input.structural_fingerprint.clone(),
            ignore_fingerprint: input.ignore_fingerprint.clone(),
        })
    }

    pub fn generation_summaries(&self, limit: usize) -> Result<Vec<GenerationSummary>> {
        if !(1..=100).contains(&limit) {
            bail!("source_index_query_limit_invalid");
        }
        let mut statement = self.connection.prepare(
            "SELECT id, parent_id, reason, created_at, committed_at, file_count, node_count, edge_count, unresolved_count, diagnostic_count, structural_fingerprint, ignore_fingerprint FROM index_generations WHERE state = 'committed' ORDER BY id DESC LIMIT ?1",
        )?;
        let summaries = statement
            .query_map([count_i64(limit)?], row_to_summary)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("source_index_generation_summary_failed")?;
        Ok(summaries)
    }

    pub fn load_active_generation(&self) -> Result<Option<StoredGeneration>> {
        self.active_generation()
            .map(|generation_id| self.load_generation(generation_id))
            .transpose()
    }

    pub fn load_active_generation_metadata(&self) -> Result<Option<ActiveGenerationMetadata>> {
        self.active_generation()
            .map(|generation_id| {
                let summary = load_generation_summary(&self.connection, generation_id)?;
                let files = load_generation_files(&self.connection, generation_id)?;
                let coverage = load_generation_coverage(&self.connection, generation_id)?;
                Ok(ActiveGenerationMetadata {
                    summary,
                    files,
                    coverage,
                })
            })
            .transpose()
    }

    pub fn load_generation(&self, generation_id: i64) -> Result<StoredGeneration> {
        let summary = load_generation_summary(&self.connection, generation_id)?;
        let input = load_generation_records(&self.connection, &summary)?;
        Ok(StoredGeneration { summary, input })
    }

    pub fn plan_refresh(
        &self,
        current_files: &[DiscoveredFile],
        ignore_fingerprint: Option<&str>,
        bounds: &RefreshBounds,
    ) -> Result<RefreshPlan> {
        validate_refresh_bounds(bounds)?;
        if let Some(fingerprint) = ignore_fingerprint {
            validate_hash(fingerprint)?;
        }
        let mut current = BTreeMap::new();
        for file in current_files {
            validate_locator(&file.locator)?;
            validate_hash(&file.content_hash)?;
            if file.byte_size < 0 || current.insert(file.locator.clone(), file).is_some() {
                bail!("source_index_refresh_discovery_invalid");
            }
        }
        let Some(active) = self.load_active_generation_metadata()? else {
            let added_files = current.keys().cloned().collect::<Vec<_>>();
            return Ok(RefreshPlan {
                invalidated_files: added_files.clone(),
                added_files,
                changed_files: Vec::new(),
                deleted_files: Vec::new(),
                renamed_files: Vec::new(),
                unchanged_file_count: 0,
                ignore_rules_changed: ignore_fingerprint.is_some(),
                truncated: false,
                no_change: false,
                reason_codes: vec!["source_index_initial_build".to_string()],
            });
        };
        let previous = active
            .files
            .iter()
            .map(|file| (file.locator.clone(), file))
            .collect::<BTreeMap<_, _>>();
        let mut added = current
            .keys()
            .filter(|locator| !previous.contains_key(*locator))
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut deleted = previous
            .keys()
            .filter(|locator| !current.contains_key(*locator))
            .cloned()
            .collect::<BTreeSet<_>>();
        let changed = current
            .iter()
            .filter(|(locator, file)| {
                previous.get(*locator).is_some_and(|old| {
                    old.content_hash != file.content_hash || old.byte_size != file.byte_size
                })
            })
            .map(|(locator, _)| locator.clone())
            .collect::<BTreeSet<_>>();
        let unchanged_file_count = current
            .iter()
            .filter(|(locator, file)| {
                previous.get(*locator).is_some_and(|old| {
                    old.content_hash == file.content_hash && old.byte_size == file.byte_size
                })
            })
            .count();
        let renamed_files = detect_renames(&previous, &current, &added, &deleted);
        for rename in &renamed_files {
            added.remove(&rename.to_locator);
            deleted.remove(&rename.from_locator);
        }
        let ignore_rules_changed =
            active.summary.ignore_fingerprint.as_deref() != ignore_fingerprint;
        let no_change = added.is_empty()
            && deleted.is_empty()
            && changed.is_empty()
            && renamed_files.is_empty()
            && !ignore_rules_changed;
        if no_change {
            return Ok(RefreshPlan {
                added_files: Vec::new(),
                changed_files: Vec::new(),
                deleted_files: Vec::new(),
                renamed_files: Vec::new(),
                invalidated_files: Vec::new(),
                unchanged_file_count,
                ignore_rules_changed: false,
                truncated: false,
                no_change: true,
                reason_codes: vec!["source_index_no_change".to_string()],
            });
        }
        let mut seed_files = changed.clone();
        seed_files.extend(deleted.iter().cloned());
        seed_files.extend(
            renamed_files
                .iter()
                .map(|rename| rename.from_locator.clone()),
        );
        let (mut invalidated, mut truncated) = if ignore_rules_changed {
            (current.keys().cloned().collect::<BTreeSet<_>>(), false)
        } else {
            let active = self.load_generation(active.summary.id)?;
            invalidation_closure(&active.input, &seed_files, bounds)
        };
        invalidated.extend(added.iter().cloned());
        invalidated.extend(renamed_files.iter().map(|rename| rename.to_locator.clone()));
        invalidated.retain(|locator| current.contains_key(locator));
        if invalidated.len() > bounds.max_invalidated_files {
            invalidated = invalidated
                .into_iter()
                .take(bounds.max_invalidated_files)
                .collect();
            truncated = true;
        }
        let mut reason_codes = Vec::new();
        for (present, code) in [
            (!changed.is_empty(), "source_index_content_changed"),
            (!added.is_empty(), "source_index_files_added"),
            (!deleted.is_empty(), "source_index_files_deleted"),
            (!renamed_files.is_empty(), "source_index_files_renamed"),
            (ignore_rules_changed, "source_index_ignore_rules_changed"),
            (truncated, "source_index_invalidation_truncated"),
        ] {
            if present {
                reason_codes.push(code.to_string());
            }
        }
        Ok(RefreshPlan {
            added_files: added.into_iter().collect(),
            changed_files: changed.into_iter().collect(),
            deleted_files: deleted.into_iter().collect(),
            renamed_files,
            invalidated_files: invalidated.into_iter().collect(),
            unchanged_file_count,
            ignore_rules_changed,
            truncated,
            no_change: false,
            reason_codes,
        })
    }

    pub fn commit_incremental(
        &mut self,
        plan: &RefreshPlan,
        replacement: &GenerationInput,
    ) -> Result<RefreshCommit> {
        if plan.no_change {
            let summary = self
                .generation_summaries(1)?
                .into_iter()
                .next()
                .context("source_index_active_generation_missing")?;
            return Ok(RefreshCommit {
                summary,
                wrote: false,
                invalidated_file_count: 0,
            });
        }
        if plan.truncated {
            bail!("source_index_refresh_plan_truncated");
        }
        let replacement_files = replacement
            .files
            .iter()
            .map(|file| file.locator.as_str())
            .collect::<BTreeSet<_>>();
        if plan
            .invalidated_files
            .iter()
            .any(|locator| !replacement_files.contains(locator.as_str()))
        {
            bail!("source_index_refresh_replacement_incomplete");
        }
        let active = self
            .load_active_generation()?
            .context("source_index_active_generation_missing")?;
        let merged = merge_incremental_generation(&active.input, replacement, plan)?;
        let summary = self.commit_generation(&merged)?;
        Ok(RefreshCommit {
            summary,
            wrote: true,
            invalidated_file_count: plan.invalidated_files.len(),
        })
    }

    pub fn find_nodes(&self, query: &str, bounds: &QueryBounds) -> Result<QueryPage<NodeRecord>> {
        validate_query_bounds(bounds)?;
        validate_query_text(query)?;
        let started = Instant::now();
        let Some(generation_id) = self.active_generation() else {
            return Ok(QueryPage {
                items: Vec::new(),
                next_cursor: None,
            });
        };
        let cursor = bounds.cursor.as_deref().unwrap_or("");
        let terms = search_terms(query);
        let query_with = |connector: &str| -> Result<Vec<NodeRecord>> {
            let predicates = terms
                .iter()
                .enumerate()
                .map(|(index, _)| {
                    let parameter = index + 3;
                    format!("(lower(qualified_name) LIKE ?{parameter} ESCAPE '\\' OR lower(locator) LIKE ?{parameter} ESCAPE '\\')")
                })
                .collect::<Vec<_>>()
                .join(connector);
            let limit_parameter = terms.len() + 3;
            let sql = format!(
                "SELECT canonical_id, kind, language_kind, qualified_name, locator, start_line, end_line, content_hash, visibility FROM index_nodes WHERE generation_id = ?1 AND canonical_id > ?2 AND {predicates} ORDER BY canonical_id LIMIT ?{limit_parameter}"
            );
            let mut parameters = Vec::with_capacity(terms.len() + 3);
            parameters.push(SqlValue::Integer(generation_id));
            parameters.push(SqlValue::Text(cursor.to_string()));
            parameters.extend(
                terms
                    .iter()
                    .map(|term| SqlValue::Text(format!("%{}%", escape_like(term)))),
            );
            parameters.push(SqlValue::Integer(count_i64(bounds.limit + 1)?));
            let mut statement = self.connection.prepare(&sql)?;
            let items = statement
                .query_map(params_from_iter(parameters.iter()), row_to_node)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(items)
        };
        let mut items = query_with(" AND ")?;
        if items.is_empty() && terms.len() > 1 {
            items = query_with(" OR ")?;
        }
        ensure_deadline(started, bounds)?;
        bounded_page(items, bounds)
    }

    pub fn find_exact_nodes(
        &self,
        query: &str,
        bounds: &QueryBounds,
    ) -> Result<QueryPage<NodeRecord>> {
        validate_query_bounds(bounds)?;
        validate_query_text(query)?;
        let started = Instant::now();
        let Some(generation_id) = self.active_generation() else {
            return Ok(QueryPage {
                items: Vec::new(),
                next_cursor: None,
            });
        };
        let cursor = bounds.cursor.as_deref().unwrap_or("");
        let mut statement = self.connection.prepare(
            "SELECT canonical_id, kind, language_kind, qualified_name, locator, start_line, end_line, content_hash, visibility FROM index_nodes WHERE generation_id = ?1 AND canonical_id > ?2 AND (canonical_id = ?3 OR qualified_name = ?3 OR locator = ?3 OR (length(qualified_name) > length(?3) + 2 AND substr(qualified_name, -(length(?3) + 2)) = '::' || ?3)) ORDER BY canonical_id LIMIT ?4",
        )?;
        let items = statement
            .query_map(
                params![generation_id, cursor, query, count_i64(bounds.limit + 1)?],
                row_to_node,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure_deadline(started, bounds)?;
        bounded_page(items, bounds)
    }

    pub fn dependency_edges(
        &self,
        node_id: &str,
        direction: EdgeDirection,
        bounds: &QueryBounds,
    ) -> Result<QueryPage<EdgeRecord>> {
        self.dependency_edges_with_kinds(node_id, direction, bounds, None)
    }

    fn dependency_edges_with_kinds(
        &self,
        node_id: &str,
        direction: EdgeDirection,
        bounds: &QueryBounds,
        edge_kinds: Option<&BTreeSet<String>>,
    ) -> Result<QueryPage<EdgeRecord>> {
        validate_query_bounds(bounds)?;
        validate_identifier(node_id)?;
        let started = Instant::now();
        let Some(generation_id) = self.active_generation() else {
            return Ok(QueryPage {
                items: Vec::new(),
                next_cursor: None,
            });
        };
        let predicate = match direction {
            EdgeDirection::Incoming => "target_id = ?2",
            EdgeDirection::Outgoing => "source_id = ?2",
            EdgeDirection::Both => "(source_id = ?2 OR target_id = ?2)",
        };
        let edge_kind_predicate = edge_kinds.map_or_else(String::new, |kinds| {
            let parameters = (0..kinds.len())
                .map(|index| format!("?{}", index + 4))
                .collect::<Vec<_>>()
                .join(", ");
            format!(" AND kind IN ({parameters})")
        });
        let limit_parameter = edge_kinds.map_or(4, |kinds| kinds.len() + 4);
        let sql = format!(
            "SELECT canonical_id, source_id, target_id, kind, locator, start_line, end_line, resolver, resolver_version, confidence, resolution_class, stale FROM index_edges WHERE generation_id = ?1 AND {predicate} AND canonical_id > ?3{edge_kind_predicate} ORDER BY canonical_id LIMIT ?{limit_parameter}"
        );
        let mut parameters = vec![
            SqlValue::Integer(generation_id),
            SqlValue::Text(node_id.to_string()),
            SqlValue::Text(bounds.cursor.clone().unwrap_or_default()),
        ];
        if let Some(kinds) = edge_kinds {
            parameters.extend(kinds.iter().cloned().map(SqlValue::Text));
        }
        parameters.push(SqlValue::Integer(count_i64(bounds.limit + 1)?));
        let mut statement = self.connection.prepare(&sql)?;
        let items = statement
            .query_map(params_from_iter(parameters.iter()), row_to_edge)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure_deadline(started, bounds)?;
        bounded_page(items, bounds)
    }

    pub fn impact_edges(
        &self,
        node_id: &str,
        bounds: &QueryBounds,
    ) -> Result<QueryPage<EdgeRecord>> {
        self.dependency_edges(node_id, EdgeDirection::Incoming, bounds)
    }

    pub fn node(&self, node_id: &str) -> Result<Option<NodeRecord>> {
        validate_identifier(node_id)?;
        let Some(generation_id) = self.active_generation() else {
            return Ok(None);
        };
        self.node_by_id(generation_id, node_id)
    }

    pub fn edge(&self, edge_id: &str) -> Result<Option<EdgeRecord>> {
        validate_identifier(edge_id)?;
        let Some(generation_id) = self.active_generation() else {
            return Ok(None);
        };
        self.connection
            .query_row(
                "SELECT canonical_id, source_id, target_id, kind, locator, start_line, end_line, resolver, resolver_version, confidence, resolution_class, stale FROM index_edges WHERE generation_id = ?1 AND canonical_id = ?2",
                params![generation_id, edge_id],
                row_to_edge,
            )
            .optional()
            .context("source_index_edge_query_failed")
    }

    pub fn nodes_by_kind(&self, kind: &str, bounds: &QueryBounds) -> Result<QueryPage<NodeRecord>> {
        validate_query_bounds(bounds)?;
        validate_token(kind, "source_index_node_kind_invalid")?;
        let started = Instant::now();
        let Some(generation_id) = self.active_generation() else {
            return Ok(QueryPage {
                items: Vec::new(),
                next_cursor: None,
            });
        };
        let cursor = bounds.cursor.as_deref().unwrap_or("");
        let mut statement = self.connection.prepare(
            "SELECT canonical_id, kind, language_kind, qualified_name, locator, start_line, end_line, content_hash, visibility FROM index_nodes WHERE generation_id = ?1 AND kind = ?2 AND canonical_id > ?3 ORDER BY canonical_id LIMIT ?4",
        )?;
        let items = statement
            .query_map(
                params![generation_id, kind, cursor, count_i64(bounds.limit + 1)?],
                row_to_node,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure_deadline(started, bounds)?;
        bounded_page(items, bounds)
    }

    pub fn neighborhood(&self, node_id: &str, bounds: &QueryBounds) -> Result<GraphNeighborhood> {
        self.dependency_neighborhood(node_id, EdgeDirection::Both, bounds)
    }

    pub fn dependency_neighborhood(
        &self,
        node_id: &str,
        direction: EdgeDirection,
        bounds: &QueryBounds,
    ) -> Result<GraphNeighborhood> {
        self.dependency_neighborhood_inner(node_id, direction, bounds, None)
    }

    pub fn dependency_neighborhood_with_kinds(
        &self,
        node_id: &str,
        direction: EdgeDirection,
        bounds: &QueryBounds,
        edge_kinds: &BTreeSet<String>,
    ) -> Result<GraphNeighborhood> {
        self.dependency_neighborhood_inner(node_id, direction, bounds, Some(edge_kinds))
    }

    fn dependency_neighborhood_inner(
        &self,
        node_id: &str,
        direction: EdgeDirection,
        bounds: &QueryBounds,
        edge_kinds: Option<&BTreeSet<String>>,
    ) -> Result<GraphNeighborhood> {
        validate_query_bounds(bounds)?;
        validate_identifier(node_id)?;
        let Some(generation_id) = self.active_generation() else {
            return Ok(GraphNeighborhood {
                nodes: Vec::new(),
                edges: Vec::new(),
                truncated: false,
            });
        };
        let started = Instant::now();
        let mut nodes = BTreeMap::new();
        let Some(seed) = self.node_by_id(generation_id, node_id)? else {
            return Ok(GraphNeighborhood {
                nodes: Vec::new(),
                edges: Vec::new(),
                truncated: false,
            });
        };
        nodes.insert(seed.canonical_id.clone(), seed);
        let mut edges = BTreeMap::new();
        let mut frontier = vec![node_id.to_string()];
        let mut truncated = false;
        for _ in 0..bounds.max_depth {
            let mut next = BTreeSet::new();
            for current in frontier {
                ensure_deadline(started, bounds)?;
                let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
                let mut edge_bounds = bounds.clone();
                edge_bounds.limit = bounds.limit;
                edge_bounds.cursor = None;
                edge_bounds.timeout_ms = bounds.timeout_ms.saturating_sub(elapsed_ms).max(1);
                let page = self.dependency_edges_with_kinds(
                    &current,
                    direction,
                    &edge_bounds,
                    edge_kinds,
                )?;
                ensure_deadline(started, bounds)?;
                truncated |= page.next_cursor.is_some();
                for edge in page.items {
                    if edges.len() >= bounds.limit {
                        truncated = true;
                        break;
                    }
                    let other = match direction {
                        EdgeDirection::Incoming => edge.source_id.clone(),
                        EdgeDirection::Outgoing => edge.target_id.clone(),
                        EdgeDirection::Both if edge.source_id == current => edge.target_id.clone(),
                        EdgeDirection::Both => edge.source_id.clone(),
                    };
                    if !nodes.contains_key(&other) {
                        if nodes.len() >= bounds.limit {
                            truncated = true;
                            continue;
                        }
                        if let Some(node) = self.node_by_id(generation_id, &other)? {
                            nodes.insert(other.clone(), node);
                            next.insert(other);
                        }
                    }
                    edges.entry(edge.canonical_id.clone()).or_insert(edge);
                }
            }
            if next.is_empty() {
                break;
            }
            frontier = next.into_iter().collect();
        }
        let result = GraphNeighborhood {
            nodes: nodes.into_values().collect(),
            edges: edges.into_values().collect(),
            truncated,
        };
        ensure_deadline(started, bounds)?;
        enforce_output_bound(&result, bounds)?;
        Ok(result)
    }

    pub fn trace_routes(
        &self,
        from_node_id: &str,
        to_node_id: &str,
        bounds: &QueryBounds,
    ) -> Result<GraphRoutes> {
        validate_query_bounds(bounds)?;
        validate_identifier(from_node_id)?;
        validate_identifier(to_node_id)?;
        let started = Instant::now();
        let mut queue = VecDeque::from([GraphRoute {
            node_ids: vec![from_node_id.to_string()],
            edge_ids: Vec::new(),
        }]);
        let max_queue = bounds.limit.saturating_mul(bounds.max_depth.max(1));
        let mut routes = Vec::new();
        let mut truncated = false;
        'search: while let Some(route) = queue.pop_front() {
            ensure_deadline(started, bounds)?;
            if route.edge_ids.len() >= bounds.max_depth {
                continue;
            }
            let current = route
                .node_ids
                .last()
                .context("source_index_route_invalid")?;
            let mut edge_bounds = bounds.clone();
            edge_bounds.limit = 100;
            edge_bounds.cursor = None;
            let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
            edge_bounds.timeout_ms = bounds.timeout_ms.saturating_sub(elapsed_ms).max(1);
            let page = self.dependency_edges(current, EdgeDirection::Outgoing, &edge_bounds)?;
            ensure_deadline(started, bounds)?;
            truncated |= page.next_cursor.is_some();
            for edge in page.items {
                if route.node_ids.contains(&edge.target_id) {
                    continue;
                }
                let mut candidate = route.clone();
                candidate.node_ids.push(edge.target_id.clone());
                candidate.edge_ids.push(edge.canonical_id);
                if edge.target_id == to_node_id {
                    routes.push(candidate);
                    if routes.len() > bounds.limit {
                        truncated = true;
                        break 'search;
                    }
                } else if queue.len() < max_queue {
                    queue.push_back(candidate);
                } else {
                    truncated = true;
                }
            }
        }
        routes.sort_by(|left, right| {
            left.edge_ids
                .len()
                .cmp(&right.edge_ids.len())
                .then_with(|| left.edge_ids.cmp(&right.edge_ids))
        });
        routes.truncate(bounds.limit);
        let result = GraphRoutes {
            items: routes,
            truncated,
        };
        ensure_deadline(started, bounds)?;
        enforce_output_bound(&result, bounds)?;
        Ok(result)
    }

    /// Returns a bounded induced graph slice grouped by deterministic label propagation.
    /// Topology forms communities; paths only supply deterministic display labels.
    pub fn communities(
        &self,
        bounds: &QueryBounds,
    ) -> Result<GraphProjection<CommunityProjection>> {
        validate_query_bounds(bounds)?;
        let started = Instant::now();
        let Some(generation_id) = self.active_generation() else {
            return Ok(GraphProjection {
                items: Vec::new(),
                nodes: Vec::new(),
                edges: Vec::new(),
                truncated: false,
                next_cursor: None,
            });
        };
        let projection_offset = projection_offset(bounds.cursor.as_ref(), 1, generation_id)?;
        let mut statement = self.connection.prepare(
            "SELECT canonical_id, kind, language_kind, qualified_name, locator, start_line, end_line, content_hash, visibility FROM index_nodes WHERE generation_id = ?1 ORDER BY ordinal LIMIT ?2",
        )?;
        let mut scan_nodes = statement
            .query_map(
                params![
                    generation_id,
                    count_i64(COMMUNITY_SCAN_NODE_LIMIT.saturating_add(1))?
                ],
                row_to_node,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure_deadline(started, bounds)?;
        let mut scan_truncated = scan_nodes.len() > COMMUNITY_SCAN_NODE_LIMIT;
        scan_nodes.truncate(COMMUNITY_SCAN_NODE_LIMIT);
        if scan_nodes.is_empty() {
            return Ok(GraphProjection {
                items: Vec::new(),
                nodes: Vec::new(),
                edges: Vec::new(),
                truncated: scan_truncated,
                next_cursor: None,
            });
        }

        let node_ids = scan_nodes
            .iter()
            .map(|node| node.canonical_id.clone())
            .collect::<BTreeSet<_>>();
        let mut edge_statement = self.connection.prepare(
            "WITH bounded_nodes AS (SELECT canonical_id FROM index_nodes WHERE generation_id = ?1 ORDER BY ordinal LIMIT ?2) SELECT canonical_id, source_id, target_id, kind, locator, start_line, end_line, resolver, resolver_version, confidence, resolution_class, stale FROM index_edges WHERE generation_id = ?1 AND source_id IN (SELECT canonical_id FROM bounded_nodes) AND target_id IN (SELECT canonical_id FROM bounded_nodes) ORDER BY ordinal LIMIT ?3",
        )?;
        let mut scan_edges = edge_statement
            .query_map(
                params![
                    generation_id,
                    count_i64(COMMUNITY_SCAN_NODE_LIMIT)?,
                    count_i64(COMMUNITY_SCAN_EDGE_LIMIT.saturating_add(1))?
                ],
                row_to_edge,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure_deadline(started, bounds)?;
        scan_truncated |= scan_edges.len() > COMMUNITY_SCAN_EDGE_LIMIT;
        scan_edges.truncate(COMMUNITY_SCAN_EDGE_LIMIT);

        let mut labels = scan_nodes
            .iter()
            .map(|node| (node.canonical_id.clone(), node.canonical_id.clone()))
            .collect::<BTreeMap<_, _>>();
        let mut neighbors = node_ids
            .iter()
            .map(|id| (id.clone(), BTreeSet::new()))
            .collect::<BTreeMap<_, _>>();
        for edge in &scan_edges {
            neighbors
                .entry(edge.source_id.clone())
                .or_default()
                .insert(edge.target_id.clone());
            neighbors
                .entry(edge.target_id.clone())
                .or_default()
                .insert(edge.source_id.clone());
        }
        for _ in 0..COMMUNITY_MAX_PASSES {
            ensure_deadline(started, bounds)?;
            let mut changed = false;
            for node_id in &node_ids {
                let adjacent = neighbors.get(node_id).into_iter().flatten();
                let mut votes = BTreeMap::<String, usize>::new();
                for neighbor in adjacent {
                    if let Some(label) = labels.get(neighbor) {
                        *votes.entry(label.clone()).or_default() += 1;
                    }
                }
                let next = votes
                    .into_iter()
                    .max_by(|left, right| left.1.cmp(&right.1).then_with(|| right.0.cmp(&left.0)))
                    .map(|(label, _)| label)
                    .unwrap_or_else(|| labels[node_id].clone());
                if next != labels[node_id] {
                    labels.insert(node_id.clone(), next);
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }

        let mut grouped = BTreeMap::<String, Vec<String>>::new();
        for (node_id, label) in &labels {
            grouped
                .entry(label.clone())
                .or_default()
                .push(node_id.clone());
        }
        let nodes_by_id = scan_nodes
            .into_iter()
            .map(|node| (node.canonical_id.clone(), node))
            .collect::<BTreeMap<_, _>>();
        let mut communities = grouped
            .into_values()
            .map(|mut members| {
                members.sort();
                let mut path_counts = BTreeMap::<String, usize>::new();
                for node_id in &members {
                    if let Some(node) = nodes_by_id.get(node_id) {
                        *path_counts
                            .entry(community_path(&node.locator))
                            .or_default() += 1;
                    }
                }
                let path = path_counts
                    .into_iter()
                    .max_by(|left, right| left.1.cmp(&right.1).then_with(|| right.0.cmp(&left.0)))
                    .map(|(path, _)| path)
                    .unwrap_or_else(|| "workspace://unknown".to_string());
                (members, path)
            })
            .collect::<Vec<_>>();
        communities.sort_by(|left, right| {
            right
                .0
                .len()
                .cmp(&left.0.len())
                .then_with(|| left.0.cmp(&right.0))
        });
        if projection_offset > communities.len() {
            bail!("source_index_projection_cursor_stale");
        }
        let omitted_communities =
            projection_offset.saturating_add(bounds.limit) < communities.len();
        let next_cursor = omitted_communities
            .then(|| projection_cursor(1, generation_id, projection_offset + bounds.limit));
        communities = communities
            .into_iter()
            .skip(projection_offset)
            .take(bounds.limit)
            .collect();
        let community_count = communities.len().max(1);
        let per_community_node_cap = (100 / community_count).max(1);
        let mut items = Vec::new();
        let mut evidence_nodes = BTreeMap::<String, NodeRecord>::new();
        let mut evidence_edges = BTreeMap::<String, EdgeRecord>::new();
        for (mut community_nodes, path_prefix) in communities {
            community_nodes.sort();
            let community_set = community_nodes.iter().collect::<BTreeSet<_>>();
            let represented_relationship_count = scan_edges
                .iter()
                .filter(|edge| {
                    community_set.contains(&edge.source_id)
                        && community_set.contains(&edge.target_id)
                })
                .count();
            let mut internal_degrees = BTreeMap::<String, usize>::new();
            for edge in &scan_edges {
                if community_set.contains(&edge.source_id)
                    && community_set.contains(&edge.target_id)
                {
                    *internal_degrees.entry(edge.source_id.clone()).or_default() += 1;
                    *internal_degrees.entry(edge.target_id.clone()).or_default() += 1;
                }
            }
            let mut evidence_candidates = community_nodes.clone();
            evidence_candidates.sort_by(|left, right| {
                internal_degrees
                    .get(right)
                    .copied()
                    .unwrap_or(0)
                    .cmp(&internal_degrees.get(left).copied().unwrap_or(0))
                    .then_with(|| left.cmp(right))
            });
            let remaining_nodes = 100usize.saturating_sub(evidence_nodes.len());
            let node_ids = evidence_candidates
                .iter()
                .take(per_community_node_cap.min(remaining_nodes))
                .cloned()
                .collect::<Vec<_>>();
            let selected_nodes = node_ids.iter().collect::<BTreeSet<_>>();
            for node_id in &node_ids {
                if let Some(node) = nodes_by_id.get(node_id) {
                    evidence_nodes.insert(node_id.clone(), node.clone());
                }
            }
            let remaining_edges = 100usize.saturating_sub(evidence_edges.len());
            let relationship_ids = scan_edges
                .iter()
                .filter(|edge| {
                    selected_nodes.contains(&edge.source_id)
                        && selected_nodes.contains(&edge.target_id)
                })
                .take(remaining_edges)
                .map(|edge| {
                    evidence_edges.insert(edge.canonical_id.clone(), edge.clone());
                    edge.canonical_id.clone()
                })
                .collect::<Vec<_>>();
            let item_truncated = scan_truncated
                || omitted_communities
                || node_ids.len() < community_nodes.len()
                || relationship_ids.len() < represented_relationship_count;
            let id_parts = community_nodes
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>();
            items.push(CommunityProjection {
                id: projection_id("cicommunity_", COMMUNITY_ALGORITHM_VERSION, &id_parts),
                label: path_prefix.trim_start_matches("workspace://").to_string(),
                path_prefix,
                represented_node_count: community_nodes.len(),
                represented_relationship_count,
                node_ids,
                relationship_ids,
                generation: generation_id,
                algorithm_version: COMMUNITY_ALGORITHM_VERSION.to_string(),
                truncated: item_truncated,
            });
        }
        let truncated =
            scan_truncated || omitted_communities || items.iter().any(|item| item.truncated);
        let result = GraphProjection {
            items,
            nodes: evidence_nodes.into_values().collect(),
            edges: evidence_edges.into_values().collect(),
            truncated,
            next_cursor,
        };
        enforce_output_bound(&result, bounds)?;
        Ok(result)
    }

    /// Returns source-backed, bounded paths beginning at explicit entry-evidence edges.
    pub fn processes(&self, bounds: &QueryBounds) -> Result<GraphProjection<ProcessProjection>> {
        validate_query_bounds(bounds)?;
        if bounds.max_depth == 0 {
            bail!("source_index_process_bounds_invalid");
        }
        let started = Instant::now();
        let Some(generation_id) = self.active_generation() else {
            return Ok(GraphProjection {
                items: Vec::new(),
                nodes: Vec::new(),
                edges: Vec::new(),
                truncated: false,
                next_cursor: None,
            });
        };
        let projection_offset = projection_offset(bounds.cursor.as_ref(), 2, generation_id)?;
        let mut statement = self.connection.prepare(
            "SELECT canonical_id, source_id, target_id, kind, locator, start_line, end_line, resolver, resolver_version, confidence, resolution_class, stale FROM index_edges WHERE generation_id = ?1 AND kind IN ('entry_point', 'handles_route') AND stale = 0 AND confidence >= ?2 AND resolution_class != 'unresolved' ORDER BY canonical_id LIMIT ?3 OFFSET ?4",
        )?;
        let mut entry_edges = statement
            .query_map(
                params![
                    generation_id,
                    PROCESS_MIN_CONFIDENCE,
                    count_i64(bounds.limit.saturating_add(1))?,
                    count_i64(projection_offset)?
                ],
                row_to_edge,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure_deadline(started, bounds)?;
        if projection_offset > 0 && entry_edges.is_empty() {
            bail!("source_index_projection_cursor_stale");
        }
        let mut globally_truncated = entry_edges.len() > bounds.limit;
        entry_edges.truncate(bounds.limit);
        let next_cursor = globally_truncated
            .then(|| projection_cursor(2, generation_id, projection_offset + bounds.limit));

        let mut items = Vec::new();
        let mut evidence_nodes = BTreeMap::<String, NodeRecord>::new();
        let mut evidence_edges = BTreeMap::<String, EdgeRecord>::new();
        for entry in entry_edges {
            ensure_deadline(started, bounds)?;
            let Some(candidate) = self.find_process_path(generation_id, &entry, bounds, started)?
            else {
                globally_truncated = true;
                continue;
            };
            let mut evidence_node_ids = vec![entry.source_id.clone(), entry.target_id.clone()];
            for node_id in candidate.node_ids.iter().skip(1) {
                if !evidence_node_ids.contains(node_id) {
                    evidence_node_ids.push(node_id.clone());
                }
            }
            let mut path_edges = vec![entry.clone()];
            path_edges.extend(candidate.edges.iter().cloned());
            let mut path_nodes = Vec::new();
            let mut missing_evidence = false;
            for node_id in &evidence_node_ids {
                if let Some(node) = self.node_by_id(generation_id, node_id)? {
                    path_nodes.push(node);
                } else {
                    missing_evidence = true;
                    break;
                }
            }
            if missing_evidence {
                globally_truncated = true;
                continue;
            }
            let new_nodes = path_nodes
                .iter()
                .filter(|node| !evidence_nodes.contains_key(&node.canonical_id))
                .count();
            let new_edges = path_edges
                .iter()
                .filter(|edge| !evidence_edges.contains_key(&edge.canonical_id))
                .count();
            if evidence_nodes.len().saturating_add(new_nodes) > 100
                || evidence_edges.len().saturating_add(new_edges) > 100
                || items.len() >= bounds.limit
            {
                globally_truncated = true;
                break;
            }
            for node in path_nodes {
                evidence_nodes.insert(node.canonical_id.clone(), node);
            }
            for edge in &path_edges {
                evidence_edges.insert(edge.canonical_id.clone(), edge.clone());
            }
            let sink_id = if candidate.edges.is_empty() {
                &entry.target_id
            } else {
                candidate
                    .node_ids
                    .last()
                    .context("source_index_process_invalid")?
            };
            let sink = evidence_nodes
                .get(sink_id)
                .context("source_index_process_evidence_missing")?;
            let entry_node = evidence_nodes
                .get(&entry.source_id)
                .context("source_index_process_evidence_missing")?;
            let relationship_ids = path_edges
                .iter()
                .map(|edge| edge.canonical_id.clone())
                .collect::<Vec<_>>();
            let confidence = path_edges
                .iter()
                .map(|edge| edge.confidence)
                .fold(1.0_f64, f64::min);
            let process_node_ids = if candidate.edges.is_empty() {
                vec![entry.source_id.clone(), entry.target_id.clone()]
            } else {
                candidate.node_ids
            };
            let id_parts = relationship_ids
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>();
            items.push(ProcessProjection {
                id: projection_id("ciprocess_", PROCESS_ALGORITHM_VERSION, &id_parts),
                label: format!("{} to {}", concise_name(entry_node), concise_name(sink)),
                entry_node_id: entry.source_id.clone(),
                entry_relationship_id: entry.canonical_id.clone(),
                sink_node_id: sink.canonical_id.clone(),
                sink_kind: process_sink_kind(sink, candidate.edges.last()),
                node_ids: process_node_ids,
                relationship_ids,
                confidence,
                generation: generation_id,
                algorithm_version: PROCESS_ALGORITHM_VERSION.to_string(),
                truncated: candidate.truncated,
            });
        }
        if globally_truncated {
            for item in &mut items {
                item.truncated = true;
            }
        }
        let result = GraphProjection {
            items,
            nodes: evidence_nodes.into_values().collect(),
            edges: evidence_edges.into_values().collect(),
            truncated: globally_truncated,
            next_cursor,
        };
        enforce_output_bound(&result, bounds)?;
        Ok(result)
    }

    fn find_process_path(
        &self,
        generation_id: i64,
        entry: &EdgeRecord,
        bounds: &QueryBounds,
        started: Instant,
    ) -> Result<Option<ProcessPath>> {
        if !PROCESS_ENTRY_KINDS.contains(&entry.kind.as_str()) {
            return Ok(None);
        }
        let mut queue = VecDeque::from([ProcessPath {
            node_ids: vec![entry.source_id.clone()],
            edges: Vec::new(),
            truncated: false,
        }]);
        let mut fallback = Some(queue[0].clone());
        let max_execution_depth = bounds.max_depth.saturating_sub(1);
        let max_queue = bounds.limit.saturating_mul(bounds.max_depth.max(1));
        while let Some(path) = queue.pop_front() {
            ensure_deadline(started, bounds)?;
            let current_id = path
                .node_ids
                .last()
                .context("source_index_process_invalid")?;
            let current = self.node_by_id(generation_id, current_id)?;
            if !path.edges.is_empty()
                && current
                    .as_ref()
                    .is_some_and(|node| is_process_sink(node, path.edges.last()))
            {
                return Ok(Some(path));
            }
            let outgoing = self
                .process_step_edges(generation_id, current_id, bounds.limit)?
                .into_iter()
                .filter(|edge| edge.canonical_id != entry.canonical_id)
                .collect::<Vec<_>>();
            let has_more = outgoing.len() > bounds.limit;
            let outgoing = outgoing.into_iter().take(bounds.limit).collect::<Vec<_>>();
            if outgoing.is_empty() {
                if !path.edges.is_empty() {
                    fallback = Some(path);
                }
                continue;
            }
            if path.edges.len() >= max_execution_depth {
                let mut bounded = path;
                bounded.truncated = true;
                return Ok(Some(bounded));
            }
            for edge in outgoing {
                if path.node_ids.contains(&edge.target_id) {
                    continue;
                }
                if queue.len() >= max_queue {
                    globally_mark_path(&mut fallback);
                    break;
                }
                let mut candidate = path.clone();
                candidate.node_ids.push(edge.target_id.clone());
                candidate.edges.push(edge);
                candidate.truncated |= has_more;
                fallback = Some(candidate.clone());
                queue.push_back(candidate);
            }
        }
        if fallback.as_ref().is_some_and(|path| !path.edges.is_empty()) {
            globally_mark_path(&mut fallback);
        }
        Ok(fallback)
    }

    fn process_step_edges(
        &self,
        generation_id: i64,
        source_id: &str,
        limit: usize,
    ) -> Result<Vec<EdgeRecord>> {
        let placeholders = (0..PROCESS_STEP_KINDS.len())
            .map(|index| format!("?{}", index + 4))
            .collect::<Vec<_>>()
            .join(",");
        let limit_parameter = PROCESS_STEP_KINDS.len() + 4;
        let sql = format!(
            "SELECT canonical_id, source_id, target_id, kind, locator, start_line, end_line, resolver, resolver_version, confidence, resolution_class, stale FROM index_edges WHERE generation_id = ?1 AND source_id = ?2 AND stale = 0 AND confidence >= ?3 AND resolution_class != 'unresolved' AND kind IN ({placeholders}) ORDER BY canonical_id LIMIT ?{limit_parameter}"
        );
        let mut parameters = Vec::with_capacity(PROCESS_STEP_KINDS.len() + 4);
        parameters.push(SqlValue::Integer(generation_id));
        parameters.push(SqlValue::Text(source_id.to_string()));
        parameters.push(SqlValue::Real(PROCESS_MIN_CONFIDENCE));
        parameters.extend(
            PROCESS_STEP_KINDS
                .iter()
                .map(|kind| SqlValue::Text((*kind).to_string())),
        );
        parameters.push(SqlValue::Integer(count_i64(limit.saturating_add(2))?));
        let mut statement = self.connection.prepare(&sql)?;
        let edges = statement
            .query_map(params_from_iter(parameters.iter()), row_to_edge)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("source_index_process_edges_failed")?;
        Ok(edges)
    }

    fn node_by_id(&self, generation_id: i64, node_id: &str) -> Result<Option<NodeRecord>> {
        self.connection
            .query_row(
                "SELECT canonical_id, kind, language_kind, qualified_name, locator, start_line, end_line, content_hash, visibility FROM index_nodes WHERE generation_id = ?1 AND canonical_id = ?2",
                params![generation_id, node_id],
                row_to_node,
            )
            .optional()
            .context("source_index_node_query_failed")
    }
}

#[derive(Debug, Clone)]
struct ProcessPath {
    node_ids: Vec<String>,
    edges: Vec<EdgeRecord>,
    truncated: bool,
}

fn globally_mark_path(path: &mut Option<ProcessPath>) {
    if let Some(path) = path {
        path.truncated = true;
    }
}

fn community_path(locator: &str) -> String {
    let relative = locator_file(locator).trim_start_matches("workspace://");
    let parts = relative.split('/').collect::<Vec<_>>();
    let depth = if parts.len() >= 2
        && matches!(
            parts[0],
            "apps" | "packages" | "services" | "providers" | "crates" | "modules"
        ) {
        2
    } else {
        1
    };
    format!("workspace://{}", parts[..depth.min(parts.len())].join("/"))
}

fn projection_id(prefix: &str, algorithm: &str, parts: &[&str]) -> String {
    let mut digest = Sha256::new();
    digest.update(algorithm.as_bytes());
    for part in parts {
        digest.update([0]);
        digest.update(part.as_bytes());
    }
    format!("{prefix}{}", &hex::encode(digest.finalize())[..32])
}

fn concise_name(node: &NodeRecord) -> String {
    node.qualified_name
        .rsplit("::")
        .next()
        .unwrap_or(&node.qualified_name)
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || "_.$:/#@ +()<>, -".contains(character) {
                character
            } else {
                '_'
            }
        })
        .take(72)
        .collect()
}

fn is_process_sink(node: &NodeRecord, incoming: Option<&EdgeRecord>) -> bool {
    matches!(
        node.kind.as_str(),
        "route" | "handler" | "storage" | "queue" | "event" | "sink"
    ) || incoming
        .is_some_and(|edge| matches!(edge.kind.as_str(), "reads" | "writes" | "emits" | "listens"))
}

fn process_sink_kind(node: &NodeRecord, incoming: Option<&EdgeRecord>) -> String {
    incoming
        .filter(|edge| matches!(edge.kind.as_str(), "reads" | "writes" | "emits" | "listens"))
        .map_or_else(|| node.kind.clone(), |edge| edge.kind.clone())
}

fn insert_generation_records(
    transaction: &rusqlite::Transaction<'_>,
    generation_id: i64,
    input: &GenerationInput,
) -> Result<()> {
    for (ordinal, record) in input.files.iter().enumerate() {
        transaction.execute(
            "INSERT INTO index_files (generation_id, ordinal, locator, content_hash, byte_size, language, parse_state, diagnostic_count, owner_identity) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![generation_id, count_i64(ordinal)?, record.locator, record.content_hash, record.byte_size, record.language, record.parse_state, record.diagnostic_count, record.owner_identity],
        )?;
    }
    for (ordinal, record) in input.nodes.iter().enumerate() {
        transaction.execute(
            "INSERT INTO index_nodes (generation_id, ordinal, canonical_id, kind, language_kind, qualified_name, locator, start_line, end_line, content_hash, visibility) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![generation_id, count_i64(ordinal)?, record.canonical_id, record.kind, record.language_kind, record.qualified_name, record.locator, record.start_line, record.end_line, record.content_hash, record.visibility],
        )?;
    }
    for (ordinal, record) in input.edges.iter().enumerate() {
        transaction.execute(
            "INSERT INTO index_edges (generation_id, ordinal, canonical_id, source_id, target_id, kind, locator, start_line, end_line, resolver, resolver_version, confidence, resolution_class, stale) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![generation_id, count_i64(ordinal)?, record.canonical_id, record.source_id, record.target_id, record.kind, record.locator, record.start_line, record.end_line, record.resolver, record.resolver_version, record.confidence, record.resolution_class, i64::from(record.stale)],
        )?;
    }
    for (ordinal, record) in input.unresolved.iter().enumerate() {
        transaction.execute(
            "INSERT INTO index_unresolved (generation_id, ordinal, canonical_id, source_id, relationship_kind, target_text_hash, locator, start_line, end_line, reason_code, confidence_class) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![generation_id, count_i64(ordinal)?, record.canonical_id, record.source_id, record.relationship_kind, record.target_text_hash, record.locator, record.start_line, record.end_line, record.reason_code, record.confidence_class],
        )?;
    }
    for (ordinal, record) in input.coverage.iter().enumerate() {
        transaction.execute(
            "INSERT INTO index_coverage (generation_id, ordinal, language, capability, represented_count, omitted_count, failed_count, reason_code) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![generation_id, count_i64(ordinal)?, record.language, record.capability, record.represented_count, record.omitted_count, record.failed_count, record.reason_code],
        )?;
    }
    for (ordinal, record) in input.diagnostics.iter().enumerate() {
        transaction.execute(
            "INSERT INTO index_diagnostics (generation_id, ordinal, canonical_id, severity, code, locator, start_line, end_line, message_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![generation_id, count_i64(ordinal)?, record.canonical_id, record.severity, record.code, record.locator, record.start_line, record.end_line, record.message_hash],
        )?;
    }
    Ok(())
}

fn load_generation_summary(
    connection: &Connection,
    generation_id: i64,
) -> Result<GenerationSummary> {
    connection
        .query_row(
            "SELECT id, parent_id, reason, created_at, committed_at, file_count, node_count, edge_count, unresolved_count, diagnostic_count, structural_fingerprint, ignore_fingerprint FROM index_generations WHERE id = ?1 AND state = 'committed'",
            [generation_id],
            row_to_summary,
        )
        .context("source_index_generation_not_found")
}

fn load_generation_files(connection: &Connection, generation_id: i64) -> Result<Vec<FileRecord>> {
    collect_rows(
        connection,
        "SELECT locator, content_hash, byte_size, language, parse_state, diagnostic_count, owner_identity FROM index_files WHERE generation_id = ?1 ORDER BY ordinal",
        generation_id,
        |row| Ok(FileRecord {
            locator: row.get(0)?,
            content_hash: row.get(1)?,
            byte_size: row.get(2)?,
            language: row.get(3)?,
            parse_state: row.get(4)?,
            diagnostic_count: row.get(5)?,
            owner_identity: row.get(6)?,
        }),
    )
}

fn load_generation_coverage(
    connection: &Connection,
    generation_id: i64,
) -> Result<Vec<CoverageRecord>> {
    collect_rows(
        connection,
        "SELECT language, capability, represented_count, omitted_count, failed_count, reason_code FROM index_coverage WHERE generation_id = ?1 ORDER BY ordinal",
        generation_id,
        |row| Ok(CoverageRecord {
            language: row.get(0)?,
            capability: row.get(1)?,
            represented_count: row.get(2)?,
            omitted_count: row.get(3)?,
            failed_count: row.get(4)?,
            reason_code: row.get(5)?,
        }),
    )
}

fn load_generation_records(
    connection: &Connection,
    summary: &GenerationSummary,
) -> Result<GenerationInput> {
    let files = load_generation_files(connection, summary.id)?;
    let nodes = collect_rows(
        connection,
        "SELECT canonical_id, kind, language_kind, qualified_name, locator, start_line, end_line, content_hash, visibility FROM index_nodes WHERE generation_id = ?1 ORDER BY ordinal",
        summary.id,
        row_to_node,
    )?;
    let edges = collect_rows(
        connection,
        "SELECT canonical_id, source_id, target_id, kind, locator, start_line, end_line, resolver, resolver_version, confidence, resolution_class, stale FROM index_edges WHERE generation_id = ?1 ORDER BY ordinal",
        summary.id,
        row_to_edge,
    )?;
    let unresolved = collect_rows(
        connection,
        "SELECT canonical_id, source_id, relationship_kind, target_text_hash, locator, start_line, end_line, reason_code, confidence_class FROM index_unresolved WHERE generation_id = ?1 ORDER BY ordinal",
        summary.id,
        |row| Ok(UnresolvedRecord {
            canonical_id: row.get(0)?,
            source_id: row.get(1)?,
            relationship_kind: row.get(2)?,
            target_text_hash: row.get(3)?,
            locator: row.get(4)?,
            start_line: row.get(5)?,
            end_line: row.get(6)?,
            reason_code: row.get(7)?,
            confidence_class: row.get(8)?,
        }),
    )?;
    let coverage = load_generation_coverage(connection, summary.id)?;
    let diagnostics = collect_rows(
        connection,
        "SELECT canonical_id, severity, code, locator, start_line, end_line, message_hash FROM index_diagnostics WHERE generation_id = ?1 ORDER BY ordinal",
        summary.id,
        |row| Ok(DiagnosticRecord {
            canonical_id: row.get(0)?,
            severity: row.get(1)?,
            code: row.get(2)?,
            locator: row.get(3)?,
            start_line: row.get(4)?,
            end_line: row.get(5)?,
            message_hash: row.get(6)?,
        }),
    )?;
    Ok(GenerationInput {
        reason: summary.reason.clone(),
        created_at: summary.created_at.clone(),
        structural_fingerprint: summary.structural_fingerprint.clone(),
        ignore_fingerprint: summary.ignore_fingerprint.clone(),
        files,
        nodes,
        edges,
        unresolved,
        coverage,
        diagnostics,
    })
}

fn collect_rows<T, F>(
    connection: &Connection,
    sql: &str,
    generation_id: i64,
    mapper: F,
) -> Result<Vec<T>>
where
    F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
{
    let mut statement = connection.prepare(sql)?;
    let records = statement
        .query_map([generation_id], mapper)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("source_index_generation_load_failed")?;
    Ok(records)
}

fn row_to_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<GenerationSummary> {
    Ok(GenerationSummary {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        reason: row.get(2)?,
        created_at: row.get(3)?,
        committed_at: row.get(4)?,
        file_count: row.get(5)?,
        node_count: row.get(6)?,
        edge_count: row.get(7)?,
        unresolved_count: row.get(8)?,
        diagnostic_count: row.get(9)?,
        structural_fingerprint: row.get(10)?,
        ignore_fingerprint: row.get(11)?,
    })
}

fn row_to_node(row: &rusqlite::Row<'_>) -> rusqlite::Result<NodeRecord> {
    Ok(NodeRecord {
        canonical_id: row.get(0)?,
        kind: row.get(1)?,
        language_kind: row.get(2)?,
        qualified_name: row.get(3)?,
        locator: row.get(4)?,
        start_line: row.get(5)?,
        end_line: row.get(6)?,
        content_hash: row.get(7)?,
        visibility: row.get(8)?,
    })
}

fn row_to_edge(row: &rusqlite::Row<'_>) -> rusqlite::Result<EdgeRecord> {
    Ok(EdgeRecord {
        canonical_id: row.get(0)?,
        source_id: row.get(1)?,
        target_id: row.get(2)?,
        kind: row.get(3)?,
        locator: row.get(4)?,
        start_line: row.get(5)?,
        end_line: row.get(6)?,
        resolver: row.get(7)?,
        resolver_version: row.get(8)?,
        confidence: row.get(9)?,
        resolution_class: row.get(10)?,
        stale: row.get::<_, i64>(11)? != 0,
    })
}

fn bounded_page<T>(mut items: Vec<T>, bounds: &QueryBounds) -> Result<QueryPage<T>>
where
    T: serde::Serialize,
    T: CursorRecord,
{
    let has_more = items.len() > bounds.limit;
    if has_more {
        items.pop();
    }
    let next_cursor = has_more
        .then(|| items.last().map(CursorRecord::cursor))
        .flatten();
    let page = QueryPage { items, next_cursor };
    enforce_output_bound(&page, bounds)?;
    Ok(page)
}

trait CursorRecord {
    fn cursor(&self) -> String;
}

impl CursorRecord for NodeRecord {
    fn cursor(&self) -> String {
        self.canonical_id.clone()
    }
}

impl CursorRecord for EdgeRecord {
    fn cursor(&self) -> String {
        self.canonical_id.clone()
    }
}

pub fn normalized_generation_fingerprint(input: &GenerationInput) -> Result<String> {
    let mut normalized = input.clone();
    normalize_generation_records(&mut normalized);
    let structural = serde_json::json!({
        "ignoreFingerprint": normalized.ignore_fingerprint,
        "files": normalized.files,
        "nodes": normalized.nodes,
        "edges": normalized.edges,
        "unresolved": normalized.unresolved,
        "coverage": normalized.coverage,
        "diagnostics": normalized.diagnostics,
    });
    Ok(format!(
        "sha256:{}",
        hex::encode(Sha256::digest(serde_json::to_vec(&structural)?))
    ))
}

pub fn select_generation_files(
    input: &GenerationInput,
    locators: &BTreeSet<String>,
) -> GenerationInput {
    let node_ids = input
        .nodes
        .iter()
        .filter(|node| locators.contains(locator_file(&node.locator)))
        .map(|node| node.canonical_id.clone())
        .collect::<BTreeSet<_>>();
    GenerationInput {
        reason: input.reason.clone(),
        created_at: input.created_at.clone(),
        structural_fingerprint: input.structural_fingerprint.clone(),
        ignore_fingerprint: input.ignore_fingerprint.clone(),
        files: input
            .files
            .iter()
            .filter(|file| locators.contains(&file.locator))
            .cloned()
            .collect(),
        nodes: input
            .nodes
            .iter()
            .filter(|node| node_ids.contains(&node.canonical_id))
            .cloned()
            .collect(),
        edges: input
            .edges
            .iter()
            .filter(|edge| node_ids.contains(&edge.source_id))
            .cloned()
            .collect(),
        unresolved: input
            .unresolved
            .iter()
            .filter(|item| node_ids.contains(&item.source_id))
            .cloned()
            .collect(),
        coverage: input.coverage.clone(),
        diagnostics: input
            .diagnostics
            .iter()
            .filter(|item| locators.contains(locator_file(&item.locator)))
            .cloned()
            .collect(),
    }
}

pub fn merge_incremental_generation(
    active: &GenerationInput,
    replacement: &GenerationInput,
    plan: &RefreshPlan,
) -> Result<GenerationInput> {
    let mut removed_files = plan
        .invalidated_files
        .iter()
        .chain(plan.deleted_files.iter())
        .cloned()
        .collect::<BTreeSet<_>>();
    removed_files.extend(
        plan.renamed_files
            .iter()
            .map(|rename| rename.from_locator.clone()),
    );
    let removed_nodes = active
        .nodes
        .iter()
        .filter(|node| removed_files.contains(locator_file(&node.locator)))
        .map(|node| node.canonical_id.clone())
        .collect::<BTreeSet<_>>();
    let mut merged = GenerationInput {
        reason: replacement.reason.clone(),
        created_at: replacement.created_at.clone(),
        structural_fingerprint: replacement.structural_fingerprint.clone(),
        ignore_fingerprint: replacement.ignore_fingerprint.clone(),
        files: active
            .files
            .iter()
            .filter(|file| !removed_files.contains(&file.locator))
            .cloned()
            .chain(replacement.files.iter().cloned())
            .collect(),
        nodes: active
            .nodes
            .iter()
            .filter(|node| !removed_nodes.contains(&node.canonical_id))
            .cloned()
            .chain(replacement.nodes.iter().cloned())
            .collect(),
        edges: active
            .edges
            .iter()
            .filter(|edge| {
                !removed_nodes.contains(&edge.source_id)
                    && !removed_files.contains(locator_file(&edge.locator))
            })
            .cloned()
            .chain(replacement.edges.iter().cloned())
            .collect(),
        unresolved: active
            .unresolved
            .iter()
            .filter(|item| {
                !removed_nodes.contains(&item.source_id)
                    && !removed_files.contains(locator_file(&item.locator))
            })
            .cloned()
            .chain(replacement.unresolved.iter().cloned())
            .collect(),
        coverage: if replacement.coverage.is_empty() {
            active.coverage.clone()
        } else {
            replacement.coverage.clone()
        },
        diagnostics: active
            .diagnostics
            .iter()
            .filter(|item| !removed_files.contains(locator_file(&item.locator)))
            .cloned()
            .chain(replacement.diagnostics.iter().cloned())
            .collect(),
    };
    let final_nodes = merged
        .nodes
        .iter()
        .map(|node| node.canonical_id.as_str())
        .collect::<BTreeSet<_>>();
    merged.edges.retain(|edge| {
        final_nodes.contains(edge.source_id.as_str())
            && final_nodes.contains(edge.target_id.as_str())
    });
    normalize_generation_records(&mut merged);
    merged.structural_fingerprint = normalized_generation_fingerprint(&merged)?;
    validate_generation(&merged)?;
    Ok(merged)
}

fn normalize_generation_records(input: &mut GenerationInput) {
    input
        .files
        .sort_by(|left, right| left.locator.cmp(&right.locator));
    input
        .nodes
        .sort_by(|left, right| left.canonical_id.cmp(&right.canonical_id));
    input
        .edges
        .sort_by(|left, right| left.canonical_id.cmp(&right.canonical_id));
    input
        .unresolved
        .sort_by(|left, right| left.canonical_id.cmp(&right.canonical_id));
    input.coverage.sort_by(|left, right| {
        left.language
            .cmp(&right.language)
            .then_with(|| left.capability.cmp(&right.capability))
    });
    input
        .diagnostics
        .sort_by(|left, right| left.canonical_id.cmp(&right.canonical_id));
}

fn detect_renames(
    previous: &BTreeMap<String, &FileRecord>,
    current: &BTreeMap<String, &DiscoveredFile>,
    added: &BTreeSet<String>,
    deleted: &BTreeSet<String>,
) -> Vec<FileRename> {
    let mut added_by_hash = BTreeMap::<&str, Vec<&str>>::new();
    let mut deleted_by_hash = BTreeMap::<&str, Vec<&str>>::new();
    for locator in added {
        added_by_hash
            .entry(current[locator].content_hash.as_str())
            .or_default()
            .push(locator);
    }
    for locator in deleted {
        deleted_by_hash
            .entry(previous[locator].content_hash.as_str())
            .or_default()
            .push(locator);
    }
    let mut renames = added_by_hash
        .into_iter()
        .filter_map(|(hash, added_locators)| {
            let deleted_locators = deleted_by_hash.get(hash)?;
            (added_locators.len() == 1 && deleted_locators.len() == 1).then(|| FileRename {
                from_locator: deleted_locators[0].to_string(),
                to_locator: added_locators[0].to_string(),
            })
        })
        .collect::<Vec<_>>();
    renames.sort_by(|left, right| left.from_locator.cmp(&right.from_locator));
    renames
}

fn invalidation_closure(
    generation: &GenerationInput,
    seed_files: &BTreeSet<String>,
    bounds: &RefreshBounds,
) -> (BTreeSet<String>, bool) {
    let file_by_node = generation
        .nodes
        .iter()
        .map(|node| {
            (
                node.canonical_id.as_str(),
                locator_file(&node.locator).to_string(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut invalidated = seed_files.clone();
    let mut frontier = file_by_node
        .iter()
        .filter(|(_, locator)| seed_files.contains(*locator))
        .map(|(node_id, _)| (*node_id).to_string())
        .collect::<BTreeSet<_>>();
    let mut truncated = false;
    for _ in 0..bounds.max_depth {
        let mut next = BTreeSet::new();
        for edge in &generation.edges {
            if !frontier.contains(&edge.target_id) || !invalidation_edge(edge) {
                continue;
            }
            let Some(locator) = file_by_node.get(edge.source_id.as_str()) else {
                continue;
            };
            if invalidated.insert(locator.clone()) {
                if invalidated.len() >= bounds.max_invalidated_files {
                    truncated = true;
                    return (invalidated, truncated);
                }
                next.insert(edge.source_id.clone());
            }
        }
        if next.is_empty() {
            break;
        }
        frontier = next;
    }
    (invalidated, truncated)
}

fn invalidation_edge(edge: &EdgeRecord) -> bool {
    match edge.kind.as_str() {
        "calls" => matches!(edge.resolution_class.as_str(), "typed" | "exact"),
        "imports" | "exports" | "re_exports" | "inherits" | "extends" | "implements"
        | "mixes_in" | "extends_type" | "depends_on" | "part_of" | "entry_point"
        | "handles_route" | "process_step" | "constructs" | "references" => true,
        _ => false,
    }
}

fn validate_refresh_bounds(bounds: &RefreshBounds) -> Result<()> {
    if bounds.max_depth > 8 || !(1..=100_000).contains(&bounds.max_invalidated_files) {
        bail!("source_index_refresh_bounds_invalid");
    }
    Ok(())
}

fn validate_generation(input: &GenerationInput) -> Result<()> {
    validate_token(&input.reason, "source_index_generation_reason_invalid")?;
    if input.created_at.is_empty() || input.created_at.len() > 64 {
        bail!("source_index_generation_timestamp_invalid");
    }
    validate_hash(&input.structural_fingerprint)?;
    if let Some(fingerprint) = &input.ignore_fingerprint {
        validate_hash(fingerprint)?;
    }
    let mut files = BTreeSet::new();
    for record in &input.files {
        validate_locator(&record.locator)?;
        validate_hash(&record.content_hash)?;
        validate_token(&record.language, "source_index_language_invalid")?;
        validate_token(&record.parse_state, "source_index_parse_state_invalid")?;
        validate_identifier(&record.owner_identity)?;
        if record.byte_size < 0
            || record.diagnostic_count < 0
            || !files.insert(record.locator.clone())
        {
            bail!("source_index_file_record_invalid");
        }
    }
    let mut nodes = BTreeSet::new();
    for record in &input.nodes {
        validate_identifier(&record.canonical_id)?;
        validate_token(&record.kind, "source_index_node_kind_invalid")?;
        validate_token(&record.language_kind, "source_index_language_kind_invalid")?;
        validate_token(&record.visibility, "source_index_visibility_invalid")?;
        validate_locator(&record.locator)?;
        validate_span(record.start_line, record.end_line)?;
        if let Some(hash) = &record.content_hash {
            validate_hash(hash)?;
        }
        if record.qualified_name.is_empty()
            || record.qualified_name.len() > 2_048
            || !nodes.insert(record.canonical_id.clone())
            || !files.contains(locator_file(&record.locator))
        {
            bail!("source_index_node_record_invalid");
        }
    }
    let mut edges = BTreeSet::new();
    for record in &input.edges {
        validate_identifier(&record.canonical_id)?;
        validate_locator(&record.locator)?;
        validate_span(record.start_line, record.end_line)?;
        validate_token(&record.kind, "source_index_edge_kind_invalid")?;
        validate_token(&record.resolver, "source_index_resolver_invalid")?;
        validate_token(
            &record.resolver_version,
            "source_index_resolver_version_invalid",
        )?;
        validate_token(
            &record.resolution_class,
            "source_index_resolution_class_invalid",
        )?;
        if !record.confidence.is_finite()
            || !(0.0..=1.0).contains(&record.confidence)
            || !edges.insert(record.canonical_id.clone())
            || !nodes.contains(&record.source_id)
            || !nodes.contains(&record.target_id)
            || !files.contains(locator_file(&record.locator))
        {
            bail!("source_index_edge_record_invalid");
        }
    }
    let mut unresolved = BTreeSet::new();
    for record in &input.unresolved {
        validate_identifier(&record.canonical_id)?;
        validate_hash(&record.target_text_hash)?;
        validate_locator(&record.locator)?;
        validate_span(record.start_line, record.end_line)?;
        validate_token(
            &record.relationship_kind,
            "source_index_relationship_kind_invalid",
        )?;
        validate_token(&record.reason_code, "source_index_reason_code_invalid")?;
        validate_token(
            &record.confidence_class,
            "source_index_confidence_class_invalid",
        )?;
        if !unresolved.insert(record.canonical_id.clone())
            || !nodes.contains(&record.source_id)
            || !files.contains(locator_file(&record.locator))
        {
            bail!("source_index_unresolved_record_invalid");
        }
    }
    let mut coverage = BTreeSet::new();
    for record in &input.coverage {
        validate_token(&record.language, "source_index_language_invalid")?;
        validate_token(&record.capability, "source_index_capability_invalid")?;
        if let Some(reason) = &record.reason_code {
            validate_token(reason, "source_index_reason_code_invalid")?;
        }
        if record.represented_count < 0
            || record.omitted_count < 0
            || record.failed_count < 0
            || !coverage.insert((record.language.clone(), record.capability.clone()))
        {
            bail!("source_index_coverage_record_invalid");
        }
    }
    let mut diagnostics = BTreeSet::new();
    for record in &input.diagnostics {
        validate_identifier(&record.canonical_id)?;
        validate_locator(&record.locator)?;
        validate_span(record.start_line, record.end_line)?;
        validate_hash(&record.message_hash)?;
        validate_token(&record.severity, "source_index_severity_invalid")?;
        validate_token(&record.code, "source_index_diagnostic_code_invalid")?;
        if !diagnostics.insert(record.canonical_id.clone())
            || !files.contains(locator_file(&record.locator))
        {
            bail!("source_index_diagnostic_record_invalid");
        }
    }
    Ok(())
}

fn validate_query_bounds(bounds: &QueryBounds) -> Result<()> {
    if !(1..=100).contains(&bounds.limit)
        || bounds.max_depth > 8
        || !(1_024..=1_048_576).contains(&bounds.max_output_bytes)
        || !(1..=2_000).contains(&bounds.timeout_ms)
    {
        bail!("source_index_query_bounds_invalid");
    }
    if let Some(cursor) = &bounds.cursor {
        validate_cursor(cursor)?;
    }
    Ok(())
}

fn validate_query_text(value: &str) -> Result<()> {
    if value.trim().is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        bail!("source_index_query_text_invalid");
    }
    Ok(())
}

fn search_terms(query: &str) -> Vec<String> {
    let terms = query
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| !term.is_empty())
        .map(str::to_lowercase)
        .collect::<BTreeSet<_>>();
    if terms.is_empty() {
        vec![query.to_lowercase()]
    } else {
        terms.into_iter().collect()
    }
}

fn validate_cursor(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        bail!("source_index_query_cursor_invalid");
    }
    Ok(())
}

fn validate_identifier(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        bail!("source_index_identifier_invalid");
    }
    Ok(())
}

fn validate_token(value: &str, code: &'static str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))
    {
        bail!(code);
    }
    Ok(())
}

fn validate_hash(value: &str) -> Result<()> {
    let bytes = value.as_bytes();
    if bytes.len() != 71
        || !value.starts_with("sha256:")
        || !bytes[7..].iter().all(u8::is_ascii_hexdigit)
    {
        bail!("source_index_hash_invalid");
    }
    Ok(())
}

fn validate_locator(value: &str) -> Result<()> {
    let file = locator_file(value);
    if !file.starts_with("workspace://")
        || file.len() > 4_096
        || file.contains('\0')
        || file.contains('\\')
        || file
            .trim_start_matches("workspace://")
            .split('/')
            .any(|part| part == ".." || part.is_empty())
    {
        bail!("source_index_locator_invalid");
    }
    Ok(())
}

fn locator_file(value: &str) -> &str {
    value.split_once('#').map_or(value, |(file, _)| file)
}

fn validate_span(start_line: i64, end_line: i64) -> Result<()> {
    if start_line < 1 || end_line < start_line {
        bail!("source_index_span_invalid");
    }
    Ok(())
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn count_i64(value: usize) -> Result<i64> {
    i64::try_from(value).context("source_index_count_overflow")
}

fn ensure_deadline(started: Instant, bounds: &QueryBounds) -> Result<()> {
    if started.elapsed() > Duration::from_millis(bounds.timeout_ms) {
        bail!("source_index_query_timeout");
    }
    Ok(())
}

fn enforce_output_bound<T: serde::Serialize>(value: &T, bounds: &QueryBounds) -> Result<()> {
    if serde_json::to_vec(value)?.len() > bounds.max_output_bytes {
        bail!("source_index_query_output_limit");
    }
    Ok(())
}

pub fn inspect_index(path: &Path, options: &SourceIndexOptions) -> IndexHealth {
    if !path.is_file() {
        return health(HealthStatus::Absent, "source_index_absent", None, None);
    }
    let connection = match open_read_only_connection(path) {
        Ok(connection) => connection,
        Err(_) => return health(HealthStatus::Corrupt, "source_index_corrupt", None, None),
    };
    if connection.pragma_update(None, "query_only", "ON").is_err() {
        return health(HealthStatus::Corrupt, "source_index_corrupt", None, None);
    }
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

pub fn logical_database_bytes(path: &Path) -> u64 {
    let logical_bytes = open_read_only_connection(path).and_then(|connection| {
        connection.pragma_update(None, "query_only", "ON")?;
        let page_count =
            connection.pragma_query_value(None, "page_count", |row| row.get::<_, u64>(0))?;
        let page_size =
            connection.pragma_query_value(None, "page_size", |row| row.get::<_, u64>(0))?;
        Ok(page_count.saturating_mul(page_size))
    });
    logical_bytes.unwrap_or_else(|_| fs::metadata(path).map_or(0, |metadata| metadata.len()))
}

fn open_read_only_connection(path: &Path) -> Result<Connection> {
    let path = path.to_str().context("source_index_path_invalid")?;
    let mut uri = String::with_capacity(path.len() + 32);
    uri.push_str("file:");
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'.' | b'_' | b'~' | b':') {
            uri.push(char::from(byte));
        } else {
            use std::fmt::Write as _;
            write!(&mut uri, "%{byte:02X}").context("source_index_path_invalid")?;
        }
    }
    uri.push_str("?mode=ro&immutable=1");
    Connection::open_with_flags(
        uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_URI,
    )
    .context("source_index_read_only_open_failed")
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
