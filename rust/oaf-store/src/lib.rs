use anyhow::{anyhow, bail, Context, Result};
use chrono::{SecondsFormat, Utc};
use regex::Regex;
use rusqlite::{params, params_from_iter, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::{Component, Path};
use std::sync::OnceLock;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchFact {
    pub subject: String,
    pub predicate: String,
    pub object: String,
    pub source: String,
    #[serde(default)]
    pub confidence: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub supersedes: Option<Supersedes>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub proposal: Option<Value>,
    pub fact: Option<Value>,
    pub facts: Vec<Value>,
    pub superseded_facts: Vec<Value>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveFactSnapshot {
    pub subject: String,
    pub predicate: String,
    pub object: String,
    pub source: String,
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
            supersedes,
            None,
        )?;
        self.begin()?;
        let result = (|| {
            self.enqueue_proposal_uncommitted(&proposal)?;
            self.approve_proposal_uncommitted(&proposal.id, "memory-remember")
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
                    fact.supersedes,
                    fact.supersedes_object.as_deref(),
                )?;
                self.enqueue_proposal_uncommitted(&proposal)?;
                if let Some(value) =
                    summarize_proposal_value(&self.proposal_row_value(&proposal.id)?)?
                {
                    proposal_facts.push(value);
                }
            }
            Ok(BatchReport {
                recorded_count: proposal_facts.len(),
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
        let ids = self.pending_ids(Some(&source))?;
        self.approve_ids(ids)
    }

    pub fn approve_all(&mut self) -> Result<ApproveReport> {
        let ids = self.pending_ids(None)?;
        self.approve_ids(ids)
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

    pub fn integrity_check(&self) -> Result<String> {
        let result: String = self
            .conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if result != "ok" {
            bail!("sqlite integrity check failed: {result}");
        }
        Ok(result)
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
        let fingerprint = sha256_hex(&canonical_json(&json!({
            "workspaceId": self.workspace_id,
            "sourceLocator": proposal.source_locator,
            "sourceHash": proposal.source_hash,
            "payload": proposal.payload
        })));
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
                serde_json::to_string(&proposal.payload)?,
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

        let metadata = json!({
            "approvedBy": "oaf memory approve",
            "approvedAt": self.now,
            "sourceHash": source_hash,
            "extractionConfidence": if ["extracted", "inferred", "ambiguous"].contains(&extraction_confidence) { extraction_confidence } else { "extracted" },
            "notes": payload.get("notes").cloned().unwrap_or(Value::Null)
        });
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
struct NormalizedBatchFact {
    subject: String,
    predicate: String,
    object: String,
    source: String,
    extraction_confidence: String,
    notes: Option<String>,
    supersedes: bool,
    supersedes_object: Option<String>,
}

#[derive(Debug, Clone)]
struct ProposalInput {
    id: String,
    source_locator: String,
    source_hash: String,
    enqueued_at: String,
    payload: Value,
}

fn normalize_batch_fact(root: &Path, input: &BatchFact) -> Result<NormalizedBatchFact> {
    let subject = safe_batch_token(&input.subject, "subject")?;
    let predicate = safe_batch_token(&input.predicate, "predicate")?;
    let object = safe_batch_object(&input.object)?;
    let source = safe_batch_source(root, &input.source)?;
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
    supersedes: bool,
    supersedes_object: Option<&str>,
) -> Result<ProposalInput> {
    let text = format!("{subject} {predicate} {object}");
    let source_hash = format!(
        "sha256:{}",
        sha256_hex(&canonical_json(&json!({
            "subject": subject,
            "predicate": predicate,
            "object": object,
            "source": source
        })))
    );
    let id = format!(
        "mpq_{}",
        &sha256_hex(&canonical_json(&json!({
            "workspaceId": workspace_id,
            "scope": scope,
            "subject": subject,
            "predicate": predicate,
            "object": object,
            "sourceHash": source_hash
        })))[..32]
    );
    let episode_id = deterministic_id(
        "mep",
        &json!({ "workspaceId": workspace_id, "source": source, "sourceHash": source_hash, "text": text }),
    );
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
    if let Some(supersedes_object) = supersedes_object {
        payload["supersedesObject"] = Value::String(supersedes_object.to_string());
    }
    Ok(ProposalInput {
        id,
        source_locator: source.to_string(),
        source_hash: source_hash.clone(),
        enqueued_at: enqueued_at.to_string(),
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
    Ok(Some(json!({
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
    })))
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
