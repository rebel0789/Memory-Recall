use super::{
    inspect_index, locator_file, open_read_only_connection, repository_identity_hash,
    secure_permissions, EdgeDirection, HealthStatus, NodeRecord, QueryBounds, SourceIndex,
    SourceIndexOptions,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryListOutput {
    pub repositories: Vec<RegisteredRepository>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoRepositoryModule {
    pub repository_id: String,
    pub module_coordinate: String,
    pub manifest_locator: String,
    pub required_module_coordinates: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoRepositoryRelationship {
    pub id: String,
    pub kind: String,
    pub source_repository_id: String,
    pub target_repository_id: String,
    pub from_node_id: String,
    pub to_node_id: String,
    pub evidence_locator: String,
    pub evidence_native_relationship_ids: Vec<String>,
    pub confidence: f64,
    pub resolution: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoRepositoryPath {
    pub node_ids: Vec<String>,
    pub relationship_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryGoOutput {
    pub repositories: Vec<RegisteredRepository>,
    pub go_modules: Vec<GoRepositoryModule>,
    pub go_relationships: Vec<GoRepositoryRelationship>,
    pub paths: Vec<GoRepositoryPath>,
    pub impacted_nodes: Vec<QualifiedRepositoryNode>,
    pub partial: bool,
    pub truncated: bool,
    pub opened_repository_count: usize,
}

pub struct GoRepositoryQuery<'a> {
    pub repository_ids: &'a [String],
    pub client_repository_id: &'a str,
    pub service_repository_id: &'a str,
    pub client_entry_native_id: &'a str,
    pub service_target_native_id: &'a str,
    pub deadline_ms: u64,
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

    pub fn list(&self, limit: usize) -> Result<RepositoryListOutput> {
        if !(1..=64).contains(&limit) {
            bail!("repository_list_limit_invalid");
        }
        let mut rows = self.load_rows(limit.saturating_add(1), None)?;
        let truncated = rows.len() > limit;
        rows.truncate(limit);
        Ok(RepositoryListOutput {
            repositories: rows.into_iter().map(|row| self.inspect_row(row)).collect(),
            truncated,
        })
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
                    repositories.push(self.inspect_row(row));
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

    pub fn resolve_go(&self, query: &GoRepositoryQuery<'_>) -> Result<RepositoryGoOutput> {
        self.go_relationships(query, None, GoOutputKind::Resolve)
    }

    pub fn trace_go(
        &self,
        query: &GoRepositoryQuery<'_>,
        limit: usize,
    ) -> Result<RepositoryGoOutput> {
        self.go_relationships(query, Some(limit), GoOutputKind::Trace)
    }

    pub fn impact_go(
        &self,
        query: &GoRepositoryQuery<'_>,
        limit: usize,
    ) -> Result<RepositoryGoOutput> {
        self.go_relationships(query, Some(limit), GoOutputKind::Impact)
    }

    fn go_relationships(
        &self,
        query: &GoRepositoryQuery<'_>,
        limit: Option<usize>,
        output_kind: GoOutputKind,
    ) -> Result<RepositoryGoOutput> {
        validate_go_request(query, limit)?;
        let client_repository_id = query.client_repository_id;
        let service_repository_id = query.service_repository_id;
        let started = Instant::now();
        let wanted = query
            .repository_ids
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        let rows = self.load_rows(2, Some(&wanted))?;
        if rows.len() != 2 {
            bail!("repository_not_registered");
        }
        let by_id = rows
            .into_iter()
            .map(|row| (row.repository_id.clone(), row))
            .collect::<BTreeMap<_, _>>();
        let client_row = by_id
            .get(client_repository_id)
            .context("repository_not_registered")?;
        let service_row = by_id
            .get(service_repository_id)
            .context("repository_not_registered")?;

        ensure_go_deadline(started, query.deadline_ms)?;
        let (_, service_root) =
            resolve_repository_root(&self.fleet_root, &service_row.root_locator)?;
        let service_manifest = read_go_manifest(&service_root)?;
        let service_options =
            SourceIndexOptions::new(&service_row.repository_identity_hash, &self.engine_version);
        let service_index = SourceIndex::open_read_only(
            &service_root.join(REPOSITORY_INDEX_RELATIVE_PATH),
            &service_options,
        )
        .context("repository_index_unavailable")?;
        let service_generation = service_index
            .active_generation()
            .context("repository_index_active_generation_missing")?;
        let service_target = service_index
            .node(query.service_target_native_id)?
            .context("repository_go_target_not_found")?;
        if !valid_result_locator(&service_target.locator) {
            bail!("repository_go_target_not_found");
        }
        let expected_import = go_import_coordinate(&service_manifest.module, &service_target)?;
        drop(service_index);

        ensure_go_deadline(started, query.deadline_ms)?;
        let (_, client_root) = resolve_repository_root(&self.fleet_root, &client_row.root_locator)?;
        let client_manifest = read_go_manifest(&client_root)?;
        if !client_manifest.requires.contains(&service_manifest.module) {
            bail!("repository_go_module_mismatch");
        }
        let client_options =
            SourceIndexOptions::new(&client_row.repository_identity_hash, &self.engine_version);
        let client_index = SourceIndex::open_read_only(
            &client_root.join(REPOSITORY_INDEX_RELATIVE_PATH),
            &client_options,
        )
        .context("repository_index_unavailable")?;
        let client_generation = client_index
            .active_generation()
            .context("repository_index_active_generation_missing")?;
        let client_entry = client_index
            .node(query.client_entry_native_id)?
            .context("repository_go_entry_not_found")?;
        if !valid_result_locator(&client_entry.locator) {
            bail!("repository_go_entry_not_found");
        }
        let query_bounds = QueryBounds {
            limit: REPOSITORY_SEARCH_MAX_PER_REPOSITORY,
            max_depth: 1,
            max_output_bytes: REPOSITORY_SEARCH_MAX_OUTPUT_BYTES,
            timeout_ms: remaining_ms(started, query.deadline_ms),
            cursor: None,
        };
        let client_file = locator_file(&client_entry.locator);
        let import_targets = client_index
            .find_exact_nodes(&expected_import, &query_bounds)?
            .items;
        let mut import_edge = None;
        for target in import_targets
            .into_iter()
            .filter(|node| symbol_tail(&node.qualified_name) == expected_import)
        {
            import_edge = client_index
                .dependency_edges(&target.canonical_id, EdgeDirection::Incoming, &query_bounds)?
                .items
                .into_iter()
                .find(|edge| {
                    edge.kind == "imports"
                        && edge.resolution_class == "unresolved"
                        && !edge.stale
                        && locator_file(&edge.locator) == client_file
                        && valid_result_locator(&edge.locator)
                        && valid_prefixed_hex(&edge.canonical_id, "ciedge_")
                });
            if import_edge.is_some() {
                break;
            }
        }
        let import_edge = import_edge.context("repository_go_import_not_found")?;
        let target_name = symbol_tail(&service_target.qualified_name);
        let execution_edge = client_index
            .dependency_edges(
                query.client_entry_native_id,
                EdgeDirection::Outgoing,
                &query_bounds,
            )?
            .items
            .into_iter()
            .find(|edge| {
                if !matches!(edge.kind.as_str(), "calls" | "constructs")
                    || edge.resolution_class != "unresolved"
                    || edge.stale
                    || locator_file(&edge.locator) != client_file
                    || !valid_result_locator(&edge.locator)
                    || !valid_prefixed_hex(&edge.canonical_id, "ciedge_")
                {
                    return false;
                }
                client_index
                    .node(&edge.target_id)
                    .ok()
                    .flatten()
                    .is_some_and(|node| symbol_tail(&node.qualified_name) == target_name)
            })
            .context("repository_go_relationship_not_found")?;
        drop(client_index);
        ensure_go_deadline(started, query.deadline_ms)?;

        let client_entry = qualify_node(client_repository_id, client_entry, client_generation, 1.0);
        let service_target = qualify_node(
            service_repository_id,
            service_target,
            service_generation,
            1.0,
        );
        let import_relationship_id = prefixed_digest(
            "mrrel_",
            &[
                client_repository_id.as_bytes(),
                service_repository_id.as_bytes(),
                import_edge.canonical_id.as_bytes(),
            ],
        );
        let execution_relationship_id = prefixed_digest(
            "mrrel_",
            &[
                client_repository_id.as_bytes(),
                service_repository_id.as_bytes(),
                execution_edge.canonical_id.as_bytes(),
                query.service_target_native_id.as_bytes(),
            ],
        );
        let relationships = vec![
            GoRepositoryRelationship {
                id: import_relationship_id,
                kind: "imports".to_string(),
                source_repository_id: client_repository_id.to_string(),
                target_repository_id: service_repository_id.to_string(),
                from_node_id: derive_qualified_node_id(
                    client_repository_id,
                    &import_edge.source_id,
                ),
                to_node_id: service_target.id.clone(),
                evidence_locator: import_edge.locator,
                evidence_native_relationship_ids: vec![import_edge.canonical_id.clone()],
                confidence: import_edge.confidence,
                resolution: "exact_module_coordinate".to_string(),
            },
            GoRepositoryRelationship {
                id: execution_relationship_id.clone(),
                kind: execution_edge.kind,
                source_repository_id: client_repository_id.to_string(),
                target_repository_id: service_repository_id.to_string(),
                from_node_id: client_entry.id.clone(),
                to_node_id: service_target.id.clone(),
                evidence_locator: execution_edge.locator,
                evidence_native_relationship_ids: vec![
                    import_edge.canonical_id.clone(),
                    execution_edge.canonical_id,
                ],
                confidence: import_edge.confidence.min(execution_edge.confidence),
                resolution: "exact_module_coordinate".to_string(),
            },
        ];
        let path = GoRepositoryPath {
            node_ids: vec![client_entry.id.clone(), service_target.id.clone()],
            relationship_ids: vec![execution_relationship_id],
        };
        let mut repositories = vec![
            repository_from_row(client_row, Some(client_generation)),
            repository_from_row(service_row, Some(service_generation)),
        ];
        repositories.sort_by(|left, right| left.repository_id.cmp(&right.repository_id));
        let output = RepositoryGoOutput {
            repositories,
            go_modules: vec![
                GoRepositoryModule {
                    repository_id: client_repository_id.to_string(),
                    module_coordinate: client_manifest.module,
                    manifest_locator: "workspace://go.mod".to_string(),
                    required_module_coordinates: vec![service_manifest.module.clone()],
                },
                GoRepositoryModule {
                    repository_id: service_repository_id.to_string(),
                    module_coordinate: service_manifest.module,
                    manifest_locator: "workspace://go.mod".to_string(),
                    required_module_coordinates: Vec::new(),
                },
            ],
            go_relationships: relationships,
            paths: matches!(output_kind, GoOutputKind::Trace | GoOutputKind::Impact)
                .then_some(path)
                .into_iter()
                .collect(),
            impacted_nodes: matches!(output_kind, GoOutputKind::Impact)
                .then_some(client_entry)
                .into_iter()
                .collect(),
            partial: false,
            truncated: false,
            opened_repository_count: 2,
        };
        if serde_json::to_vec(&output)?.len() > REPOSITORY_SEARCH_MAX_OUTPUT_BYTES {
            bail!("repository_go_output_too_large");
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
        let health = resolved.ok().map(|(_, root)| {
            let options =
                SourceIndexOptions::new(&row.repository_identity_hash, &self.engine_version);
            inspect_index(&root.join(REPOSITORY_INDEX_RELATIVE_PATH), &options)
        });
        let active_generation = health.as_ref().and_then(|value| value.active_generation);
        let ready = health.as_ref().is_some_and(|value| {
            value.status == HealthStatus::Ready && active_generation.is_some()
        });
        let freshness = if health.is_some_and(|value| value.status == HealthStatus::Stale) {
            "stale"
        } else {
            "unverified"
        };
        RegisteredRepository {
            repository_id: row.repository_id,
            display_name: row.display_name,
            root_locator: row.root_locator.clone(),
            index_locator: index_locator(&row.root_locator),
            repository_identity_hash: row.repository_identity_hash,
            active_generation,
            state: if ready {
                "ready".to_string()
            } else {
                "unavailable".to_string()
            },
            freshness: freshness.to_string(),
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
        match inspect_index(&root.join(REPOSITORY_INDEX_RELATIVE_PATH), &options).status {
            HealthStatus::Ready => {}
            HealthStatus::Stale => bail!("repository_index_stale"),
            HealthStatus::WrongRepository => bail!("repository_index_identity_mismatch"),
            _ => bail!("repository_index_unavailable"),
        }
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

#[derive(Clone, Copy)]
enum GoOutputKind {
    Resolve,
    Trace,
    Impact,
}

struct GoManifest {
    module: String,
    requires: BTreeSet<String>,
}

fn validate_go_request(query: &GoRepositoryQuery<'_>, limit: Option<usize>) -> Result<()> {
    if query.repository_ids.len() != 2
        || query.repository_ids[0] != query.client_repository_id
        || query.repository_ids[1] != query.service_repository_id
        || query.client_repository_id == query.service_repository_id
        || query
            .repository_ids
            .iter()
            .any(|id| !valid_prefixed_hex(id, "repo_"))
        || !valid_prefixed_hex(query.client_entry_native_id, "cinode_")
        || !valid_prefixed_hex(query.service_target_native_id, "cinode_")
        || limit.is_some_and(|value| !(1..=REPOSITORY_SEARCH_MAX_PER_REPOSITORY).contains(&value))
        || !(1..=REPOSITORY_SEARCH_MAX_DEADLINE_MS).contains(&query.deadline_ms)
    {
        bail!("repository_go_request_invalid");
    }
    Ok(())
}

fn read_go_manifest(root: &Path) -> Result<GoManifest> {
    const MAX_GO_MOD_BYTES: u64 = 64 * 1024;
    let path = root.join("go.mod");
    let canonical = path
        .canonicalize()
        .context("repository_go_module_unavailable")?;
    if !canonical.starts_with(root) {
        bail!("repository_go_module_unavailable");
    }
    let metadata = fs::metadata(&canonical).context("repository_go_module_unavailable")?;
    if !metadata.is_file() || metadata.len() > MAX_GO_MOD_BYTES {
        bail!("repository_go_module_unavailable");
    }
    let source = fs::read_to_string(canonical).context("repository_go_module_unavailable")?;
    let mut module = None;
    let mut requires = BTreeSet::new();
    let mut require_block = false;
    for line in source.lines() {
        let line = line.split("//").next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if module.is_none() {
            if let Some(value) = line.strip_prefix("module ") {
                let value = value.trim();
                if valid_go_coordinate(value) {
                    module = Some(value.to_string());
                }
                continue;
            }
        }
        if line == "require (" {
            require_block = true;
            continue;
        }
        if require_block && line == ")" {
            require_block = false;
            continue;
        }
        let value = if require_block {
            line.split_whitespace().next()
        } else {
            line.strip_prefix("require ")
                .and_then(|rest| rest.split_whitespace().next())
        };
        if let Some(value) = value.filter(|value| valid_go_coordinate(value)) {
            requires.insert(value.to_string());
        }
    }
    Ok(GoManifest {
        module: module.context("repository_go_module_unavailable")?,
        requires,
    })
}

fn valid_go_coordinate(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && !value.starts_with('/')
        && !value.ends_with('/')
        && !value.contains("//")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._~/".contains(&byte))
}

fn go_import_coordinate(module: &str, target: &NodeRecord) -> Result<String> {
    let file = target.locator.split('#').next().unwrap_or(&target.locator);
    let relative = file
        .strip_prefix("workspace://")
        .context("repository_go_target_not_found")?;
    if !relative.ends_with(".go") || relative.contains("..") {
        bail!("repository_go_target_not_found");
    }
    let directory = relative.rsplit_once('/').map(|(directory, _)| directory);
    let coordinate = directory.map_or_else(
        || module.to_string(),
        |directory| format!("{module}/{directory}"),
    );
    if !valid_go_coordinate(&coordinate) {
        bail!("repository_go_target_not_found");
    }
    Ok(coordinate)
}

fn symbol_tail(qualified_name: &str) -> &str {
    qualified_name.rsplit("::").next().unwrap_or(qualified_name)
}

fn qualify_node(
    repository_id: &str,
    node: NodeRecord,
    generation: i64,
    confidence: f64,
) -> QualifiedRepositoryNode {
    let label = result_label(&node);
    let kind = safe_result_code(&node.kind);
    QualifiedRepositoryNode {
        id: derive_qualified_node_id(repository_id, &node.canonical_id),
        native_id: node.canonical_id,
        repository_id: repository_id.to_string(),
        kind,
        label,
        locator: node.locator,
        confidence,
        generation,
    }
}

fn ensure_go_deadline(started: Instant, deadline_ms: u64) -> Result<()> {
    if started.elapsed() >= Duration::from_millis(deadline_ms) {
        bail!("repository_go_deadline_exceeded");
    }
    Ok(())
}

fn remaining_ms(started: Instant, deadline_ms: u64) -> u64 {
    deadline_ms
        .saturating_sub(elapsed_ms(started))
        .max(1)
        .min(REPOSITORY_SEARCH_MAX_DEADLINE_MS)
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
    let Some(relative) = value.strip_prefix("workspace://") else {
        return false;
    };
    let (file, fragment) = relative
        .split_once('#')
        .map_or((relative, None), |(file, fragment)| (file, Some(fragment)));
    value.len() <= 512
        && !file.is_empty()
        && file
            .split('/')
            .all(|part| !part.is_empty() && part != ".." && part.bytes().all(valid_locator_byte))
        && fragment.is_none_or(valid_line_fragment)
}

fn valid_locator_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"_.@+-".contains(&byte)
}

fn valid_line_fragment(value: &str) -> bool {
    let mut lines = value.split("-L");
    let valid_line = |line: &str| {
        (1..=9).contains(&line.len())
            && !line.starts_with('0')
            && line.bytes().all(|byte| byte.is_ascii_digit())
    };
    lines
        .next()
        .and_then(|line| line.strip_prefix('L'))
        .is_some_and(valid_line)
        && lines.next().is_none_or(valid_line)
        && lines.next().is_none()
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
    } else if text.contains("repository_index_stale") || text.contains("engine_changed") {
        "repository_index_stale"
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
