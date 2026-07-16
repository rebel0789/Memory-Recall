use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileRecord {
    pub locator: String,
    pub content_hash: String,
    pub byte_size: i64,
    pub language: String,
    pub parse_state: String,
    pub diagnostic_count: i64,
    pub owner_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeRecord {
    pub canonical_id: String,
    pub kind: String,
    pub language_kind: String,
    pub qualified_name: String,
    pub locator: String,
    pub start_line: i64,
    pub end_line: i64,
    pub content_hash: Option<String>,
    pub visibility: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EdgeRecord {
    pub canonical_id: String,
    pub source_id: String,
    pub target_id: String,
    pub kind: String,
    pub locator: String,
    pub start_line: i64,
    pub end_line: i64,
    pub resolver: String,
    pub resolver_version: String,
    pub confidence: f64,
    pub resolution_class: String,
    pub stale: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnresolvedRecord {
    pub canonical_id: String,
    pub source_id: String,
    pub relationship_kind: String,
    pub target_text_hash: String,
    pub locator: String,
    pub start_line: i64,
    pub end_line: i64,
    pub reason_code: String,
    pub confidence_class: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoverageRecord {
    pub language: String,
    pub capability: String,
    pub represented_count: i64,
    pub omitted_count: i64,
    pub failed_count: i64,
    pub reason_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnosticRecord {
    pub canonical_id: String,
    pub severity: String,
    pub code: String,
    pub locator: String,
    pub start_line: i64,
    pub end_line: i64,
    pub message_hash: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GenerationInput {
    pub reason: String,
    pub created_at: String,
    pub structural_fingerprint: String,
    pub ignore_fingerprint: Option<String>,
    pub files: Vec<FileRecord>,
    pub nodes: Vec<NodeRecord>,
    pub edges: Vec<EdgeRecord>,
    pub unresolved: Vec<UnresolvedRecord>,
    pub coverage: Vec<CoverageRecord>,
    pub diagnostics: Vec<DiagnosticRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveredFile {
    pub locator: String,
    pub content_hash: String,
    pub byte_size: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileRename {
    pub from_locator: String,
    pub to_locator: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshBounds {
    pub max_depth: usize,
    pub max_invalidated_files: usize,
}

impl Default for RefreshBounds {
    fn default() -> Self {
        Self {
            max_depth: 8,
            max_invalidated_files: 10_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefreshPlan {
    pub added_files: Vec<String>,
    pub changed_files: Vec<String>,
    pub deleted_files: Vec<String>,
    pub renamed_files: Vec<FileRename>,
    pub invalidated_files: Vec<String>,
    pub unchanged_file_count: usize,
    pub ignore_rules_changed: bool,
    pub truncated: bool,
    pub no_change: bool,
    pub reason_codes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefreshCommit {
    pub summary: GenerationSummary,
    pub wrote: bool,
    pub invalidated_file_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GenerationSummary {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub reason: String,
    pub created_at: String,
    pub committed_at: String,
    pub file_count: i64,
    pub node_count: i64,
    pub edge_count: i64,
    pub unresolved_count: i64,
    pub diagnostic_count: i64,
    pub structural_fingerprint: String,
    pub ignore_fingerprint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredGeneration {
    pub summary: GenerationSummary,
    pub input: GenerationInput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgeDirection {
    Incoming,
    Outgoing,
    Both,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryBounds {
    pub limit: usize,
    pub max_depth: usize,
    pub max_output_bytes: usize,
    pub timeout_ms: u64,
    pub cursor: Option<String>,
}

impl QueryBounds {
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            max_depth: 1,
            max_output_bytes: 1_048_576,
            timeout_ms: 250,
            cursor: None,
        }
    }

    pub fn with_depth(mut self, max_depth: usize) -> Self {
        self.max_depth = max_depth;
        self
    }

    pub fn with_cursor(mut self, cursor: impl Into<String>) -> Self {
        self.cursor = Some(cursor.into());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueryPage<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GraphNeighborhood {
    pub nodes: Vec<NodeRecord>,
    pub edges: Vec<EdgeRecord>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphRoute {
    pub node_ids: Vec<String>,
    pub edge_ids: Vec<String>,
}
