use anyhow::{anyhow, bail, Context, Result};
use chrono::{SecondsFormat, Utc};
use regex::Regex;
use rusqlite::{params, params_from_iter, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Component, Path};
use std::sync::OnceLock;
use std::time::Duration;

const PROVIDER_ID: &str = "provider:native:memory:sqlite";
const PROPOSAL_PREVIEW_LIMIT: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchFact {
    pub subject: String,
    pub predicate: String,
    pub object: String,
    pub source: String,
    #[serde(default, alias = "sourceTrust")]
    pub source_trust: Option<String>,
    #[serde(default)]
    pub confidence: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub supersedes: Option<Supersedes>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Supersedes {
    pub subject: String,
    pub predicate: String,
    #[serde(default)]
    pub object: Option<String>,
}

#[derive(Debug, Clone)]
pub struct StoreOptions {
    pub workspace_id: String,
    pub now: String,
}

impl Default for StoreOptions {
    fn default() -> Self {
        Self {
            workspace_id: "ws_local".to_string(),
            now: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct BatchReport {
    pub recorded_count: usize,
    pub skipped_unsafe_count: usize,
    pub skipped_duplicate_count: usize,
    pub skipped: Vec<Value>,
    pub proposal_facts: Vec<Value>,
}

#[derive(Debug, Clone, Default)]
pub struct ApproveReport {
    pub active_memory_created: usize,
    pub superseded_fact_count: usize,
    pub pending_proposal_count: usize,
    pub rejected_proposal_count: usize,
    pub skipped_explicit_id_only_count: usize,
    pub proposal: Option<Value>,
    pub fact: Option<Value>,
    pub facts: Vec<Value>,
    pub superseded_facts: Vec<Value>,
    pub policy_receipts: Vec<Value>,
}

#[derive(Debug, Clone)]
pub struct RecallFact {
    pub id: String,
    pub workspace_id: String,
    pub scope: String,
    pub subject: String,
    pub predicate: String,
    pub object: String,
    pub text: String,
    pub status: String,
    pub source: String,
    pub confidence: f64,
    pub updated_at: String,
    pub valid_from: String,
    pub valid_until: Option<String>,
    pub superseded_by: Option<String>,
    pub proposal_queue_id: String,
    pub episode_id: String,
    pub created_at: String,
    pub metadata: Value,
    pub episode_source_locator: Option<String>,
    pub episode: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchMode {
    Keyword,
    Semantic,
    Hybrid,
}

impl SearchMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Keyword => "keyword",
            Self::Semantic => "semantic",
            Self::Hybrid => "hybrid",
        }
    }
}

#[derive(Debug, Clone)]
struct ScoredFact {
    fact: RecallFact,
    keyword_score: f64,
    semantic_score: f64,
    governance_boost: f64,
    score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveFactSnapshot {
    pub subject: String,
    pub predicate: String,
    pub object: String,
    pub source: String,
}

#[derive(Debug, Clone)]
struct GraphEdge {
    from: String,
    predicate: String,
    to: String,
    fact_id: String,
    source: String,
}

pub struct Store {
    conn: Connection,
    workspace_id: String,
    now: String,
}

impl Store {
    pub fn open(path: impl AsRef<Path>, options: StoreOptions) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create sqlite parent {}", parent.display()))?;
        }
        let conn =
            Connection::open(path).with_context(|| format!("open sqlite {}", path.display()))?;
        conn.busy_timeout(Duration::from_millis(5_000))?;
        if path != Path::new(":memory:") {
            conn.pragma_update(None, "journal_mode", "WAL")?;
        }
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let store = Self {
            conn,
            workspace_id: if options.workspace_id.is_empty() {
                "ws_local".to_string()
            } else {
                options.workspace_id
            },
            now: if options.now.is_empty() {
                Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
            } else {
                options.now
            },
        };
        store.migrate()?;
        Ok(store)
    }

    pub fn open_read_only(path: impl AsRef<Path>, options: StoreOptions) -> Result<Self> {
        let path = path.as_ref();
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .with_context(|| format!("open read-only sqlite {}", path.display()))?;
        conn.busy_timeout(Duration::from_millis(5_000))?;
        Ok(Self {
            conn,
            workspace_id: if options.workspace_id.is_empty() {
                "ws_local".to_string()
            } else {
                options.workspace_id
            },
            now: if options.now.is_empty() {
                Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
            } else {
                options.now
            },
        })
    }

    fn migrate(&self) -> Result<()> {
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS memory_records (
              id TEXT PRIMARY KEY,
              workspace_id TEXT NOT NULL,
              kind TEXT NOT NULL,
              text TEXT NOT NULL,
              scope TEXT NOT NULL,
              status TEXT NOT NULL,
              source TEXT NOT NULL,
              source_trust TEXT NOT NULL DEFAULT 'unverified',
              decision TEXT NOT NULL DEFAULT 'allow',
              reasons_json TEXT NOT NULL DEFAULT '[]',
              confidence REAL NOT NULL,
              authority REAL NOT NULL,
              tags_json TEXT NOT NULL,
              relations_json TEXT NOT NULL,
              observed_at TEXT NOT NULL,
              valid_from TEXT,
              valid_to TEXT,
              supersedes TEXT,
              retention TEXT NOT NULL,
              data_class TEXT NOT NULL DEFAULT 'workspace-private',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              content_hash TEXT NOT NULL,
              evidence_ids_json TEXT NOT NULL DEFAULT '[]',
              conflicts_json TEXT NOT NULL DEFAULT '[]',
              verified_by TEXT,
              activated_by TEXT,
              lifecycle_json TEXT NOT NULL DEFAULT '[]',
              metadata_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_memory_workspace_status ON memory_records(workspace_id, status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memory_supersedes ON memory_records(workspace_id, supersedes);
            CREATE TABLE IF NOT EXISTS memory_proposal_queue (
              id TEXT PRIMARY KEY,
              workspace_id TEXT NOT NULL,
              fingerprint TEXT NOT NULL,
              source_locator TEXT NOT NULL,
              source_hash TEXT NOT NULL,
              status TEXT NOT NULL,
              attempts INTEGER NOT NULL,
              max_attempts INTEGER NOT NULL,
              lease_owner TEXT,
              lease_until TEXT,
              payload_json TEXT NOT NULL,
              result_json TEXT,
              error_json TEXT,
              enqueued_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE(workspace_id, fingerprint)
            );
            CREATE INDEX IF NOT EXISTS idx_memory_proposal_queue_claim ON memory_proposal_queue(workspace_id, status, lease_until, enqueued_at);
            CREATE INDEX IF NOT EXISTS idx_memory_proposal_queue_errors ON memory_proposal_queue(workspace_id, status, updated_at DESC);
            CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
              id UNINDEXED,
              workspace_id UNINDEXED,
              kind,
              text,
              tags,
              tokenize='unicode61 remove_diacritics 2'
            );
            CREATE TABLE IF NOT EXISTS memory_episodes (
              id TEXT PRIMARY KEY,
              workspace_id TEXT NOT NULL,
              scope TEXT NOT NULL,
              source_locator TEXT NOT NULL,
              summary TEXT NOT NULL,
              observed_at TEXT NOT NULL,
              created_at TEXT NOT NULL,
              metadata_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_memory_episodes_workspace ON memory_episodes(workspace_id, scope, observed_at DESC);
            CREATE TABLE IF NOT EXISTS memory_entities (
              id TEXT PRIMARY KEY,
              workspace_id TEXT NOT NULL,
              scope TEXT NOT NULL,
              kind TEXT NOT NULL,
              name TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE(workspace_id, scope, kind, name)
            );
            CREATE TABLE IF NOT EXISTS memory_facts (
              id TEXT PRIMARY KEY,
              workspace_id TEXT NOT NULL,
              scope TEXT NOT NULL,
              subject TEXT NOT NULL,
              predicate TEXT NOT NULL,
              object TEXT NOT NULL,
              text TEXT NOT NULL,
              status TEXT NOT NULL,
              source TEXT NOT NULL,
              confidence REAL NOT NULL,
              valid_from TEXT NOT NULL,
              valid_until TEXT,
              superseded_by TEXT,
              episode_id TEXT NOT NULL,
              proposal_queue_id TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              metadata_json TEXT NOT NULL,
              FOREIGN KEY(episode_id) REFERENCES memory_episodes(id)
            );
            CREATE INDEX IF NOT EXISTS idx_memory_facts_lookup ON memory_facts(workspace_id, scope, subject, predicate, valid_from, valid_until);
            CREATE INDEX IF NOT EXISTS idx_memory_facts_superseded ON memory_facts(workspace_id, superseded_by);
            CREATE INDEX IF NOT EXISTS idx_memory_facts_episode ON memory_facts(workspace_id, episode_id);
            CREATE TABLE IF NOT EXISTS memory_edges (
              id TEXT PRIMARY KEY,
              workspace_id TEXT NOT NULL,
              scope TEXT NOT NULL,
              source_entity_id TEXT NOT NULL,
              target_entity_id TEXT NOT NULL,
              predicate TEXT NOT NULL,
              fact_id TEXT NOT NULL,
              created_at TEXT NOT NULL,
              UNIQUE(workspace_id, scope, fact_id),
              FOREIGN KEY(source_entity_id) REFERENCES memory_entities(id),
              FOREIGN KEY(target_entity_id) REFERENCES memory_entities(id),
              FOREIGN KEY(fact_id) REFERENCES memory_facts(id)
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS memory_fact_fts USING fts5(
              id UNINDEXED,
              workspace_id UNINDEXED,
              scope UNINDEXED,
              subject,
              predicate,
              object,
              text,
              tokenize='unicode61 remove_diacritics 2'
            );
            CREATE TABLE IF NOT EXISTS memory_semantic_embeddings (
              fact_id TEXT NOT NULL,
              workspace_id TEXT NOT NULL,
              model TEXT NOT NULL,
              dimensions INTEGER NOT NULL,
              vector_json TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY(workspace_id, fact_id, model)
            );
            "#,
        )?;
        self.integrity_check()?;
        Ok(())
    }

    pub fn remember_single(
        &mut self,
        scope: &str,
        subject: &str,
        predicate: &str,
        object: &str,
        source: &str,
        supersedes: bool,
    ) -> Result<ApproveReport> {
        self.remember_single_with_trust(
            scope, subject, predicate, object, source, "verified", supersedes,
        )
    }

    pub fn remember_single_with_trust(
        &mut self,
        scope: &str,
        subject: &str,
        predicate: &str,
        object: &str,
        source: &str,
        source_trust: &str,
        supersedes: bool,
    ) -> Result<ApproveReport> {
        let source_trust = normalize_source_trust(source_trust)?;
        let proposal = build_proposal_input(
            &self.workspace_id,
            scope,
            subject,
            predicate,
            object,
            &normalize_workspace_locator(source)?,
            &self.now,
            &self.now,
            "extracted",
            None,
            &source_trust,
            supersedes,
            None,
        )?;
        self.begin()?;
        let result = (|| {
            self.enqueue_proposal_uncommitted(&proposal)?;
            if source_trust == "untrusted" {
                let proposal = self.proposal_row_value(&proposal.id)?;
                Ok(ApproveReport {
                    pending_proposal_count: 1,
                    proposal: Some(proposal),
                    policy_receipts: vec![policy_receipt(
                        "queue_only",
                        "untrusted_source_requires_explicit_approval",
                        &source_trust,
                    )],
                    ..ApproveReport::default()
                })
            } else {
                self.approve_proposal_uncommitted(&proposal.id, "memory-remember")
            }
        })();
        self.finish(result)
    }

    pub fn remember_batch(
        &mut self,
        root: &Path,
        scope: &str,
        facts: &[BatchFact],
    ) -> Result<BatchReport> {
        let mut normalized = Vec::new();
        let mut seen = HashSet::new();
        let mut skipped = Vec::new();
        let mut skipped_unsafe_count = 0;
        let mut skipped_duplicate_count = 0;
        for (index, fact) in facts.iter().enumerate() {
            match normalize_batch_fact(root, fact) {
                Ok(fact) => {
                    let key = format!("{}\0{}\0{}", fact.subject, fact.predicate, fact.object);
                    if !seen.insert(key) {
                        skipped_duplicate_count += 1;
                        continue;
                    }
                    normalized.push((index, fact));
                }
                Err(error) => {
                    skipped_unsafe_count += 1;
                    skipped.push(json!({
                        "index": index,
                        "subject": sanitize_string(&fact.subject, 128),
                        "predicate": sanitize_string(&fact.predicate, 128),
                        "reason": error.to_string()
                    }));
                }
            }
        }

        self.begin()?;
        let result = (|| {
            let mut proposal_facts = Vec::new();
            let mut recorded_fingerprints = HashSet::new();
            let mut existing_statuses = self.proposal_statuses_by_fingerprint()?;
            let mut enqueue = self.conn.prepare(
                r#"
                INSERT INTO memory_proposal_queue (
                  id, workspace_id, fingerprint, source_locator, source_hash, status,
                  attempts, max_attempts, lease_owner, lease_until, payload_json,
                  result_json, error_json, enqueued_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, 3, NULL, NULL, ?6, NULL, NULL, ?7, ?8)
                ON CONFLICT(workspace_id, fingerprint) DO UPDATE SET updated_at=excluded.updated_at
                "#,
            )?;
            for (index, fact) in &normalized {
                let enqueued_at = add_milliseconds(&self.now, *index as i64)?;
                let proposal = build_proposal_input(
                    &self.workspace_id,
                    scope,
                    &fact.subject,
                    &fact.predicate,
                    &fact.object,
                    &fact.source,
                    &self.now,
                    &enqueued_at,
                    &fact.extraction_confidence,
                    fact.notes.as_deref(),
                    &fact.source_trust,
                    fact.supersedes,
                    fact.supersedes_object.as_deref(),
                )?;
                let fingerprint = proposal_fingerprint(&self.workspace_id, &proposal);
                let final_status = existing_statuses
                    .get(&fingerprint)
                    .map(String::as_str)
                    .unwrap_or("pending")
                    .to_string();
                enqueue.execute(params![
                    proposal.id,
                    self.workspace_id,
                    fingerprint,
                    proposal.source_locator,
                    proposal.source_hash,
                    proposal.payload_json.clone(),
                    proposal.enqueued_at,
                    self.now
                ])?;
                if std::env::var("OAF_STORE_ABORT_AFTER_UNCOMMITTED_WRITE")
                    .ok()
                    .as_deref()
                    == Some("1")
                {
                    std::process::abort();
                }
                existing_statuses
                    .entry(fingerprint.clone())
                    .or_insert_with(|| "pending".to_string());
                if matches!(final_status.as_str(), "pending" | "claimed")
                    && recorded_fingerprints.insert(fingerprint)
                {
                    if proposal_facts.len() < PROPOSAL_PREVIEW_LIMIT {
                        if let Some(value) =
                            summarize_proposal_input(&self.workspace_id, &proposal, &final_status)?
                        {
                            proposal_facts.push(value);
                        }
                    }
                }
            }
            Ok(BatchReport {
                recorded_count: recorded_fingerprints.len(),
                skipped_unsafe_count,
                skipped_duplicate_count,
                skipped: skipped.clone(),
                proposal_facts,
            })
        })();
        let report = self.finish(result)?;
        if report.recorded_count > 0 {
            let pending: i64 = self.conn.query_row(
                "SELECT count(*) FROM memory_proposal_queue WHERE workspace_id = ? AND status = 'pending'",
                params![self.workspace_id],
                |row| row.get(0),
            )?;
            if pending < report.recorded_count as i64 {
                bail!("integrity check failed: fewer pending proposals than recorded");
            }
        }
        Ok(report)
    }

    pub fn approve_all_from(&mut self, source: &str) -> Result<ApproveReport> {
        let source = normalize_workspace_locator(source)?;
        self.approve_bulk(Some(&source))
    }

    pub fn approve_all(&mut self) -> Result<ApproveReport> {
        self.approve_bulk(None)
    }

    pub fn approve_one(&mut self, id: &str) -> Result<ApproveReport> {
        self.approve_ids(vec![id.to_string()])
    }

    pub fn reject_one(&mut self, id: &str, reason: &str) -> Result<ApproveReport> {
        self.begin()?;
        let result = (|| {
            let proposal = self.claim_result_uncommitted(
                id,
                "memory-review",
                json!({ "accepted": false, "command": "memory reject", "rejectedAt": self.now, "reason": reason }),
            )?;
            Ok(ApproveReport {
                rejected_proposal_count: 1,
                proposal: Some(proposal),
                ..ApproveReport::default()
            })
        })();
        self.finish(result)
    }

    pub fn review_pending(&self, limit: usize) -> Result<Vec<Value>> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM memory_proposal_queue WHERE workspace_id = ? AND status = 'pending' ORDER BY enqueued_at DESC, id ASC LIMIT ?",
        )?;
        let rows = stmt.query_map(params![self.workspace_id, limit as i64], |row| {
            proposal_row_to_value(row)
        })?;
        let mut out = Vec::new();
        for row in rows {
            if let Some(value) = summarize_proposal_value(&row?)? {
                out.push(value);
            }
        }
        Ok(out)
    }

    pub fn recall_current_truth(
        &self,
        scope: &str,
        query: &str,
        subject: Option<&str>,
        predicate: Option<&str>,
        limit: usize,
    ) -> Result<Vec<Value>> {
        Ok(self
            .recall_facts(scope, query, subject, predicate, limit)?
            .into_iter()
            .filter(|fact| fact.status == "active" && fact.superseded_by.is_none())
            .take(limit)
            .map(|fact| summarize_current_truth_fact(&fact))
            .collect())
    }

    pub fn current_truth_conflicts(
        &self,
        scope: &str,
        query: &str,
        subject: Option<&str>,
        predicate: Option<&str>,
    ) -> Result<Value> {
        let mut groups: BTreeMap<(String, String), Vec<RecallFact>> = BTreeMap::new();
        for fact in self.recall_facts(scope, query, subject, predicate, 100)? {
            if fact.status == "active" && fact.superseded_by.is_none() {
                groups
                    .entry((fact.subject.clone(), fact.predicate.clone()))
                    .or_default()
                    .push(fact);
            }
        }
        let mut items = Vec::new();
        for ((subject, predicate), mut facts) in groups {
            let objects = facts
                .iter()
                .map(|fact| fact.object.clone())
                .collect::<BTreeSet<_>>();
            if objects.len() < 2 {
                continue;
            }
            facts.sort_by(|left, right| {
                left.object
                    .cmp(&right.object)
                    .then_with(|| left.valid_from.cmp(&right.valid_from))
                    .then_with(|| left.id.cmp(&right.id))
            });
            let fact_values = facts.iter().map(conflict_fact_value).collect::<Vec<_>>();
            items.push(json!({
                "id": deterministic_id("ctconf", &json!({
                    "workspaceId": self.workspace_id,
                    "scope": scope,
                    "subject": subject,
                    "predicate": predicate,
                    "objects": objects
                })),
                "reason": "active_same_subject_predicate",
                "scope": scope,
                "subject": subject,
                "predicate": predicate,
                "objects": objects.into_iter().collect::<Vec<_>>(),
                "activeFactCount": fact_values.len(),
                "facts": fact_values
            }));
        }
        Ok(json!({
            "summary": { "conflictCount": items.len() },
            "items": items
        }))
    }

    pub fn search_current_truth(
        &mut self,
        scope: &str,
        query: &str,
        mode: SearchMode,
        semantic_enabled: bool,
        limit: usize,
    ) -> Result<Value> {
        let limit = limit.clamp(1, 50);
        if mode != SearchMode::Keyword && !semantic_enabled {
            bail!("semantic search modes require --semantic");
        }
        let keyword_hits = self
            .recall_facts(scope, query, None, None, 100)?
            .into_iter()
            .filter(|fact| fact.status == "active" && fact.superseded_by.is_none())
            .take(100)
            .enumerate()
            .map(|(index, fact)| (fact.id.clone(), 1.0 / (index as f64 + 1.0), fact))
            .collect::<Vec<_>>();
        let mut by_id: BTreeMap<String, ScoredFact> = BTreeMap::new();
        for (id, keyword_score, fact) in keyword_hits {
            by_id.insert(
                id,
                ScoredFact {
                    governance_boost: governance_boost(&fact),
                    fact,
                    keyword_score,
                    semantic_score: 0.0,
                    score: 0.0,
                },
            );
        }

        let mut embedding_rows_built = 0usize;
        let mut semantic_candidate_count = 0usize;
        let mut semantic_token_count = 0usize;
        let mut semantic_dimensions = 0usize;
        if semantic_enabled {
            let facts = self.active_current_facts(scope, 50_000)?;
            let index = RandomIndex::build(&facts);
            semantic_token_count = index.vocab_size();
            semantic_dimensions = RI_DIM;
            embedding_rows_built = index.doc_count();
            let query_vector = index.query_vector(query);
            if !query_vector.vector.is_empty() {
                semantic_candidate_count = facts.len();
                for fact in facts {
                    let semantic_score = index.score(&query_vector, query, &fact).max(0.0);
                    let entry = by_id.entry(fact.id.clone()).or_insert_with(|| ScoredFact {
                        governance_boost: governance_boost(&fact),
                        fact,
                        keyword_score: 0.0,
                        semantic_score: 0.0,
                        score: 0.0,
                    });
                    entry.semantic_score = semantic_score;
                }
            }
        }

        let mut scored = by_id.into_values().collect::<Vec<_>>();
        for item in &mut scored {
            item.score = match mode {
                SearchMode::Keyword => item.keyword_score + item.governance_boost,
                SearchMode::Semantic => item.semantic_score + item.governance_boost,
                SearchMode::Hybrid => {
                    (item.semantic_score * 0.72)
                        + (item.keyword_score * 0.23)
                        + item.governance_boost
                }
            };
        }
        scored.sort_by(|left, right| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    right
                        .semantic_score
                        .partial_cmp(&left.semantic_score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .then_with(|| {
                    right
                        .keyword_score
                        .partial_cmp(&left.keyword_score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .then_with(|| left.fact.id.cmp(&right.fact.id))
        });
        let hits = scored
            .into_iter()
            .filter(|item| item.score > 0.0)
            .take(limit)
            .map(search_hit_value)
            .collect::<Vec<_>>();
        Ok(json!({
            "query": query,
            "scope": scope,
            "mode": mode.as_str(),
            "hitCount": hits.len(),
            "hits": hits,
            "semantic": {
                "enabled": semantic_enabled,
                "tableLoaded": semantic_enabled,
                "model": if semantic_enabled { Some("random-indexing") } else { None },
                "revision": if semantic_enabled { Some("corpus-local") } else { None },
                "license": if semantic_enabled { Some("Apache-2.0; technique attributed to codebase-memory-mcp MIT") } else { None },
                "dimensions": semantic_dimensions,
                "tokenCount": semantic_token_count,
                "embeddingRowsBuilt": embedding_rows_built,
                "candidateCount": semantic_candidate_count,
                "signals": if semantic_enabled { Some(json!({
                    "tfidf": 0.20,
                    "randomIndexing": 0.70,
                    "minhash": 0.10,
                    "cooccurrenceWindow": RI_WINDOW,
                    "sparseNonZero": RI_SPARSE_NNZ
                })) } else { None }
            }
        }))
    }

    pub fn recall_delta(
        &self,
        scope: &str,
        query: &str,
        subject: Option<&str>,
        predicate: Option<&str>,
        limit: usize,
        since: &str,
    ) -> Result<Value> {
        let changes: Vec<Value> = self
            .recall_facts(scope, query, subject, predicate, limit)?
            .into_iter()
            .filter(|fact| {
                fact.status == "active"
                    && fact.superseded_by.is_none()
                    && changed_since(fact, since)
            })
            .take(limit)
            .map(|fact| summarize_current_truth_fact(&fact))
            .collect();
        let retracted = self.retracted_ids(scope, query, subject, predicate, since)?;
        Ok(json!({ "c": self.now, "d": changes, "r": retracted }))
    }

    pub fn profile_records(
        &self,
        scope: &str,
        query: &str,
        subject: Option<&str>,
        predicate: Option<&str>,
        limit: usize,
        since: Option<&str>,
    ) -> Result<Vec<Value>> {
        Ok(self
            .recall_facts(scope, query, subject, predicate, limit)?
            .into_iter()
            .filter(|fact| {
                fact.status == "active"
                    && fact.superseded_by.is_none()
                    && since.is_none_or(|since| changed_since(fact, since))
            })
            .take(limit)
            .map(|fact| profile_record_from_fact(&fact))
            .collect())
    }

    pub fn profile_selected_facts(
        &self,
        scope: &str,
        query: &str,
        subject: Option<&str>,
        predicate: Option<&str>,
        limit: usize,
        since: Option<&str>,
    ) -> Result<Vec<Value>> {
        Ok(self
            .recall_facts(scope, query, subject, predicate, limit)?
            .into_iter()
            .filter(|fact| {
                fact.status == "active"
                    && fact.superseded_by.is_none()
                    && since.is_none_or(|since| changed_since(fact, since))
            })
            .take(limit)
            .map(|fact| profile_selected_fact_value(&fact))
            .collect())
    }

    pub fn omission_candidates(
        &self,
        scope: &str,
        query: &str,
        subject: Option<&str>,
        predicate: Option<&str>,
        limit: usize,
    ) -> Result<Vec<Value>> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM memory_facts WHERE workspace_id = ? AND scope = ? AND status IN ('active', 'superseded') ORDER BY valid_from DESC, id ASC LIMIT ?",
        )?;
        let rows = stmt.query_map(
            params![self.workspace_id, scope, limit.clamp(1, 500) as i64],
            |row| fact_from_row(&self.conn, row),
        )?;
        let mut out = Vec::new();
        for row in rows {
            let fact = row?;
            if subject.is_some_and(|subject| fact.subject != subject)
                || predicate.is_some_and(|predicate| fact.predicate != predicate)
                || !fact_matches_query(&fact, query)
            {
                continue;
            }
            out.push(json!({
                "id": format!("mem_{}", fact.id),
                "factId": sanitize_string(&fact.id, 120),
                "text": sanitize_string(&fact.text, 300),
                "subject": sanitize_string(&fact.subject, 160),
                "predicate": sanitize_string(&fact.predicate, 120),
                "status": fact.status,
                "supersededBy": fact.superseded_by,
                "sourceRef": compact_provenance_ref(fact.episode_source_locator.as_deref().unwrap_or(&fact.source))
            }));
        }
        Ok(out)
    }

    pub fn memory_why(&self, fact_id: &str, at: &str) -> Result<Value> {
        let fact = self
            .conn
            .query_row(
                "SELECT * FROM memory_facts WHERE workspace_id = ? AND id = ?",
                params![self.workspace_id, fact_id],
                |row| fact_from_row(&self.conn, row),
            )
            .optional()?
            .ok_or_else(|| anyhow!("memory why fact not found"))?;
        let proposal = self
            .conn
            .query_row(
                "SELECT * FROM memory_proposal_queue WHERE workspace_id = ? AND id = ?",
                params![self.workspace_id, fact.proposal_queue_id],
                proposal_row_to_value,
            )
            .optional()?;
        let supersedes = self.facts_superseded_by(&fact.id)?;
        let superseded_by = if let Some(id) = fact.superseded_by.as_deref() {
            self.fact_brief_by_id(id)?
        } else {
            None
        };
        let source_hash = proposal
            .as_ref()
            .and_then(|value| value.get("sourceHash"))
            .cloned()
            .or_else(|| fact.metadata.get("sourceHash").cloned())
            .unwrap_or(Value::Null);
        let source_locator = fact
            .episode_source_locator
            .as_deref()
            .unwrap_or(&fact.source)
            .to_string();
        let chain = vec![
            json!({ "type": "source", "id": source_locator }),
            json!({ "type": "episode", "id": fact.episode_id }),
            json!({ "type": "proposal", "id": fact.proposal_queue_id }),
            json!({ "type": "fact", "id": fact.id }),
        ];
        Ok(json!({
            "fact": fact_brief(&fact),
            "source": {
                "sourceLocator": safe_locator(&source_locator),
                "sourceHash": source_hash
            },
            "episode": fact.episode,
            "proposal": proposal,
            "chain": chain,
            "confidence": fact.confidence,
            "validity": {
                "asOf": at,
                "validFrom": fact.valid_from,
                "validUntil": fact.valid_until,
                "currentAt": fact.valid_from.as_str() <= at && fact.valid_until.as_deref().is_none_or(|until| until > at)
            },
            "supersedes": supersedes,
            "supersededBy": superseded_by
        }))
    }

    pub fn active_value(
        &self,
        scope: &str,
        subject: &str,
        predicate: &str,
    ) -> Result<Option<String>> {
        self.conn
            .query_row(
                r#"
                SELECT object FROM memory_facts
                WHERE workspace_id = ?1
                  AND scope = ?2
                  AND subject = ?3
                  AND predicate = ?4
                  AND status = 'active'
                  AND superseded_by IS NULL
                ORDER BY valid_from DESC, id ASC
                LIMIT 1
                "#,
                params![self.workspace_id, scope, subject, predicate],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn detect_changes(
        &self,
        scope: &str,
        changed_locators: &[String],
        max_depth: usize,
        at: &str,
    ) -> Result<Value> {
        let edges = self.temporal_graph_edges(scope, at)?;
        let changed: BTreeSet<String> = changed_locators.iter().cloned().collect();
        let mut symbol_source = BTreeMap::new();
        let mut changed_symbols = BTreeSet::new();
        let mut stmt = self.conn.prepare(
            r#"
            SELECT subject, object, source FROM memory_facts
            WHERE workspace_id = ?1
              AND scope = ?2
              AND predicate = 'IS_A'
              AND object IN ('Function', 'Class', 'Method')
              AND status = 'active'
              AND superseded_by IS NULL
            ORDER BY subject ASC
            "#,
        )?;
        let rows = stmt.query_map(params![self.workspace_id, scope], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (name, kind, source) = row?;
            symbol_source.insert(name.clone(), (kind, source.clone()));
            if changed.contains(&source) {
                changed_symbols.insert(name);
            }
        }

        let mut affected_depth = BTreeMap::new();
        let mut queue = VecDeque::new();
        for name in &changed_symbols {
            affected_depth.insert(name.clone(), 0usize);
            queue.push_back(name.clone());
        }
        let bounded_depth = max_depth.clamp(1, 12);
        while let Some(callee) = queue.pop_front() {
            let depth = affected_depth.get(&callee).copied().unwrap_or(0);
            if depth >= bounded_depth {
                continue;
            }
            for edge in edges
                .iter()
                .filter(|edge| edge.predicate == "CALLS" && edge.to == callee)
            {
                if edge.from.starts_with("module:") || affected_depth.contains_key(&edge.from) {
                    continue;
                }
                affected_depth.insert(edge.from.clone(), depth + 1);
                queue.push_back(edge.from.clone());
            }
        }

        let mut affected_symbols = Vec::new();
        for (name, depth) in affected_depth {
            if name.starts_with("module:") {
                continue;
            }
            let (kind, source) = symbol_source
                .get(&name)
                .cloned()
                .unwrap_or_else(|| (symbol_kind(&name), "workspace://unknown".to_string()));
            affected_symbols.push(json!({
                "name": name,
                "symbolKind": kind.to_ascii_lowercase(),
                "depth": depth,
                "sourceRef": source,
                "reasonCodes": if depth == 0 { vec!["changed_locator"] } else { vec!["reverse_call_graph"] }
            }));
        }
        affected_symbols.sort_by(|left, right| {
            left.get("depth")
                .and_then(Value::as_u64)
                .cmp(&right.get("depth").and_then(Value::as_u64))
                .then_with(|| {
                    left.get("name")
                        .and_then(Value::as_str)
                        .cmp(&right.get("name").and_then(Value::as_str))
                })
        });

        let represented: BTreeSet<String> = changed_symbols
            .iter()
            .filter_map(|name| symbol_source.get(name).map(|(_, source)| source.clone()))
            .collect();
        let unresolved: Vec<Value> = changed
            .iter()
            .filter(|locator| !represented.contains(*locator))
            .map(|locator| json!({ "locator": locator, "reason": "no_function_class_or_method_symbol" }))
            .collect();
        let module_false = affected_symbols
            .iter()
            .filter(|item| {
                item.get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| name.starts_with("module:"))
            })
            .count();

        Ok(json!({
            "changedLocators": changed_locators,
            "representedChangedLocators": represented.into_iter().collect::<Vec<_>>(),
            "affectedSymbols": affected_symbols,
            "unresolved": unresolved,
            "quality": {
                "moduleLevelFalseAttributionCount": module_false,
                "maxDepth": bounded_depth
            }
        }))
    }

    pub fn entity_name_counts(&self) -> Result<Vec<(String, usize)>> {
        let mut stmt = self.conn.prepare(
            "SELECT name, count(*) FROM memory_entities WHERE workspace_id = ? GROUP BY workspace_id, scope, name ORDER BY name",
        )?;
        let rows = stmt.query_map(params![self.workspace_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as usize))
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn active_ingest_facts(&self, scope: &str) -> Result<Vec<ActiveFactSnapshot>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT subject, predicate, object, source
            FROM memory_facts
            WHERE workspace_id = ?1
              AND scope = ?2
              AND status = 'active'
              AND superseded_by IS NULL
              AND object NOT LIKE 'retired_%'
              AND metadata_json LIKE '%oaf.ingest:%'
            ORDER BY subject, predicate, object, source
            "#,
        )?;
        let rows = stmt.query_map(params![self.workspace_id, scope], |row| {
            Ok(ActiveFactSnapshot {
                subject: row.get(0)?,
                predicate: row.get(1)?,
                object: row.get(2)?,
                source: row.get(3)?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn active_facts_for_key(
        &self,
        scope: &str,
        subject: &str,
        predicate: &str,
    ) -> Result<Vec<ActiveFactSnapshot>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT subject, predicate, object, source
            FROM memory_facts
            WHERE workspace_id = ?1
              AND scope = ?2
              AND subject = ?3
              AND predicate = ?4
              AND status = 'active'
              AND superseded_by IS NULL
              AND object NOT LIKE 'retired_%'
            ORDER BY object, source
            "#,
        )?;
        let rows = stmt.query_map(
            params![self.workspace_id, scope, subject, predicate],
            |row| {
                Ok(ActiveFactSnapshot {
                    subject: row.get(0)?,
                    predicate: row.get(1)?,
                    object: row.get(2)?,
                    source: row.get(3)?,
                })
            },
        )?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn graph_path(
        &self,
        scope: &str,
        from: &str,
        to: &str,
        max_hops: usize,
        undirected: bool,
        at: &str,
    ) -> Result<Value> {
        if from.trim().is_empty() || to.trim().is_empty() {
            bail!("from and to are required");
        }
        let scope = normalize_temporal_scope(scope)?;
        let max_hops = max_hops.clamp(1, 12);
        if from == to {
            let path = vec![json!({ "name": from })];
            return Ok(json!({
                "schemaVersion": "1.0.0",
                "provider": PROVIDER_ID,
                "workspaceId": self.workspace_id,
                "scope": scope,
                "at": at,
                "maxHops": max_hops,
                "undirected": undirected,
                "path": path,
                "nodes": path,
                "edges": []
            }));
        }

        let edges = self.temporal_graph_edges(&scope, at)?;
        let mut adjacency: BTreeMap<String, Vec<GraphEdge>> = BTreeMap::new();
        for edge in edges {
            adjacency
                .entry(edge.from.clone())
                .or_default()
                .push(edge.clone());
            if undirected {
                let mut reversed = edge;
                std::mem::swap(&mut reversed.from, &mut reversed.to);
                adjacency
                    .entry(reversed.from.clone())
                    .or_default()
                    .push(reversed);
            }
        }

        let mut queue = VecDeque::from([PathState {
            node: from.to_string(),
            path: vec![from.to_string()],
            edges: Vec::new(),
        }]);
        let mut visited = HashSet::from([from.to_string()]);
        let mut found: Option<PathState> = None;
        while let Some(current) = queue.pop_front() {
            if found.is_some() {
                break;
            }
            if current.edges.len() >= max_hops {
                continue;
            }
            for edge in adjacency.get(&current.node).cloned().unwrap_or_default() {
                if visited.contains(&edge.to) {
                    continue;
                }
                let mut next = current.clone();
                next.node = edge.to.clone();
                next.path.push(edge.to.clone());
                next.edges.push(edge.clone());
                if edge.to == to {
                    found = Some(next);
                    break;
                }
                visited.insert(edge.to);
                queue.push_back(next);
            }
        }

        let path = found
            .as_ref()
            .map(|state| {
                state
                    .path
                    .iter()
                    .map(|name| json!({ "name": name }))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let edge_values = found
            .as_ref()
            .map(|state| state.edges.iter().map(graph_edge_value).collect::<Vec<_>>())
            .unwrap_or_default();
        Ok(json!({
            "schemaVersion": "1.0.0",
            "provider": PROVIDER_ID,
            "workspaceId": self.workspace_id,
            "scope": scope,
            "at": at,
            "maxHops": max_hops,
            "undirected": undirected,
            "path": path,
            "nodes": path,
            "edges": edge_values
        }))
    }

    pub fn graph_explain(
        &self,
        scope: &str,
        entity: Option<&str>,
        query: Option<&str>,
        depth: usize,
        at: &str,
    ) -> Result<Value> {
        let scope = normalize_temporal_scope(scope)?;
        let query = query.unwrap_or("");
        let edges = self.temporal_graph_edges(&scope, at)?;
        let entity_name = resolve_temporal_entity_name(&edges, entity, query)
            .ok_or_else(|| anyhow!("entity is required"))?;
        let depth = depth.clamp(1, 6);
        let mut nodes = vec![json!({ "name": entity_name, "depth": 0 })];
        let mut depths = HashMap::from([(entity_name.clone(), 0usize)]);
        let mut edge_keys = HashSet::new();
        let mut selected_edges = Vec::new();
        let mut frontier = vec![entity_name.clone()];
        for level in 1..=depth {
            let mut next_frontier = Vec::new();
            for node in &frontier {
                for edge in &edges {
                    if edge.from != *node && edge.to != *node {
                        continue;
                    }
                    let key = format!(
                        "{}\0{}\0{}\0{}",
                        edge.from, edge.predicate, edge.to, edge.fact_id
                    );
                    if edge_keys.insert(key) {
                        selected_edges.push(edge.clone());
                    }
                    let other = if edge.from == *node {
                        &edge.to
                    } else {
                        &edge.from
                    };
                    if !depths.contains_key(other) {
                        depths.insert(other.clone(), level);
                        nodes.push(json!({ "name": other, "depth": level }));
                        next_frontier.push(other.clone());
                    }
                }
            }
            frontier = next_frontier;
        }
        let scoped_digest =
            scoped_digest(query, at, Vec::<String>::new(), Vec::<[String; 3]>::new());
        Ok(json!({
            "schemaVersion": "1.0.0",
            "provider": PROVIDER_ID,
            "workspaceId": self.workspace_id,
            "scope": scope,
            "query": query,
            "entity": entity_name,
            "depth": depth,
            "at": at,
            "nodes": nodes,
            "edges": selected_edges.iter().map(graph_edge_value).collect::<Vec<_>>(),
            "semantic": { "status": "skipped", "reason": "local_embedder_unavailable" },
            "scopedDigest": scoped_digest
        }))
    }

    pub fn query_graph(
        &self,
        scope: &str,
        cypher: &str,
        at: &str,
        max_rows: usize,
    ) -> Result<Value> {
        let scope = normalize_temporal_scope(scope)?;
        let parsed = parse_cypher(cypher)?;
        let at = parsed.at.as_deref().unwrap_or(at);
        let edges = self.temporal_graph_edges(&scope, at)?;
        let result = evaluate_cypher(&parsed, &edges, max_rows.clamp(1, 500))?;
        Ok(json!({
            "schemaVersion": "1.0.0",
            "command": "query.graph",
            "provider": PROVIDER_ID,
            "workspaceId": self.workspace_id,
            "scope": scope,
            "at": at,
            "cypher": cypher,
            "columns": result.columns,
            "rowCount": result.rows.len(),
            "truncated": result.truncated,
            "rows": result.rows,
            "supportedSubset": [
                "MATCH (n:Label)-[:REL]->(m:Label)",
                "WHERE property compares with AND/OR/NOT and n:Label",
                "RETURN properties, AS, labels(n), count(*), count(DISTINCT x)",
                "WITH DISTINCT",
                "ORDER BY",
                "LIMIT",
                "toInteger()",
                "AS OF '<iso-timestamp>'"
            ],
            "safeguards": read_only_safeguards()
        }))
    }

    pub fn architecture_overview(&self, scope: &str, at: &str, max_items: usize) -> Result<Value> {
        let scope = normalize_temporal_scope(scope)?;
        let max_items = max_items.clamp(1, 50);
        let edges = self.temporal_graph_edges(&scope, at)?;
        let mut nodes: BTreeMap<String, OverviewNode> = BTreeMap::new();
        let mut out_degree: HashMap<String, usize> = HashMap::new();
        let mut in_degree: HashMap<String, usize> = HashMap::new();
        let mut language_counts: BTreeMap<String, usize> = BTreeMap::new();
        for edge in &edges {
            for name in [&edge.from, &edge.to] {
                nodes.entry(name.clone()).or_insert_with(|| OverviewNode {
                    name: name.clone(),
                    entity_type: temporal_graph_entity_type(name),
                    degree: 0,
                    community: 0,
                });
                if let Some(language) = infer_language(name) {
                    *language_counts.entry(language).or_default() += 1;
                }
            }
            if let Some(language) = infer_language(&edge.source) {
                *language_counts.entry(language).or_default() += 1;
            }
            *out_degree.entry(edge.from.clone()).or_default() += 1;
            *in_degree.entry(edge.to.clone()).or_default() += 1;
        }
        for node in nodes.values_mut() {
            node.degree = out_degree.get(&node.name).copied().unwrap_or(0)
                + in_degree.get(&node.name).copied().unwrap_or(0);
        }
        let communities = graph_communities(nodes.keys().cloned().collect(), &edges);
        for node in nodes.values_mut() {
            node.community = communities.get(&node.name).copied().unwrap_or(0);
        }
        let mut community_stats: BTreeMap<usize, CommunityStats> = BTreeMap::new();
        for node in nodes.values() {
            let entry = community_stats.entry(node.community).or_default();
            entry.node_count += 1;
            if entry.sample_nodes.len() < 5 {
                entry.sample_nodes.push(node.name.clone());
            }
        }
        for edge in &edges {
            if let Some(community) = communities.get(&edge.from) {
                community_stats.entry(*community).or_default().edge_count += 1;
            }
        }
        let mut hotspots = nodes.values().cloned().collect::<Vec<_>>();
        hotspots.sort_by(|left, right| {
            right
                .degree
                .cmp(&left.degree)
                .then_with(|| left.name.cmp(&right.name))
        });
        let mut modules = hotspots
            .iter()
            .filter(|node| node.entity_type == "module" || node.entity_type == "file")
            .cloned()
            .collect::<Vec<_>>();
        modules.truncate(max_items);
        let mut entry_points = nodes
            .values()
            .filter(|node| {
                out_degree.get(&node.name).copied().unwrap_or(0) > 0
                    && incoming_call_count(&node.name, &edges) == 0
                    && outgoing_call_count(&node.name, &edges) > 0
            })
            .cloned()
            .collect::<Vec<_>>();
        entry_points.sort_by(|left, right| {
            outgoing_call_count(&right.name, &edges)
                .cmp(&outgoing_call_count(&left.name, &edges))
                .then_with(|| left.name.cmp(&right.name))
        });
        entry_points.truncate(max_items);
        let mut governed_decisions = nodes
            .values()
            .filter(|node| {
                node.name.starts_with("decision:")
                    || node.name.starts_with("adr:")
                    || edges.iter().any(|edge| {
                        edge.predicate == "GOVERNS"
                            && (edge.from == node.name || edge.to == node.name)
                    })
            })
            .cloned()
            .collect::<Vec<_>>();
        governed_decisions.sort_by(|left, right| left.name.cmp(&right.name));
        governed_decisions.truncate(max_items);
        let language_histogram = language_counts
            .into_iter()
            .map(|(language, count)| json!({ "language": language, "count": count }))
            .collect::<Vec<_>>();
        let communities_out = community_stats
            .into_iter()
            .map(|(id, stats)| {
                json!({
                    "id": id,
                    "nodeCount": stats.node_count,
                    "edgeCount": stats.edge_count,
                    "sampleNodes": stats.sample_nodes
                })
            })
            .take(max_items)
            .collect::<Vec<_>>();
        let node_count = nodes.len();
        let edge_count = edges.len();
        Ok(json!({
            "schemaVersion": "1.0.0",
            "command": "architecture.overview",
            "provider": PROVIDER_ID,
            "workspaceId": self.workspace_id,
            "scope": scope,
            "at": at,
            "communityMethod": "label-propagation",
            "summary": {
                "nodeCount": node_count,
                "edgeCount": edge_count,
                "currentNodeCount": node_count,
                "currentEdgeCount": edge_count,
                "communityCount": communities.values().copied().collect::<BTreeSet<_>>().len(),
                "truncated": hotspots.len() > max_items
            },
            "languageHistogram": language_histogram,
            "topModules": modules.iter().map(overview_node_value).collect::<Vec<_>>(),
            "entryPoints": entry_points.iter().map(overview_node_value).collect::<Vec<_>>(),
            "hotspots": hotspots.iter().take(max_items).map(overview_node_value).collect::<Vec<_>>(),
            "governedDecisions": governed_decisions.iter().map(overview_node_value).collect::<Vec<_>>(),
            "communities": communities_out,
            "safeguards": read_only_safeguards()
        }))
    }

    pub fn ui_graph(&self, scope: &str, at: &str, history: bool) -> Result<Value> {
        let scope = normalize_temporal_scope(scope)?;
        let edges = if history {
            self.history_graph_edges(&scope)?
        } else {
            self.temporal_graph_edges(&scope, at)?
        };
        let mut nodes: BTreeMap<String, OverviewNode> = BTreeMap::new();
        for edge in &edges {
            for name in [&edge.from, &edge.to] {
                nodes.entry(name.clone()).or_insert_with(|| OverviewNode {
                    name: name.clone(),
                    entity_type: temporal_graph_entity_type(name),
                    degree: 0,
                    community: 0,
                });
            }
        }
        for edge in &edges {
            if let Some(node) = nodes.get_mut(&edge.from) {
                node.degree += 1;
            }
            if let Some(node) = nodes.get_mut(&edge.to) {
                node.degree += 1;
            }
        }
        let communities = graph_communities(nodes.keys().cloned().collect(), &edges);
        let mut community_stats: BTreeMap<usize, CommunityStats> = BTreeMap::new();
        for node in nodes.values_mut() {
            node.community = communities.get(&node.name).copied().unwrap_or(0);
            let entry = community_stats.entry(node.community).or_default();
            entry.node_count += 1;
            if entry.sample_nodes.len() < 5 {
                entry.sample_nodes.push(node.name.clone());
            }
        }
        for edge in &edges {
            if let Some(community) = communities.get(&edge.from) {
                community_stats.entry(*community).or_default().edge_count += 1;
            }
        }
        let mut safeguards = read_only_safeguards();
        if let Some(object) = safeguards.as_object_mut() {
            object.insert("localhostOnly".to_string(), Value::Bool(true));
            object.insert("uiAssetsCompiledIn".to_string(), Value::Bool(true));
        }
        Ok(json!({
            "schemaVersion": "1.0.0",
            "command": "ui.graph",
            "provider": PROVIDER_ID,
            "workspaceId": self.workspace_id,
            "scope": scope,
            "mode": if history { "history" } else { "current" },
            "at": at,
            "summary": {
                "nodeCount": nodes.len(),
                "edgeCount": edges.len(),
                "communityCount": communities.values().copied().collect::<BTreeSet<_>>().len()
            },
            "nodes": nodes.values().map(ui_node_value).collect::<Vec<_>>(),
            "edges": edges.iter().map(ui_edge_value).collect::<Vec<_>>(),
            "communities": community_stats.into_iter().map(|(id, stats)| json!({
                "id": id,
                "nodeCount": stats.node_count,
                "edgeCount": stats.edge_count,
                "sampleNodes": stats.sample_nodes
            })).collect::<Vec<_>>(),
            "safeguards": safeguards
        }))
    }

    pub fn knowledge_wiki(&self, scope: &str, at: &str) -> Result<Value> {
        let scope = normalize_temporal_scope(scope)?;
        let current = self.active_current_facts(&scope, 10_000)?;
        let mut stmt = self.conn.prepare(
            "SELECT * FROM memory_facts WHERE workspace_id = ? AND scope = ? AND status IN ('active', 'superseded') ORDER BY subject, predicate, object, id LIMIT 10000",
        )?;
        let rows = stmt.query_map(params![self.workspace_id, scope], |row| {
            fact_from_row(&self.conn, row)
        })?;
        let all = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        let history = all
            .iter()
            .filter(|fact| fact.status != "active" || fact.superseded_by.is_some())
            .cloned()
            .collect::<Vec<_>>();

        let mut entity_facts: BTreeMap<String, Vec<&RecallFact>> = BTreeMap::new();
        for fact in &current {
            entity_facts
                .entry(fact.subject.clone())
                .or_default()
                .push(fact);
            if is_wiki_entity_like(&fact.object) {
                entity_facts
                    .entry(fact.object.clone())
                    .or_default()
                    .push(fact);
            }
        }
        let entities = entity_facts
            .iter()
            .map(|(entity, facts)| {
                json!({
                    "id": entity,
                    "title": wiki_title(entity),
                    "factCount": facts.len(),
                    "currentFacts": facts.iter().take(100).map(|fact| wiki_fact_value(fact)).collect::<Vec<_>>()
                })
            })
            .collect::<Vec<_>>();

        let mut community_facts: BTreeMap<String, Vec<&RecallFact>> = BTreeMap::new();
        for fact in &current {
            community_facts
                .entry(wiki_community(&fact.subject))
                .or_default()
                .push(fact);
        }
        let communities = community_facts
            .iter()
            .map(|(community, facts)| {
                json!({
                    "id": community,
                    "title": wiki_title(community),
                    "factCount": facts.len(),
                    "entities": sorted_strings_local(facts.iter().map(|fact| fact.subject.clone()).collect::<Vec<_>>()).into_iter().take(50).collect::<Vec<_>>(),
                    "currentFacts": facts.iter().take(50).map(|fact| wiki_fact_value(fact)).collect::<Vec<_>>()
                })
            })
            .collect::<Vec<_>>();

        let decisions = current
            .iter()
            .filter(|fact| is_wiki_decision_fact(fact))
            .map(|fact| {
                let related_history = history
                    .iter()
                    .filter(|old| {
                        old.subject == fact.subject
                            || old.superseded_by.as_deref() == Some(&fact.id)
                    })
                    .map(wiki_fact_value)
                    .collect::<Vec<_>>();
                json!({
                    "id": fact.id,
                    "title": fact.subject,
                    "current": wiki_fact_value(fact),
                    "history": related_history
                })
            })
            .collect::<Vec<_>>();

        let current_truth = current.iter().map(wiki_fact_value).collect::<Vec<_>>();
        let history_values = history.iter().map(wiki_fact_value).collect::<Vec<_>>();
        Ok(json!({
            "schemaVersion": "1.0.0",
            "command": "ui.wiki",
            "provider": PROVIDER_ID,
            "workspaceId": self.workspace_id,
            "scope": scope,
            "generatedAt": at,
            "summary": {
                "entityPageCount": entities.len(),
                "communityPageCount": communities.len(),
                "decisionPageCount": decisions.len(),
                "currentFactCount": current.len(),
                "historyFactCount": history_values.len(),
                "offline": true,
                "zeroCdn": true,
                "modelCalls": 0,
                "networkCalls": 0
            },
            "pages": {
                "index": {
                    "title": "Knowledge Wiki",
                    "sections": ["entities", "communities", "decisions", "currentTruth", "history"]
                },
                "entities": entities,
                "communities": communities,
                "decisions": decisions,
                "currentTruth": current_truth,
                "history": history_values
            },
            "safeguards": {
                "readOnly": true,
                "localhostOnly": true,
                "uiAssetsCompiledIn": true,
                "networkCalls": 0,
                "modelCalls": 0,
                "externalWritesEnabled": false,
                "rawSourceBodiesIncluded": false,
                "absoluteFilesystemLocationsIncluded": false
            }
        }))
    }

    pub fn integrity_check(&self) -> Result<String> {
        let result: String = self
            .conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if result != "ok" {
            bail!("sqlite integrity check failed: {result}");
        }
        Ok(result)
    }

    fn temporal_graph_edges(&self, scope: &str, at: &str) -> Result<Vec<GraphEdge>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT e.predicate,
                   e.fact_id,
                   source.name AS source_name,
                   target.name AS target_name,
                   f.source AS fact_source
            FROM memory_edges e
            JOIN memory_entities source ON source.id = e.source_entity_id
            JOIN memory_entities target ON target.id = e.target_entity_id
            JOIN memory_facts f ON f.workspace_id = e.workspace_id
              AND f.scope = e.scope
              AND f.id = e.fact_id
            WHERE e.workspace_id = ?
              AND e.scope = ?
              AND f.status IN ('active', 'superseded')
              AND f.valid_from <= ?
              AND (f.valid_until IS NULL OR f.valid_until > ?)
              AND (f.superseded_by IS NULL OR f.valid_until > ?)
            ORDER BY source.name ASC, e.predicate ASC, target.name ASC, e.created_at ASC, e.fact_id ASC
            "#,
        )?;
        let rows = stmt.query_map(params![self.workspace_id, scope, at, at, at], |row| {
            Ok(GraphEdge {
                predicate: row.get("predicate")?,
                fact_id: row.get("fact_id")?,
                from: row.get("source_name")?,
                to: row.get("target_name")?,
                source: row.get("fact_source")?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    fn history_graph_edges(&self, scope: &str) -> Result<Vec<GraphEdge>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT e.predicate,
                   e.fact_id,
                   source.name AS source_name,
                   target.name AS target_name,
                   f.source AS fact_source
            FROM memory_edges e
            JOIN memory_entities source ON source.id = e.source_entity_id
            JOIN memory_entities target ON target.id = e.target_entity_id
            JOIN memory_facts f ON f.workspace_id = e.workspace_id
              AND f.scope = e.scope
              AND f.id = e.fact_id
            WHERE e.workspace_id = ?
              AND e.scope = ?
              AND f.status IN ('active', 'superseded')
            ORDER BY source.name ASC, e.predicate ASC, target.name ASC, e.created_at ASC, e.fact_id ASC
            "#,
        )?;
        let rows = stmt.query_map(params![self.workspace_id, scope], |row| {
            Ok(GraphEdge {
                predicate: row.get("predicate")?,
                fact_id: row.get("fact_id")?,
                from: row.get("source_name")?,
                to: row.get("target_name")?,
                source: row.get("fact_source")?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    fn begin(&self) -> Result<()> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        Ok(())
    }

    fn finish<T>(&self, result: Result<T>) -> Result<T> {
        match result {
            Ok(value) => {
                self.conn.execute_batch("COMMIT")?;
                self.integrity_check()?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    fn enqueue_proposal_uncommitted(&self, proposal: &ProposalInput) -> Result<()> {
        let fingerprint = proposal_fingerprint(&self.workspace_id, proposal);
        self.conn.execute(
            r#"
            INSERT INTO memory_proposal_queue (
              id, workspace_id, fingerprint, source_locator, source_hash, status,
              attempts, max_attempts, lease_owner, lease_until, payload_json,
              result_json, error_json, enqueued_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, 3, NULL, NULL, ?6, NULL, NULL, ?7, ?8)
            ON CONFLICT(workspace_id, fingerprint) DO UPDATE SET updated_at=excluded.updated_at
            "#,
            params![
                proposal.id,
                self.workspace_id,
                fingerprint,
                proposal.source_locator,
                proposal.source_hash,
                proposal.payload_json.clone(),
                proposal.enqueued_at,
                self.now
            ],
        )?;
        if std::env::var("OAF_STORE_ABORT_AFTER_UNCOMMITTED_WRITE")
            .ok()
            .as_deref()
            == Some("1")
        {
            std::process::abort();
        }
        Ok(())
    }

    fn approve_bulk(&mut self, source: Option<&str>) -> Result<ApproveReport> {
        let candidates = self.pending_ids(source)?;
        if candidates.is_empty() {
            bail!("memory approve found no pending proposals");
        }
        let mut ids = Vec::new();
        let mut skipped_explicit_id_only_count = 0;
        for id in candidates {
            let proposal = self.proposal_row_value(&id)?;
            if requires_explicit_proposal_approval(&proposal) {
                skipped_explicit_id_only_count += 1;
            } else {
                ids.push(id);
            }
        }
        if ids.is_empty() {
            return Ok(ApproveReport {
                pending_proposal_count: self.pending_ids(None)?.len(),
                skipped_explicit_id_only_count,
                ..ApproveReport::default()
            });
        }
        let mut report = self.approve_ids(ids)?;
        report.skipped_explicit_id_only_count = skipped_explicit_id_only_count;
        Ok(report)
    }

    fn approve_ids(&mut self, ids: Vec<String>) -> Result<ApproveReport> {
        if ids.is_empty() {
            bail!("memory approve found no pending proposals");
        }
        self.begin()?;
        let result = (|| {
            let mut facts = Vec::new();
            let mut superseded_facts = Vec::new();
            let mut proposal = None;
            for id in &ids {
                let approved = self.approve_proposal_uncommitted(id, "memory-review")?;
                if proposal.is_none() {
                    proposal = approved.proposal;
                }
                facts.extend(approved.facts);
                superseded_facts.extend(approved.superseded_facts);
            }
            let pending_proposal_count = self.pending_ids(None)?.len();
            Ok(ApproveReport {
                active_memory_created: facts.len(),
                superseded_fact_count: superseded_facts.len(),
                pending_proposal_count,
                proposal: if ids.len() == 1 { proposal } else { None },
                fact: facts.first().cloned(),
                facts,
                superseded_facts,
                ..ApproveReport::default()
            })
        })();
        self.finish(result)
    }

    fn approve_proposal_uncommitted(&self, id: &str, worker_id: &str) -> Result<ApproveReport> {
        let proposal = self.claim_result_uncommitted(
            id,
            worker_id,
            json!({ "accepted": true, "command": "memory approve", "approvedAt": self.now }),
        )?;
        let payload = proposal
            .get("payload")
            .and_then(Value::as_object)
            .context("proposal payload missing")?;
        if payload.get("kind").and_then(Value::as_str) != Some("fact") {
            bail!("memory approve only supports fact proposals");
        }
        let fact_id = fact_id_from_proposal_id(id);
        let scope = payload_str(payload, "scope", "workspace");
        let subject = payload_str(payload, "subject", "");
        let predicate = payload_str(payload, "predicate", "");
        let object = payload_str(payload, "object", "");
        let text = payload_str(payload, "text", &format!("{subject} {predicate} {object}"));
        let observed_at = payload_str(payload, "observedAt", &self.now);
        let source = proposal
            .get("sourceLocator")
            .and_then(Value::as_str)
            .unwrap_or("workspace://memory/proposals");
        let source_hash = proposal
            .get("sourceHash")
            .and_then(Value::as_str)
            .unwrap_or("");
        let extraction_confidence = payload
            .get("extractionConfidence")
            .and_then(Value::as_str)
            .unwrap_or("extracted");
        let source_trust = payload
            .get("sourceTrust")
            .and_then(Value::as_str)
            .unwrap_or("verified")
            .to_string();
        let trust_class = payload
            .get("trustClass")
            .and_then(Value::as_str)
            .unwrap_or(&source_trust)
            .to_string();
        let approval_policy_receipt = if source_trust == "untrusted" {
            policy_receipt(
                "approved_after_review",
                "explicit_memory_approve_required",
                &source_trust,
            )
        } else {
            Value::Null
        };
        let confidence = match extraction_confidence {
            "inferred" => 0.6,
            "ambiguous" => 0.3,
            _ => 0.9,
        };
        let episode_id = payload
            .get("provenanceEpisodeId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| episode_id_from_proposal_id(id));
        self.conn.execute(
            r#"
            INSERT INTO memory_episodes (id, workspace_id, scope, source_locator, summary, observed_at, created_at, metadata_json)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '{}')
            ON CONFLICT(id) DO UPDATE SET
              workspace_id=excluded.workspace_id,
              scope=excluded.scope,
              source_locator=excluded.source_locator,
              summary=excluded.summary,
              observed_at=excluded.observed_at,
              metadata_json=excluded.metadata_json
            "#,
            params![episode_id, self.workspace_id, scope, source, text, observed_at, self.now],
        )?;

        let subject_entity_id = self.upsert_entity(&scope, &subject)?;
        let object_entity_id = self.upsert_entity(&scope, &object)?;
        let mut superseded_facts = Vec::new();
        if payload
            .get("supersedesSubjectPredicate")
            .and_then(Value::as_bool)
            == Some(true)
        {
            let supersedes_object = payload.get("supersedesObject").and_then(Value::as_str);
            let history = self.history(&scope, &subject, &predicate, 50)?;
            if let Some(supersedes_object) = supersedes_object {
                self.conn.execute(
                    r#"
                    UPDATE memory_facts
                    SET status='superseded', valid_until=?1, superseded_by=?2, updated_at=?3
                    WHERE workspace_id=?4
                      AND scope=?5
                      AND subject=?6
                      AND predicate=?7
                      AND id <> ?8
                      AND object = ?9
                      AND superseded_by IS NULL
                      AND (valid_until IS NULL OR valid_until > ?10)
                    "#,
                    params![
                        observed_at,
                        fact_id,
                        self.now,
                        self.workspace_id,
                        scope,
                        subject,
                        predicate,
                        fact_id,
                        supersedes_object,
                        observed_at
                    ],
                )?;
            } else {
                self.conn.execute(
                    r#"
                    UPDATE memory_facts
                    SET status='superseded', valid_until=?1, superseded_by=?2, updated_at=?3
                    WHERE workspace_id=?4
                      AND scope=?5
                      AND subject=?6
                      AND predicate=?7
                      AND id <> ?8
                      AND object <> ?9
                      AND superseded_by IS NULL
                      AND (valid_until IS NULL OR valid_until > ?10)
                    "#,
                    params![
                        observed_at,
                        fact_id,
                        self.now,
                        self.workspace_id,
                        scope,
                        subject,
                        predicate,
                        fact_id,
                        object,
                        observed_at
                    ],
                )?;
            }
            superseded_facts = history
                .into_iter()
                .filter(|fact| {
                    fact.superseded_by.is_none()
                        && supersedes_object
                            .map(|exact| fact.object == exact)
                            .unwrap_or(fact.object != object)
                })
                .map(|mut fact| {
                    fact.status = "superseded".to_string();
                    fact.superseded_by = Some(fact_id.clone());
                    fact.valid_until = Some(observed_at.clone());
                    fact.updated_at = self.now.clone();
                    temporal_fact_value(&fact)
                })
                .collect();
        }

        let mut metadata = json!({
            "approvedBy": "oaf memory approve",
            "approvedAt": self.now,
            "sourceHash": source_hash,
            "extractionConfidence": if ["extracted", "inferred", "ambiguous"].contains(&extraction_confidence) { extraction_confidence } else { "extracted" },
            "notes": payload.get("notes").cloned().unwrap_or(Value::Null)
        });
        if source_trust != "verified" {
            metadata["sourceTrust"] = Value::String(source_trust.clone());
            metadata["trustClass"] = Value::String(trust_class.clone());
            metadata["policyReceipt"] = approval_policy_receipt.clone();
        }
        self.conn.execute(
            r#"
            INSERT INTO memory_facts (
              id, workspace_id, scope, subject, predicate, object, text, status, source,
              confidence, valid_from, valid_until, superseded_by, episode_id, proposal_queue_id,
              created_at, updated_at, metadata_json
            ) VALUES (
              ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8, ?9, ?10, NULL, NULL, ?11, ?12, ?13, ?14, ?15
            )
            ON CONFLICT(id) DO UPDATE SET
              workspace_id=excluded.workspace_id,
              scope=excluded.scope,
              subject=excluded.subject,
              predicate=excluded.predicate,
              object=excluded.object,
              text=excluded.text,
              status=excluded.status,
              source=excluded.source,
              confidence=excluded.confidence,
              valid_from=excluded.valid_from,
              valid_until=excluded.valid_until,
              superseded_by=excluded.superseded_by,
              episode_id=excluded.episode_id,
              proposal_queue_id=excluded.proposal_queue_id,
              updated_at=excluded.updated_at,
              metadata_json=excluded.metadata_json
            "#,
            params![
                fact_id,
                self.workspace_id,
                scope,
                subject,
                predicate,
                object,
                text,
                source,
                confidence,
                observed_at,
                episode_id,
                id,
                self.now,
                self.now,
                serde_json::to_string(&metadata)?
            ],
        )?;
        self.conn.execute(
            "DELETE FROM memory_fact_fts WHERE workspace_id = ?1 AND id = ?2",
            params![self.workspace_id, fact_id],
        )?;
        self.conn.execute(
            "INSERT INTO memory_fact_fts(id, workspace_id, scope, subject, predicate, object, text) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![fact_id, self.workspace_id, scope, subject, predicate, object, expand_token_text(&text)],
        )?;
        let edge_id = deterministic_id(
            "medge",
            &json!({ "workspaceId": self.workspace_id, "scope": scope, "factId": fact_id }),
        );
        self.conn.execute(
            r#"
            INSERT INTO memory_edges (id, workspace_id, scope, source_entity_id, target_entity_id, predicate, fact_id, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ON CONFLICT(workspace_id, scope, fact_id) DO UPDATE SET
              source_entity_id=excluded.source_entity_id,
              target_entity_id=excluded.target_entity_id,
              predicate=excluded.predicate
            "#,
            params![edge_id, self.workspace_id, scope, subject_entity_id, object_entity_id, predicate, fact_id, self.now],
        )?;
        let fact = self
            .fact_by_id(&fact_id)?
            .context("approved fact missing after write")?;
        Ok(ApproveReport {
            active_memory_created: 1,
            superseded_fact_count: superseded_facts.len(),
            proposal: Some(proposal),
            fact: Some(temporal_fact_value(&fact)),
            facts: vec![temporal_fact_value(&fact)],
            superseded_facts,
            policy_receipts: if source_trust == "untrusted" {
                vec![approval_policy_receipt.clone()]
            } else {
                Vec::new()
            },
            ..ApproveReport::default()
        })
    }

    fn claim_result_uncommitted(&self, id: &str, worker_id: &str, result: Value) -> Result<Value> {
        let current: Option<String> = self
            .conn
            .query_row(
                "SELECT status FROM memory_proposal_queue WHERE workspace_id = ?1 AND id = ?2",
                params![self.workspace_id, id],
                |row| row.get(0),
            )
            .optional()?;
        if current.as_deref() != Some("pending") {
            bail!("memory proposal is not pending: {id}");
        }
        self.conn.execute(
            r#"
            UPDATE memory_proposal_queue
            SET status='applied',
                attempts=attempts+1,
                lease_owner=NULL,
                lease_until=NULL,
                result_json=?1,
                error_json=NULL,
                updated_at=?2
            WHERE workspace_id=?3 AND id=?4
            "#,
            params![
                serde_json::to_string(&result)?,
                self.now,
                self.workspace_id,
                id
            ],
        )?;
        let _ = worker_id;
        self.proposal_row_value(id)
    }

    fn upsert_entity(&self, scope: &str, name: &str) -> Result<String> {
        let id = deterministic_id(
            "ment",
            &json!({ "workspaceId": self.workspace_id, "scope": scope, "name": name }),
        );
        self.conn.execute(
            r#"
            INSERT INTO memory_entities (id, workspace_id, scope, kind, name, created_at, updated_at)
            VALUES (?1, ?2, ?3, 'entity', ?4, ?5, ?6)
            ON CONFLICT(workspace_id, scope, kind, name) DO UPDATE SET updated_at=excluded.updated_at
            "#,
            params![id, self.workspace_id, scope, name, self.now, self.now],
        )?;
        Ok(id)
    }

    fn pending_ids(&self, source: Option<&str>) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM memory_proposal_queue WHERE workspace_id = ? AND status = 'pending' ORDER BY enqueued_at ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![self.workspace_id], |row| proposal_row_to_value(row))?;
        let mut out = Vec::new();
        for row in rows {
            let row = row?;
            if source.is_none_or(|source| memory_proposal_source_matches(&row, source)) {
                if let Some(id) = row.get("id").and_then(Value::as_str) {
                    out.push(id.to_string());
                }
            }
        }
        Ok(out)
    }

    fn proposal_row_value(&self, id: &str) -> Result<Value> {
        self.conn
            .query_row(
                "SELECT * FROM memory_proposal_queue WHERE workspace_id = ?1 AND id = ?2",
                params![self.workspace_id, id],
                proposal_row_to_value,
            )
            .optional()?
            .ok_or_else(|| anyhow!("memory proposal queue record not found: {id}"))
    }

    fn proposal_statuses_by_fingerprint(&self) -> Result<HashMap<String, String>> {
        let mut stmt = self.conn.prepare(
            "SELECT fingerprint, status FROM memory_proposal_queue WHERE workspace_id = ?",
        )?;
        let rows = stmt.query_map(params![self.workspace_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<std::result::Result<HashMap<_, _>, _>>()
            .map_err(Into::into)
    }

    fn fact_by_id(&self, id: &str) -> Result<Option<RecallFact>> {
        self.conn
            .query_row(
                "SELECT * FROM memory_facts WHERE workspace_id = ?1 AND id = ?2",
                params![self.workspace_id, id],
                |row| fact_from_row(&self.conn, row),
            )
            .optional()
            .map_err(Into::into)
    }

    fn history(
        &self,
        scope: &str,
        subject: &str,
        predicate: &str,
        limit: usize,
    ) -> Result<Vec<RecallFact>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT * FROM memory_facts
            WHERE workspace_id = ?1 AND scope = ?2 AND subject = ?3 AND predicate = ?4
            ORDER BY valid_from DESC, id ASC
            LIMIT ?5
            "#,
        )?;
        let rows = stmt.query_map(
            params![self.workspace_id, scope, subject, predicate, limit as i64],
            |row| fact_from_row(&self.conn, row),
        )?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    fn recall_facts(
        &self,
        scope: &str,
        query: &str,
        subject: Option<&str>,
        predicate: Option<&str>,
        limit: usize,
    ) -> Result<Vec<RecallFact>> {
        let mut conditions = vec![
            "m.workspace_id = ?".to_string(),
            "m.scope = ?".to_string(),
            "m.status IN ('active', 'superseded')".to_string(),
            "m.valid_from <= ?".to_string(),
            "(m.valid_until IS NULL OR m.valid_until > ?)".to_string(),
        ];
        let mut values = vec![
            self.workspace_id.clone(),
            scope.to_string(),
            self.now.clone(),
            self.now.clone(),
        ];
        if let Some(subject) = subject {
            conditions.push("m.subject = ?".to_string());
            values.push(subject.to_string());
        }
        if let Some(predicate) = predicate {
            conditions.push("m.predicate = ?".to_string());
            values.push(predicate.to_string());
        }
        values.push(limit.clamp(1, 100).to_string());
        let expression = fts_expression(query);
        let sql = if expression.is_some() {
            format!(
                "SELECT m.* FROM memory_fact_fts JOIN memory_facts m ON m.id = memory_fact_fts.id AND m.workspace_id = memory_fact_fts.workspace_id WHERE memory_fact_fts MATCH ? AND {} ORDER BY bm25(memory_fact_fts) ASC, m.valid_from DESC, m.id ASC LIMIT ?",
                conditions.join(" AND ")
            )
        } else {
            format!(
                "SELECT m.* FROM memory_facts m WHERE {} ORDER BY m.valid_from DESC, m.id ASC LIMIT ?",
                conditions.join(" AND ")
            )
        };
        let mut params_vec = Vec::new();
        if let Some(expression) = expression {
            params_vec.push(expression);
        }
        params_vec.extend(values);
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(params_vec), |row| {
            fact_from_row(&self.conn, row)
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    fn facts_superseded_by(&self, fact_id: &str) -> Result<Vec<Value>> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM memory_facts WHERE workspace_id = ? AND superseded_by = ? ORDER BY valid_from DESC, id ASC",
        )?;
        let rows = stmt.query_map(params![self.workspace_id, fact_id], |row| {
            fact_from_row(&self.conn, row)
        })?;
        rows.map(|row| row.map(|fact| fact_brief(&fact)))
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    fn fact_brief_by_id(&self, fact_id: &str) -> Result<Option<Value>> {
        self.conn
            .query_row(
                "SELECT * FROM memory_facts WHERE workspace_id = ? AND id = ?",
                params![self.workspace_id, fact_id],
                |row| fact_from_row(&self.conn, row).map(|fact| fact_brief(&fact)),
            )
            .optional()
            .map_err(Into::into)
    }

    fn active_current_facts(&self, scope: &str, limit: usize) -> Result<Vec<RecallFact>> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM memory_facts m WHERE m.workspace_id = ? AND m.scope = ? AND m.status = 'active' AND m.superseded_by IS NULL AND m.valid_from <= ? AND (m.valid_until IS NULL OR m.valid_until > ?) ORDER BY m.valid_from DESC, m.id ASC LIMIT ?",
        )?;
        let rows = stmt.query_map(
            params![
                self.workspace_id,
                scope,
                self.now,
                self.now,
                limit.clamp(1, 100_000) as i64
            ],
            |row| fact_from_row(&self.conn, row),
        )?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    fn retracted_ids(
        &self,
        scope: &str,
        query: &str,
        subject: Option<&str>,
        predicate: Option<&str>,
        since: &str,
    ) -> Result<Vec<Value>> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM memory_facts WHERE workspace_id = ? AND scope = ? ORDER BY valid_from DESC, created_at DESC, id ASC LIMIT 500",
        )?;
        let rows = stmt.query_map(params![self.workspace_id, scope], |row| {
            fact_from_row(&self.conn, row)
        })?;
        let mut out = Vec::new();
        for row in rows {
            let fact = row?;
            if fact.status == "superseded"
                && fact.superseded_by.is_some()
                && changed_since(&fact, since)
                && subject.is_none_or(|subject| fact.subject == subject)
                && predicate.is_none_or(|predicate| fact.predicate == predicate)
                && fact_matches_query(&fact, query)
            {
                out.push(Value::String(sanitize_string(&fact.id, 120)));
            }
        }
        Ok(out)
    }
}

#[derive(Debug, Clone)]
struct PathState {
    node: String,
    path: Vec<String>,
    edges: Vec<GraphEdge>,
}

#[derive(Debug, Clone)]
struct OverviewNode {
    name: String,
    entity_type: String,
    degree: usize,
    community: usize,
}

#[derive(Debug, Clone, Default)]
struct CommunityStats {
    node_count: usize,
    edge_count: usize,
    sample_nodes: Vec<String>,
}

fn graph_edge_value(edge: &GraphEdge) -> Value {
    json!({
        "from": edge.from,
        "predicate": edge.predicate,
        "to": edge.to,
        "factId": edge.fact_id
    })
}

fn read_only_safeguards() -> Value {
    json!({
        "readOnly": true,
        "proposalGated": true,
        "canonicalStateMutated": false,
        "activeMemoryCreated": 0,
        "hardDeleted": false,
        "networkCalls": 0,
        "modelCalls": 0,
        "externalWritesEnabled": false,
        "rawSourceBodiesIncluded": false,
        "absoluteFilesystemLocationsIncluded": false
    })
}

fn normalize_temporal_scope(scope: &str) -> Result<String> {
    match scope {
        "workspace" | "session" | "agent" | "user" => Ok(scope.to_string()),
        _ => bail!("unsupported temporal memory scope: {scope}"),
    }
}

fn resolve_temporal_entity_name(
    edges: &[GraphEdge],
    entity: Option<&str>,
    query: &str,
) -> Option<String> {
    let requested = entity.unwrap_or(query).trim();
    if requested.is_empty() {
        return None;
    }
    let names = edges
        .iter()
        .flat_map(|edge| [edge.from.clone(), edge.to.clone()])
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    names
        .iter()
        .find(|name| name.as_str() == requested)
        .cloned()
        .or_else(|| {
            let lower = requested.to_lowercase();
            names
                .iter()
                .find(|name| name.to_lowercase() == lower)
                .cloned()
        })
        .or_else(|| {
            let lower = requested.to_lowercase();
            names
                .iter()
                .find(|name| name.to_lowercase().contains(&lower))
                .cloned()
        })
}

fn scoped_digest(query: &str, at: &str, result_ids: Vec<String>, edges: Vec<[String; 3]>) -> Value {
    let summary = json!({
        "query": query,
        "at": at,
        "resultIds": result_ids,
        "edges": edges
    });
    let serialized = canonical_json(&summary);
    json!({
        "digest": format!("sha256:{}", sha256_hex(&serialized)),
        "summary": summary
    })
}

fn temporal_graph_entity_type(name: &str) -> String {
    if name.starts_with("project:") {
        "project"
    } else if name.starts_with("provider:") {
        "provider"
    } else if name.starts_with("adr:") || name.starts_with("decision:") {
        "decision"
    } else if name.starts_with("file:") {
        "file"
    } else if name.starts_with("module:") || name.ends_with("_mjs") {
        "module"
    } else if name.ends_with("Port") {
        "port"
    } else if name.starts_with("class:") {
        "class"
    } else if name.starts_with("method:") {
        "method"
    } else if name.starts_with("function:") {
        "function"
    } else {
        "entity"
    }
    .to_string()
}

fn cypher_label(name: &str) -> String {
    match temporal_graph_entity_type(name).as_str() {
        "project" => "Project",
        "provider" => "Provider",
        "decision" => "Decision",
        "file" => "File",
        "module" => "Module",
        "port" => "Port",
        "class" => "Class",
        "method" => "Method",
        "function" => "Function",
        _ => "Entity",
    }
    .to_string()
}

fn label_matches(name: &str, label: &str) -> bool {
    cypher_label(name).eq_ignore_ascii_case(label)
}

fn infer_language(value: &str) -> Option<String> {
    let lower = value.to_lowercase();
    let language = if lower.ends_with(".rs") || lower.ends_with("_rs") {
        "rust"
    } else if lower.ends_with(".ts") || lower.ends_with("_ts") {
        "typescript"
    } else if lower.ends_with(".tsx") || lower.ends_with("_tsx") {
        "tsx"
    } else if lower.ends_with(".js")
        || lower.ends_with("_js")
        || lower.ends_with(".mjs")
        || lower.ends_with("_mjs")
    {
        "javascript"
    } else if lower.ends_with(".jsx") || lower.ends_with("_jsx") {
        "jsx"
    } else if lower.ends_with(".py") || lower.ends_with("_py") {
        "python"
    } else if lower.ends_with(".go") || lower.ends_with("_go") {
        "go"
    } else if lower.ends_with(".java") || lower.ends_with("_java") {
        "java"
    } else if lower.ends_with(".c") || lower.ends_with("_c") {
        "c"
    } else if lower.ends_with(".cpp")
        || lower.ends_with("_cpp")
        || lower.ends_with(".cc")
        || lower.ends_with("_cc")
        || lower.ends_with(".cxx")
        || lower.ends_with("_cxx")
    {
        "cpp"
    } else if lower.ends_with(".rb") || lower.ends_with("_rb") {
        "ruby"
    } else if lower.ends_with(".php") || lower.ends_with("_php") {
        "php"
    } else if lower.ends_with(".cs") || lower.ends_with("_cs") {
        "csharp"
    } else if lower.ends_with(".swift") || lower.ends_with("_swift") {
        "swift"
    } else if lower.ends_with(".kt") || lower.ends_with("_kt") || lower.ends_with(".kts") {
        "kotlin"
    } else if lower.ends_with(".lua") || lower.ends_with("_lua") {
        "lua"
    } else if lower.ends_with(".sh")
        || lower.ends_with("_sh")
        || lower.ends_with(".bash")
        || lower.ends_with("_bash")
    {
        "bash"
    } else if lower.ends_with(".sql") || lower.ends_with("_sql") {
        "sql"
    } else if lower.ends_with(".m")
        || lower.ends_with("_m")
        || lower.ends_with(".mm")
        || lower.ends_with("_mm")
    {
        "objective-c"
    } else if lower.ends_with(".scala") || lower.ends_with("_scala") || lower.ends_with(".sc") {
        "scala"
    } else if lower.ends_with(".dart") || lower.ends_with("_dart") {
        "dart"
    } else if lower.ends_with(".r") || lower.ends_with("_r") {
        "r"
    } else if lower.ends_with(".jl") || lower.ends_with("_jl") {
        "julia"
    } else if lower.ends_with(".zig") || lower.ends_with("_zig") {
        "zig"
    } else {
        return None;
    };
    Some(language.to_string())
}

fn graph_communities(nodes: Vec<String>, edges: &[GraphEdge]) -> BTreeMap<String, usize> {
    let mut labels = nodes
        .iter()
        .map(|node| (node.clone(), node.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut neighbors = nodes
        .iter()
        .map(|node| (node.clone(), Vec::<String>::new()))
        .collect::<BTreeMap<_, _>>();
    for edge in edges {
        if neighbors.contains_key(&edge.from) && neighbors.contains_key(&edge.to) {
            neighbors
                .entry(edge.from.clone())
                .or_default()
                .push(edge.to.clone());
            neighbors
                .entry(edge.to.clone())
                .or_default()
                .push(edge.from.clone());
        }
    }
    for _ in 0..8 {
        let mut changed = false;
        for node in &nodes {
            let mut counts: BTreeMap<String, usize> = BTreeMap::new();
            for neighbor in neighbors.get(node).cloned().unwrap_or_default() {
                if let Some(label) = labels.get(&neighbor) {
                    *counts.entry(label.clone()).or_default() += 1;
                }
            }
            let best = counts
                .into_iter()
                .max_by(|left, right| left.1.cmp(&right.1).then_with(|| right.0.cmp(&left.0)))
                .map(|(label, _)| label);
            if let Some(best) = best {
                if labels.get(node) != Some(&best) {
                    labels.insert(node.clone(), best);
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }
    let label_ids = labels
        .values()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .enumerate()
        .map(|(index, label)| (label, index + 1))
        .collect::<BTreeMap<_, _>>();
    labels
        .into_iter()
        .map(|(node, label)| (node, label_ids.get(&label).copied().unwrap_or(0)))
        .collect()
}

fn outgoing_call_count(name: &str, edges: &[GraphEdge]) -> usize {
    edges
        .iter()
        .filter(|edge| edge.from == name && edge.predicate == "CALLS")
        .count()
}

fn incoming_call_count(name: &str, edges: &[GraphEdge]) -> usize {
    edges
        .iter()
        .filter(|edge| edge.to == name && edge.predicate == "CALLS")
        .count()
}

fn overview_node_value(node: &OverviewNode) -> Value {
    json!({
        "name": node.name,
        "type": node.entity_type,
        "degree": node.degree,
        "community": node.community
    })
}

fn ui_node_value(node: &OverviewNode) -> Value {
    json!({
        "id": node.name,
        "label": node.name,
        "type": node.entity_type,
        "degree": node.degree,
        "community": node.community,
        "governedDecision": node.entity_type == "decision"
    })
}

fn ui_edge_value(edge: &GraphEdge) -> Value {
    let governed = edge.predicate == "GOVERNS"
        || edge.from.starts_with("decision:")
        || edge.from.starts_with("adr:")
        || edge.to.starts_with("decision:")
        || edge.to.starts_with("adr:");
    json!({
        "from": edge.from,
        "to": edge.to,
        "predicate": edge.predicate,
        "factId": edge.fact_id,
        "governedDecision": governed
    })
}

fn wiki_fact_value(fact: &RecallFact) -> Value {
    json!({
        "id": sanitize_string(&fact.id, 120),
        "subject": sanitize_string(&fact.subject, 160),
        "predicate": sanitize_string(&fact.predicate, 120),
        "object": sanitize_string(&fact.object, 240),
        "status": fact.status,
        "sourceRef": compact_provenance_ref(fact.episode_source_locator.as_deref().unwrap_or(&fact.source)),
        "validFrom": fact.valid_from,
        "validUntil": fact.valid_until,
        "supersededBy": fact.superseded_by,
        "confidence": extraction_confidence(fact.metadata.get("extractionConfidence").and_then(Value::as_str))
    })
}

fn is_wiki_entity_like(value: &str) -> bool {
    value.contains(':')
        || value == "Decision"
        || value == "Document"
        || value == "ADR"
        || value == "GitHubIssue"
        || value == "ChatExport"
}

fn is_wiki_decision_fact(fact: &RecallFact) -> bool {
    fact.subject.starts_with("decision:")
        || fact.subject.starts_with("adr:")
        || matches!(
            fact.predicate.as_str(),
            "DECISION" | "HAS_STATUS" | "SUPERSEDES" | "GOVERNS"
        )
        || fact.object == "Decision"
}

fn wiki_community(subject: &str) -> String {
    subject
        .split_once(':')
        .map(|(prefix, _)| prefix.to_string())
        .unwrap_or_else(|| "general".to_string())
}

fn wiki_title(value: &str) -> String {
    value
        .replace([':', '_', '-'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn sorted_strings_local(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TokenKind {
    Ident,
    String,
    Number,
    Symbol,
}

#[derive(Debug, Clone)]
struct Token {
    kind: TokenKind,
    text: String,
}

#[derive(Debug, Clone)]
struct ParsedCypher {
    at: Option<String>,
    pattern: MatchPattern,
    where_expr: Option<BoolExpr>,
    with_clause: Option<ProjectionClause>,
    return_clause: ProjectionClause,
    order_by: Option<OrderBy>,
    limit: Option<usize>,
}

#[derive(Debug, Clone)]
struct MatchPattern {
    left_var: String,
    left_label: Option<String>,
    rel_var: Option<String>,
    rel_type: String,
    right_var: String,
    right_label: Option<String>,
}

#[derive(Debug, Clone)]
struct ProjectionClause {
    distinct: bool,
    items: Vec<SelectItem>,
}

#[derive(Debug, Clone)]
struct SelectItem {
    expr: ValueExpr,
    alias: String,
}

#[derive(Debug, Clone)]
struct OrderBy {
    key: String,
    descending: bool,
}

#[derive(Debug, Clone)]
enum ValueExpr {
    Property(String, String),
    Labels(String),
    ToInteger(Box<ValueExpr>),
    String(String),
    Number(i64),
    Alias(String),
    CountAll,
    CountDistinct(Box<ValueExpr>),
}

#[derive(Debug, Clone)]
enum BoolExpr {
    Or(Box<BoolExpr>, Box<BoolExpr>),
    And(Box<BoolExpr>, Box<BoolExpr>),
    Not(Box<BoolExpr>),
    Compare(ValueExpr, CompareOp, ValueExpr),
    LabelTest(String, String),
}

#[derive(Debug, Clone)]
enum CompareOp {
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
    Contains,
    StartsWith,
}

#[derive(Debug, Clone)]
struct QueryResult {
    columns: Vec<String>,
    rows: Vec<Value>,
    truncated: bool,
}

#[derive(Debug, Clone)]
struct EvalRow {
    entities: HashMap<String, String>,
    rels: HashMap<String, GraphEdge>,
    aliases: HashMap<String, Value>,
}

fn parse_cypher(input: &str) -> Result<ParsedCypher> {
    let upper = input.to_ascii_uppercase();
    for forbidden in ["CREATE", "MERGE", "DELETE", "DETACH", "SET ", "REMOVE "] {
        if upper.contains(forbidden) {
            bail!("unsupported Cypher: write and mutation clauses are not supported");
        }
    }
    let tokens = lex_cypher(input)?;
    let mut parser = CypherParser { tokens, pos: 0 };
    let at = if parser.consume_keyword("AS") {
        parser.expect_keyword("OF")?;
        Some(parser.expect_string_like("AS OF timestamp")?)
    } else {
        None
    };
    parser.expect_keyword("MATCH")?;
    let pattern = parser.parse_pattern()?;
    let where_expr = if parser.consume_keyword("WHERE") {
        Some(parser.parse_or_expr()?)
    } else {
        None
    };
    let with_clause = if parser.consume_keyword("WITH") {
        Some(parser.parse_projection_until(&["RETURN"])?)
    } else {
        None
    };
    parser.expect_keyword("RETURN")?;
    let return_clause = parser.parse_projection_until(&["ORDER", "LIMIT"])?;
    let order_by = if parser.consume_keyword("ORDER") {
        parser.expect_keyword("BY")?;
        let key = parser.expect_ident("ORDER BY key")?;
        let descending = if parser.consume_keyword("DESC") {
            true
        } else {
            parser.consume_keyword("ASC");
            false
        };
        Some(OrderBy { key, descending })
    } else {
        None
    };
    let limit = if parser.consume_keyword("LIMIT") {
        Some(parser.expect_number("LIMIT")? as usize)
    } else {
        None
    };
    if !parser.is_end() {
        bail!("unsupported Cypher: trailing syntax is not part of the M4 subset");
    }
    Ok(ParsedCypher {
        at,
        pattern,
        where_expr,
        with_clause,
        return_clause,
        order_by,
        limit,
    })
}

fn lex_cypher(input: &str) -> Result<Vec<Token>> {
    let chars = input.chars().collect::<Vec<_>>();
    let mut out = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if ch.is_whitespace() {
            index += 1;
            continue;
        }
        if ch == '\'' {
            index += 1;
            let mut value = String::new();
            while index < chars.len() && chars[index] != '\'' {
                value.push(chars[index]);
                index += 1;
            }
            if index >= chars.len() {
                bail!("invalid Cypher: unterminated string literal");
            }
            index += 1;
            out.push(Token {
                kind: TokenKind::String,
                text: value,
            });
            continue;
        }
        if ch.is_ascii_digit() {
            let start = index;
            index += 1;
            while index < chars.len() && chars[index].is_ascii_digit() {
                index += 1;
            }
            out.push(Token {
                kind: TokenKind::Number,
                text: chars[start..index].iter().collect(),
            });
            continue;
        }
        if ch.is_alphabetic() || ch == '_' {
            let start = index;
            index += 1;
            while index < chars.len() && (chars[index].is_alphanumeric() || chars[index] == '_') {
                index += 1;
            }
            out.push(Token {
                kind: TokenKind::Ident,
                text: chars[start..index].iter().collect(),
            });
            continue;
        }
        let two = if index + 1 < chars.len() {
            Some([chars[index], chars[index + 1]])
        } else {
            None
        };
        if matches!(
            two,
            Some(['-', '>'] | ['<', '-'] | ['<', '>'] | ['>', '='] | ['<', '='])
        ) {
            out.push(Token {
                kind: TokenKind::Symbol,
                text: chars[index..=index + 1].iter().collect(),
            });
            index += 2;
            continue;
        }
        if "()[]:.,-=<>*|".contains(ch) {
            out.push(Token {
                kind: TokenKind::Symbol,
                text: ch.to_string(),
            });
            index += 1;
            continue;
        }
        bail!("invalid Cypher: unsupported character {ch:?}");
    }
    Ok(out)
}

struct CypherParser {
    tokens: Vec<Token>,
    pos: usize,
}

impl CypherParser {
    fn is_end(&self) -> bool {
        self.pos >= self.tokens.len()
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn peek_text(&self) -> Option<&str> {
        self.peek().map(|token| token.text.as_str())
    }

    fn consume_text(&mut self, text: &str) -> bool {
        if self.peek_text() == Some(text) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn consume_keyword(&mut self, text: &str) -> bool {
        if self.peek().is_some_and(|token| {
            token.kind == TokenKind::Ident && token.text.eq_ignore_ascii_case(text)
        }) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn expect_keyword(&mut self, text: &str) -> Result<()> {
        if self.consume_keyword(text) {
            Ok(())
        } else {
            bail!("invalid Cypher: expected {text}");
        }
    }

    fn expect_text(&mut self, text: &str) -> Result<()> {
        if self.consume_text(text) {
            Ok(())
        } else {
            bail!("invalid Cypher: expected {text}");
        }
    }

    fn expect_ident(&mut self, context: &str) -> Result<String> {
        if self
            .peek()
            .is_some_and(|token| token.kind == TokenKind::Ident)
        {
            let value = self.tokens[self.pos].text.clone();
            self.pos += 1;
            Ok(value)
        } else {
            bail!("invalid Cypher: expected {context}");
        }
    }

    fn expect_number(&mut self, context: &str) -> Result<i64> {
        if self
            .peek()
            .is_some_and(|token| token.kind == TokenKind::Number)
        {
            let value = self.tokens[self.pos].text.parse::<i64>()?;
            self.pos += 1;
            Ok(value)
        } else {
            bail!("invalid Cypher: expected numeric {context}");
        }
    }

    fn expect_string_like(&mut self, context: &str) -> Result<String> {
        if self
            .peek()
            .is_some_and(|token| matches!(token.kind, TokenKind::String | TokenKind::Ident))
        {
            let value = self.tokens[self.pos].text.clone();
            self.pos += 1;
            Ok(value)
        } else {
            bail!("invalid Cypher: expected {context}");
        }
    }

    fn parse_pattern(&mut self) -> Result<MatchPattern> {
        if self
            .peek()
            .is_some_and(|token| token.kind == TokenKind::Ident)
            && self
                .tokens
                .get(self.pos + 1)
                .is_some_and(|token| token.text == "=")
        {
            bail!("unsupported Cypher: path binding is not part of the M4 subset");
        }
        self.expect_text("(")?;
        let left_var = self.expect_ident("left node variable")?;
        let left_label = if self.consume_text(":") {
            Some(self.expect_ident("left node label")?)
        } else {
            None
        };
        self.expect_text(")")?;
        self.expect_text("-")?;
        self.expect_text("[")?;
        let mut rel_var = None;
        if self
            .peek()
            .is_some_and(|token| token.kind == TokenKind::Ident)
            && self
                .tokens
                .get(self.pos + 1)
                .is_some_and(|token| token.text == ":")
        {
            rel_var = Some(self.expect_ident("relationship variable")?);
        }
        self.expect_text(":")?;
        if self.consume_text("*") {
            bail!(
                "unsupported Cypher: variable-length relationships are not part of the M4 subset"
            );
        }
        let rel_type = self.expect_ident("relationship type")?;
        if self.consume_text("|") {
            bail!("unsupported Cypher: relationship alternation is not part of the M4 subset");
        }
        self.expect_text("]")?;
        if self.consume_text("<-") {
            bail!(
                "unsupported Cypher: reverse relationship patterns are not part of the M4 subset"
            );
        }
        self.expect_text("->")?;
        self.expect_text("(")?;
        let right_var = self.expect_ident("right node variable")?;
        let right_label = if self.consume_text(":") {
            Some(self.expect_ident("right node label")?)
        } else {
            None
        };
        self.expect_text(")")?;
        Ok(MatchPattern {
            left_var,
            left_label,
            rel_var,
            rel_type,
            right_var,
            right_label,
        })
    }

    fn parse_projection_until(&mut self, stop_keywords: &[&str]) -> Result<ProjectionClause> {
        let distinct = self.consume_keyword("DISTINCT");
        let mut items = Vec::new();
        loop {
            let expr = self.parse_value_expr()?;
            let alias = if self.consume_keyword("AS") {
                self.expect_ident("projection alias")?
            } else {
                default_alias(&expr)
            };
            items.push(SelectItem { expr, alias });
            if self.consume_text(",") {
                continue;
            }
            if self.is_end()
                || stop_keywords.iter().any(|keyword| {
                    self.peek().is_some_and(|token| {
                        token.kind == TokenKind::Ident && token.text.eq_ignore_ascii_case(keyword)
                    })
                })
            {
                break;
            }
            bail!("invalid Cypher: expected comma or clause boundary");
        }
        if items.is_empty() {
            bail!("invalid Cypher: projection requires at least one item");
        }
        Ok(ProjectionClause { distinct, items })
    }

    fn parse_or_expr(&mut self) -> Result<BoolExpr> {
        let mut expr = self.parse_and_expr()?;
        while self.consume_keyword("OR") {
            expr = BoolExpr::Or(Box::new(expr), Box::new(self.parse_and_expr()?));
        }
        Ok(expr)
    }

    fn parse_and_expr(&mut self) -> Result<BoolExpr> {
        let mut expr = self.parse_not_expr()?;
        while self.consume_keyword("AND") {
            expr = BoolExpr::And(Box::new(expr), Box::new(self.parse_not_expr()?));
        }
        Ok(expr)
    }

    fn parse_not_expr(&mut self) -> Result<BoolExpr> {
        if self.consume_keyword("NOT") {
            Ok(BoolExpr::Not(Box::new(self.parse_not_expr()?)))
        } else {
            self.parse_atom_expr()
        }
    }

    fn parse_atom_expr(&mut self) -> Result<BoolExpr> {
        if self.consume_text("(") {
            let expr = self.parse_or_expr()?;
            self.expect_text(")")?;
            return Ok(expr);
        }
        if self
            .peek()
            .is_some_and(|token| token.kind == TokenKind::Ident)
            && self
                .tokens
                .get(self.pos + 1)
                .is_some_and(|token| token.text == ":")
        {
            let var = self.expect_ident("label variable")?;
            self.expect_text(":")?;
            let label = self.expect_ident("label")?;
            return Ok(BoolExpr::LabelTest(var, label));
        }
        let left = self.parse_value_expr()?;
        let op = if self.consume_text("=") {
            CompareOp::Eq
        } else if self.consume_text("<>") {
            CompareOp::Ne
        } else if self.consume_text(">=") {
            CompareOp::Gte
        } else if self.consume_text("<=") {
            CompareOp::Lte
        } else if self.consume_text(">") {
            CompareOp::Gt
        } else if self.consume_text("<") {
            CompareOp::Lt
        } else if self.consume_keyword("CONTAINS") {
            CompareOp::Contains
        } else if self.consume_keyword("STARTS") {
            self.expect_keyword("WITH")?;
            CompareOp::StartsWith
        } else {
            bail!("invalid Cypher: expected WHERE comparison operator");
        };
        let right = self.parse_value_expr()?;
        Ok(BoolExpr::Compare(left, op, right))
    }

    fn parse_value_expr(&mut self) -> Result<ValueExpr> {
        if self.consume_keyword("count") {
            self.expect_text("(")?;
            if self.consume_text("*") {
                self.expect_text(")")?;
                return Ok(ValueExpr::CountAll);
            }
            self.expect_keyword("DISTINCT")?;
            let expr = self.parse_value_expr()?;
            self.expect_text(")")?;
            return Ok(ValueExpr::CountDistinct(Box::new(expr)));
        }
        if self.consume_keyword("labels") {
            self.expect_text("(")?;
            let var = self.expect_ident("labels variable")?;
            self.expect_text(")")?;
            return Ok(ValueExpr::Labels(var));
        }
        if self.consume_keyword("toInteger") {
            self.expect_text("(")?;
            let expr = self.parse_value_expr()?;
            self.expect_text(")")?;
            return Ok(ValueExpr::ToInteger(Box::new(expr)));
        }
        if self
            .peek()
            .is_some_and(|token| token.kind == TokenKind::String)
        {
            let value = self.tokens[self.pos].text.clone();
            self.pos += 1;
            return Ok(ValueExpr::String(value));
        }
        if self
            .peek()
            .is_some_and(|token| token.kind == TokenKind::Number)
        {
            let value = self.tokens[self.pos].text.parse::<i64>()?;
            self.pos += 1;
            return Ok(ValueExpr::Number(value));
        }
        let ident = self.expect_ident("expression")?;
        if self.consume_text(".") {
            let prop = self.expect_ident("property")?;
            return Ok(ValueExpr::Property(ident, prop));
        }
        Ok(ValueExpr::Alias(ident))
    }
}

fn default_alias(expr: &ValueExpr) -> String {
    match expr {
        ValueExpr::Property(var, prop) => format!("{var}.{prop}"),
        ValueExpr::Labels(var) => format!("labels({var})"),
        ValueExpr::ToInteger(_) => "toInteger".to_string(),
        ValueExpr::String(_) => "string".to_string(),
        ValueExpr::Number(_) => "number".to_string(),
        ValueExpr::Alias(value) => value.clone(),
        ValueExpr::CountAll => "count".to_string(),
        ValueExpr::CountDistinct(_) => "count".to_string(),
    }
}

fn evaluate_cypher(
    parsed: &ParsedCypher,
    edges: &[GraphEdge],
    max_rows: usize,
) -> Result<QueryResult> {
    let mut rows = Vec::new();
    for edge in edges {
        if edge.predicate != parsed.pattern.rel_type {
            continue;
        }
        if parsed
            .pattern
            .left_label
            .as_deref()
            .is_some_and(|label| !label_matches(&edge.from, label))
            || parsed
                .pattern
                .right_label
                .as_deref()
                .is_some_and(|label| !label_matches(&edge.to, label))
        {
            continue;
        }
        let mut entities = HashMap::new();
        entities.insert(parsed.pattern.left_var.clone(), edge.from.clone());
        entities.insert(parsed.pattern.right_var.clone(), edge.to.clone());
        let mut rels = HashMap::new();
        if let Some(var) = &parsed.pattern.rel_var {
            rels.insert(var.clone(), edge.clone());
        }
        rows.push(EvalRow {
            entities,
            rels,
            aliases: HashMap::new(),
        });
    }
    if let Some(expr) = &parsed.where_expr {
        rows.retain(|row| eval_bool(expr, row).unwrap_or(false));
    }
    if let Some(with_clause) = &parsed.with_clause {
        rows = project_eval_rows(&rows, with_clause)?;
    }
    let columns = parsed
        .return_clause
        .items
        .iter()
        .map(|item| item.alias.clone())
        .collect::<Vec<_>>();
    let has_aggregate = parsed
        .return_clause
        .items
        .iter()
        .any(|item| matches!(item.expr, ValueExpr::CountAll | ValueExpr::CountDistinct(_)));
    let mut out_rows = if has_aggregate {
        if parsed.return_clause.items.len() != 1 {
            bail!("unsupported Cypher: aggregate projections cannot be mixed in the M4 subset");
        }
        vec![project_aggregate_row(
            &rows,
            &parsed.return_clause.items[0],
        )?]
    } else {
        project_json_rows(&rows, &parsed.return_clause)?
    };
    if parsed.return_clause.distinct {
        out_rows = distinct_json_rows(out_rows);
    }
    if let Some(order_by) = &parsed.order_by {
        out_rows.sort_by(|left, right| {
            let left_value = left.get(&order_by.key).cloned().unwrap_or(Value::Null);
            let right_value = right.get(&order_by.key).cloned().unwrap_or(Value::Null);
            let ordering = json_sort_key(&left_value).cmp(&json_sort_key(&right_value));
            if order_by.descending {
                ordering.reverse()
            } else {
                ordering
            }
        });
    }
    if let Some(limit) = parsed.limit {
        out_rows.truncate(limit);
    }
    let truncated = out_rows.len() > max_rows;
    out_rows.truncate(max_rows);
    Ok(QueryResult {
        columns,
        rows: out_rows,
        truncated,
    })
}

fn project_eval_rows(rows: &[EvalRow], clause: &ProjectionClause) -> Result<Vec<EvalRow>> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for row in rows {
        let mut aliases = HashMap::new();
        let mut key_parts = Vec::new();
        for item in &clause.items {
            let value = eval_value(&item.expr, row)?;
            key_parts.push(canonical_json(&value));
            aliases.insert(item.alias.clone(), value);
        }
        if clause.distinct && !seen.insert(key_parts.join("\0")) {
            continue;
        }
        out.push(EvalRow {
            entities: HashMap::new(),
            rels: HashMap::new(),
            aliases,
        });
    }
    Ok(out)
}

fn project_json_rows(rows: &[EvalRow], clause: &ProjectionClause) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    for row in rows {
        let mut object = Map::new();
        for item in &clause.items {
            object.insert(item.alias.clone(), eval_value(&item.expr, row)?);
        }
        out.push(Value::Object(object));
    }
    Ok(out)
}

fn project_aggregate_row(rows: &[EvalRow], item: &SelectItem) -> Result<Value> {
    let value = match &item.expr {
        ValueExpr::CountAll => json!(rows.len()),
        ValueExpr::CountDistinct(expr) => {
            let mut seen = HashSet::new();
            for row in rows {
                seen.insert(canonical_json(&eval_value(expr, row)?));
            }
            json!(seen.len())
        }
        _ => bail!("invalid Cypher: expected aggregate expression"),
    };
    let mut object = Map::new();
    object.insert(item.alias.clone(), value);
    Ok(Value::Object(object))
}

fn distinct_json_rows(rows: Vec<Value>) -> Vec<Value> {
    let mut seen = HashSet::new();
    rows.into_iter()
        .filter(|row| seen.insert(canonical_json(row)))
        .collect()
}

fn eval_bool(expr: &BoolExpr, row: &EvalRow) -> Result<bool> {
    Ok(match expr {
        BoolExpr::Or(left, right) => eval_bool(left, row)? || eval_bool(right, row)?,
        BoolExpr::And(left, right) => eval_bool(left, row)? && eval_bool(right, row)?,
        BoolExpr::Not(inner) => !eval_bool(inner, row)?,
        BoolExpr::LabelTest(var, label) => row
            .entities
            .get(var)
            .is_some_and(|name| label_matches(name, label)),
        BoolExpr::Compare(left, op, right) => {
            compare_values(&eval_value(left, row)?, op, &eval_value(right, row)?)
        }
    })
}

fn compare_values(left: &Value, op: &CompareOp, right: &Value) -> bool {
    match op {
        CompareOp::Eq => left == right,
        CompareOp::Ne => left != right,
        CompareOp::Gt | CompareOp::Gte | CompareOp::Lt | CompareOp::Lte => {
            let left_num = left.as_i64().or_else(|| left.as_str().and_then(parse_int));
            let right_num = right
                .as_i64()
                .or_else(|| right.as_str().and_then(parse_int));
            match (left_num, right_num) {
                (Some(left), Some(right)) => match op {
                    CompareOp::Gt => left > right,
                    CompareOp::Gte => left >= right,
                    CompareOp::Lt => left < right,
                    CompareOp::Lte => left <= right,
                    _ => false,
                },
                _ => match op {
                    CompareOp::Gt => json_sort_key(left) > json_sort_key(right),
                    CompareOp::Gte => json_sort_key(left) >= json_sort_key(right),
                    CompareOp::Lt => json_sort_key(left) < json_sort_key(right),
                    CompareOp::Lte => json_sort_key(left) <= json_sort_key(right),
                    _ => false,
                },
            }
        }
        CompareOp::Contains => value_string(left).contains(&value_string(right)),
        CompareOp::StartsWith => value_string(left).starts_with(&value_string(right)),
    }
}

fn eval_value(expr: &ValueExpr, row: &EvalRow) -> Result<Value> {
    Ok(match expr {
        ValueExpr::Property(var, prop) => {
            if let Some(name) = row.entities.get(var) {
                match prop.as_str() {
                    "name" => Value::String(name.clone()),
                    "type" | "kind" => Value::String(temporal_graph_entity_type(name)),
                    _ => bail!("unsupported Cypher: node property {prop} is not supported"),
                }
            } else if let Some(edge) = row.rels.get(var) {
                match prop.as_str() {
                    "predicate" => Value::String(edge.predicate.clone()),
                    "factId" | "fact_id" => Value::String(edge.fact_id.clone()),
                    "from" => Value::String(edge.from.clone()),
                    "to" => Value::String(edge.to.clone()),
                    "source" => Value::String(edge.source.clone()),
                    _ => bail!("unsupported Cypher: relationship property {prop} is not supported"),
                }
            } else {
                bail!("invalid Cypher: unknown variable {var}");
            }
        }
        ValueExpr::Labels(var) => {
            let name = row
                .entities
                .get(var)
                .ok_or_else(|| anyhow!("invalid Cypher: unknown variable {var}"))?;
            json!([cypher_label(name)])
        }
        ValueExpr::ToInteger(inner) => {
            let value = eval_value(inner, row)?;
            match value
                .as_i64()
                .or_else(|| value.as_str().and_then(parse_int))
            {
                Some(value) => json!(value),
                None => Value::Null,
            }
        }
        ValueExpr::String(value) => Value::String(value.clone()),
        ValueExpr::Number(value) => json!(value),
        ValueExpr::Alias(value) => row
            .aliases
            .get(value)
            .cloned()
            .or_else(|| {
                row.entities
                    .get(value)
                    .map(|name| Value::String(name.clone()))
            })
            .ok_or_else(|| anyhow!("invalid Cypher: unknown alias or variable {value}"))?,
        ValueExpr::CountAll | ValueExpr::CountDistinct(_) => {
            bail!("invalid Cypher: aggregate expression is only valid in RETURN")
        }
    })
}

fn parse_int(value: &str) -> Option<i64> {
    value.trim().parse::<i64>().ok()
}

fn value_string(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

fn json_sort_key(value: &Value) -> String {
    match value {
        Value::Null => "".to_string(),
        Value::String(value) => value.clone(),
        Value::Number(value) => format!("{value:>020}"),
        Value::Bool(value) => value.to_string(),
        Value::Array(_) | Value::Object(_) => canonical_json(value),
    }
}

#[derive(Debug, Clone)]
struct NormalizedBatchFact {
    subject: String,
    predicate: String,
    object: String,
    source: String,
    source_trust: String,
    extraction_confidence: String,
    notes: Option<String>,
    supersedes: bool,
    supersedes_object: Option<String>,
}

#[derive(Debug, Clone)]
struct ProposalInput {
    id: String,
    fingerprint: String,
    source_locator: String,
    source_hash: String,
    enqueued_at: String,
    payload_json: String,
    payload: Value,
}

fn normalize_batch_fact(root: &Path, input: &BatchFact) -> Result<NormalizedBatchFact> {
    let subject = safe_batch_token(&input.subject, "subject")?;
    let predicate = safe_batch_token(&input.predicate, "predicate")?;
    let object = safe_batch_object(&input.object)?;
    let source = safe_batch_source(root, &input.source)?;
    let source_trust = normalize_source_trust(input.source_trust.as_deref().unwrap_or("verified"))?;
    let extraction_confidence = match input.confidence.as_deref().unwrap_or("extracted").trim() {
        "extracted" | "inferred" | "ambiguous" => input
            .confidence
            .clone()
            .unwrap_or_else(|| "extracted".to_string()),
        _ => bail!("confidence must be extracted, inferred, or ambiguous"),
    };
    let notes = match input.notes.as_deref() {
        Some(value) => Some(safe_batch_notes(value)?),
        None => None,
    };
    let (supersedes, supersedes_object) = match &input.supersedes {
        Some(supersedes) => {
            let supersedes_subject = safe_batch_token(&supersedes.subject, "supersedes.subject")?;
            let supersedes_predicate =
                safe_batch_token(&supersedes.predicate, "supersedes.predicate")?;
            if supersedes_subject != subject || supersedes_predicate != predicate {
                bail!("supersedes must match subject and predicate");
            }
            let supersedes_object = match supersedes.object.as_deref() {
                Some(value) => Some(safe_batch_object(value)?),
                None => None,
            };
            (true, supersedes_object)
        }
        None => (false, None),
    };
    Ok(NormalizedBatchFact {
        subject,
        predicate,
        object,
        source,
        source_trust,
        extraction_confidence,
        notes,
        supersedes,
        supersedes_object,
    })
}

fn build_proposal_input(
    workspace_id: &str,
    scope: &str,
    subject: &str,
    predicate: &str,
    object: &str,
    source: &str,
    generated_at: &str,
    enqueued_at: &str,
    extraction_confidence: &str,
    notes: Option<&str>,
    source_trust: &str,
    supersedes: bool,
    supersedes_object: Option<&str>,
) -> Result<ProposalInput> {
    let text = format!("{subject} {predicate} {object}");
    let source_hash = source_hash_for_fact(subject, predicate, object, source);
    let id = proposal_id_from_parts(
        workspace_id,
        scope,
        subject,
        predicate,
        object,
        &source_hash,
    );
    let episode_id = episode_id_from_parts(workspace_id, source, &source_hash, &text);
    let mut payload = json!({
        "kind": "fact",
        "scope": scope,
        "subject": subject,
        "predicate": predicate,
        "object": object,
        "text": text,
        "observedAt": generated_at,
        "subjectEntity": subject,
        "objectEntity": object,
        "provenanceEpisodeId": episode_id,
        "provenanceSourceLocator": source,
        "provenanceSourceHash": source_hash,
        "extractionConfidence": extraction_confidence,
        "supersedesSubjectPredicate": supersedes,
        "notes": notes
    });
    payload["factFingerprint"] = Value::String(fact_proposal_fingerprint(
        scope, subject, predicate, object, source,
    ));
    if let Some(supersedes_object) = supersedes_object {
        payload["supersedesObject"] = Value::String(supersedes_object.to_string());
    }
    if source_trust != "verified" {
        payload["sourceTrust"] = Value::String(source_trust.to_string());
        payload["trustClass"] = Value::String(source_trust.to_string());
        payload["policyReceipt"] = policy_receipt(
            "queue_only",
            "untrusted_source_requires_explicit_approval",
            source_trust,
        );
    }
    let payload_json = serde_json::to_string(&payload)?;
    let fingerprint = proposal_fingerprint_from_parts(
        workspace_id,
        source,
        &source_hash,
        &canonical_json(&payload),
    );
    Ok(ProposalInput {
        id,
        fingerprint,
        source_locator: source.to_string(),
        source_hash: source_hash.clone(),
        enqueued_at: enqueued_at.to_string(),
        payload_json,
        payload,
    })
}

fn proposal_row_to_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let payload_json: String = row.get("payload_json")?;
    let result_json: Option<String> = row.get("result_json")?;
    let error_json: Option<String> = row.get("error_json")?;
    Ok(json!({
        "schemaVersion": "1.0.0",
        "id": row.get::<_, String>("id")?,
        "workspaceId": row.get::<_, String>("workspace_id")?,
        "fingerprint": row.get::<_, String>("fingerprint")?,
        "sourceLocator": row.get::<_, String>("source_locator")?,
        "sourceHash": row.get::<_, String>("source_hash")?,
        "status": row.get::<_, String>("status")?,
        "attempts": row.get::<_, i64>("attempts")?,
        "maxAttempts": row.get::<_, i64>("max_attempts")?,
        "leaseOwner": row.get::<_, Option<String>>("lease_owner")?,
        "leaseUntil": row.get::<_, Option<String>>("lease_until")?,
        "payload": serde_json::from_str::<Value>(&payload_json).unwrap_or_else(|_| json!({})),
        "result": result_json.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
        "error": error_json.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
        "enqueuedAt": row.get::<_, String>("enqueued_at")?,
        "updatedAt": row.get::<_, String>("updated_at")?
    }))
}

fn proposal_fingerprint(workspace_id: &str, proposal: &ProposalInput) -> String {
    debug_assert_eq!(
        proposal.fingerprint,
        proposal_fingerprint_from_parts(
            workspace_id,
            &proposal.source_locator,
            &proposal.source_hash,
            &canonical_json(&proposal.payload),
        )
    );
    proposal.fingerprint.clone()
}

fn proposal_fingerprint_from_parts(
    workspace_id: &str,
    source_locator: &str,
    source_hash: &str,
    payload_canonical_json: &str,
) -> String {
    sha256_hex(&format!(
        "{{\"payload\":{},\"sourceHash\":{},\"sourceLocator\":{},\"workspaceId\":{}}}",
        payload_canonical_json,
        serde_json::to_string(source_hash).unwrap(),
        serde_json::to_string(source_locator).unwrap(),
        serde_json::to_string(workspace_id).unwrap()
    ))
}

fn source_hash_for_fact(subject: &str, predicate: &str, object: &str, source: &str) -> String {
    format!(
        "sha256:{}",
        sha256_hex(&canonical_string_object(&[
            ("object", object),
            ("predicate", predicate),
            ("source", source),
            ("subject", subject),
        ]))
    )
}

fn fact_proposal_fingerprint(
    scope: &str,
    subject: &str,
    predicate: &str,
    object: &str,
    source: &str,
) -> String {
    sha256_hex(&canonical_string_object(&[
        ("scope", scope),
        ("subject", subject),
        ("predicate", predicate),
        ("object", object),
        ("source", source),
    ]))
}

fn proposal_id_from_parts(
    workspace_id: &str,
    scope: &str,
    subject: &str,
    predicate: &str,
    object: &str,
    source_hash: &str,
) -> String {
    format!(
        "mpq_{}",
        &sha256_hex(&canonical_string_object(&[
            ("object", object),
            ("predicate", predicate),
            ("scope", scope),
            ("sourceHash", source_hash),
            ("subject", subject),
            ("workspaceId", workspace_id),
        ]))[..32]
    )
}

fn episode_id_from_parts(
    workspace_id: &str,
    source: &str,
    source_hash: &str,
    text: &str,
) -> String {
    format!(
        "mep_{}",
        &sha256_hex(&canonical_string_object(&[
            ("source", source),
            ("sourceHash", source_hash),
            ("text", text),
            ("workspaceId", workspace_id),
        ]))[..32]
    )
}

fn summarize_proposal_input(
    workspace_id: &str,
    proposal: &ProposalInput,
    status: &str,
) -> Result<Option<Value>> {
    summarize_proposal_value(&json!({
        "id": proposal.id,
        "workspaceId": workspace_id,
        "status": status,
        "payload": proposal.payload,
        "sourceLocator": proposal.source_locator,
        "sourceHash": proposal.source_hash
    }))
}

fn summarize_proposal_value(item: &Value) -> Result<Option<Value>> {
    let Some(payload) = item.get("payload").and_then(Value::as_object) else {
        return Ok(None);
    };
    if payload.get("kind").and_then(Value::as_str) != Some("fact") {
        return Ok(None);
    }
    let Some(status) = item.get("status").and_then(Value::as_str) else {
        return Ok(None);
    };
    if status != "pending" && status != "claimed" {
        return Ok(None);
    }
    let mut summary = json!({
        "id": sanitize_string(item.get("id").and_then(Value::as_str).unwrap_or(""), 120),
        "workspaceId": item.get("workspaceId").cloned().unwrap_or(Value::Null),
        "status": status,
        "scope": sanitize_string(payload.get("scope").and_then(Value::as_str).unwrap_or("workspace"), 64),
        "subject": sanitize_string(payload.get("subject").and_then(Value::as_str).unwrap_or(""), 160),
        "predicate": sanitize_string(payload.get("predicate").and_then(Value::as_str).unwrap_or(""), 120),
        "object": sanitize_string(payload.get("object").and_then(Value::as_str).unwrap_or(""), 240),
        "extractionConfidence": extraction_confidence(payload.get("extractionConfidence").and_then(Value::as_str)),
        "text": sanitize_string(payload.get("text").and_then(Value::as_str).unwrap_or(""), 600),
        "provenance": {
            "sourceLocator": safe_locator(item.get("sourceLocator").and_then(Value::as_str).unwrap_or("")),
            "sourceHash": item.get("sourceHash").cloned().unwrap_or(Value::Null),
            "episodeId": payload.get("provenanceEpisodeId").and_then(Value::as_str).map(|value| sanitize_string(value, 120))
        }
    });
    if let Some(source_trust) = payload.get("sourceTrust") {
        summary["sourceTrust"] = source_trust.clone();
    }
    if let Some(trust_class) = payload.get("trustClass") {
        summary["trustClass"] = trust_class.clone();
    }
    if let Some(receipt) = payload.get("policyReceipt") {
        summary["policyReceipt"] = receipt.clone();
    }
    Ok(Some(summary))
}

fn fact_from_row(conn: &Connection, row: &rusqlite::Row<'_>) -> rusqlite::Result<RecallFact> {
    let episode_id: String = row.get("episode_id")?;
    let workspace_id: String = row.get("workspace_id")?;
    let episode = conn
        .query_row(
            "SELECT * FROM memory_episodes WHERE workspace_id = ? AND id = ?",
            params![workspace_id, episode_id],
            |episode| {
                let metadata_json: String = episode.get("metadata_json")?;
                Ok(json!({
                    "schemaVersion": "1.0.0",
                    "id": episode.get::<_, String>("id")?,
                    "workspaceId": episode.get::<_, String>("workspace_id")?,
                    "scope": episode.get::<_, String>("scope")?,
                    "sourceLocator": episode.get::<_, String>("source_locator")?,
                    "summary": episode.get::<_, String>("summary")?,
                    "observedAt": episode.get::<_, String>("observed_at")?,
                    "createdAt": episode.get::<_, String>("created_at")?,
                    "metadata": serde_json::from_str::<Value>(&metadata_json).unwrap_or_else(|_| json!({}))
                }))
            },
        )
        .optional()?;
    let episode_source_locator = episode
        .as_ref()
        .and_then(|value| value.get("sourceLocator"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let metadata_json: String = row.get("metadata_json")?;
    Ok(RecallFact {
        id: row.get("id")?,
        workspace_id,
        scope: row.get("scope")?,
        subject: row.get("subject")?,
        predicate: row.get("predicate")?,
        object: row.get("object")?,
        text: row.get("text")?,
        status: row.get("status")?,
        source: row.get("source")?,
        confidence: row.get("confidence")?,
        updated_at: row.get("updated_at")?,
        valid_from: row.get("valid_from")?,
        valid_until: row.get("valid_until")?,
        superseded_by: row.get("superseded_by")?,
        proposal_queue_id: row.get("proposal_queue_id")?,
        episode_id,
        created_at: row.get("created_at")?,
        metadata: serde_json::from_str(&metadata_json).unwrap_or_else(|_| json!({})),
        episode_source_locator,
        episode,
    })
}

fn temporal_fact_value(fact: &RecallFact) -> Value {
    json!({
        "schemaVersion": "1.0.0",
        "id": fact.id,
        "workspaceId": fact.workspace_id,
        "scope": fact.scope,
        "subject": fact.subject,
        "predicate": fact.predicate,
        "object": fact.object,
        "text": fact.text,
        "status": fact.status,
        "source": fact.source,
        "confidence": fact.confidence,
        "validFrom": fact.valid_from,
        "validUntil": fact.valid_until,
        "supersededBy": fact.superseded_by,
        "episodeId": fact.episode_id,
        "proposalQueueId": fact.proposal_queue_id,
        "createdAt": fact.created_at,
        "updatedAt": fact.updated_at,
        "metadata": fact.metadata,
        "episode": fact.episode
    })
}

fn summarize_current_truth_fact(fact: &RecallFact) -> Value {
    json!({
        "id": sanitize_string(&fact.id, 120),
        "subject": sanitize_string(&fact.subject, 160),
        "predicate": sanitize_string(&fact.predicate, 120),
        "value": sanitize_string(&fact.object, 240),
        "extractionConfidence": extraction_confidence(fact.metadata.get("extractionConfidence").and_then(Value::as_str)),
        "sourceRef": compact_provenance_ref(if !fact.proposal_queue_id.is_empty() {
            &fact.proposal_queue_id
        } else {
            fact.episode_source_locator.as_deref().unwrap_or(&fact.source)
        })
    })
}

fn conflict_fact_value(fact: &RecallFact) -> Value {
    json!({
        "id": sanitize_string(&fact.id, 120),
        "object": sanitize_string(&fact.object, 240),
        "status": fact.status,
        "sourceRef": compact_provenance_ref(fact.episode_source_locator.as_deref().unwrap_or(&fact.source)),
        "sourceTrust": fact.metadata.get("sourceTrust").cloned().unwrap_or_else(|| Value::String("verified".to_string())),
        "trustClass": fact.metadata.get("trustClass").cloned().unwrap_or_else(|| Value::String("verified".to_string())),
        "validFrom": fact.valid_from,
        "confidence": fact.confidence
    })
}

fn fact_brief(fact: &RecallFact) -> Value {
    json!({
        "id": sanitize_string(&fact.id, 120),
        "subject": sanitize_string(&fact.subject, 160),
        "predicate": sanitize_string(&fact.predicate, 120),
        "object": sanitize_string(&fact.object, 240),
        "text": sanitize_string(&fact.text, 300),
        "status": fact.status,
        "confidence": fact.confidence,
        "validFrom": fact.valid_from,
        "validUntil": fact.valid_until,
        "supersededBy": fact.superseded_by,
        "episodeId": fact.episode_id,
        "proposalQueueId": fact.proposal_queue_id,
        "sourceRef": compact_provenance_ref(fact.episode_source_locator.as_deref().unwrap_or(&fact.source))
    })
}

fn search_hit_value(item: ScoredFact) -> Value {
    json!({
        "fact": {
            "id": sanitize_string(&item.fact.id, 120),
            "subject": sanitize_string(&item.fact.subject, 160),
            "predicate": sanitize_string(&item.fact.predicate, 120),
            "value": sanitize_string(&item.fact.object, 240),
            "text": sanitize_string(&item.fact.text, 320),
            "sourceRef": compact_provenance_ref(item.fact.episode_source_locator.as_deref().unwrap_or(&item.fact.source)),
            "extractionConfidence": extraction_confidence(item.fact.metadata.get("extractionConfidence").and_then(Value::as_str))
        },
        "score": {
            "total": round_score(item.score),
            "keyword": round_score(item.keyword_score),
            "semantic": round_score(item.semantic_score),
            "governanceBoost": round_score(item.governance_boost)
        }
    })
}

fn round_score(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

fn profile_record_from_fact(fact: &RecallFact) -> Value {
    let source_trust = fact
        .metadata
        .get("sourceTrust")
        .and_then(Value::as_str)
        .unwrap_or("verified");
    let trust_class = fact
        .metadata
        .get("trustClass")
        .and_then(Value::as_str)
        .unwrap_or(source_trust);
    let mut metadata = json!({
        "extractionConfidence": extraction_confidence(fact.metadata.get("extractionConfidence").and_then(Value::as_str))
    });
    if let Some(receipt) = fact.metadata.get("policyReceipt") {
        if !receipt.is_null() {
            metadata["policyReceipt"] = receipt.clone();
        }
    }
    json!({
        "id": format!("mem_{}", fact.id),
        "workspaceId": fact.workspace_id,
        "kind": "fact",
        "text": fact.text,
        "scope": fact.scope,
        "dataClass": "workspace-private",
        "status": fact.status,
        "source": fact.source,
        "sourceTrust": source_trust,
        "trustClass": trust_class,
        "confidence": fact.confidence,
        "authority": fact.confidence,
        "tags": [fact.subject.clone(), fact.predicate.clone(), fact.object.clone()],
        "relations": [fact.subject.clone(), fact.object.clone()],
        "updatedAt": fact.updated_at,
        "observedAt": fact.valid_from,
        "metadata": metadata
    })
}

fn profile_selected_fact_value(fact: &RecallFact) -> Value {
    let mut value = json!({
        "id": format!("mem_{}", sanitize_string(&fact.id, 120)),
        "text": sanitize_string(&fact.text, 300),
        "sourceRef": compact_provenance_ref(fact.episode_source_locator.as_deref().unwrap_or(&fact.source)),
        "trust": "active",
        "extractionConfidence": extraction_confidence(fact.metadata.get("extractionConfidence").and_then(Value::as_str))
    });
    if let Some(source_trust) = fact.metadata.get("sourceTrust") {
        value["sourceTrust"] = source_trust.clone();
    }
    if let Some(trust_class) = fact.metadata.get("trustClass") {
        value["trustClass"] = trust_class.clone();
    }
    if let Some(receipt) = fact.metadata.get("policyReceipt") {
        if !receipt.is_null() {
            value["metadata"] = json!({ "policyReceipt": receipt });
        }
    }
    value
}

fn symbol_kind(name: &str) -> String {
    if name.starts_with("method:") {
        "Method".to_string()
    } else if name.starts_with("class:") {
        "Class".to_string()
    } else {
        "Function".to_string()
    }
}

fn safe_batch_token(value: &str, name: &str) -> Result<String> {
    let text = value.trim();
    if !Regex::new(r"^[A-Za-z0-9:_-]{1,128}$")?.is_match(text) || is_private_or_unsafe(text) {
        bail!("{name} must be safe");
    }
    Ok(text.to_string())
}

fn safe_batch_object(value: &str) -> Result<String> {
    let text = value.trim().trim_end_matches(['.', ';', ':', ',']).trim();
    if !Regex::new(r"^[A-Za-z0-9][A-Za-z0-9:_./ =,;()'-]{0,239}$")?.is_match(text)
        || is_private_or_unsafe(text)
    {
        bail!("object must be safe");
    }
    Ok(text.to_string())
}

fn safe_batch_notes(value: &str) -> Result<String> {
    let text = value.trim();
    if text.is_empty()
        || text.len() > 500
        || text.contains('\n')
        || text.contains('\r')
        || is_private_or_unsafe(text)
    {
        bail!("notes must be safe");
    }
    Ok(text.to_string())
}

fn safe_batch_source(root: &Path, value: &str) -> Result<String> {
    let source = normalize_workspace_locator(value)?;
    let relative = source.trim_start_matches("workspace://");
    let root =
        fs::canonicalize(root).with_context(|| format!("canonicalize root {}", root.display()))?;
    let absolute = root.join(relative);
    if !absolute.starts_with(&root) {
        bail!("source must stay inside workspace");
    }
    Ok(source)
}

fn normalize_workspace_locator(value: &str) -> Result<String> {
    let source = value.trim();
    if !source.starts_with("workspace://") {
        bail!("source must be workspace-relative");
    }
    let rest = &source["workspace://".len()..];
    if rest.is_empty()
        || rest.starts_with('/')
        || rest.contains('\\')
        || rest.contains("..")
        || rest.contains('\n')
        || rest.contains('\r')
    {
        bail!("source must stay inside workspace");
    }
    let mut parts = Vec::new();
    for component in Path::new(rest).components() {
        match component {
            Component::Normal(value) => parts.push(value.to_string_lossy().to_string()),
            Component::CurDir => {}
            _ => bail!("source must stay inside workspace"),
        }
    }
    if parts.is_empty() {
        bail!("source must stay inside workspace");
    }
    Ok(format!("workspace://{}", parts.join("/")))
}

fn is_private_or_unsafe(value: &str) -> bool {
    static PRIVATE: OnceLock<Regex> = OnceLock::new();
    static UNSAFE: OnceLock<Regex> = OnceLock::new();
    PRIVATE
        .get_or_init(|| {
            Regex::new(r#"(?i)(/Users(?:/|$)\S*|/home/[A-Za-z0-9._-]+(?:/|$)\S*|[A-Za-z]:\\\S*|sk-[A-Za-z0-9_-]{12,}|OPENAI_API_KEY|AKIA[0-9A-Z]{16}|gh[opsu]_[A-Za-z0-9_]{12,}|(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^"',;\s]+)"#).unwrap()
        })
        .is_match(value)
        || UNSAFE.get_or_init(|| Regex::new(r#"(?i)(^/|\s/|file://|[A-Za-z]:\\|\n|\r)"#).unwrap()).is_match(value)
}

pub fn expand_token_text(value: &str) -> String {
    let mut out = BTreeSet::new();
    for raw in
        value.split(|ch: char| !(ch.is_alphanumeric() || ch == ':' || ch == '_' || ch == '-'))
    {
        if raw.is_empty() {
            continue;
        }
        let lower = raw.to_lowercase();
        out.insert(lower);
        let separated = split_identifier(raw);
        if separated != raw {
            out.insert(separated.to_lowercase());
        }
        let separators = raw.replace([':', '_', '-'], " ");
        if separators != raw {
            out.insert(separators.to_lowercase());
        }
        let separated = split_identifier(&separators);
        if separated != separators {
            out.insert(separated.to_lowercase());
        }
    }
    out.into_iter().collect::<Vec<_>>().join(" ")
}

fn split_identifier(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::new();
    for (index, ch) in chars.iter().enumerate() {
        if index > 0 {
            let prev = chars[index - 1];
            let next = chars.get(index + 1).copied();
            let lower_to_upper = prev.is_lowercase() && ch.is_uppercase();
            let acronym_boundary = prev.is_uppercase()
                && ch.is_uppercase()
                && next.is_some_and(|next| next.is_lowercase());
            let digit_boundary = ((prev.is_ascii_digit() && !ch.is_ascii_digit())
                || (!prev.is_ascii_digit() && ch.is_ascii_digit()))
                && !(prev.is_uppercase() && ch.is_ascii_digit());
            if lower_to_upper || acronym_boundary || digit_boundary {
                out.push(' ');
            }
        }
        out.push(*ch);
    }
    out
}

fn fts_expression(query: &str) -> Option<String> {
    let mut tokens = Vec::new();
    let expanded = expand_token_text(query);
    for token in expanded
        .split(|ch: char| !(ch.is_alphanumeric() || ch == '_'))
        .filter(|token| !token.is_empty())
    {
        if !tokens.iter().any(|seen| seen == token) {
            tokens.push(token.to_string());
        }
        if tokens.len() == 24 {
            break;
        }
    }
    if tokens.is_empty() {
        None
    } else {
        Some(
            tokens
                .into_iter()
                .map(|token| format!("\"{}\"*", token.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(" OR "),
        )
    }
}

fn fact_matches_query(fact: &RecallFact, query: &str) -> bool {
    let stopwords = [
        "what",
        "which",
        "who",
        "where",
        "when",
        "why",
        "how",
        "is",
        "the",
        "a",
        "an",
        "by",
        "does",
        "do",
        "for",
        "to",
        "of",
        "provider",
        "default",
        "implements",
    ];
    let mut tokens = Vec::new();
    for token in query
        .to_lowercase()
        .split(|ch: char| !(ch.is_ascii_alphanumeric() || ch == ':' || ch == '_' || ch == '-'))
        .filter(|token| !token.is_empty() && !stopwords.contains(token))
    {
        tokens.push(token.to_string());
        if let Some(stripped) = token.strip_suffix('s') {
            tokens.push(stripped.to_string());
        }
    }
    if tokens.is_empty() {
        return true;
    }
    let haystack = format!(
        "{} {} {} {}",
        fact.subject, fact.predicate, fact.object, fact.object
    )
    .to_lowercase();
    tokens.iter().any(|token| haystack.contains(token))
}

fn changed_since(fact: &RecallFact, since: &str) -> bool {
    let changed = if fact.updated_at.is_empty() {
        &fact.valid_from
    } else {
        &fact.updated_at
    };
    changed.as_str() > since
}

fn memory_proposal_source_matches(item: &Value, source: &str) -> bool {
    let candidates = [
        item.get("sourceLocator").and_then(Value::as_str),
        item.pointer("/payload/provenance/sourceLocator")
            .and_then(Value::as_str),
        item.pointer("/payload/provenanceSourceLocator")
            .and_then(Value::as_str),
    ];
    candidates
        .into_iter()
        .flatten()
        .any(|candidate| normalize_workspace_locator(candidate).ok().as_deref() == Some(source))
}

fn requires_explicit_proposal_approval(item: &Value) -> bool {
    matches!(
        item.pointer("/payload/approvalMode")
            .and_then(Value::as_str),
        Some("explicit-id-only")
    ) || matches!(
        item.pointer("/payload/proposalOrigin")
            .and_then(Value::as_str),
        Some("semantic-setup")
    )
}

fn safe_locator(value: &str) -> Value {
    if value.is_empty() {
        Value::Null
    } else {
        Value::String(sanitize_string(value, 240))
    }
}

fn sanitize_string(value: &str, max_len: usize) -> String {
    let mut out = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if out.len() > max_len {
        out.truncate(max_len);
    }
    out
}

fn extraction_confidence(value: Option<&str>) -> &'static str {
    match value {
        Some("inferred") => "inferred",
        Some("ambiguous") => "ambiguous",
        _ => "extracted",
    }
}

fn compact_provenance_ref(value: &str) -> String {
    let raw = value.strip_prefix("workspace://").unwrap_or(value);
    let parts: Vec<&str> = raw.split('/').filter(|part| !part.is_empty()).collect();
    let compact = if parts.len() > 2 {
        format!("{}/{}", parts[parts.len() - 2], parts[parts.len() - 1])
    } else {
        raw.to_string()
    };
    sanitize_string(&compact, 96)
}

const RI_DIM: usize = 256;
const RI_SPARSE_NNZ: usize = 8;
const RI_WINDOW: usize = 5;
const RI_MAX_TOKENS: usize = 512;
const RI_MAX_OCCURRENCES: usize = 512;
const RI_MINHASH_K: usize = 64;

#[derive(Debug, Clone)]
struct RiDoc {
    vector: Vec<f32>,
    tfidf: HashMap<String, f32>,
    minhash: [u64; RI_MINHASH_K],
}

#[derive(Debug, Clone)]
struct RiQuery {
    vector: Vec<f32>,
    tfidf: HashMap<String, f32>,
    minhash: [u64; RI_MINHASH_K],
}

#[derive(Debug, Clone)]
struct RandomIndex {
    idf: HashMap<String, f32>,
    enriched: HashMap<String, Vec<f32>>,
    docs: HashMap<String, RiDoc>,
}

impl RandomIndex {
    fn build(facts: &[RecallFact]) -> Self {
        let doc_tokens = facts
            .iter()
            .map(|fact| (fact.id.clone(), ri_fact_tokens(fact)))
            .collect::<Vec<_>>();
        let mut df: HashMap<String, usize> = HashMap::new();
        let mut counts: HashMap<String, usize> = HashMap::new();
        for (_, tokens) in &doc_tokens {
            let mut seen = HashSet::new();
            for token in tokens {
                *counts.entry(token.clone()).or_default() += 1;
                if seen.insert(token) {
                    *df.entry(token.clone()).or_default() += 1;
                }
            }
        }
        let doc_count = facts.len().max(1) as f32;
        let idf = df
            .into_iter()
            .map(|(token, freq)| {
                let weight = (1.0 + doc_count / freq.max(1) as f32).log2() + 0.5;
                (token, weight)
            })
            .collect::<HashMap<_, _>>();
        let mut enriched = idf
            .keys()
            .map(|token| (token.clone(), ri_random_vector(token)))
            .collect::<HashMap<_, _>>();
        let mut ordinals: HashMap<String, usize> = HashMap::new();
        for (_, tokens) in &doc_tokens {
            for (index, token) in tokens.iter().enumerate() {
                let ordinal = ordinals.entry(token.clone()).or_default();
                let current = *ordinal;
                *ordinal += 1;
                let total = counts.get(token).copied().unwrap_or(0);
                if total > RI_MAX_OCCURRENCES {
                    let stride = total.div_ceil(RI_MAX_OCCURRENCES);
                    if current % stride != 0 {
                        continue;
                    }
                }
                let start = index.saturating_sub(RI_WINDOW);
                let end = (index + RI_WINDOW + 1).min(tokens.len());
                let context = (start..end)
                    .filter(|other| *other != index)
                    .map(|other| ri_random_vector(&tokens[other]))
                    .collect::<Vec<_>>();
                if let Some(target) = enriched.get_mut(token) {
                    let scale = if context.is_empty() {
                        0.0
                    } else {
                        0.3 / context.len() as f32
                    };
                    for vector in context {
                        add_scaled(target, &vector, scale);
                    }
                }
            }
        }
        for vector in enriched.values_mut() {
            normalize_dense(vector);
        }
        let docs = doc_tokens
            .into_iter()
            .map(|(id, tokens)| {
                let doc = RiDoc {
                    vector: ri_weighted_vector(&tokens, &idf, &enriched),
                    tfidf: ri_tfidf(&tokens, &idf),
                    minhash: ri_minhash(&tokens),
                };
                (id, doc)
            })
            .collect::<HashMap<_, _>>();
        Self {
            idf,
            enriched,
            docs,
        }
    }

    fn vocab_size(&self) -> usize {
        self.idf.len()
    }

    fn doc_count(&self) -> usize {
        self.docs.len()
    }

    fn query_vector(&self, query: &str) -> RiQuery {
        let tokens = ri_tokens(query);
        RiQuery {
            vector: ri_weighted_vector(&tokens, &self.idf, &self.enriched),
            tfidf: ri_tfidf(&tokens, &self.idf),
            minhash: ri_minhash(&tokens),
        }
    }

    fn score(&self, query: &RiQuery, raw_query: &str, fact: &RecallFact) -> f64 {
        let Some(doc) = self.docs.get(&fact.id) else {
            return 0.0;
        };
        let ri = cosine_f32(&query.vector, &doc.vector).max(0.0);
        let tfidf = tfidf_cosine(&query.tfidf, &doc.tfidf).max(0.0);
        let minhash = minhash_similarity(&query.minhash, &doc.minhash).max(0.0);
        let lexical = semantic_alias_overlap(raw_query, fact);
        ((ri * 0.70) + (tfidf * 0.20) + (minhash * 0.10)).max(lexical * 0.72) as f64
    }
}

fn ri_fact_tokens(fact: &RecallFact) -> Vec<String> {
    [
        fact.subject.as_str(),
        fact.predicate.as_str(),
        fact.object.as_str(),
        fact.source.as_str(),
        fact.episode_source_locator.as_deref().unwrap_or(""),
    ]
    .into_iter()
    .flat_map(ri_tokens)
    .take(RI_MAX_TOKENS)
    .collect()
}

fn ri_tokens(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let expanded = expand_token_text(value);
    for raw in expanded
        .split(|ch: char| !(ch.is_ascii_alphanumeric() || ch == ':'))
        .filter(|token| !token.is_empty())
    {
        let token = raw.to_ascii_lowercase();
        if ri_stopword(&token) {
            continue;
        }
        push_ri_token(&mut out, &token);
        if let Some(stripped) = token.strip_suffix('s') {
            if stripped.len() > 2 {
                push_ri_token(&mut out, stripped);
            }
        }
        for alias in ri_aliases(&token) {
            push_ri_token(&mut out, alias);
        }
        if out.len() >= RI_MAX_TOKENS {
            break;
        }
    }
    out
}

fn push_ri_token(out: &mut Vec<String>, token: &str) {
    if !token.is_empty() && !ri_stopword(token) && out.len() < RI_MAX_TOKENS {
        out.push(token.to_string());
    }
}

fn ri_aliases(token: &str) -> &'static [&'static str] {
    match token {
        "sql" | "sqlite" | "rusqlite" => &["database", "storage", "store"],
        "backend" => &["provider", "store", "storage"],
        "accept" | "accepted" | "approved" | "approval" => &["approve", "proposal", "active"],
        "queued" | "queue" | "proposal" | "proposals" => &["pending", "approve", "memory"],
        "dependency" | "dependencies" => &["graph", "edge", "import", "calls"],
        "neighborhood" | "neighbourhood" => &["graph", "explain", "path", "edge"],
        "changed" | "change" | "changes" => &["detect", "impact", "affected"],
        "impact" | "impacts" => &["affected", "symbol", "detect"],
        "memories" => &["memory", "fact"],
        "auth" => &["authentication", "authorization"],
        _ => &[],
    }
}

fn ri_stopword(value: &str) -> bool {
    matches!(
        value,
        "function"
            | "method"
            | "module"
            | "class"
            | "command"
            | "workspace"
            | "src"
            | "lib"
            | "rs"
            | "js"
            | "ts"
            | "py"
            | "go"
            | "for"
            | "all"
            | "the"
            | "a"
            | "an"
            | "of"
            | "to"
            | "in"
            | "and"
            | "is"
            | "with"
    )
}

fn ri_weighted_vector(
    tokens: &[String],
    idf: &HashMap<String, f32>,
    enriched: &HashMap<String, Vec<f32>>,
) -> Vec<f32> {
    let mut vector = vec![0.0; RI_DIM];
    let tf = token_counts(tokens);
    for (token, count) in tf {
        let weight = (count as f32).sqrt() * idf.get(&token).copied().unwrap_or(0.5);
        let token_vector = enriched
            .get(&token)
            .cloned()
            .unwrap_or_else(|| ri_random_vector(&token));
        add_scaled(&mut vector, &token_vector, weight);
    }
    normalize_dense(&mut vector);
    vector
}

fn ri_tfidf(tokens: &[String], idf: &HashMap<String, f32>) -> HashMap<String, f32> {
    token_counts(tokens)
        .into_iter()
        .map(|(token, count)| {
            let weight = (count as f32).sqrt() * idf.get(&token).copied().unwrap_or(0.5);
            (token, weight)
        })
        .collect()
}

fn token_counts(tokens: &[String]) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for token in tokens {
        *counts.entry(token.clone()).or_default() += 1;
    }
    counts
}

fn ri_random_vector(token: &str) -> Vec<f32> {
    let mut vector = vec![0.0; RI_DIM];
    for index in 0..RI_SPARSE_NNZ {
        let hash = stable_hash64(&[token, &index.to_string()]);
        let pos = (hash as usize) % RI_DIM;
        let sign = if hash & 1 == 0 { 1.0 } else { -1.0 };
        vector[pos] += sign;
    }
    normalize_dense(&mut vector);
    vector
}

fn stable_hash64(parts: &[&str]) -> u64 {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    let digest = hasher.finalize();
    u64::from_le_bytes(digest[0..8].try_into().unwrap_or([0; 8]))
}

fn add_scaled(dst: &mut [f32], src: &[f32], scale: f32) {
    for (left, right) in dst.iter_mut().zip(src.iter()) {
        *left += *right * scale;
    }
}

fn normalize_dense(vector: &mut [f32]) {
    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm > 0.0 {
        for value in vector {
            *value /= norm;
        }
    }
}

fn cosine_f32(left: &[f32], right: &[f32]) -> f32 {
    if left.len() != right.len() || left.is_empty() {
        return 0.0;
    }
    left.iter()
        .zip(right.iter())
        .map(|(left, right)| left * right)
        .sum()
}

fn tfidf_cosine(left: &HashMap<String, f32>, right: &HashMap<String, f32>) -> f32 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let dot = left
        .iter()
        .filter_map(|(token, weight)| right.get(token).map(|right| weight * right))
        .sum::<f32>();
    let left_mag = left.values().map(|value| value * value).sum::<f32>().sqrt();
    let right_mag = right
        .values()
        .map(|value| value * value)
        .sum::<f32>()
        .sqrt();
    if left_mag == 0.0 || right_mag == 0.0 {
        0.0
    } else {
        dot / (left_mag * right_mag)
    }
}

fn ri_minhash(tokens: &[String]) -> [u64; RI_MINHASH_K] {
    let unique = tokens.iter().collect::<BTreeSet<_>>();
    let mut signature = [u64::MAX; RI_MINHASH_K];
    for token in unique {
        for (index, slot) in signature.iter_mut().enumerate() {
            *slot = (*slot).min(stable_hash64(&[token, &format!("minhash:{index}")]));
        }
    }
    signature
}

fn minhash_similarity(left: &[u64; RI_MINHASH_K], right: &[u64; RI_MINHASH_K]) -> f32 {
    if left.iter().all(|value| *value == u64::MAX) || right.iter().all(|value| *value == u64::MAX) {
        return 0.0;
    }
    let same = left
        .iter()
        .zip(right.iter())
        .filter(|(left, right)| left == right)
        .count();
    same as f32 / RI_MINHASH_K as f32
}

fn semantic_alias_overlap(query: &str, fact: &RecallFact) -> f32 {
    let query_tokens = ri_tokens(query).into_iter().collect::<BTreeSet<_>>();
    if query_tokens.is_empty() {
        return 0.0;
    }
    let fact_tokens = ri_fact_tokens(fact).into_iter().collect::<BTreeSet<_>>();
    let hits = query_tokens
        .iter()
        .filter(|token| fact_tokens.contains(*token))
        .count();
    (hits as f32 / query_tokens.len() as f32).min(1.0)
}

fn governance_boost(fact: &RecallFact) -> f64 {
    let mut boost = 0.03;
    let text = format!("{} {} {}", fact.subject, fact.predicate, fact.object).to_lowercase();
    if text.contains("govern") || text.contains("decision") || text.contains("truth") {
        boost += 0.02;
    }
    boost
}

fn fact_id_from_proposal_id(id: &str) -> String {
    format!(
        "memfact_{}",
        id.trim_start_matches("mpq_")
            .chars()
            .take(128)
            .collect::<String>()
    )
}

fn episode_id_from_proposal_id(id: &str) -> String {
    format!(
        "mep_{}",
        id.trim_start_matches("mpq_")
            .chars()
            .take(128)
            .collect::<String>()
    )
}

fn deterministic_id(prefix: &str, value: &Value) -> String {
    format!("{prefix}_{}", &sha256_hex(&canonical_json(value))[..32])
}

fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).unwrap(),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let sorted: BTreeMap<&String, &Value> = map.iter().collect();
            format!(
                "{{{}}}",
                sorted
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        canonical_json(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn canonical_string_object(fields: &[(&str, &str)]) -> String {
    format!(
        "{{{}}}",
        fields
            .iter()
            .map(|(key, value)| format!(
                "{}:{}",
                serde_json::to_string(key).unwrap(),
                serde_json::to_string(value).unwrap()
            ))
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn add_milliseconds(iso: &str, amount: i64) -> Result<String> {
    let parsed = chrono::DateTime::parse_from_rfc3339(iso)?;
    Ok((parsed + chrono::Duration::milliseconds(amount))
        .to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn payload_str<'a>(payload: &'a Map<String, Value>, key: &str, fallback: &'a str) -> String {
    payload
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_string()
}

fn normalize_source_trust(value: &str) -> Result<String> {
    match value.trim() {
        "" | "verified" => Ok("verified".to_string()),
        "untrusted" => Ok("untrusted".to_string()),
        other => bail!("source trust must be verified or untrusted, got {other}"),
    }
}

fn policy_receipt(decision: &str, reason: &str, source_trust: &str) -> Value {
    json!({
        "schemaVersion": "1.0.0",
        "decision": decision,
        "reason": reason,
        "sourceTrust": source_trust,
        "sideEffectClass": "memory.write",
        "externalWritesEnabled": false,
        "modelCalls": 0,
        "networkCalls": 0
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proposal_cached_serializations_match_canonical_paths() {
        let proposal = build_proposal_input(
            "ws_local",
            "workspace",
            "method:Runner_run",
            "CALLS",
            "method:Worker_run",
            "workspace://src/Worker.java",
            "2026-06-29T00:00:00.000Z",
            "2026-06-29T00:00:00.001Z",
            "extracted",
            Some("oaf.ingest:typed-call-java"),
            "verified",
            false,
            None,
        )
        .unwrap();

        let old_fingerprint = sha256_hex(&canonical_json(&json!({
            "workspaceId": "ws_local",
            "sourceLocator": proposal.source_locator,
            "sourceHash": proposal.source_hash,
            "payload": proposal.payload
        })));
        let old_source_hash = format!(
            "sha256:{}",
            sha256_hex(&canonical_json(&json!({
                "subject": "method:Runner_run",
                "predicate": "CALLS",
                "object": "method:Worker_run",
                "source": "workspace://src/Worker.java"
            })))
        );
        let old_id = format!(
            "mpq_{}",
            &sha256_hex(&canonical_json(&json!({
                "workspaceId": "ws_local",
                "scope": "workspace",
                "subject": "method:Runner_run",
                "predicate": "CALLS",
                "object": "method:Worker_run",
                "sourceHash": old_source_hash
            })))[..32]
        );
        let old_episode_id = deterministic_id(
            "mep",
            &json!({
                "workspaceId": "ws_local",
                "source": "workspace://src/Worker.java",
                "sourceHash": old_source_hash,
                "text": "method:Runner_run CALLS method:Worker_run"
            }),
        );

        assert_eq!(
            proposal.payload_json,
            serde_json::to_string(&proposal.payload).unwrap()
        );
        assert_eq!(
            proposal
                .payload
                .get("factFingerprint")
                .and_then(Value::as_str),
            Some("976ece96d4859c935e82c68b9cc170ea2cd2cb8db9cab45c7f3c964a9845d27c")
        );
        assert_eq!(proposal.source_hash, old_source_hash);
        assert_eq!(proposal.id, old_id);
        assert_eq!(
            proposal
                .payload
                .get("provenanceEpisodeId")
                .and_then(Value::as_str),
            Some(old_episode_id.as_str())
        );
        assert_eq!(proposal.fingerprint, old_fingerprint);
        assert_eq!(proposal_fingerprint("ws_local", &proposal), old_fingerprint);
    }

    #[test]
    fn bulk_approval_skips_explicit_id_only_proposals() {
        let mut store = Store::open(
            ":memory:",
            StoreOptions {
                workspace_id: "ws_local".to_string(),
                now: "2026-06-29T00:00:00.000Z".to_string(),
            },
        )
        .unwrap();
        let mut proposal = build_proposal_input(
            "ws_local",
            "workspace",
            "project:fixture",
            "semantic_status",
            "pending",
            "workspace://README.md",
            "2026-06-29T00:00:00.000Z",
            "2026-06-29T00:00:00.000Z",
            "extracted",
            None,
            "verified",
            false,
            None,
        )
        .unwrap();
        proposal.payload["approvalMode"] = Value::String("explicit-id-only".to_string());
        proposal.payload_json = serde_json::to_string(&proposal.payload).unwrap();
        proposal.fingerprint = proposal_fingerprint_from_parts(
            "ws_local",
            &proposal.source_locator,
            &proposal.source_hash,
            &canonical_json(&proposal.payload),
        );

        store.begin().unwrap();
        store.enqueue_proposal_uncommitted(&proposal).unwrap();
        store.finish(Ok(())).unwrap();

        let bulk = store.approve_all_from("workspace://README.md").unwrap();
        assert_eq!(bulk.active_memory_created, 0);
        assert_eq!(bulk.pending_proposal_count, 1);
        assert_eq!(bulk.skipped_explicit_id_only_count, 1);
        assert_eq!(
            store
                .proposal_row_value(&proposal.id)
                .unwrap()
                .get("status")
                .and_then(Value::as_str),
            Some("pending")
        );

        let named = store.approve_one(&proposal.id).unwrap();
        assert_eq!(named.active_memory_created, 1);
    }
}
