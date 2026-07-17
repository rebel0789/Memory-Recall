use anyhow::{bail, Context, Result};
use ignore::{DirEntry, WalkBuilder};
use oaf_store::{ActiveFactSnapshot, BatchFact, Supersedes};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Instant;
use tree_sitter::{Language, Node, Parser};

pub const DEFAULT_MAX_MEMORY_BYTES: u64 = 350 * 1024 * 1024;
pub const DEFAULT_MAX_FILE_BYTES: u64 = 1024 * 1024;
const PER_WORKER_MEMORY_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct IngestOptions {
    pub root: PathBuf,
    pub max_memory_bytes: u64,
    pub max_file_bytes: u64,
    pub workers: usize,
    pub only_sources: Option<BTreeSet<String>>,
    pub prefer_cpp_headers: bool,
}

impl IngestOptions {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            max_memory_bytes: DEFAULT_MAX_MEMORY_BYTES,
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
            workers: 1,
            only_sources: None,
            prefer_cpp_headers: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Eq, PartialEq)]
pub struct IngestFileHash {
    pub source: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct FileHashDiscoveryBounds {
    pub max_candidate_files: usize,
    pub max_hashed_bytes: u64,
    pub selected_file_limit: Option<usize>,
    pub deadline: Instant,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct IngestFileHashReport {
    pub hashes: Vec<IngestFileHash>,
    pub complete: bool,
    pub reason_codes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Eq, PartialEq)]
pub struct IngestFileRename {
    pub from_source: String,
    pub to_source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Eq, PartialEq)]
pub struct IngestFileHashDiff {
    pub added: Vec<IngestFileHash>,
    pub changed: Vec<IngestFileHash>,
    pub deleted: Vec<String>,
    pub renamed: Vec<IngestFileRename>,
    pub unchanged_count: usize,
}

pub fn diff_file_hashes(
    previous: &[IngestFileHash],
    current: &[IngestFileHash],
) -> Result<IngestFileHashDiff> {
    let previous = unique_hashes_by_source(previous)?;
    let current = unique_hashes_by_source(current)?;
    let mut added = current
        .iter()
        .filter(|(source, _)| !previous.contains_key(*source))
        .map(|(_, value)| (*value).clone())
        .collect::<Vec<_>>();
    let mut deleted = previous
        .keys()
        .filter(|source| !current.contains_key(*source))
        .map(|source| (*source).clone())
        .collect::<Vec<_>>();
    let changed = current
        .iter()
        .filter(|(source, value)| {
            previous
                .get(*source)
                .is_some_and(|old| old.sha256 != value.sha256 || old.bytes != value.bytes)
        })
        .map(|(_, value)| (*value).clone())
        .collect::<Vec<_>>();
    let unchanged_count = current
        .iter()
        .filter(|(source, value)| {
            previous
                .get(*source)
                .is_some_and(|old| old.sha256 == value.sha256 && old.bytes == value.bytes)
        })
        .count();
    let mut added_by_hash = BTreeMap::<&str, Vec<&str>>::new();
    let mut deleted_by_hash = BTreeMap::<&str, Vec<&str>>::new();
    for file in &added {
        added_by_hash
            .entry(&file.sha256)
            .or_default()
            .push(&file.source);
    }
    for source in &deleted {
        deleted_by_hash
            .entry(&previous[source].sha256)
            .or_default()
            .push(source);
    }
    let mut renamed = added_by_hash
        .into_iter()
        .filter_map(|(hash, destinations)| {
            let sources = deleted_by_hash.get(hash)?;
            (destinations.len() == 1 && sources.len() == 1).then(|| IngestFileRename {
                from_source: sources[0].to_string(),
                to_source: destinations[0].to_string(),
            })
        })
        .collect::<Vec<_>>();
    renamed.sort_by(|left, right| left.from_source.cmp(&right.from_source));
    let renamed_from = renamed
        .iter()
        .map(|item| item.from_source.as_str())
        .collect::<BTreeSet<_>>();
    let renamed_to = renamed
        .iter()
        .map(|item| item.to_source.as_str())
        .collect::<BTreeSet<_>>();
    added.retain(|file| !renamed_to.contains(file.source.as_str()));
    deleted.retain(|source| !renamed_from.contains(source.as_str()));
    Ok(IngestFileHashDiff {
        added,
        changed,
        deleted,
        renamed,
        unchanged_count,
    })
}

fn unique_hashes_by_source(values: &[IngestFileHash]) -> Result<BTreeMap<String, &IngestFileHash>> {
    let mut output = BTreeMap::new();
    for value in values {
        if value.source.is_empty()
            || value.sha256.len() != 64
            || !value.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || output.insert(value.source.clone(), value).is_some()
        {
            bail!("ingest_file_hash_diff_invalid");
        }
    }
    Ok(output)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Eq, PartialEq, Ord, PartialOrd)]
pub struct CodeSpan {
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

impl CodeSpan {
    fn from_node(node: Node<'_>) -> Self {
        let start = node.start_position();
        let end = node.end_position();
        Self {
            start_line: start.row as u32 + 1,
            start_column: start.column as u32,
            end_line: end.row as u32 + 1,
            end_column: end.column as u32,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Eq, PartialEq)]
pub struct CodeFactRecord {
    pub subject: String,
    pub predicate: String,
    pub object: String,
    pub source: String,
    pub note: String,
    pub span: CodeSpan,
}

pub const CODE_MINHASH_K: usize = 64;

#[derive(Debug, Clone)]
pub struct CodeFingerprint {
    pub subject: String,
    pub source: String,
    pub language: String,
    pub minhash: [u64; CODE_MINHASH_K],
    pub token_count: usize,
    pub feature_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestReport {
    pub scanned_file_count: usize,
    pub parsed_file_count: usize,
    pub skipped_file_count: usize,
    pub generated_fact_count: usize,
    pub generated_call_count: usize,
    pub import_count: usize,
    pub definition_count: usize,
    pub parsed_bytes: u64,
    pub requested_worker_count: usize,
    pub effective_worker_count: usize,
    pub cgroup_memory_limit_bytes: Option<u64>,
    pub elapsed_ms: u128,
    pub skipped_files: Vec<SkippedFile>,
    pub recovered_files: Vec<RecoveredFile>,
    #[serde(skip)]
    pub facts: Vec<BatchFact>,
    #[serde(skip)]
    pub code_facts: Vec<CodeFactRecord>,
    pub language_counts: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentIngestReport {
    pub scanned_file_count: usize,
    pub parsed_file_count: usize,
    pub skipped_file_count: usize,
    pub generated_fact_count: usize,
    pub generated_decision_count: usize,
    pub generated_supersession_count: usize,
    pub parsed_bytes: u64,
    pub elapsed_ms: u128,
    pub skipped_files: Vec<SkippedFile>,
    #[serde(skip)]
    pub facts: Vec<BatchFact>,
    pub format_counts: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkippedFile {
    pub workspace_ref: String,
    pub reason: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveredFile {
    pub workspace_ref: String,
    pub reason: String,
    pub bytes: u64,
}

#[derive(Debug, Clone)]
struct ParsedRepo {
    facts: BTreeSet<FactKey>,
    deferred_definitions: Vec<DeferredDefinitionRef>,
    calls: Vec<CallRef>,
    constructs: Vec<ConstructRef>,
    imports: Vec<ImportRef>,
    re_exports: Vec<ImportRef>,
    parts: Vec<ImportRef>,
    exports: Vec<ExportRef>,
    routes: Vec<RouteRef>,
    heritage: Vec<HeritageRef>,
    frameworks: Vec<FrameworkRef>,
    definitions_by_name: BTreeMap<String, BTreeSet<String>>,
    symbol_aliases: BTreeMap<(String, String), String>,
    package_entries: BTreeMap<String, String>,
    generated_call_count: usize,
    import_count: usize,
    definition_count: usize,
}

impl ParsedRepo {
    fn new() -> Self {
        Self {
            facts: BTreeSet::new(),
            deferred_definitions: Vec::new(),
            calls: Vec::new(),
            constructs: Vec::new(),
            imports: Vec::new(),
            re_exports: Vec::new(),
            parts: Vec::new(),
            exports: Vec::new(),
            routes: Vec::new(),
            heritage: Vec::new(),
            frameworks: Vec::new(),
            definitions_by_name: BTreeMap::new(),
            symbol_aliases: BTreeMap::new(),
            package_entries: BTreeMap::new(),
            generated_call_count: 0,
            import_count: 0,
            definition_count: 0,
        }
    }

    fn add_entity_at(
        &mut self,
        subject: String,
        kind: &'static str,
        source: &str,
        note: &'static str,
        span: CodeSpan,
    ) {
        self.add_fact_at(subject, "IS_A", kind.to_string(), source, note, span);
    }

    fn add_definition_at(
        &mut self,
        owner: &str,
        symbol: &str,
        source: &str,
        note: &'static str,
        span: CodeSpan,
    ) {
        self.definition_count += 1;
        self.add_fact_at(
            owner.to_string(),
            "DEFINES",
            symbol.to_string(),
            source,
            note,
            span,
        );
    }

    fn add_deferred_definition_at(
        &mut self,
        owner_name: &str,
        fallback_owner: &str,
        symbol: &str,
        source: &str,
        note: &'static str,
        span: CodeSpan,
    ) {
        self.definition_count += 1;
        self.deferred_definitions.push(DeferredDefinitionRef {
            owner_name: owner_name.to_string(),
            fallback_owner: fallback_owner.to_string(),
            symbol: symbol.to_string(),
            source: source.to_string(),
            note,
            span,
        });
    }

    fn add_import(&mut self, owner: &str, target: ImportTarget, source: &str, span: CodeSpan) {
        self.import_count += 1;
        self.imports.push(ImportRef {
            owner: owner.to_string(),
            raw: target.raw,
            fallback: target.fallback,
            source: source.to_string(),
            span,
        });
    }

    fn add_re_export(&mut self, owner: &str, target: ImportTarget, source: &str, span: CodeSpan) {
        self.re_exports.push(ImportRef {
            owner: owner.to_string(),
            raw: target.raw,
            fallback: target.fallback,
            source: source.to_string(),
            span,
        });
    }

    fn add_part(&mut self, owner: &str, target: ImportTarget, source: &str, span: CodeSpan) {
        self.parts.push(ImportRef {
            owner: owner.to_string(),
            raw: target.raw,
            fallback: target.fallback,
            source: source.to_string(),
            span,
        });
    }

    fn add_fact_at(
        &mut self,
        subject: String,
        predicate: &'static str,
        object: String,
        source: &str,
        note: &'static str,
        span: CodeSpan,
    ) {
        self.facts.insert(FactKey {
            subject,
            predicate: predicate.to_string(),
            object,
            source: source.to_string(),
            note: note.to_string(),
            span,
        });
    }

    fn add_symbol_name(&mut self, name: &str, subject: &str) {
        self.definitions_by_name
            .entry(name.to_string())
            .or_default()
            .insert(subject.to_string());
    }

    fn add_symbol_alias(&mut self, source: &str, alias: &str, target: &str) {
        if let (Some(alias), Some(target)) =
            (sanitize_symbol(alias), normalize_symbol_lookup_name(target))
        {
            self.symbol_aliases
                .insert((source.to_string(), alias), target);
        }
    }

    fn add_call_with_hint(
        &mut self,
        caller: &str,
        callee_name: &str,
        typed_target: Option<TypedCallHint>,
        allow_name_resolution: bool,
        source: &str,
        span: CodeSpan,
    ) {
        if callee_name.is_empty()
            || matches!(
                callee_name,
                "require" | "super" | "return" | "exit" | "export" | "local" | "echo"
            )
        {
            return;
        }
        self.generated_call_count += 1;
        self.calls.push(CallRef {
            caller: caller.to_string(),
            callee_name: callee_name.to_string(),
            typed_target,
            allow_name_resolution,
            source: source.to_string(),
            span,
        });
    }

    fn finish(mut self) -> (Vec<BatchFact>, Vec<CodeFactRecord>) {
        let deferred_definitions = std::mem::take(&mut self.deferred_definitions);
        for definition in deferred_definitions {
            let owner = self
                .resolve_type_symbol_name_in_source(&definition.owner_name, &definition.source)
                .or_else(|| self.resolve_type_symbol_name(&definition.owner_name))
                .unwrap_or(definition.fallback_owner);
            self.add_fact_at(
                owner,
                "DEFINES",
                definition.symbol,
                &definition.source,
                definition.note,
                definition.span,
            );
        }
        let imports = std::mem::take(&mut self.imports);
        for import in imports {
            let resolved = self.resolve_import_target(&import);
            let target = resolved.clone().unwrap_or_else(|| import.fallback.clone());
            if !self.has_entity_subject(&target) {
                self.add_entity_at(
                    target.clone(),
                    "Module",
                    &import.source,
                    if resolved.is_some() {
                        "oaf.ingest:resolved-import-module"
                    } else {
                        "oaf.ingest:import-module"
                    },
                    import.span,
                );
            }
            self.add_fact_at(
                import.owner,
                "IMPORTS",
                target,
                &import.source,
                if resolved.is_some() {
                    "oaf.ingest:resolved-import"
                } else {
                    "oaf.ingest:unresolved-import"
                },
                import.span,
            );
        }
        let re_exports = std::mem::take(&mut self.re_exports);
        for export in re_exports {
            let resolved = self.resolve_import_target(&export);
            let target = resolved.clone().unwrap_or_else(|| export.fallback.clone());
            if !self.has_entity_subject(&target) {
                self.add_entity_at(
                    target.clone(),
                    "Module",
                    &export.source,
                    "oaf.ingest:re-export-module",
                    export.span,
                );
            }
            self.add_fact_at(
                export.owner,
                "RE_EXPORTS",
                target,
                &export.source,
                if resolved.is_some() {
                    "oaf.ingest:resolved-re-export"
                } else {
                    "oaf.ingest:unresolved-re-export"
                },
                export.span,
            );
        }
        let exports = std::mem::take(&mut self.exports);
        for export in exports {
            let target = if self.has_entity_subject(&export.target) {
                Some(export.target)
            } else {
                self.resolve_exact_symbol_name(&export.target)
            };
            let Some(target) = target else {
                continue;
            };
            self.add_fact_at(
                export.owner,
                "EXPORTS",
                target,
                &export.source,
                "oaf.ingest:resolved-export",
                export.span,
            );
        }

        let parts = std::mem::take(&mut self.parts);
        for part in parts {
            let target = self
                .resolve_import_target(&part)
                .unwrap_or(part.fallback.clone());
            if !self.has_entity_subject(&target) {
                self.add_entity_at(
                    target.clone(),
                    "Module",
                    &part.source,
                    "oaf.ingest:dart-part-module",
                    part.span,
                );
            }
            self.add_fact_at(
                target,
                "PART_OF",
                part.owner,
                &part.source,
                "oaf.ingest:dart-part",
                part.span,
            );
        }

        let routes = std::mem::take(&mut self.routes);
        for route in routes {
            let route_id = route_id(&route.method, &route.path);
            self.add_entity_at(
                route_id.clone(),
                "Route",
                &route.source,
                "oaf.ingest:route",
                route.span,
            );
            self.add_fact_at(
                route_id.clone(),
                "HAS_METHOD",
                format!("method={}", route.method),
                &route.source,
                route.note,
                route.span,
            );
            self.add_fact_at(
                route_id.clone(),
                "HAS_PATH",
                format!("path={}", route.path),
                &route.source,
                route.note,
                route.span,
            );
            if let Some(handler) = self.resolve_route_handler(&route) {
                self.add_fact_at(
                    handler,
                    "HANDLES",
                    route_id,
                    &route.source,
                    route.note,
                    route.span,
                );
            }
        }

        let calls = std::mem::take(&mut self.calls);
        for call in calls {
            let (target, note) = self.resolve_call(&call);
            if !self.has_definition_subject(&target) {
                self.add_entity_at(
                    target.clone(),
                    symbol_kind(&target),
                    &call.source,
                    "oaf.ingest:call-target",
                    call.span,
                );
            }
            self.add_fact_at(call.caller, "CALLS", target, &call.source, note, call.span);
        }
        let constructs = std::mem::take(&mut self.constructs);
        for construct in constructs {
            let resolved = self
                .resolve_type_symbol_name_in_source(&construct.type_name, &construct.source)
                .or_else(|| self.resolve_type_symbol_name(&construct.type_name));
            let target = resolved
                .clone()
                .unwrap_or_else(|| format!("external_class:{}", construct.type_name));
            if !self.has_entity_subject(&target) {
                self.add_entity_at(
                    target.clone(),
                    "Class",
                    &construct.source,
                    "oaf.ingest:construct-target",
                    construct.span,
                );
            }
            self.add_fact_at(
                construct.caller,
                "CONSTRUCTS",
                target,
                &construct.source,
                if resolved.is_some() {
                    "oaf.ingest:resolved-construct"
                } else {
                    "oaf.ingest:unresolved-construct"
                },
                construct.span,
            );
        }
        let heritage = std::mem::take(&mut self.heritage);
        for relation in heritage {
            let subject = if relation.subject.contains(':') {
                relation.subject
            } else {
                self.resolve_type_symbol_name_in_source(&relation.subject, &relation.source)
                    .unwrap_or_else(|| format!("external_struct:{}", relation.subject))
            };
            let resolved = match relation.predicate {
                "EXTENDS_TYPE" => {
                    self.resolve_extended_type(&relation.target_name, &relation.source)
                }
                "MIXES_IN" => {
                    self.resolve_mixin_symbol_name(&relation.target_name, &relation.source)
                }
                _ => self
                    .resolve_type_symbol_name_in_source(&relation.target_name, &relation.source)
                    .or_else(|| self.resolve_type_symbol_name(&relation.target_name)),
            };
            let predicate = if relation.predicate == "INHERITS" {
                if subject.starts_with("interface:") {
                    "EXTENDS"
                } else if resolved.as_deref().is_some_and(|target| {
                    matches!(
                        target.split_once(':').map(|(kind, _)| kind),
                        Some("interface" | "protocol" | "trait" | "mixin")
                    )
                }) {
                    "IMPLEMENTS"
                } else {
                    "EXTENDS"
                }
            } else {
                relation.predicate
            };
            let target = resolved.clone().unwrap_or_else(|| {
                let kind = match predicate {
                    "IMPLEMENTS" => "interface",
                    "MIXES_IN" => "mixin",
                    _ => "class",
                };
                format!("external_{kind}:{}", relation.target_name)
            });
            if !self.has_entity_subject(&target) {
                self.add_entity_at(
                    target.clone(),
                    match predicate {
                        "IMPLEMENTS" => "Interface",
                        "MIXES_IN" => "Mixin",
                        _ => "Class",
                    },
                    &relation.source,
                    "oaf.ingest:heritage-target",
                    relation.span,
                );
            }
            self.add_fact_at(
                subject,
                predicate,
                target,
                &relation.source,
                if resolved.is_some() {
                    "oaf.ingest:resolved-heritage"
                } else {
                    "oaf.ingest:unresolved-heritage"
                },
                relation.span,
            );
        }
        let frameworks = std::mem::take(&mut self.frameworks);
        for framework in frameworks {
            self.add_entity_at(
                framework.component.clone(),
                "FrameworkComponent",
                &framework.source,
                "oaf.ingest:framework-component",
                framework.span,
            );
            self.add_fact_at(
                framework.owner,
                "DEPENDS_ON",
                framework.component.clone(),
                &framework.source,
                "oaf.ingest:framework",
                framework.span,
            );
            if let Some(handler) = framework
                .handler_name
                .as_deref()
                .and_then(|name| self.resolve_exact_symbol_name(name))
            {
                self.add_fact_at(
                    handler,
                    "LISTENS",
                    framework.component,
                    &framework.source,
                    "oaf.ingest:framework-handler",
                    framework.span,
                );
            }
        }
        let code_facts = self
            .facts
            .iter()
            .cloned()
            .map(FactKey::into_code_fact)
            .collect::<Vec<_>>();
        let mut facts = BTreeMap::new();
        for fact in self.facts {
            let key = (
                fact.subject.clone(),
                fact.predicate.clone(),
                fact.object.clone(),
                fact.source.clone(),
                fact.note.clone(),
            );
            facts.entry(key).or_insert_with(|| fact.into_batch_fact());
        }
        (facts.into_values().collect(), code_facts)
    }

    fn resolve_import_target(&self, import: &ImportRef) -> Option<String> {
        if let Some(container) = self.resolve_container_subject(&import.raw) {
            return Some(container);
        }
        let source_rel = import
            .source
            .strip_prefix("workspace://")
            .unwrap_or(&import.source);
        let mut candidates = Vec::new();
        if let Some(stem) = resolve_relative_import(source_rel, &import.raw) {
            candidates.push(stem);
        } else if is_relative_source_reference(&import.raw) {
            if let Some(stem) = resolve_relative_import(source_rel, &format!("./{}", import.raw)) {
                candidates.push(stem);
            }
        }
        if let Some(stem) = resolve_package_import(&self.package_entries, &import.raw) {
            candidates.push(stem);
        }
        candidates.extend(self.local_language_import_stems(import));
        candidates.sort();
        candidates.dedup();
        candidates
            .iter()
            .find_map(|stem| self.resolve_existing_module_subject(stem))
    }

    fn resolve_container_subject(&self, raw: &str) -> Option<String> {
        [format!("package:{raw}"), format!("namespace:{raw}")]
            .into_iter()
            .find(|subject| self.has_entity_subject(subject))
    }

    fn local_language_import_stems(&self, import: &ImportRef) -> Vec<String> {
        if !import.source.ends_with(".rs") || !import.raw.starts_with("crate::") {
            return Vec::new();
        }
        let tail = import.raw.trim_start_matches("crate::").replace("::", "/");
        self.package_entries
            .values()
            .filter_map(|entry| {
                let root = entry
                    .strip_suffix("/lib")
                    .or_else(|| entry.strip_suffix("lib"))?;
                Some(format!("{}/{tail}", root.trim_end_matches('/')))
            })
            .collect()
    }

    fn resolve_existing_module_subject(&self, stem: &str) -> Option<String> {
        let normalized = strip_known_extension(stem.trim().trim_start_matches("./"));
        let mut candidate = normalized.to_string();
        loop {
            let subject = format!("module:{}", module_token(&candidate));
            if self.has_entity_subject(&subject) {
                return Some(subject);
            }
            let Some((parent, _)) = candidate.rsplit_once('/') else {
                break;
            };
            candidate = parent.to_string();
        }

        let directory = normalized.trim_matches('/');
        let prefix = format!("workspace://{directory}/");
        let modules = self
            .facts
            .iter()
            .filter(|fact| {
                fact.predicate == "IS_A"
                    && fact.object == "Module"
                    && fact.source.starts_with(&prefix)
                    && fact.source[prefix.len()..].split('/').count() == 1
            })
            .map(|fact| fact.subject.clone())
            .collect::<BTreeSet<_>>();
        (modules.len() == 1).then(|| modules.iter().next().unwrap().clone())
    }

    fn resolve_route_handler(&self, route: &RouteRef) -> Option<String> {
        if let Some(subject) = route.handler_subject.as_deref() {
            return Some(subject.to_string());
        }
        route
            .handler_name
            .as_deref()
            .and_then(|name| self.resolve_exact_symbol_name(name))
    }

    fn resolve_call(&self, call: &CallRef) -> (String, &'static str) {
        if let Some(hint) = call.typed_target.as_ref() {
            if let Some(target) = self
                .resolve_unambiguous_symbol_name_in_source(&hint.target_name, &call.source)
                .or_else(|| self.resolve_unambiguous_symbol_name(&hint.target_name))
            {
                return (target, hint.note);
            }
        }
        if let Some(target) = self.resolve_scoped_call_target(call) {
            return (target, "oaf.ingest:resolved-scoped-call");
        }
        match call
            .allow_name_resolution
            .then(|| self.resolve_known_call_target(&call.callee_name))
            .flatten()
        {
            Some(target) => (target, "oaf.ingest:resolved-call"),
            None => (
                format!(
                    "external_function:{}",
                    sanitize_symbol(&call.callee_name).unwrap_or_else(|| "unknown".to_string())
                ),
                "oaf.ingest:unresolved-call",
            ),
        }
    }

    fn resolve_scoped_call_target(&self, call: &CallRef) -> Option<String> {
        if !call.allow_name_resolution {
            return None;
        }
        let direct_name = sanitize_symbol(&call.callee_name)?;
        let name = self.lookup_symbol_name_in_source(&call.callee_name, &call.source)?;
        let subjects = self.definitions_by_name.get(&name)?;
        let local = subjects
            .iter()
            .filter(|candidate| {
                self.facts.iter().any(|fact| {
                    fact.predicate == "DEFINES"
                        && fact.subject == call.caller
                        && fact.object == candidate.as_str()
                        && fact.source == call.source
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        if local.len() == 1 {
            return Some(local[0].clone());
        }
        let enclosing_owners = self
            .facts
            .iter()
            .filter(|fact| {
                fact.predicate == "DEFINES"
                    && fact.object == call.caller
                    && fact.source == call.source
            })
            .map(|fact| fact.subject.as_str())
            .collect::<BTreeSet<_>>();
        if enclosing_owners.len() == 1 {
            let enclosing_owner = enclosing_owners.iter().next().unwrap();
            let siblings = subjects
                .iter()
                .filter(|candidate| {
                    self.facts.iter().any(|fact| {
                        fact.predicate == "DEFINES"
                            && fact.subject == *enclosing_owner
                            && fact.object == candidate.as_str()
                            && fact.source == call.source
                    })
                })
                .cloned()
                .collect::<Vec<_>>();
            if siblings.len() == 1 {
                return Some(siblings[0].clone());
            }
        }
        if name != direct_name && subjects.len() == 1 {
            return subjects.iter().next().cloned();
        }
        None
    }

    fn resolve_exact_symbol_name(&self, name: &str) -> Option<String> {
        let name = self.lookup_symbol_name(name)?;
        let subjects = self.definitions_by_name.get(&name)?;
        if subjects.len() == 1 {
            return subjects.iter().next().cloned();
        }
        subjects
            .iter()
            .find(|subject| subject.starts_with("method:"))
            .cloned()
    }

    fn resolve_unambiguous_symbol_name(&self, name: &str) -> Option<String> {
        let name = self.lookup_symbol_name(name)?;
        let subjects = self.definitions_by_name.get(&name)?;
        (subjects.len() == 1).then(|| subjects.iter().next().unwrap().clone())
    }

    fn resolve_unambiguous_symbol_name_in_source(
        &self,
        name: &str,
        source: &str,
    ) -> Option<String> {
        let name = self.lookup_symbol_name_in_source(name, source)?;
        let subjects = self.definitions_by_name.get(&name)?;
        let local = subjects
            .iter()
            .filter(|subject| {
                self.facts.iter().any(|fact| {
                    fact.predicate == "IS_A"
                        && fact.subject == subject.as_str()
                        && fact.source == source
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        if local.len() == 1 {
            return Some(local[0].clone());
        }
        (subjects.len() == 1).then(|| subjects.iter().next().unwrap().clone())
    }

    fn resolve_type_symbol_name(&self, name: &str) -> Option<String> {
        let name = self.lookup_symbol_name(name)?;
        let subjects = self.definitions_by_name.get(&name)?;
        let types = subjects
            .iter()
            .filter(|subject| is_type_subject(subject))
            .cloned()
            .collect::<Vec<_>>();
        (types.len() == 1).then(|| types[0].clone())
    }

    fn resolve_type_symbol_name_in_source(&self, name: &str, source: &str) -> Option<String> {
        let name = self.lookup_symbol_name_in_source(name, source)?;
        let subjects = self.definitions_by_name.get(&name)?;
        let local = subjects
            .iter()
            .filter(|subject| {
                is_type_subject(subject)
                    && self.facts.iter().any(|fact| {
                        fact.predicate == "IS_A"
                            && fact.subject == subject.as_str()
                            && fact.source == source
                    })
            })
            .cloned()
            .collect::<Vec<_>>();
        if local.len() == 1 {
            return Some(local[0].clone());
        }
        let types = subjects
            .iter()
            .filter(|subject| is_type_subject(subject))
            .cloned()
            .collect::<Vec<_>>();
        (types.len() == 1).then(|| types[0].clone())
    }

    fn resolve_extended_type(&self, name: &str, source: &str) -> Option<String> {
        let name = self.lookup_symbol_name_in_source(name, source)?;
        let subjects = self.definitions_by_name.get(&name)?;
        let candidates = subjects
            .iter()
            .filter(|subject| is_type_subject(subject) && !subject.starts_with("extension:"))
            .cloned()
            .collect::<Vec<_>>();
        let local = candidates
            .iter()
            .filter(|subject| {
                self.facts.iter().any(|fact| {
                    fact.predicate == "IS_A"
                        && fact.subject == subject.as_str()
                        && fact.source == source
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        if local.len() == 1 {
            return Some(local[0].clone());
        }
        (candidates.len() == 1).then(|| candidates[0].clone())
    }

    fn resolve_mixin_symbol_name(&self, name: &str, source: &str) -> Option<String> {
        let name = self.lookup_symbol_name_in_source(name, source)?;
        let subjects = self.definitions_by_name.get(&name)?;
        let candidates = subjects
            .iter()
            .filter(|subject| is_type_subject(subject) || subject.starts_with("namespace:"))
            .cloned()
            .collect::<Vec<_>>();
        (candidates.len() == 1).then(|| candidates[0].clone())
    }

    fn lookup_symbol_name(&self, name: &str) -> Option<String> {
        sanitize_symbol(name)
    }

    fn lookup_symbol_name_in_source(&self, name: &str, source: &str) -> Option<String> {
        let alias = sanitize_symbol(name)?;
        self.symbol_aliases
            .get(&(source.to_string(), alias))
            .cloned()
            .or_else(|| sanitize_symbol(name))
    }

    fn resolve_known_call_target(&self, callee_name: &str) -> Option<String> {
        let name = self.lookup_symbol_name(callee_name)?;
        match self.definitions_by_name.get(&name) {
            Some(subjects) if subjects.len() == 1 => subjects.iter().next().cloned(),
            Some(subjects) => {
                let functions = subjects
                    .iter()
                    .filter(|subject| subject.starts_with("function:"))
                    .cloned()
                    .collect::<Vec<_>>();
                (functions.len() == 1).then(|| functions[0].clone())
            }
            None => None,
        }
    }

    fn has_definition_subject(&self, subject: &str) -> bool {
        self.definitions_by_name
            .values()
            .any(|subjects| subjects.contains(subject))
    }

    fn has_entity_subject(&self, subject: &str) -> bool {
        self.facts
            .iter()
            .any(|fact| fact.predicate == "IS_A" && fact.subject == subject)
    }

    fn merge(&mut self, other: ParsedRepo) {
        self.facts.extend(other.facts);
        self.deferred_definitions.extend(other.deferred_definitions);
        self.calls.extend(other.calls);
        self.constructs.extend(other.constructs);
        self.imports.extend(other.imports);
        self.re_exports.extend(other.re_exports);
        self.parts.extend(other.parts);
        self.exports.extend(other.exports);
        self.routes.extend(other.routes);
        self.heritage.extend(other.heritage);
        self.frameworks.extend(other.frameworks);
        for (name, subjects) in other.definitions_by_name {
            self.definitions_by_name
                .entry(name)
                .or_default()
                .extend(subjects);
        }
        self.symbol_aliases.extend(other.symbol_aliases);
        self.package_entries.extend(other.package_entries);
        self.generated_call_count += other.generated_call_count;
        self.import_count += other.import_count;
        self.definition_count += other.definition_count;
    }
}

#[derive(Debug, Clone)]
struct ImportTarget {
    raw: String,
    fallback: String,
}

#[derive(Debug, Clone)]
struct ImportRef {
    owner: String,
    raw: String,
    fallback: String,
    source: String,
    span: CodeSpan,
}

#[derive(Debug, Clone)]
struct ExportRef {
    owner: String,
    target: String,
    source: String,
    span: CodeSpan,
}

#[derive(Debug, Clone)]
struct DeferredDefinitionRef {
    owner_name: String,
    fallback_owner: String,
    symbol: String,
    source: String,
    note: &'static str,
    span: CodeSpan,
}

#[derive(Debug, Clone)]
struct RouteRef {
    method: String,
    path: String,
    handler_subject: Option<String>,
    handler_name: Option<String>,
    source: String,
    note: &'static str,
    span: CodeSpan,
}

#[derive(Debug, Clone)]
struct CallRef {
    caller: String,
    callee_name: String,
    typed_target: Option<TypedCallHint>,
    allow_name_resolution: bool,
    source: String,
    span: CodeSpan,
}

#[derive(Debug, Clone)]
struct ConstructRef {
    caller: String,
    type_name: String,
    source: String,
    span: CodeSpan,
}

#[derive(Debug, Clone)]
struct HeritageRef {
    subject: String,
    predicate: &'static str,
    target_name: String,
    source: String,
    span: CodeSpan,
}

#[derive(Debug, Clone)]
struct FrameworkRef {
    owner: String,
    component: String,
    handler_name: Option<String>,
    source: String,
    span: CodeSpan,
}

#[derive(Debug, Clone)]
struct TypedCallHint {
    target_name: String,
    note: &'static str,
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
struct FactKey {
    subject: String,
    predicate: String,
    object: String,
    source: String,
    note: String,
    span: CodeSpan,
}

impl FactKey {
    fn into_code_fact(self) -> CodeFactRecord {
        CodeFactRecord {
            subject: self.subject,
            predicate: self.predicate,
            object: self.object,
            source: self.source,
            note: self.note,
            span: self.span,
        }
    }

    fn into_batch_fact(self) -> BatchFact {
        BatchFact {
            subject: self.subject,
            predicate: self.predicate,
            object: self.object,
            source: self.source,
            source_trust: None,
            confidence: Some("extracted".to_string()),
            notes: Some(self.note),
            supersedes: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum LangKind {
    JavaScript,
    TypeScript,
    Tsx,
    Python,
    Rust,
    Go,
    Java,
    C,
    Cpp,
    Ruby,
    Php,
    CSharp,
    Swift,
    Kotlin,
    Lua,
    Bash,
    Sql,
    ObjectiveC,
    Scala,
    Dart,
    R,
    Julia,
    Zig,
}

impl LangKind {
    fn group(self) -> &'static str {
        match self {
            LangKind::JavaScript => "javascript-jsx",
            LangKind::TypeScript | LangKind::Tsx => "typescript-tsx",
            LangKind::Python => "python",
            LangKind::Rust => "rust",
            LangKind::Go => "go",
            LangKind::Java => "java",
            LangKind::C => "c",
            LangKind::Cpp => "cpp",
            LangKind::Ruby => "ruby",
            LangKind::Php => "php",
            LangKind::CSharp => "csharp",
            LangKind::Swift => "swift",
            LangKind::Kotlin => "kotlin",
            LangKind::Lua => "lua",
            LangKind::Bash => "bash",
            LangKind::Sql => "sql",
            LangKind::ObjectiveC => "objective-c",
            LangKind::Scala => "scala",
            LangKind::Dart => "dart",
            LangKind::R => "r",
            LangKind::Julia => "julia",
            LangKind::Zig => "zig",
        }
    }

    fn language(self) -> Language {
        match self {
            LangKind::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            LangKind::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            LangKind::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            LangKind::Python => tree_sitter_python::LANGUAGE.into(),
            LangKind::Rust => tree_sitter_rust::LANGUAGE.into(),
            LangKind::Go => tree_sitter_go::LANGUAGE.into(),
            LangKind::Java => tree_sitter_java::LANGUAGE.into(),
            LangKind::C => tree_sitter_c::LANGUAGE.into(),
            LangKind::Cpp => tree_sitter_cpp::LANGUAGE.into(),
            LangKind::Ruby => tree_sitter_ruby::LANGUAGE.into(),
            LangKind::Php => tree_sitter_php::LANGUAGE_PHP.into(),
            LangKind::CSharp => tree_sitter_c_sharp::LANGUAGE.into(),
            LangKind::Swift => tree_sitter_swift::LANGUAGE.into(),
            LangKind::Kotlin => tree_sitter_kotlin_ng::LANGUAGE.into(),
            LangKind::Lua => tree_sitter_lua::LANGUAGE.into(),
            LangKind::Bash => tree_sitter_bash::LANGUAGE.into(),
            LangKind::Sql => tree_sitter_sequel::LANGUAGE.into(),
            LangKind::ObjectiveC => tree_sitter_objc::LANGUAGE.into(),
            LangKind::Scala => tree_sitter_scala::LANGUAGE.into(),
            LangKind::Dart => tree_sitter_dart::LANGUAGE.into(),
            LangKind::R => tree_sitter_r::LANGUAGE.into(),
            LangKind::Julia => tree_sitter_julia::LANGUAGE.into(),
            LangKind::Zig => tree_sitter_zig::LANGUAGE.into(),
        }
    }
}

#[derive(Debug, Clone)]
struct WalkContext {
    module: String,
    source: String,
    lang: LangKind,
    container_name: Option<String>,
    class_name: Option<String>,
    owner_subject: Option<String>,
    route_prefix: Option<String>,
    impl_name: Option<String>,
    caller: Option<String>,
    type_bindings: BTreeMap<String, String>,
    suppress_calls: bool,
}

#[derive(Debug, Clone)]
struct DeclaredContainer {
    name: String,
    subject: String,
    kind: &'static str,
    span: CodeSpan,
}

fn declared_container(root: Node<'_>, source: &[u8], lang: LangKind) -> Option<DeclaredContainer> {
    let expected = match lang {
        LangKind::Java => &["package_declaration"][..],
        LangKind::Kotlin => &["package_header"][..],
        LangKind::CSharp => &["namespace_declaration", "file_scoped_namespace_declaration"][..],
        LangKind::Php => &["namespace_definition"][..],
        LangKind::Dart => &["library_name"][..],
        _ => return None,
    };
    let node = first_descendant_matching(root, &|candidate| expected.contains(&candidate.kind()))?;
    let raw_name = node
        .child_by_field_name("name")
        .map(|child| node_text(child, source))
        .or_else(|| {
            (0..node.named_child_count())
                .filter_map(|index| node.named_child(index))
                .find(|child| {
                    matches!(
                        child.kind(),
                        "identifier"
                            | "scoped_identifier"
                            | "qualified_identifier"
                            | "qualified_name"
                            | "dotted_identifier_list"
                    )
                })
                .map(|child| node_text(child, source))
        })?;
    let name = normalize_container_name(raw_name)?;
    let (prefix, kind) = match lang {
        LangKind::CSharp | LangKind::Php => ("namespace", "Namespace"),
        LangKind::Dart => ("library", "Library"),
        _ => ("package", "Package"),
    };
    Some(DeclaredContainer {
        subject: format!("{prefix}:{name}"),
        name,
        kind,
        span: CodeSpan::from_node(node),
    })
}

fn first_descendant_matching<'tree>(
    node: Node<'tree>,
    predicate: &impl Fn(Node<'tree>) -> bool,
) -> Option<Node<'tree>> {
    for index in 0..node.named_child_count() {
        let child = node.named_child(index)?;
        if predicate(child) {
            return Some(child);
        }
        if let Some(found) = first_descendant_matching(child, predicate) {
            return Some(found);
        }
    }
    None
}

fn first_ancestor_matching<'tree>(
    mut node: Node<'tree>,
    predicate: &impl Fn(Node<'tree>) -> bool,
) -> Option<Node<'tree>> {
    while let Some(parent) = node.parent() {
        if predicate(parent) {
            return Some(parent);
        }
        node = parent;
    }
    None
}

fn normalize_container_name(value: &str) -> Option<String> {
    let normalized = value.replace('\\', ".");
    let name = normalized
        .trim()
        .trim_start_matches("package ")
        .trim_start_matches("namespace ")
        .trim_end_matches([';', '{'])
        .trim();
    if name.is_empty()
        || name.len() > 160
        || name.split('.').any(|segment| {
            segment.is_empty()
                || !segment
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '$'))
        })
    {
        return None;
    }
    Some(name.to_string())
}

pub fn extract_repo(options: &IngestOptions) -> Result<IngestReport> {
    let started = Instant::now();
    let root = options.root.canonicalize().with_context(|| {
        format!(
            "ingest root must point at a local workspace directory: {}",
            options.root.display()
        )
    })?;
    let requested_worker_count = options.workers.max(1);
    let cgroup_memory_limit_bytes = cgroup_memory_limit_bytes();
    let effective_worker_count = effective_worker_count(
        requested_worker_count,
        options.max_memory_bytes,
        cgroup_memory_limit_bytes,
    );
    let package_entries = scan_package_entries(&root)?;
    let (jobs, mut skipped_files, scanned_file_count) = discover_jobs(&root, options)?;
    let results = parse_jobs(jobs, effective_worker_count)?;
    let mut parsed = ParsedRepo::new();
    parsed.package_entries = package_entries;
    let mut parsed_file_count = 0usize;
    let mut parsed_bytes = 0u64;
    let mut language_counts = BTreeMap::new();
    let mut recovered_files = Vec::new();

    for result in results {
        parsed_bytes += result.bytes_read;
        if let Some(recovered) = result.recovered {
            recovered_files.push(recovered);
        }
        if let Some(skipped) = result.skipped {
            skipped_files.push(skipped);
            continue;
        }
        if let Some(file_parsed) = result.parsed {
            parsed.merge(file_parsed);
            parsed_file_count += 1;
            *language_counts
                .entry(result.lang.group().to_string())
                .or_insert(0) += 1;
        }
    }

    augment_build_targets(&root, &mut parsed)?;

    let generated_call_count = parsed.generated_call_count;
    let import_count = parsed.import_count;
    let definition_count = parsed.definition_count;
    let (facts, code_facts) = parsed.finish();
    Ok(IngestReport {
        scanned_file_count,
        parsed_file_count,
        skipped_file_count: skipped_files.len(),
        generated_fact_count: facts.len(),
        generated_call_count,
        import_count,
        definition_count,
        parsed_bytes,
        requested_worker_count,
        effective_worker_count,
        cgroup_memory_limit_bytes,
        elapsed_ms: started.elapsed().as_millis(),
        skipped_files,
        recovered_files,
        facts,
        code_facts,
        language_counts,
    })
}

fn augment_build_targets(root: &Path, parsed: &mut ParsedRepo) -> Result<()> {
    let mut builder = WalkBuilder::new(root);
    builder
        .follow_links(false)
        .git_ignore(true)
        .git_exclude(true)
        .parents(true)
        .hidden(false)
        .filter_entry(should_descend);
    for entry in builder.build().filter_map(Result::ok) {
        let path = entry.path();
        if !is_build_configuration(path) {
            continue;
        }
        let metadata = fs::metadata(path).with_context(|| format!("stat {}", path.display()))?;
        if metadata.len() > DEFAULT_MAX_FILE_BYTES {
            continue;
        }
        let relative = workspace_rel(root, path)?;
        let source_ref = format!("workspace://{relative}");
        let source = fs::read_to_string(path)
            .with_context(|| format!("read build configuration {relative}"))?;
        if path.file_name().and_then(|name| name.to_str()) == Some("CMakeLists.txt") {
            let variables = cmake_source_variables(path, &source)?;
            for (command, arguments, line) in cmake_target_calls(&source) {
                let tokens = expand_source_variables(
                    arguments.split_whitespace().map(str::to_string).collect(),
                    &variables,
                    0,
                );
                let Some(target_name) = tokens.first().and_then(|token| sanitize_symbol(token))
                else {
                    continue;
                };
                add_build_target(
                    parsed,
                    &relative,
                    &source_ref,
                    &target_name,
                    &tokens[1..],
                    line,
                    command.eq_ignore_ascii_case("add_executable"),
                    "cmake",
                );
            }
        } else {
            let variables = makefile_variables(&source);
            for (target_name, sources, line) in makefile_target_calls(&source, &variables) {
                add_build_target(
                    parsed,
                    &relative,
                    &source_ref,
                    &target_name,
                    &sources,
                    line,
                    true,
                    "makefile",
                );
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn add_build_target(
    parsed: &mut ParsedRepo,
    config: &str,
    source_ref: &str,
    target_name: &str,
    tokens: &[String],
    line: u32,
    executable: bool,
    resolver: &str,
) {
    let sources = tokens
        .iter()
        .map(|token| token.trim_matches(['"', '\'']))
        .filter(|token| {
            !matches!(
                *token,
                "STATIC" | "SHARED" | "MODULE" | "OBJECT" | "EXCLUDE_FROM_ALL"
            )
        })
        .filter(|token| {
            matches!(
                language_for_path(Path::new(token)),
                Some(LangKind::C | LangKind::Cpp)
            )
        })
        .collect::<Vec<_>>();
    let modules = sources
        .iter()
        .filter_map(|source| {
            let resolved = resolve_config_relative(config, source);
            parsed.resolve_existing_module_subject(&resolved)
        })
        .collect::<BTreeSet<_>>();
    if modules.is_empty() {
        return;
    }
    let target = format!("build_target:{target_name}");
    let span = CodeSpan {
        start_line: line,
        start_column: 0,
        end_line: line,
        end_column: 1,
    };
    let cpp = sources
        .iter()
        .any(|source| language_for_path(Path::new(source)) == Some(LangKind::Cpp));
    let note = match (resolver, cpp) {
        ("cmake", true) => "oaf.ingest:cmake-cpp",
        ("cmake", false) => "oaf.ingest:cmake-c",
        ("makefile", true) => "oaf.ingest:makefile-cpp",
        _ => "oaf.ingest:makefile-c",
    };
    parsed.add_entity_at(target.clone(), "BuildTarget", source_ref, note, span);
    for module in modules {
        parsed.add_fact_at(target.clone(), "DEPENDS_ON", module, source_ref, note, span);
    }
    if executable && parsed.has_entity_subject("function:main") {
        parsed.add_fact_at(
            "function:main".to_string(),
            "ENTRY_POINT",
            target,
            source_ref,
            note,
            span,
        );
    }
}

fn cmake_source_variables(path: &Path, source: &str) -> Result<BTreeMap<String, Vec<String>>> {
    let mut variables = BTreeMap::<String, Vec<String>>::new();
    let Some(directory) = path.parent() else {
        return Ok(variables);
    };
    let mut siblings = fs::read_dir(directory)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| is_makefile(path))
        .collect::<Vec<_>>();
    siblings.sort();
    for sibling in siblings {
        let metadata = fs::metadata(&sibling)?;
        if metadata.len() <= DEFAULT_MAX_FILE_BYTES {
            let contents = fs::read_to_string(&sibling)?;
            variables.extend(makefile_variables(&contents));
        }
    }
    for (command, arguments, _) in cmake_variable_calls(source) {
        let mut tokens = arguments.split_whitespace();
        if command.eq_ignore_ascii_case("set") {
            let Some(name) = tokens.next().and_then(sanitize_symbol) else {
                continue;
            };
            variables.insert(name, tokens.map(str::to_string).collect());
        } else {
            if tokens.next() != Some("APPEND") {
                continue;
            }
            let Some(name) = tokens.next().and_then(sanitize_symbol) else {
                continue;
            };
            variables
                .entry(name)
                .or_default()
                .extend(tokens.map(str::to_string));
        }
    }
    Ok(variables)
}

fn makefile_variables(source: &str) -> BTreeMap<String, Vec<String>> {
    let mut variables = BTreeMap::<String, Vec<String>>::new();
    for (line, _) in logical_makefile_lines(source) {
        let Some((left, right)) = line.split_once('=') else {
            continue;
        };
        let append = left.trim_end().ends_with('+');
        let name = left.trim().trim_end_matches([':', '+', '?']).trim();
        if sanitize_symbol(name).as_deref() != Some(name) {
            continue;
        }
        let values = right.split_whitespace().map(str::to_string);
        if append {
            variables
                .entry(name.to_string())
                .or_default()
                .extend(values);
        } else {
            variables.insert(name.to_string(), values.collect());
        }
    }
    variables
}

fn makefile_target_calls(
    source: &str,
    variables: &BTreeMap<String, Vec<String>>,
) -> Vec<(String, Vec<String>, u32)> {
    logical_makefile_lines(source)
        .into_iter()
        .filter_map(|(line, line_number)| {
            if line.contains('=') || line.starts_with('.') || line.starts_with('\t') {
                return None;
            }
            let (target, dependencies) = line.split_once(':')?;
            let target = sanitize_symbol(target.trim())?;
            let sources = expand_source_variables(
                dependencies
                    .split_whitespace()
                    .map(str::to_string)
                    .collect(),
                variables,
                0,
            );
            Some((target, sources, line_number))
        })
        .collect()
}

fn logical_makefile_lines(source: &str) -> Vec<(String, u32)> {
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut start_line = 1u32;
    for (index, raw) in source.lines().enumerate() {
        let line_number = index as u32 + 1;
        let content = raw.split('#').next().unwrap_or("").trim_end();
        if current.is_empty() {
            start_line = line_number;
        }
        current.push_str(content.trim_end_matches('\\'));
        current.push(' ');
        if !content.ends_with('\\') {
            let logical = current.trim().to_string();
            if !logical.is_empty() {
                lines.push((logical, start_line));
            }
            current.clear();
        }
    }
    lines
}

fn expand_source_variables(
    tokens: Vec<String>,
    variables: &BTreeMap<String, Vec<String>>,
    depth: usize,
) -> Vec<String> {
    if depth >= 4 {
        return tokens;
    }
    tokens
        .into_iter()
        .flat_map(|token| {
            variable_reference(&token)
                .and_then(|name| variables.get(name))
                .map(|values| expand_source_variables(values.clone(), variables, depth + 1))
                .unwrap_or_else(|| vec![token])
        })
        .collect()
}

fn variable_reference(token: &str) -> Option<&str> {
    token
        .strip_prefix("${")
        .and_then(|value| value.strip_suffix('}'))
        .or_else(|| {
            token
                .strip_prefix("$(")
                .and_then(|value| value.strip_suffix(')'))
        })
}

fn cmake_target_calls(source: &str) -> Vec<(&str, &str, u32)> {
    cmake_calls(source, &["add_executable", "add_library"])
}

fn cmake_variable_calls(source: &str) -> Vec<(&str, &str, u32)> {
    cmake_calls(source, &["set", "list"])
}

fn cmake_calls<'a>(
    source: &'a str,
    commands: &[&'static str],
) -> Vec<(&'static str, &'a str, u32)> {
    let mut out = Vec::new();
    for &command in commands {
        let mut offset = 0usize;
        while let Some(found) = source[offset..].find(command) {
            let start = offset + found;
            if start > 0
                && (source.as_bytes()[start - 1].is_ascii_alphanumeric()
                    || source.as_bytes()[start - 1] == b'_')
            {
                offset = start + command.len();
                continue;
            }
            let tail = &source[start + command.len()..];
            let open = tail.len() - tail.trim_start().len();
            if !tail[open..].starts_with('(') {
                offset = start + command.len();
                continue;
            }
            let Some(arguments) = parenthesized_segments(&tail[open..]).into_iter().next() else {
                break;
            };
            let line = source[..start]
                .bytes()
                .filter(|byte| *byte == b'\n')
                .count() as u32
                + 1;
            out.push((command, arguments, line));
            offset = start + command.len() + open + arguments.len() + 2;
        }
    }
    out.sort_by_key(|(_, _, line)| *line);
    out
}

fn resolve_config_relative(config: &str, source: &str) -> String {
    let directory = config.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    let joined = if directory.is_empty() {
        source.to_string()
    } else {
        format!("{directory}/{source}")
    };
    strip_known_extension(&joined).to_string()
}

pub fn discover_file_hashes(options: &IngestOptions) -> Result<Vec<IngestFileHash>> {
    let (jobs, _skipped, _scanned) = discover_jobs(&options.root, options)?;
    let mut hashes = Vec::with_capacity(jobs.len());
    for job in jobs {
        let bytes = fs::read(&job.path).with_context(|| format!("read {}", job.source))?;
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        hashes.push(IngestFileHash {
            source: job.source,
            sha256: hex::encode(hasher.finalize()),
            bytes: bytes.len() as u64,
        });
    }
    let root = options.root.canonicalize().with_context(|| {
        format!(
            "hash discovery root must point at a local workspace directory: {}",
            options.root.display()
        )
    })?;
    let mut builder = WalkBuilder::new(&root);
    builder
        .follow_links(false)
        .git_ignore(true)
        .git_exclude(true)
        .parents(true)
        .hidden(false)
        .filter_entry(should_descend);
    for entry in builder.build().filter_map(Result::ok) {
        let path = entry.path();
        if !is_build_configuration(path) {
            continue;
        }
        let metadata = fs::metadata(path).with_context(|| format!("stat {}", path.display()))?;
        if metadata.len() > options.max_file_bytes {
            continue;
        }
        let relative = workspace_rel(&root, path)?;
        let source = format!("workspace://{relative}");
        if options
            .only_sources
            .as_ref()
            .is_some_and(|selected| !selected.contains(&source))
        {
            continue;
        }
        let bytes = fs::read(path).with_context(|| format!("read {source}"))?;
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        hashes.push(IngestFileHash {
            source,
            sha256: hex::encode(hasher.finalize()),
            bytes: bytes.len() as u64,
        });
    }
    hashes.sort_by(|left, right| left.source.cmp(&right.source));
    hashes.dedup_by(|left, right| left.source == right.source);
    Ok(hashes)
}

pub fn discover_file_hashes_bounded(
    options: &IngestOptions,
    bounds: &FileHashDiscoveryBounds,
    include_source: impl Fn(&str) -> bool,
) -> Result<IngestFileHashReport> {
    if bounds.max_candidate_files == 0 || bounds.max_hashed_bytes == 0 {
        bail!("ingest_file_hash_discovery_bounds_invalid");
    }
    let root = options.root.canonicalize().with_context(|| {
        format!(
            "hash discovery root must point at a local workspace directory: {}",
            options.root.display()
        )
    })?;
    let mut builder = WalkBuilder::new(&root);
    builder
        .follow_links(false)
        .git_ignore(true)
        .git_exclude(true)
        .parents(true)
        .hidden(false)
        .filter_entry(should_descend);

    let mut candidates = Vec::<(String, PathBuf, u64)>::new();
    let mut reason_codes = BTreeSet::new();
    for entry in builder.build() {
        if Instant::now() >= bounds.deadline {
            reason_codes.insert("source_index_freshness_deadline_exceeded".to_string());
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                reason_codes.insert("source_index_freshness_walk_failed".to_string());
                break;
            }
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_build_config = is_build_configuration(path);
        if !is_build_config && language_for_path_with_options(path, options).is_none() {
            continue;
        }
        let relative = match workspace_rel(&root, path) {
            Ok(relative) => relative,
            Err(_) => {
                reason_codes.insert("source_index_freshness_path_failed".to_string());
                break;
            }
        };
        let source = format!("workspace://{relative}");
        if !include_source(&source)
            || options
                .only_sources
                .as_ref()
                .is_some_and(|selected| !selected.contains(&source))
        {
            continue;
        }
        let metadata = match fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(_) => {
                reason_codes.insert("source_index_freshness_stat_failed".to_string());
                break;
            }
        };
        let bytes = metadata.len();
        if bytes > options.max_file_bytes {
            continue;
        }
        let canonical = match path.canonicalize() {
            Ok(canonical) if canonical.starts_with(&root) => canonical,
            _ => {
                reason_codes.insert("source_index_freshness_path_failed".to_string());
                break;
            }
        };
        if candidates.len() >= bounds.max_candidate_files {
            reason_codes.insert("source_index_freshness_candidate_cap".to_string());
            break;
        }
        candidates.push((source, canonical, bytes));
    }

    candidates.sort_by(|left, right| left.0.cmp(&right.0));
    candidates.dedup_by(|left, right| left.0 == right.0);
    if let Some(limit) = bounds.selected_file_limit {
        candidates.truncate(limit);
    }

    let mut hashes = Vec::with_capacity(candidates.len());
    let mut hashed_bytes = 0u64;
    if reason_codes.is_empty() {
        for (source, path, bytes) in candidates {
            if Instant::now() >= bounds.deadline {
                reason_codes.insert("source_index_freshness_deadline_exceeded".to_string());
                break;
            }
            if hashed_bytes.saturating_add(bytes) > bounds.max_hashed_bytes {
                reason_codes.insert("source_index_freshness_byte_cap".to_string());
                break;
            }
            let content = match fs::read(path) {
                Ok(content) => content,
                Err(_) => {
                    reason_codes.insert("source_index_freshness_read_failed".to_string());
                    break;
                }
            };
            hashed_bytes = hashed_bytes.saturating_add(content.len() as u64);
            hashes.push(IngestFileHash {
                source,
                sha256: hex::encode(Sha256::digest(&content)),
                bytes: content.len() as u64,
            });
        }
    }
    let complete = reason_codes.is_empty();
    Ok(IngestFileHashReport {
        hashes,
        complete,
        reason_codes: reason_codes.into_iter().collect(),
    })
}

pub fn extract_code_fingerprints(options: &IngestOptions) -> Result<Vec<CodeFingerprint>> {
    let root = options.root.canonicalize().with_context(|| {
        format!(
            "fingerprint root must point at a local workspace directory: {}",
            options.root.display()
        )
    })?;
    let (jobs, _skipped_files, _scanned_file_count) = discover_jobs(&root, options)?;
    let mut fingerprints = Vec::new();
    for job in jobs {
        fingerprints.extend(extract_file_fingerprints(job)?);
    }
    fingerprints.sort_by(|left, right| {
        left.subject
            .cmp(&right.subject)
            .then_with(|| left.source.cmp(&right.source))
    });
    Ok(fingerprints)
}

pub fn retirement_facts(active: &[ActiveFactSnapshot], extracted: &[BatchFact]) -> Vec<BatchFact> {
    let current = extracted
        .iter()
        .map(|fact| {
            (
                fact.subject.as_str(),
                fact.predicate.as_str(),
                fact.object.as_str(),
                fact.source.as_str(),
            )
        })
        .collect::<BTreeSet<_>>();
    active
        .iter()
        .filter(|fact| {
            !current.contains(&(
                fact.subject.as_str(),
                fact.predicate.as_str(),
                fact.object.as_str(),
                fact.source.as_str(),
            ))
        })
        .map(|fact| BatchFact {
            subject: fact.subject.clone(),
            predicate: fact.predicate.clone(),
            object: format!("retired_{}", short_hash(&fact.object)),
            source: fact.source.clone(),
            source_trust: None,
            confidence: Some("extracted".to_string()),
            notes: Some("oaf.ingest:retired".to_string()),
            supersedes: Some(Supersedes {
                subject: fact.subject.clone(),
                predicate: fact.predicate.clone(),
                object: Some(fact.object.clone()),
            }),
        })
        .collect()
}

pub fn report_quality_fields(report: &IngestReport) -> Value {
    json!({
        "scannedFileCount": report.scanned_file_count,
        "parsedFileCount": report.parsed_file_count,
        "skippedFileCount": report.skipped_file_count,
        "generatedFactCount": report.generated_fact_count,
        "generatedCallCount": report.generated_call_count,
        "definitionCount": report.definition_count,
        "importCount": report.import_count,
        "parsedBytes": report.parsed_bytes,
        "requestedWorkerCount": report.requested_worker_count,
        "effectiveWorkerCount": report.effective_worker_count,
        "cgroupMemoryLimitBytes": report.cgroup_memory_limit_bytes,
        "elapsedMs": report.elapsed_ms,
        "languageCounts": report.language_counts,
        "skippedFiles": report.skipped_files,
        "recoveredFiles": report.recovered_files
    })
}

#[derive(Debug, Clone)]
struct FileJob {
    index: usize,
    path: PathBuf,
    rel: String,
    source: String,
    lang: LangKind,
    bytes: u64,
}

#[derive(Debug)]
struct FileParse {
    index: usize,
    lang: LangKind,
    bytes_read: u64,
    parsed: Option<ParsedRepo>,
    skipped: Option<SkippedFile>,
    recovered: Option<RecoveredFile>,
}

fn discover_jobs(
    root: &Path,
    options: &IngestOptions,
) -> Result<(Vec<FileJob>, Vec<SkippedFile>, usize)> {
    let mut builder = WalkBuilder::new(root);
    builder
        .follow_links(false)
        .git_ignore(true)
        .git_exclude(true)
        .parents(true)
        .hidden(false)
        .filter_entry(should_descend);

    let mut candidates = Vec::new();
    let mut skipped_files = Vec::new();
    let mut scanned_file_count = 0usize;
    for entry in builder.build() {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                skipped_files.push(SkippedFile {
                    workspace_ref: "workspace://.".to_string(),
                    reason: format!("walk error: {error}"),
                    bytes: 0,
                });
                continue;
            }
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(lang) = language_for_path_with_options(path, options) else {
            continue;
        };
        scanned_file_count += 1;
        let rel = workspace_rel(root, path)?;
        let source = format!("workspace://{rel}");
        if options
            .only_sources
            .as_ref()
            .is_some_and(|sources| !sources.contains(&source))
        {
            continue;
        }
        let metadata = fs::metadata(path).with_context(|| format!("stat {source}"))?;
        let bytes = metadata.len();
        if bytes > options.max_file_bytes {
            skipped_files.push(SkippedFile {
                workspace_ref: source,
                reason: "file exceeds max-file-bytes and was not truncated".to_string(),
                bytes,
            });
            continue;
        }
        let canonical = path
            .canonicalize()
            .with_context(|| format!("canonicalize {source}"))?;
        if !canonical.starts_with(root) {
            skipped_files.push(SkippedFile {
                workspace_ref: source,
                reason: "path resolves outside workspace root".to_string(),
                bytes,
            });
            continue;
        }
        candidates.push(FileJob {
            index: 0,
            path: canonical,
            rel,
            source,
            lang,
            bytes,
        });
    }

    candidates.sort_by(|left, right| left.rel.cmp(&right.rel));
    let mut jobs = Vec::new();
    let mut planned_bytes = 0u64;
    for mut candidate in candidates {
        if planned_bytes.saturating_add(candidate.bytes) > options.max_memory_bytes {
            skipped_files.push(SkippedFile {
                workspace_ref: candidate.source,
                reason: "max-memory cap reached before reading file".to_string(),
                bytes: candidate.bytes,
            });
            continue;
        }
        planned_bytes += candidate.bytes;
        candidate.index = jobs.len();
        jobs.push(candidate);
    }
    Ok((jobs, skipped_files, scanned_file_count))
}

pub fn extract_documents(options: &IngestOptions) -> Result<DocumentIngestReport> {
    let started = Instant::now();
    let root = options.root.canonicalize().with_context(|| {
        format!(
            "canonicalize document ingest root {}",
            options.root.display()
        )
    })?;
    let (jobs, mut skipped_files, scanned_file_count) = discover_document_jobs(&root, options)?;
    let mut facts = Vec::new();
    let mut parsed_file_count = 0usize;
    let mut parsed_bytes = 0u64;
    let mut generated_decision_count = 0usize;
    let mut format_counts = BTreeMap::new();

    for job in jobs {
        let text = match job.kind {
            DocumentKind::Pdf => match pdf_extract::extract_text(&job.path) {
                Ok(text) => text,
                Err(error) => {
                    skipped_files.push(SkippedFile {
                        workspace_ref: job.source,
                        reason: format!("pdf text extraction failed: {error}"),
                        bytes: job.bytes,
                    });
                    continue;
                }
            },
            DocumentKind::Markdown | DocumentKind::Text => match fs::read_to_string(&job.path) {
                Ok(text) => text,
                Err(error) => {
                    skipped_files.push(SkippedFile {
                        workspace_ref: job.source,
                        reason: format!("read document failed: {error}"),
                        bytes: job.bytes,
                    });
                    continue;
                }
            },
        };
        parsed_file_count += 1;
        parsed_bytes += job.bytes;
        *format_counts
            .entry(job.kind.name().to_string())
            .or_insert(0) += 1;
        let before = facts.len();
        let stats = parse_document_text(&job, &text, &mut facts);
        generated_decision_count += stats.decision_count;
        if facts.len() == before {
            push_doc_fact(
                &mut facts,
                doc_subject(&job.rel),
                "HAS_CONTENT",
                format!("empty {}", job.kind.name()),
                &job.source,
                "oaf.ingest:doc-empty; lines=0-0".to_string(),
                None,
            );
        }
    }

    facts.sort_by(|left, right| {
        left.subject
            .cmp(&right.subject)
            .then_with(|| left.predicate.cmp(&right.predicate))
            .then_with(|| left.object.cmp(&right.object))
            .then_with(|| left.source.cmp(&right.source))
    });
    facts.dedup_by(|left, right| {
        left.subject == right.subject
            && left.predicate == right.predicate
            && left.object == right.object
            && left.source == right.source
    });
    let generated_supersession_count = facts
        .iter()
        .filter(|fact| fact.supersedes.is_some())
        .count();
    Ok(DocumentIngestReport {
        scanned_file_count,
        parsed_file_count,
        skipped_file_count: skipped_files.len(),
        generated_fact_count: facts.len(),
        generated_decision_count,
        generated_supersession_count,
        parsed_bytes,
        elapsed_ms: started.elapsed().as_millis(),
        skipped_files,
        facts,
        format_counts,
    })
}

#[derive(Debug, Clone)]
struct DocumentJob {
    path: PathBuf,
    rel: String,
    source: String,
    kind: DocumentKind,
    bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DocumentKind {
    Markdown,
    Text,
    Pdf,
}

impl DocumentKind {
    fn name(self) -> &'static str {
        match self {
            DocumentKind::Markdown => "markdown",
            DocumentKind::Text => "text",
            DocumentKind::Pdf => "pdf",
        }
    }

    fn entity_kind(self, rel: &str) -> &'static str {
        if is_adr_source(rel) {
            "ADR"
        } else {
            match self {
                DocumentKind::Markdown | DocumentKind::Text => "Document",
                DocumentKind::Pdf => "PDF",
            }
        }
    }
}

#[derive(Default)]
struct DocumentParseStats {
    decision_count: usize,
}

fn discover_document_jobs(
    root: &Path,
    options: &IngestOptions,
) -> Result<(Vec<DocumentJob>, Vec<SkippedFile>, usize)> {
    let mut builder = WalkBuilder::new(root);
    builder
        .follow_links(false)
        .git_ignore(true)
        .git_exclude(true)
        .parents(true)
        .hidden(false)
        .filter_entry(should_descend);

    let mut candidates = Vec::new();
    let mut skipped_files = Vec::new();
    let mut scanned_file_count = 0usize;
    for entry in builder.build() {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                skipped_files.push(SkippedFile {
                    workspace_ref: "workspace://.".to_string(),
                    reason: format!("walk error: {error}"),
                    bytes: 0,
                });
                continue;
            }
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(kind) = document_kind_for_path(path) else {
            continue;
        };
        scanned_file_count += 1;
        let rel = workspace_rel(root, path)?;
        let source = format!("workspace://{rel}");
        if options
            .only_sources
            .as_ref()
            .is_some_and(|sources| !sources.contains(&source))
        {
            continue;
        }
        let metadata = fs::metadata(path).with_context(|| format!("stat {source}"))?;
        let bytes = metadata.len();
        if bytes > options.max_file_bytes {
            skipped_files.push(SkippedFile {
                workspace_ref: source,
                reason: "file exceeds max-file-bytes and was not truncated".to_string(),
                bytes,
            });
            continue;
        }
        let canonical = path
            .canonicalize()
            .with_context(|| format!("canonicalize {source}"))?;
        if !canonical.starts_with(root) {
            skipped_files.push(SkippedFile {
                workspace_ref: source,
                reason: "path resolves outside workspace root".to_string(),
                bytes,
            });
            continue;
        }
        candidates.push(DocumentJob {
            path: canonical,
            rel,
            source,
            kind,
            bytes,
        });
    }
    candidates.sort_by(|left, right| left.rel.cmp(&right.rel));
    let mut jobs = Vec::new();
    let mut planned_bytes = 0u64;
    for candidate in candidates {
        if planned_bytes.saturating_add(candidate.bytes) > options.max_memory_bytes {
            skipped_files.push(SkippedFile {
                workspace_ref: candidate.source,
                reason: "max-memory cap reached before reading file".to_string(),
                bytes: candidate.bytes,
            });
            continue;
        }
        planned_bytes += candidate.bytes;
        jobs.push(candidate);
    }
    Ok((jobs, skipped_files, scanned_file_count))
}

fn document_kind_for_path(path: &Path) -> Option<DocumentKind> {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "md" | "markdown" | "mdx" => Some(DocumentKind::Markdown),
        "txt" | "text" => Some(DocumentKind::Text),
        "pdf" => Some(DocumentKind::Pdf),
        _ => None,
    }
}

fn parse_document_text(
    job: &DocumentJob,
    text: &str,
    facts: &mut Vec<BatchFact>,
) -> DocumentParseStats {
    let doc = doc_subject(&job.rel);
    let mut stats = DocumentParseStats::default();
    push_doc_fact(
        facts,
        doc.clone(),
        "IS_A",
        job.kind.entity_kind(&job.rel).to_string(),
        &job.source,
        "oaf.ingest:doc-entity; lines=1-1".to_string(),
        None,
    );
    if is_adr_source(&job.rel) {
        let decision = decision_subject(&job.rel);
        stats.decision_count += 1;
        push_doc_fact(
            facts,
            decision.clone(),
            "IS_A",
            "Decision".to_string(),
            &job.source,
            "oaf.ingest:adr-decision; lines=1-1".to_string(),
            None,
        );
        push_doc_fact(
            facts,
            doc.clone(),
            "DEFINES",
            decision,
            &job.source,
            "oaf.ingest:adr-defines; lines=1-1".to_string(),
            None,
        );
    }

    let mut current_heading = String::new();
    let mut snippet_count = 0usize;
    let mut decision_heading_line = None;
    for (index, raw_line) in text.lines().enumerate() {
        let line_no = index + 1;
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(title) = markdown_heading(line) {
            current_heading = title.to_string();
            let section = format!("section:{}:{}", stable_token(&doc), stable_token(title));
            push_doc_fact(
                facts,
                section.clone(),
                "IS_A",
                "Section".to_string(),
                &job.source,
                format!("oaf.ingest:doc-section; lines={line_no}-{line_no}"),
                None,
            );
            if let Some(object) = safe_doc_object(title) {
                push_doc_fact(
                    facts,
                    section.clone(),
                    "HAS_TITLE",
                    object,
                    &job.source,
                    format!("oaf.ingest:doc-heading; lines={line_no}-{line_no}"),
                    None,
                );
            }
            push_doc_fact(
                facts,
                section,
                "PART_OF",
                doc.clone(),
                &job.source,
                format!("oaf.ingest:doc-section-parent; lines={line_no}-{line_no}"),
                None,
            );
            if is_decision_heading(title) {
                decision_heading_line = Some(line_no);
            }
            continue;
        }

        if is_adr_source(&job.rel) {
            parse_adr_line(job, line, line_no, decision_heading_line, facts, &mut stats);
        }

        if snippet_count < 64 {
            let cleaned = line
                .trim_start_matches(['-', '*', '+', '>', ' '])
                .trim_start_matches(|ch: char| ch.is_ascii_digit() || ch == '.')
                .trim();
            if cleaned.len() >= 12 {
                if let Some(object) = safe_doc_object(cleaned) {
                    let predicate = if current_heading.is_empty() {
                        "HAS_CONTENT"
                    } else {
                        "MENTIONS"
                    };
                    push_doc_fact(
                        facts,
                        doc.clone(),
                        predicate,
                        object,
                        &job.source,
                        format!("oaf.ingest:doc-snippet; lines={line_no}-{line_no}"),
                        None,
                    );
                    snippet_count += 1;
                }
            }
        }
    }
    stats
}

fn parse_adr_line(
    job: &DocumentJob,
    line: &str,
    line_no: usize,
    decision_heading_line: Option<usize>,
    facts: &mut Vec<BatchFact>,
    stats: &mut DocumentParseStats,
) {
    let decision = decision_subject(&job.rel);
    if let Some(value) = field_value(line, "status") {
        if let Some(object) = safe_doc_object(value) {
            push_doc_fact(
                facts,
                decision.clone(),
                "HAS_STATUS",
                object,
                &job.source,
                format!("oaf.ingest:adr-status; lines={line_no}-{line_no}"),
                None,
            );
        }
    }
    if let Some(value) = field_value(line, "decision") {
        if let Some(object) = safe_doc_object(value) {
            stats.decision_count += 1;
            push_doc_fact(
                facts,
                decision.clone(),
                "DECISION",
                object,
                &job.source,
                format!("oaf.ingest:adr-decision-text; lines={line_no}-{line_no}"),
                None,
            );
        }
    } else if decision_heading_line
        .is_some_and(|heading_line| line_no > heading_line && line_no <= heading_line + 6)
    {
        if let Some(object) = safe_doc_object(line) {
            stats.decision_count += 1;
            push_doc_fact(
                facts,
                decision.clone(),
                "DECISION",
                object,
                &job.source,
                format!("oaf.ingest:adr-decision-text; lines={line_no}-{line_no}"),
                None,
            );
        }
    }
    if let Some(value) = field_value(line, "supersedes").or_else(|| field_value(line, "replaces")) {
        for old in split_references(value) {
            add_decision_supersession(job, &decision, &old, line_no, facts);
        }
    } else if line.to_ascii_lowercase().contains("supersedes") {
        for old in split_references(line) {
            if normalize_decision_ref(&old) != decision {
                add_decision_supersession(job, &decision, &old, line_no, facts);
            }
        }
    }
}

fn add_decision_supersession(
    job: &DocumentJob,
    decision: &str,
    old: &str,
    line_no: usize,
    facts: &mut Vec<BatchFact>,
) {
    let old_decision = normalize_decision_ref(old);
    if old_decision == decision {
        return;
    }
    push_doc_fact(
        facts,
        decision.to_string(),
        "SUPERSEDES",
        old_decision.clone(),
        &job.source,
        format!("oaf.ingest:adr-supersedes; lines={line_no}-{line_no}"),
        None,
    );
    push_doc_fact(
        facts,
        old_decision.clone(),
        "HAS_STATUS",
        format!("retired_by_{}", stable_token(decision)),
        &job.source,
        format!("oaf.ingest:adr-retired; lines={line_no}-{line_no}"),
        Some(Supersedes {
            subject: old_decision,
            predicate: "HAS_STATUS".to_string(),
            object: None,
        }),
    );
}

fn markdown_heading(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    let level = trimmed.chars().take_while(|ch| *ch == '#').count();
    if (1..=6).contains(&level) && trimmed.chars().nth(level) == Some(' ') {
        Some(trimmed[level..].trim())
    } else {
        None
    }
}

fn field_value<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let trimmed = line
        .trim_start_matches(['-', '*', '+', ' '])
        .trim_start_matches(|ch: char| ch.is_ascii_digit() || ch == '.')
        .trim();
    let (left, right) = trimmed.split_once(':')?;
    if left.trim().eq_ignore_ascii_case(key) {
        Some(right.trim())
    } else {
        None
    }
}

fn split_references(value: &str) -> Vec<String> {
    value
        .split(|ch: char| ch == ',' || ch == ';' || ch.is_whitespace())
        .filter_map(|part| {
            let clean = part
                .trim_matches(|ch: char| {
                    !(ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == ':')
                })
                .trim();
            let lower = clean.to_ascii_lowercase();
            if clean.len() >= 3
                && lower != "supersedes"
                && lower != "replaces"
                && (lower.contains("adr")
                    || lower.contains("decision")
                    || clean.chars().any(|ch| ch.is_ascii_digit()))
            {
                Some(clean.to_string())
            } else {
                None
            }
        })
        .collect()
}

fn is_decision_heading(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower == "decision" || lower == "decisions" || lower.contains("decision")
}

fn is_adr_source(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    lower.contains("/adr/")
        || lower.starts_with("adr/")
        || lower.contains("decision")
        || lower.contains("/architecture/")
}

fn doc_subject(rel: &str) -> String {
    format!("doc:{}", stable_token(rel.trim_end_matches(".md")))
}

fn decision_subject(rel: &str) -> String {
    let stem = Path::new(rel)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(rel);
    normalize_decision_ref(stem)
}

fn normalize_decision_ref(value: &str) -> String {
    let clean = value
        .trim()
        .trim_start_matches("workspace://")
        .trim_end_matches(".md")
        .trim_end_matches(".markdown");
    let token = if clean.starts_with("decision:") {
        stable_token(clean.trim_start_matches("decision:"))
    } else {
        stable_token(clean)
    };
    format!("decision:{token}")
}

fn stable_token(value: &str) -> String {
    let mut out = String::new();
    let mut last_was_sep = false;
    for ch in value.chars() {
        let next = if ch.is_ascii_alphanumeric() {
            last_was_sep = false;
            Some(ch.to_ascii_lowercase())
        } else if !last_was_sep {
            last_was_sep = true;
            Some('_')
        } else {
            None
        };
        if let Some(ch) = next {
            out.push(ch);
        }
        if out.len() >= 80 {
            break;
        }
    }
    let out = out.trim_matches('_').to_string();
    if out.is_empty() {
        format!("item_{}", short_hash(value))
    } else {
        out
    }
}

fn safe_doc_object(value: &str) -> Option<String> {
    let mut out = String::new();
    let mut last_space = false;
    for ch in value
        .trim()
        .trim_matches(['`', '"', '\'', '*', '_', '[', ']'])
        .chars()
    {
        let allowed = ch.is_ascii_alphanumeric()
            || matches!(
                ch,
                ' ' | '_' | '.' | ':' | '/' | '=' | ',' | ';' | '(' | ')' | '\'' | '-'
            );
        if allowed {
            if ch.is_whitespace() {
                if !last_space {
                    out.push(' ');
                }
                last_space = true;
            } else {
                out.push(ch);
                last_space = false;
            }
        } else if !last_space {
            out.push(' ');
            last_space = true;
        }
        if out.len() >= 220 {
            break;
        }
    }
    let out = out
        .trim()
        .trim_end_matches(['.', ';', ':', ','])
        .trim()
        .to_string();
    if out
        .chars()
        .next()
        .is_some_and(|ch| ch.is_ascii_alphanumeric())
        && out.len() >= 2
    {
        Some(out)
    } else {
        None
    }
}

fn push_doc_fact(
    facts: &mut Vec<BatchFact>,
    subject: String,
    predicate: &str,
    object: String,
    source: &str,
    notes: String,
    supersedes: Option<Supersedes>,
) {
    facts.push(BatchFact {
        subject,
        predicate: predicate.to_string(),
        object,
        source: source.to_string(),
        source_trust: Some("verified".to_string()),
        confidence: Some("extracted".to_string()),
        notes: Some(notes),
        supersedes,
    });
}

fn scan_package_entries(root: &Path) -> Result<BTreeMap<String, String>> {
    let mut entries = BTreeMap::new();
    let mut builder = WalkBuilder::new(root);
    builder
        .follow_links(false)
        .git_ignore(true)
        .git_exclude(true)
        .parents(true)
        .hidden(false)
        .filter_entry(should_descend);

    for entry in builder.build() {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !is_manifest_name(name) {
            continue;
        }
        let metadata = fs::metadata(path).with_context(|| format!("stat {}", path.display()))?;
        if metadata.len() > DEFAULT_MAX_FILE_BYTES {
            continue;
        }
        let rel = workspace_rel(root, path)?;
        let source = fs::read_to_string(path).with_context(|| format!("read manifest {rel}"))?;
        parse_manifest_entries(name, &rel, &source, &mut entries);
    }
    Ok(entries)
}

fn is_manifest_name(name: &str) -> bool {
    matches!(
        name,
        "package.json" | "tsconfig.json" | "Cargo.toml" | "pyproject.toml" | "go.mod"
    )
}

fn parse_manifest_entries(
    name: &str,
    rel: &str,
    source: &str,
    entries: &mut BTreeMap<String, String>,
) {
    match name {
        "package.json" => parse_package_json_entries(rel, source, entries),
        "tsconfig.json" => parse_tsconfig_entries(rel, source, entries),
        "Cargo.toml" => parse_cargo_toml_entries(rel, source, entries),
        "pyproject.toml" => parse_pyproject_toml_entries(rel, source, entries),
        "go.mod" => parse_go_mod_entries(rel, source, entries),
        _ => {}
    }
}

fn parse_tsconfig_entries(rel: &str, source: &str, entries: &mut BTreeMap<String, String>) {
    let Ok(root) = serde_json::from_str::<Value>(source) else {
        return;
    };
    let Some(compiler_options) = root.get("compilerOptions") else {
        return;
    };
    let base_url = compiler_options
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or(".")
        .trim_matches('/');
    let Some(paths) = compiler_options.get("paths").and_then(Value::as_object) else {
        return;
    };
    let config_dir = rel.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    for (pattern, targets) in paths {
        let Some(target) = targets
            .as_array()
            .and_then(|items| items.first())
            .and_then(Value::as_str)
        else {
            continue;
        };
        let target = target.trim().trim_end_matches('*').trim_end_matches('/');
        let parts = [config_dir, base_url, target]
            .into_iter()
            .filter(|part| !part.is_empty() && *part != ".")
            .collect::<Vec<_>>();
        let stem = strip_known_extension(&parts.join("/")).to_string();
        insert_package_entry(entries, pattern, &stem);
    }
}

fn parse_package_json_entries(rel: &str, source: &str, entries: &mut BTreeMap<String, String>) {
    let Ok(root) = serde_json::from_str::<Value>(source) else {
        return;
    };
    let Some(name) = root.get("name").and_then(Value::as_str) else {
        return;
    };
    if name.trim().is_empty() {
        return;
    }
    let entry = root
        .get("exports")
        .and_then(|exports| exports.get("."))
        .and_then(package_export_entry)
        .or_else(|| root.get("main").and_then(Value::as_str))
        .or_else(|| root.get("module").and_then(Value::as_str))
        .unwrap_or("src/index.ts");
    if let Some(stem) = manifest_entry_stem(rel, entry) {
        insert_package_entry(entries, name, &stem);
    }
}

fn package_export_entry(value: &Value) -> Option<&str> {
    if let Some(text) = value.as_str() {
        return Some(text);
    }
    value
        .get("import")
        .and_then(Value::as_str)
        .or_else(|| value.get("default").and_then(Value::as_str))
        .or_else(|| value.get("require").and_then(Value::as_str))
}

fn parse_cargo_toml_entries(rel: &str, source: &str, entries: &mut BTreeMap<String, String>) {
    let Some(name) = toml_section_name(source, "[package]") else {
        return;
    };
    let Some(stem) = manifest_entry_stem(rel, "src/lib.rs") else {
        return;
    };
    insert_package_entry(entries, &name, &stem);
    insert_package_entry(entries, &name.replace('-', "_"), &stem);
}

fn parse_pyproject_toml_entries(rel: &str, source: &str, entries: &mut BTreeMap<String, String>) {
    let Some(name) = toml_section_name(source, "[project]") else {
        return;
    };
    let normalized = name.replace('-', "_");
    let Some(stem) = manifest_entry_stem(rel, &format!("src/{normalized}")) else {
        return;
    };
    insert_package_entry(entries, &normalized, &stem);
}

fn parse_go_mod_entries(rel: &str, source: &str, entries: &mut BTreeMap<String, String>) {
    let Some(module_path) = source
        .lines()
        .find_map(|line| line.trim().strip_prefix("module "))
    else {
        return;
    };
    let dir = rel.rsplit_once('/').map(|(dir, _)| dir).unwrap_or(".");
    insert_package_entry(
        entries,
        module_path.split_whitespace().next().unwrap_or(""),
        dir,
    );
}

fn toml_section_name(source: &str, section: &str) -> Option<String> {
    let mut in_section = false;
    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_section = trimmed == section;
            continue;
        }
        if !in_section {
            continue;
        }
        let Some(value) = trimmed
            .strip_prefix("name")
            .and_then(|rest| rest.trim_start().strip_prefix('='))
        else {
            continue;
        };
        return quoted_value(value.trim()).map(str::to_string);
    }
    None
}

fn quoted_value(value: &str) -> Option<&str> {
    let quote = value.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let rest = &value[quote.len_utf8()..];
    rest.find(quote).map(|index| &rest[..index])
}

fn manifest_entry_stem(rel: &str, entry: &str) -> Option<String> {
    let dir = rel.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    let entry = entry.trim().trim_start_matches("./");
    let joined = if dir.is_empty() {
        entry.to_string()
    } else {
        format!("{dir}/{entry}")
    };
    Some(strip_known_extension(&joined).to_string())
}

fn insert_package_entry(entries: &mut BTreeMap<String, String>, name: &str, stem: &str) {
    let key = name.trim();
    if key.is_empty() || stem.trim().is_empty() {
        return;
    }
    entries
        .entry(key.to_string())
        .or_insert_with(|| stem.trim_matches('/').to_string());
}

fn parse_jobs(jobs: Vec<FileJob>, worker_count: usize) -> Result<Vec<FileParse>> {
    if worker_count <= 1 {
        return jobs.into_iter().map(parse_file_job).collect();
    }

    let total_jobs = jobs.len();
    let mut scheduled = jobs;
    scheduled.sort_by(|left, right| {
        right
            .bytes
            .cmp(&left.bytes)
            .then_with(|| left.rel.cmp(&right.rel))
    });
    let queue = Arc::new(scheduled);
    let next_job = Arc::new(AtomicUsize::new(0));
    let (tx, rx) = mpsc::channel();
    let mut handles = Vec::new();
    for _ in 0..worker_count.max(1) {
        let queue = Arc::clone(&queue);
        let next_job = Arc::clone(&next_job);
        let tx = tx.clone();
        handles.push(thread::spawn(move || loop {
            let index = next_job.fetch_add(1, Ordering::Relaxed);
            if index >= queue.len() {
                break;
            }
            let job = queue[index].clone();
            if tx.send(parse_file_job(job)).is_err() {
                break;
            }
        }));
    }
    drop(tx);

    let mut parsed = Vec::with_capacity(total_jobs);
    let mut first_error = None;
    for result in rx {
        match result {
            Ok(file) => parsed.push(file),
            Err(error) if first_error.is_none() => first_error = Some(error),
            Err(_) => {}
        }
    }
    for handle in handles {
        handle
            .join()
            .map_err(|_| anyhow::anyhow!("ingest worker panicked"))?;
    }
    if let Some(error) = first_error {
        return Err(error);
    }
    if parsed.len() != total_jobs {
        bail!("ingest worker pool returned incomplete parse results");
    }
    parsed.sort_by_key(|file| file.index);
    Ok(parsed)
}

fn parse_file_job(job: FileJob) -> Result<FileParse> {
    let bytes = fs::read(&job.path).with_context(|| format!("read {}", job.source))?;
    let bytes_read = bytes.len() as u64;
    let mut parser = Parser::new();
    parser
        .set_language(&job.lang.language())
        .with_context(|| format!("load parser for {}", job.source))?;
    let tree = parser
        .parse(&bytes, None)
        .with_context(|| format!("parse {}", job.source))?;
    let recovered = tree.root_node().has_error().then(|| RecoveredFile {
        workspace_ref: job.source.clone(),
        reason: "tree-sitter recovered syntax error".to_string(),
        bytes: job.bytes,
    });

    let mut parsed = ParsedRepo::new();
    let file_id = format!("file:{}", path_token(&job.rel));
    let module = format!("module:{}", module_token(&job.rel));
    let file_span = CodeSpan::from_node(tree.root_node());
    parsed.add_entity_at(
        file_id.clone(),
        "File",
        &job.source,
        "oaf.ingest:file",
        file_span,
    );
    parsed.add_entity_at(
        module.clone(),
        "Module",
        &job.source,
        "oaf.ingest:module",
        file_span,
    );
    parsed.add_definition_at(
        &file_id,
        &module,
        &job.source,
        "oaf.ingest:file-defines-module",
        file_span,
    );
    let container = declared_container(tree.root_node(), &bytes, job.lang);
    if let Some(container) = container.as_ref() {
        parsed.add_entity_at(
            container.subject.clone(),
            container.kind,
            &job.source,
            "oaf.ingest:container",
            container.span,
        );
        parsed.add_definition_at(
            &module,
            &container.subject,
            &job.source,
            "oaf.ingest:define-container",
            container.span,
        );
        parsed.add_symbol_name(&container.name, &container.subject);
    }
    let context = WalkContext {
        module,
        source: job.source,
        lang: job.lang,
        container_name: container.as_ref().map(|value| value.name.clone()),
        class_name: None,
        owner_subject: container.map(|value| value.subject),
        route_prefix: None,
        impl_name: None,
        caller: None,
        type_bindings: BTreeMap::new(),
        suppress_calls: false,
    };
    walk_node(tree.root_node(), &bytes, &context, &mut parsed);
    Ok(FileParse {
        index: job.index,
        lang: job.lang,
        bytes_read,
        parsed: Some(parsed),
        skipped: None,
        recovered,
    })
}

fn extract_file_fingerprints(job: FileJob) -> Result<Vec<CodeFingerprint>> {
    let bytes = fs::read(&job.path).with_context(|| format!("read {}", job.source))?;
    let mut parser = Parser::new();
    parser
        .set_language(&job.lang.language())
        .with_context(|| format!("load parser for {}", job.source))?;
    let tree = parser
        .parse(&bytes, None)
        .with_context(|| format!("parse {}", job.source))?;
    let module = format!("module:{}", module_token(&job.rel));
    let container = declared_container(tree.root_node(), &bytes, job.lang);
    let context = WalkContext {
        module,
        source: job.source,
        lang: job.lang,
        container_name: container.as_ref().map(|value| value.name.clone()),
        class_name: None,
        owner_subject: container.map(|value| value.subject),
        route_prefix: None,
        impl_name: None,
        caller: None,
        type_bindings: BTreeMap::new(),
        suppress_calls: false,
    };
    let mut out = Vec::new();
    walk_fingerprint_nodes(tree.root_node(), &bytes, &context, &mut out);
    Ok(out)
}

fn walk_fingerprint_nodes(
    node: Node<'_>,
    source: &[u8],
    context: &WalkContext,
    out: &mut Vec<CodeFingerprint>,
) {
    let mut next = context.clone();
    apply_scoped_namespace(node, source, context, &mut next, None);
    if let Some((name, subject, _, _)) = type_declaration(node, source, context.lang) {
        let (name, subject) = qualified_type_identity(name, subject, context);
        next.class_name = Some(name);
        next.owner_subject = Some(subject);
    }
    if context.lang == LangKind::Rust && node.kind() == "impl_item" {
        next.impl_name = rust_impl_name(node, source);
    }
    if let Some((_name, subject, _kind)) = callable_definition(node, source, context) {
        if let Some((minhash, token_count, feature_count)) = code_minhash(node) {
            out.push(CodeFingerprint {
                subject,
                source: context.source.clone(),
                language: context.lang.group().to_string(),
                minhash,
                token_count,
                feature_count,
            });
        }
    }
    for index in 0..node.named_child_count() {
        if let Some(child) = node.named_child(index) {
            walk_fingerprint_nodes(child, source, &next, out);
        }
    }
}

fn code_minhash(node: Node<'_>) -> Option<([u64; CODE_MINHASH_K], usize, usize)> {
    let mut tokens = Vec::new();
    collect_leaf_tokens(node, &mut tokens);
    if tokens.len() < 30 {
        return None;
    }
    let mut features = BTreeSet::new();
    for window in tokens.windows(3) {
        let weight = window
            .iter()
            .filter(|token| !matches!(token.as_str(), "I" | "S" | "N" | "T"))
            .count();
        if weight == 0 {
            continue;
        }
        features.insert(format!("{}|{}|{}", window[0], window[1], window[2]));
    }
    if features.len() < 16 {
        return None;
    }
    let mut signature = [u64::MAX; CODE_MINHASH_K];
    for feature in &features {
        for (index, slot) in signature.iter_mut().enumerate() {
            *slot = (*slot).min(stable_hash64(&[feature, &format!("code-minhash:{index}")]));
        }
    }
    Some((signature, tokens.len(), features.len()))
}

fn collect_leaf_tokens(node: Node<'_>, out: &mut Vec<String>) {
    if node.child_count() == 0 {
        let kind = normalize_node_kind(node.kind());
        if !kind.is_empty() {
            out.push(kind.to_string());
        }
        return;
    }
    for index in 0..node.child_count() {
        if let Some(child) = node.child(index) {
            collect_leaf_tokens(child, out);
        }
    }
}

fn normalize_node_kind(kind: &str) -> &str {
    match kind {
        "identifier"
        | "field_identifier"
        | "property_identifier"
        | "type_identifier"
        | "shorthand_property_identifier"
        | "shorthand_field_identifier"
        | "variable_name"
        | "name" => "I",
        "string"
        | "string_literal"
        | "interpreted_string_literal"
        | "raw_string_literal"
        | "template_string"
        | "string_content"
        | "escape_sequence" => "S",
        "number" | "integer" | "float" | "integer_literal" | "float_literal" | "int_literal"
        | "number_literal" => "N",
        "predefined_type" | "primitive_type" | "builtin_type" | "type_annotation"
        | "simple_type" => "T",
        other => other,
    }
}

fn effective_worker_count(
    requested: usize,
    max_memory_bytes: u64,
    cgroup_memory_limit_bytes: Option<u64>,
) -> usize {
    let available = thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .max(1);
    let memory_limit = cgroup_memory_limit_bytes
        .map(|limit| limit.min(max_memory_bytes))
        .unwrap_or(max_memory_bytes);
    let memory_workers = (memory_limit / PER_WORKER_MEMORY_BYTES).max(1) as usize;
    requested.max(1).min(available).min(memory_workers).max(1)
}

fn cgroup_memory_limit_bytes() -> Option<u64> {
    read_cgroup_limit("/sys/fs/cgroup/memory.max")
        .or_else(|| read_cgroup_limit("/sys/fs/cgroup/memory/memory.limit_in_bytes"))
}

fn read_cgroup_limit(path: &str) -> Option<u64> {
    let raw = fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "max" {
        return None;
    }
    let value = trimmed.parse::<u64>().ok()?;
    (value < (1u64 << 60)).then_some(value)
}

fn walk_node(node: Node<'_>, source: &[u8], context: &WalkContext, parsed: &mut ParsedRepo) {
    let mut suppress_child_calls = false;
    if node.kind() == "variable_declarator"
        && matches!(
            context.lang,
            LangKind::JavaScript | LangKind::TypeScript | LangKind::Tsx
        )
    {
        if let Some((alias, target)) = commonjs_require_member_binding(node, source, context) {
            parsed.add_symbol_alias(&context.source, &alias, &target);
        }
    }
    if context.lang == LangKind::Go && node.kind() == "composite_literal" {
        if let (Some(caller), Some(type_name)) = (
            context.caller.as_deref(),
            node.child_by_field_name("type")
                .and_then(|type_node| heritage_target_name(type_node, source)),
        ) {
            parsed.constructs.push(ConstructRef {
                caller: caller.to_string(),
                type_name,
                source: context.source.clone(),
                span: CodeSpan::from_node(node),
            });
        }
    }
    if matches!(node.kind(), "new_expression" | "object_creation_expression") {
        if let Some(caller) = context.caller.as_deref() {
            if let Some(type_name) = constructor_callee(node, source) {
                parsed.constructs.push(ConstructRef {
                    caller: caller.to_string(),
                    type_name,
                    source: context.source.clone(),
                    span: CodeSpan::from_node(node),
                });
            }
        }
    }
    if context.lang == LangKind::Ruby && node.kind() == "call" {
        if let (Some(caller), Some(type_name)) = (
            context.caller.as_deref(),
            ruby_constructor_type(node, source),
        ) {
            parsed.constructs.push(ConstructRef {
                caller: caller.to_string(),
                type_name,
                source: context.source.clone(),
                span: CodeSpan::from_node(node),
            });
            suppress_child_calls = true;
        }
    }

    if matches!(
        node.kind(),
        "call_expression"
            | "call"
            | "method_invocation"
            | "function_call"
            | "function_call_expression"
            | "member_call_expression"
            | "nullsafe_member_call_expression"
            | "scoped_call_expression"
            | "invocation"
            | "invocation_expression"
            | "message_expression"
            | "command"
    ) && !is_transparent_kotlin_dsl_call(node, source, context.lang)
    {
        if matches!(
            context.lang,
            LangKind::JavaScript | LangKind::TypeScript | LangKind::Tsx
        ) && callee_name(node, source).as_deref() == Some("require")
        {
            for raw in quoted_literals(node_text(node, source)) {
                if let Some(target) = import_target_from_raw(&raw) {
                    parsed.add_import(
                        &context.module,
                        target,
                        &context.source,
                        CodeSpan::from_node(node),
                    );
                }
            }
        }
        let ruby_import = (context.lang == LangKind::Ruby)
            .then(|| callee_name(node, source))
            .flatten()
            .filter(|name| matches!(name.as_str(), "require" | "require_relative"));
        if let Some(import_call) = ruby_import {
            for raw in quoted_literals(node_text(node, source)) {
                let raw = if import_call == "require_relative" {
                    format!("./{raw}")
                } else {
                    raw
                };
                if let Some(target) = import_target_from_raw(&raw) {
                    parsed.add_import(
                        &context.module,
                        target,
                        &context.source,
                        CodeSpan::from_node(node),
                    );
                }
            }
        }
        if let Some(framework) = node_http_server(node, source, context) {
            parsed.frameworks.push(framework);
        }
        let is_flutter_entry = context.lang == LangKind::Dart
            && context.caller.as_deref() == Some("function:main")
            && callee_name(node, source).as_deref() == Some("runApp");
        if is_flutter_entry {
            let component = "framework:flutter_application".to_string();
            let span = CodeSpan::from_node(node);
            parsed.add_entity_at(
                component.clone(),
                "FrameworkComponent",
                &context.source,
                "oaf.ingest:flutter-entry",
                span,
            );
            parsed.add_fact_at(
                "function:main".to_string(),
                "ENTRY_POINT",
                component,
                &context.source,
                "oaf.ingest:flutter-entry",
                span,
            );
        }
        let route = route_registration(node, source, context);
        let is_route_registration = route.is_some();
        if let Some(route) = route {
            parsed.routes.push(route);
            suppress_child_calls = true;
        }
        let ruby_mixin_target = (context.lang == LangKind::Ruby && context.class_name.is_some())
            .then(|| ruby_mixin_target(node_text(node, source)))
            .flatten();
        let ruby_mixin = ruby_mixin_target.is_some();
        if let Some(target_name) = ruby_mixin_target {
            if let Some(subject) = context.owner_subject.as_deref() {
                parsed.heritage.push(HeritageRef {
                    subject: subject.to_string(),
                    predicate: "MIXES_IN",
                    target_name,
                    source: context.source.clone(),
                    span: CodeSpan::from_node(node),
                });
            }
        }
        if !suppress_child_calls
            && !is_route_registration
            && !is_flutter_entry
            && !ruby_mixin
            && !context.suppress_calls
        {
            if let Some(caller) = context.caller.as_deref() {
                if let Some(callee) = callee_name(node, source) {
                    if !is_declaration_signature_call(node, context.lang, caller, &callee) {
                        if let Some(type_name) = rust_associated_constructor(node, source, context)
                        {
                            parsed.constructs.push(ConstructRef {
                                caller: caller.to_string(),
                                type_name,
                                source: context.source.clone(),
                                span: CodeSpan::from_node(node),
                            });
                        } else if matches!(
                            context.lang,
                            LangKind::Python
                                | LangKind::Kotlin
                                | LangKind::Cpp
                                | LangKind::Swift
                                | LangKind::Dart
                        ) && looks_like_type_name(&callee)
                        {
                            parsed.constructs.push(ConstructRef {
                                caller: caller.to_string(),
                                type_name: callee,
                                source: context.source.clone(),
                                span: CodeSpan::from_node(node),
                            });
                        } else {
                            let typed_target = typed_call_target(node, source, context);
                            let member_access = (node.kind() == "method_invocation"
                                && node.child_by_field_name("object").is_some())
                                || node
                                    .child_by_field_name("function")
                                    .or_else(|| node.named_child(0))
                                    .is_some_and(|function| {
                                        receiver_method(node_text(function, source)).is_some()
                                    });
                            parsed.add_call_with_hint(
                                caller,
                                &callee,
                                typed_target,
                                !member_access,
                                &context.source,
                                CodeSpan::from_node(node),
                            );
                        }
                    }
                }
            }
        }
    }

    if is_import_node(node.kind())
        && !(context.lang == LangKind::Php
            && node.kind() == "use_declaration"
            && context.class_name.is_some())
    {
        if context.lang == LangKind::Php {
            if let Some((alias, target)) = php_use_alias(node_text(node, source)) {
                parsed.add_symbol_alias(&context.source, &alias, &target);
            }
        }
        for target in import_targets(node, source, context.lang) {
            let owner = if context.lang == LangKind::Dart {
                context.owner_subject.as_deref().unwrap_or(&context.module)
            } else {
                &context.module
            };
            parsed.add_import(owner, target, &context.source, CodeSpan::from_node(node));
        }
    }

    if context.lang == LangKind::Php
        && node.kind() == "use_declaration"
        && context.class_name.is_some()
    {
        if let Some(subject) = context.owner_subject.as_deref() {
            for target_name in php_trait_use_targets(node_text(node, source)) {
                parsed.heritage.push(HeritageRef {
                    subject: subject.to_string(),
                    predicate: "MIXES_IN",
                    target_name,
                    source: context.source.clone(),
                    span: CodeSpan::from_node(node),
                });
            }
        }
    }

    if context.lang == LangKind::Dart && node.kind() == "library_export" {
        for raw in quoted_literals(node_text(node, source)) {
            if let Some(target) = import_target_from_raw(&raw) {
                let owner = context.owner_subject.as_deref().unwrap_or(&context.module);
                parsed.add_re_export(owner, target, &context.source, CodeSpan::from_node(node));
            }
        }
    }

    if context.lang == LangKind::Dart && node.kind() == "part_directive" {
        for raw in quoted_literals(node_text(node, source)) {
            if let Some(target) = import_target_from_raw(&raw) {
                parsed.add_part(
                    &context.module,
                    target,
                    &context.source,
                    CodeSpan::from_node(node),
                );
            }
        }
    }

    if node.kind() == "export_statement" {
        if let Some(source_node) = node.child_by_field_name("source") {
            for raw in quoted_literals(node_text(source_node, source)) {
                if let Some(target) = import_target_from_raw(&raw) {
                    parsed.add_re_export(
                        &context.module,
                        target,
                        &context.source,
                        CodeSpan::from_node(node),
                    );
                }
            }
        } else {
            for target in exported_subjects(node, source, context) {
                parsed.exports.push(ExportRef {
                    owner: context.module.clone(),
                    target,
                    source: context.source.clone(),
                    span: CodeSpan::from_node(node),
                });
            }
        }
    }
    if let Some(target) = commonjs_assignment_export(node, source, context.lang) {
        parsed.exports.push(ExportRef {
            owner: context.module.clone(),
            target,
            source: context.source.clone(),
            span: CodeSpan::from_node(node),
        });
    }

    let mut next = context.clone();
    if suppress_child_calls {
        next.suppress_calls = true;
    }
    apply_scoped_namespace(node, source, context, &mut next, Some(parsed));
    if let Some((simple_type_name, type_id, type_kind, establishes_owner)) =
        type_declaration(node, source, context.lang)
    {
        let (type_name, type_id) =
            qualified_type_identity(simple_type_name.clone(), type_id, context);
        let definition_owner = context
            .caller
            .as_deref()
            .or(context.owner_subject.as_deref())
            .unwrap_or(&context.module);
        parsed.add_entity_at(
            type_id.clone(),
            type_kind,
            &context.source,
            "oaf.ingest:type",
            CodeSpan::from_node(node),
        );
        parsed.add_definition_at(
            definition_owner,
            &type_id,
            &context.source,
            "oaf.ingest:define-type",
            CodeSpan::from_node(node),
        );
        parsed.add_symbol_name(&simple_type_name, &type_id);
        if type_name != simple_type_name {
            parsed.add_symbol_name(&type_name, &type_id);
        }
        if let Some(container_name) = context.container_name.as_deref() {
            let relative = context
                .source
                .strip_prefix("workspace://")
                .unwrap_or(&context.source);
            parsed.package_entries.insert(
                format!("{container_name}.{simple_type_name}"),
                strip_known_extension(relative).to_string(),
            );
        }
        for (predicate, target_name) in heritage_targets(node, source, context.lang) {
            parsed.heritage.push(HeritageRef {
                subject: type_id.clone(),
                predicate,
                target_name,
                source: context.source.clone(),
                span: CodeSpan::from_node(node),
            });
        }
        if establishes_owner {
            next.class_name = Some(type_name);
            next.owner_subject = Some(type_id);
            next.type_bindings
                .extend(batch_c_type_bindings(node, source, context.lang));
            if matches!(context.lang, LangKind::Java | LangKind::CSharp) {
                next.route_prefix = controller_route_prefix(node_text(node, source), context.lang);
            }
            if matches!(
                context.lang,
                LangKind::JavaScript | LangKind::TypeScript | LangKind::Tsx
            ) {
                let controller_text = node
                    .parent()
                    .filter(|parent| parent.kind() == "export_statement")
                    .map(|parent| node_text(parent, source))
                    .unwrap_or_else(|| node_text(node, source));
                next.route_prefix = nest_controller_prefix(controller_text);
            }
        }
    }

    if context.lang == LangKind::Rust && node.kind() == "impl_item" {
        next.impl_name = rust_impl_name(node, source);
        if let (Some(type_node), Some(trait_node)) = (
            node.child_by_field_name("type"),
            node.child_by_field_name("trait"),
        ) {
            if let (Some(type_name), Some(trait_name)) = (
                heritage_target_name(type_node, source),
                heritage_target_name(trait_node, source),
            ) {
                parsed.heritage.push(HeritageRef {
                    subject: type_name,
                    predicate: "IMPLEMENTS",
                    target_name: trait_name,
                    source: context.source.clone(),
                    span: CodeSpan::from_node(node),
                });
            }
        }
    }

    if let Some((name, subject, kind)) = callable_definition(node, source, context) {
        let fallback_owner = context
            .caller
            .as_deref()
            .or(context.owner_subject.as_deref())
            .unwrap_or(&context.module);
        parsed.add_entity_at(
            subject.clone(),
            kind,
            &context.source,
            "oaf.ingest:callable",
            CodeSpan::from_node(node),
        );
        let receiver_owner = if context.lang == LangKind::Go && subject.starts_with("method:") {
            go_receiver_name(node_text(node, source))
        } else if context.lang == LangKind::Rust && subject.starts_with("method:") {
            context.impl_name.clone()
        } else if context.lang == LangKind::Cpp && subject.starts_with("method:") {
            cpp_callable_owner(node, source, context)
                .and_then(|owner| owner.rsplit('.').next().map(str::to_string))
        } else {
            None
        };
        if let Some(owner_name) = receiver_owner {
            parsed.add_deferred_definition_at(
                &owner_name,
                fallback_owner,
                &subject,
                &context.source,
                "oaf.ingest:define-callable",
                CodeSpan::from_node(node),
            );
        } else {
            parsed.add_definition_at(
                fallback_owner,
                &subject,
                &context.source,
                "oaf.ingest:define-callable",
                CodeSpan::from_node(node),
            );
        }
        parsed.add_symbol_name(&name, &subject);
        if let Some((_, method)) = javascript_member_assigned_function(node, source) {
            parsed.add_symbol_name(&method, &subject);
        }
        if let Some(bare) =
            callable_node_name(node, source, context).and_then(|value| sanitize_symbol(&value))
        {
            if bare != name {
                parsed.add_symbol_name(&bare, &subject);
            }
            if subject.starts_with("method:") {
                if let Some(owner) = context.class_name.as_deref() {
                    let simple_owner = owner.rsplit('.').next().unwrap_or(owner);
                    parsed.add_symbol_name(&format!("{simple_owner}_{bare}"), &subject);
                }
            }
        }
        for alias in batch_c_callable_aliases(&subject) {
            parsed.add_symbol_name(&alias, &subject);
        }
        if let Some(receiver) = extension_receiver_type(node, source, context.lang) {
            if let Some(callable) =
                callable_node_name(node, source, context).and_then(|value| sanitize_symbol(&value))
            {
                parsed.add_symbol_name(&format!("{receiver}_{callable}"), &subject);
            }
        }
        if node.kind() == "assignment_expression"
            && matches!(
                context.lang,
                LangKind::JavaScript | LangKind::TypeScript | LangKind::Tsx
            )
            && commonjs_exported_function(node, source, context).is_some()
        {
            parsed.exports.push(ExportRef {
                owner: context.module.clone(),
                target: subject.clone(),
                source: context.source.clone(),
                span: CodeSpan::from_node(node),
            });
        }
        next.caller = Some(subject);
        next.type_bindings = local_type_bindings(node, source, context);
        next.suppress_calls = false;
        if let Some(route) = callable_route(node, source, context, &next.caller.clone().unwrap()) {
            parsed.routes.push(route);
        }
    }

    for index in 0..node.named_child_count() {
        if let Some(child) = node.named_child(index) {
            walk_node(child, source, &next, parsed);
        }
    }
}

fn commonjs_exported_function(
    node: Node<'_>,
    source: &[u8],
    context: &WalkContext,
) -> Option<String> {
    let left = node.child_by_field_name("left")?;
    let right = node.child_by_field_name("right")?;
    if !matches!(right.kind(), "function_expression" | "function") {
        return None;
    }
    let export_name = node_text(left, source)
        .strip_prefix("exports.")
        .or_else(|| node_text(left, source).strip_prefix("module.exports."))
        .and_then(sanitize_symbol)?;
    let function_name = right
        .child_by_field_name("name")
        .map(|name| node_text(name, source))
        .and_then(sanitize_symbol)?;
    if function_name != export_name {
        return None;
    }
    let module_name = context.module.strip_prefix("module:")?;
    Some(format!("{module_name}.{export_name}"))
}

fn commonjs_assignment_export(node: Node<'_>, source: &[u8], lang: LangKind) -> Option<String> {
    if node.kind() != "assignment_expression"
        || !matches!(lang, LangKind::JavaScript | LangKind::TypeScript | LangKind::Tsx)
        || node
            .child_by_field_name("left")
            .is_none_or(|left| node_text(left, source) != "module.exports")
    {
        return None;
    }
    let right = node.child_by_field_name("right")?;
    if right.kind() != "identifier" {
        return None;
    }
    sanitize_symbol(node_text(right, source))
}

fn javascript_member_assigned_function(node: Node<'_>, source: &[u8]) -> Option<(String, String)> {
    let left = node.child_by_field_name("left")?;
    let right = node.child_by_field_name("right")?;
    if !matches!(
        right.kind(),
        "function_expression" | "function" | "arrow_function"
    ) {
        return None;
    }
    let left = node_text(left, source);
    if left.starts_with("exports.") || left.starts_with("module.exports.") {
        return None;
    }
    let (receiver, method) = receiver_method(left)?;
    Some((format!("{receiver}_{method}"), method))
}

fn commonjs_require_member_binding(
    node: Node<'_>,
    source: &[u8],
    context: &WalkContext,
) -> Option<(String, String)> {
    let alias = node
        .child_by_field_name("name")
        .map(|name| node_text(name, source))
        .and_then(sanitize_symbol)?;
    let value = node.child_by_field_name("value")?;
    if value.kind() != "member_expression" {
        return None;
    }
    let require_call = value.child_by_field_name("object")?;
    if require_call.kind() != "call_expression"
        || callee_name(require_call, source).as_deref() != Some("require")
    {
        return None;
    }
    let raw = quoted_literals(node_text(require_call, source))
        .into_iter()
        .next()?;
    if !raw.starts_with('.') {
        return None;
    }
    let member = value
        .child_by_field_name("property")
        .map(|property| node_text(property, source))
        .and_then(sanitize_symbol)?;
    let source_rel = context
        .source
        .strip_prefix("workspace://")
        .unwrap_or(&context.source);
    let target_module = resolve_relative_import(source_rel, &raw)?;
    Some((
        alias,
        format!("{}.{}", module_token(&target_module), member),
    ))
}

fn apply_scoped_namespace(
    node: Node<'_>,
    source: &[u8],
    context: &WalkContext,
    next: &mut WalkContext,
    mut parsed: Option<&mut ParsedRepo>,
) {
    let scoped_namespace = matches!(
        (context.lang, node.kind()),
        (LangKind::Cpp, "namespace_definition") | (LangKind::Ruby, "module")
    );
    if !scoped_namespace {
        return;
    }
    let Some(simple_name) = node
        .child_by_field_name("name")
        .map(|child| node_text(child, source))
        .and_then(sanitize_symbol)
    else {
        return;
    };
    let name = context
        .container_name
        .as_deref()
        .map(|parent| format!("{parent}.{simple_name}"))
        .unwrap_or(simple_name);
    let subject = format!("namespace:{name}");
    if let Some(parsed) = parsed.as_mut() {
        let owner = context.owner_subject.as_deref().unwrap_or(&context.module);
        parsed.add_entity_at(
            subject.clone(),
            "Namespace",
            &context.source,
            "oaf.ingest:namespace",
            CodeSpan::from_node(node),
        );
        parsed.add_definition_at(
            owner,
            &subject,
            &context.source,
            "oaf.ingest:define-namespace",
            CodeSpan::from_node(node),
        );
        parsed.add_symbol_name(&name, &subject);
        if let Some(simple) = name.rsplit('.').next() {
            parsed.add_symbol_name(simple, &subject);
        }
    }
    next.container_name = Some(name);
    next.owner_subject = Some(subject);
}

fn is_declaration_signature_call(
    node: Node<'_>,
    lang: LangKind,
    caller: &str,
    callee: &str,
) -> bool {
    lang == LangKind::Julia
        && node.kind() == "call_expression"
        && caller.strip_prefix("function:") == Some(callee)
}

fn is_type_subject(subject: &str) -> bool {
    matches!(
        subject.split_once(':').map(|(kind, _)| kind),
        Some(
            "class"
                | "interface"
                | "struct"
                | "enum"
                | "trait"
                | "protocol"
                | "mixin"
                | "extension"
                | "type_alias"
        )
    )
}

fn callable_definition(
    node: Node<'_>,
    source: &[u8],
    context: &WalkContext,
) -> Option<(String, String, &'static str)> {
    let kind = node.kind();
    if context.lang == LangKind::R && kind == "function_definition" {
        return None;
    }
    match kind {
        "function_declaration"
        | "function_definition"
        | "function_item"
        | "create_function"
        | "method"
        | "singleton_method"
        | "field_declaration" => {
            if context.lang == LangKind::Ruby && kind == "method" && node.named_child_count() == 0 {
                return None;
            }
            if kind == "field_declaration"
                && (context.lang != LangKind::Cpp
                    || !descendant_has_kind(node, "function_declarator"))
            {
                return None;
            }
            let name = callable_node_name(node, source, context)?;
            let sanitized = sanitize_symbol(&name)?;
            if context.caller.is_none()
                && matches!(
                    context.lang,
                    LangKind::Java
                        | LangKind::Kotlin
                        | LangKind::CSharp
                        | LangKind::Cpp
                        | LangKind::Swift
                        | LangKind::Dart
                )
            {
                let signature = callable_parameter_signature(node, source, context.lang);
                let callable = if context.lang == LangKind::Cpp
                    && context
                        .class_name
                        .as_deref()
                        .is_some_and(|owner| owner.rsplit('.').next() == Some(sanitized.as_str()))
                {
                    "new"
                } else {
                    &sanitized
                };
                if let Some(owner) =
                    cpp_callable_owner(node, source, context).or_else(|| context.class_name.clone())
                {
                    let qualified = format!("{owner}.{callable}{signature}");
                    return Some((qualified.clone(), format!("method:{qualified}"), "Method"));
                }
                if let Some(container) = context.container_name.as_deref() {
                    let qualified = format!("{container}.{callable}{signature}");
                    return Some((
                        qualified.clone(),
                        format!("function:{qualified}"),
                        "Function",
                    ));
                }
            }
            if let Some(caller) = context.caller.as_deref() {
                let owner = caller.split_once(':').map_or(caller, |(_, value)| value);
                let nested_name = format!("{owner}_{sanitized}");
                return Some((
                    nested_name.clone(),
                    format!("function:{nested_name}"),
                    "Function",
                ));
            }
            if context.lang == LangKind::Rust && context.impl_name.is_some() {
                let impl_name = context.impl_name.as_deref().unwrap();
                let method_name = format!("{impl_name}_{sanitized}");
                return Some((
                    method_name.clone(),
                    format!("method:{method_name}"),
                    "Method",
                ));
            }
            if context.class_name.is_some()
                && matches!(
                    context.lang,
                    LangKind::Python
                        | LangKind::Cpp
                        | LangKind::Php
                        | LangKind::Ruby
                        | LangKind::Swift
                        | LangKind::Kotlin
                        | LangKind::Lua
                        | LangKind::Scala
                        | LangKind::Zig
                )
            {
                let class_name = context.class_name.as_deref().unwrap();
                let method_name = format!("{class_name}_{sanitized}");
                return Some((
                    method_name.clone(),
                    format!("method:{method_name}"),
                    "Method",
                ));
            }
            if matches!(context.lang, LangKind::Php | LangKind::Ruby) {
                if let Some(container) = context.container_name.as_deref() {
                    let qualified = format!("{container}.{sanitized}");
                    return Some((
                        qualified.clone(),
                        format!("function:{qualified}"),
                        "Function",
                    ));
                }
            }
            Some((
                sanitized.clone(),
                format!("function:{sanitized}"),
                "Function",
            ))
        }
        "method_definition" | "method_declaration" => {
            let name = callable_node_name(node, source, context)?;
            let sanitized = sanitize_symbol(&name)?;
            if matches!(
                context.lang,
                LangKind::Java | LangKind::CSharp | LangKind::Swift | LangKind::Dart
            ) {
                let owner = context.class_name.as_deref()?;
                let signature = callable_parameter_signature(node, source, context.lang);
                let qualified = format!("{owner}.{sanitized}{signature}");
                return Some((qualified.clone(), format!("method:{qualified}"), "Method"));
            }
            let receiver = if context.lang == LangKind::Go {
                go_receiver_name(node_text(node, source))
            } else {
                context.class_name.clone()
            }
            .unwrap_or_else(|| "receiver".to_string());
            let method_name = format!("{receiver}_{sanitized}");
            Some((
                method_name.clone(),
                format!("method:{method_name}"),
                "Method",
            ))
        }
        "constructor_declaration" | "compact_constructor_declaration" | "secondary_constructor"
            if matches!(
                context.lang,
                LangKind::Java | LangKind::Kotlin | LangKind::CSharp
            ) =>
        {
            let owner = context.class_name.as_deref()?;
            let signature = callable_parameter_signature(node, source, context.lang);
            let qualified = format!("{owner}.new{signature}");
            Some((qualified.clone(), format!("method:{qualified}"), "Method"))
        }
        "assignment_expression"
            if matches!(
                context.lang,
                LangKind::JavaScript | LangKind::TypeScript | LangKind::Tsx
            ) =>
        {
            if let Some(qualified) = commonjs_exported_function(node, source, context) {
                Some((
                    qualified.clone(),
                    format!("function:{qualified}"),
                    "Function",
                ))
            } else {
                let (qualified, _) = javascript_member_assigned_function(node, source)?;
                Some((qualified.clone(), format!("method:{qualified}"), "Method"))
            }
        }
        "variable_declarator" => {
            let value = node.child_by_field_name("value")?;
            if value.kind() != "arrow_function" && value.kind() != "function" {
                return None;
            }
            let name = node.child_by_field_name("name")?;
            let sanitized = sanitize_symbol(node_text(name, source))?;
            Some((
                sanitized.clone(),
                format!("function:{sanitized}"),
                "Function",
            ))
        }
        "binary_operator" if context.lang == LangKind::R => {
            let value = node.child_by_field_name("rhs")?;
            if value.kind() != "function_definition" {
                return None;
            }
            let name = node
                .child_by_field_name("lhs")
                .and_then(|child| descendant_identifier_name(child, source))?;
            let sanitized = sanitize_symbol(&name)?;
            Some((
                sanitized.clone(),
                format!("function:{sanitized}"),
                "Function",
            ))
        }
        _ => None,
    }
}

fn callable_parameter_signature(node: Node<'_>, source: &[u8], lang: LangKind) -> String {
    let parameters = node.child_by_field_name("parameters").or_else(|| {
        first_descendant_matching(node, &|child| {
            matches!(
                child.kind(),
                "formal_parameters"
                    | "function_value_parameters"
                    | "parameter_list"
                    | "formal_parameter_list"
            )
        })
    });
    let mut types = Vec::new();
    if let Some(parameters) = parameters {
        collect_parameter_types(parameters, source, lang, &mut types);
    } else {
        for index in 0..node.named_child_count() {
            if let Some(child) = node.named_child(index) {
                if matches!(child.kind(), "parameter" | "formal_parameter") {
                    collect_parameter_types(child, source, lang, &mut types);
                }
            }
        }
    }
    format!("({})", types.join(","))
}

fn collect_parameter_types(node: Node<'_>, source: &[u8], lang: LangKind, out: &mut Vec<String>) {
    if matches!(
        node.kind(),
        "formal_parameter"
            | "spread_parameter"
            | "receiver_parameter"
            | "parameter"
            | "parameter_declaration"
            | "simple_parameter"
            | "variadic_parameter"
            | "property_promotion_parameter"
    ) {
        let type_name = node
            .child_by_field_name("type")
            .map(|child| node_text(child, source))
            .and_then(signature_type_name)
            .or_else(|| {
                (lang == LangKind::Dart)
                    .then(|| {
                        (0..node.named_child_count())
                            .filter_map(|index| node.named_child(index))
                            .find(|child| child.kind() == "type")
                            .map(|child| node_text(child, source))
                    })
                    .flatten()
                    .and_then(signature_type_name)
            })
            .or_else(|| {
                matches!(lang, LangKind::Kotlin | LangKind::Swift)
                    .then(|| {
                        node_text(node, source)
                            .split_once(':')
                            .map(|(_, value)| value)
                    })
                    .flatten()
                    .and_then(signature_type_name)
            })
            .unwrap_or_else(|| "unknown".to_string());
        out.push(type_name);
        return;
    }
    for index in 0..node.named_child_count() {
        if let Some(child) = node.named_child(index) {
            collect_parameter_types(child, source, lang, out);
        }
    }
}

fn cpp_callable_owner(node: Node<'_>, source: &[u8], context: &WalkContext) -> Option<String> {
    if context.lang != LangKind::Cpp || node.kind() != "function_definition" {
        return None;
    }
    let declarator = node.child_by_field_name("declarator")?;
    let name = declarator
        .child_by_field_name("declarator")
        .unwrap_or(declarator);
    let (owner, _) = node_text(name, source).rsplit_once("::")?;
    let owner = last_identifier(owner).and_then(|value| sanitize_symbol(&value))?;
    Some(
        context
            .container_name
            .as_deref()
            .map(|container| format!("{container}.{owner}"))
            .unwrap_or(owner),
    )
}

fn signature_type_name(value: &str) -> Option<String> {
    let value = value
        .split('=')
        .next()
        .unwrap_or(value)
        .trim()
        .trim_end_matches(['?', '&']);
    last_identifier(value).and_then(|name| sanitize_symbol(&name))
}

fn batch_c_callable_aliases(subject: &str) -> Vec<String> {
    let Some((_, identity)) = subject.split_once(':') else {
        return Vec::new();
    };
    let base = identity
        .split_once('(')
        .map_or(identity, |(value, _)| value);
    let Some((owner, callable)) = base.rsplit_once('.') else {
        return Vec::new();
    };
    let simple_owner = owner.rsplit('.').next().unwrap_or(owner);
    vec![format!("{simple_owner}_{callable}")]
}

fn extension_receiver_type(node: Node<'_>, source: &[u8], lang: LangKind) -> Option<String> {
    match lang {
        LangKind::Kotlin if node.kind() == "function_declaration" => {
            let name = node.child_by_field_name("name")?;
            let prefix = std::str::from_utf8(&source[node.start_byte()..name.start_byte()]).ok()?;
            let receiver = prefix.trim_end().strip_suffix('.')?.trim_end();
            let receiver = receiver.split_whitespace().last()?;
            let receiver = receiver.split('<').next().unwrap_or(receiver);
            last_identifier(receiver).and_then(|value| sanitize_symbol(&value))
        }
        LangKind::CSharp if node.kind() == "method_declaration" => {
            let parameters = node.child_by_field_name("parameters")?;
            let parameter = (0..parameters.named_child_count())
                .filter_map(|index| parameters.named_child(index))
                .find(|child| {
                    child.kind() == "parameter"
                        && node_text(*child, source)
                            .split_whitespace()
                            .next()
                            .is_some_and(|token| token == "this")
                })?;
            parameter
                .child_by_field_name("type")
                .map(|child| node_text(child, source))
                .and_then(signature_type_name)
        }
        LangKind::Dart if node.kind() == "method_declaration" => {
            let extension =
                first_ancestor_matching(node, &|parent| parent.kind() == "extension_declaration")?;
            extension
                .child_by_field_name("class")
                .map(|child| node_text(child, source))
                .and_then(signature_type_name)
        }
        _ => None,
    }
}

fn type_declaration(
    node: Node<'_>,
    source: &[u8],
    lang: LangKind,
) -> Option<(String, String, &'static str, bool)> {
    let (prefix, kind, establishes_owner) = match node.kind() {
        "interface_declaration" | "interface_definition" => ("interface", "Interface", true),
        "trait_declaration" => ("trait", "Trait", true),
        "type_alias_declaration" => ("type_alias", "TypeAlias", false),
        "mixin_declaration" => ("mixin", "Mixin", true),
        "extension_declaration" => ("extension", "Extension", true),
        "record_declaration" => ("class", "Class", true),
        "enum_declaration" | "enum_item" => ("enum", "Enum", true),
        "struct_item" | "struct_specifier" => ("struct", "Struct", true),
        "trait_item" | "trait_definition" => ("trait", "Trait", true),
        "protocol_declaration" => ("protocol", "Protocol", true),
        "class_declaration" if lang == LangKind::Kotlin => {
            let header = node_text(node, source).split('{').next().unwrap_or("");
            if header.split_whitespace().any(|token| token == "interface") {
                ("interface", "Interface", true)
            } else {
                ("class", "Class", true)
            }
        }
        "class_declaration" if lang == LangKind::Swift => {
            let header = node_text(node, source).split('{').next().unwrap_or("");
            let keywords = header
                .split(|character: char| !character.is_ascii_alphabetic())
                .filter(|token| !token.is_empty())
                .collect::<BTreeSet<_>>();
            if keywords.contains("extension") {
                ("extension", "Extension", true)
            } else if keywords.contains("struct") {
                ("struct", "Struct", true)
            } else if keywords.contains("enum") {
                ("enum", "Enum", true)
            } else {
                ("class", "Class", true)
            }
        }
        "class_declaration"
            if lang == LangKind::Dart
                && node_text(node, source)
                    .split('{')
                    .next()
                    .is_some_and(|header| header.contains("interface class")) =>
        {
            ("interface", "Interface", true)
        }
        "class_declaration"
        | "class"
        | "abstract_class_declaration"
        | "class_definition"
        | "class_implementation"
        | "class_interface"
        | "object_definition" => ("class", "Class", true),
        "struct_definition" if lang == LangKind::Julia => ("struct", "Struct", true),
        "variable_declaration" if lang == LangKind::Zig => {
            if !node_text(node, source).contains("struct") {
                return None;
            }
            ("struct", "Struct", true)
        }
        "class_specifier" if lang == LangKind::Cpp => ("class", "Class", true),
        "type_spec" if lang == LangKind::Go => {
            let declared_type = node.child_by_field_name("type").or_else(|| {
                (0..node.named_child_count())
                    .filter_map(|index| node.named_child(index))
                    .find(|child| matches!(child.kind(), "struct_type" | "interface_type"))
            })?;
            match declared_type.kind() {
                "struct_type" => ("struct", "Struct", true),
                "interface_type" => ("interface", "Interface", true),
                _ => return None,
            }
        }
        _ => return None,
    };
    let raw_name = if node.kind() == "struct_definition" && lang == LangKind::Julia {
        descendant_identifier_name(node, source)
    } else {
        node_name(node, source)
    }?;
    let name = sanitize_symbol(&raw_name)?;
    Some((
        name.clone(),
        format!("{prefix}:{name}"),
        kind,
        establishes_owner,
    ))
}

fn declaration_name(node: Node<'_>, source: &[u8]) -> Option<String> {
    node.child_by_field_name("name")
        .map(|child| node_text(child, source))
        .and_then(last_identifier)
        .and_then(|name| sanitize_symbol(&name))
}

fn qualified_type_identity(
    name: String,
    subject: String,
    context: &WalkContext,
) -> (String, String) {
    if !matches!(
        context.lang,
        LangKind::Java
            | LangKind::Kotlin
            | LangKind::CSharp
            | LangKind::Cpp
            | LangKind::Php
            | LangKind::Ruby
            | LangKind::Dart
    ) {
        return (name, subject);
    }
    let Some(container) = context.container_name.as_deref() else {
        return (name, subject);
    };
    let Some((kind, _)) = subject.split_once(':') else {
        return (name, subject);
    };
    let qualified = format!("{container}.{name}");
    (qualified.clone(), format!("{kind}:{qualified}"))
}

fn exported_subjects(node: Node<'_>, source: &[u8], context: &WalkContext) -> Vec<String> {
    let mut subjects = Vec::new();
    for index in 0..node.named_child_count() {
        let Some(child) = node.named_child(index) else {
            continue;
        };
        if let Some((_, subject, _)) = callable_definition(child, source, context) {
            subjects.push(subject);
            continue;
        }
        if let Some((_, subject, _, _)) = type_declaration(child, source, context.lang) {
            subjects.push(subject);
            continue;
        }
        if child.kind() == "export_clause" {
            for child_index in 0..child.named_child_count() {
                if let Some(name) = child
                    .named_child(child_index)
                    .and_then(|item| descendant_identifier_name(item, source))
                    .and_then(|value| sanitize_symbol(&value))
                {
                    subjects.push(name);
                }
            }
        }
    }
    subjects.sort();
    subjects.dedup();
    subjects
}

fn heritage_targets(node: Node<'_>, source: &[u8], lang: LangKind) -> Vec<(&'static str, String)> {
    if lang == LangKind::Python {
        let Some(superclasses) = node.child_by_field_name("superclasses") else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for index in 0..superclasses.named_child_count() {
            if let Some(base) = superclasses.named_child(index) {
                if let Some(name) = heritage_target_name(base, source) {
                    out.push(("EXTENDS", name));
                }
            }
        }
        out.sort();
        out.dedup();
        return out;
    }
    if matches!(lang, LangKind::Java | LangKind::Kotlin | LangKind::CSharp) {
        return batch_c_heritage_targets(node, source, lang);
    }
    if matches!(lang, LangKind::Cpp | LangKind::Swift | LangKind::Dart) {
        return batch_d_heritage_targets(node, source, lang);
    }
    if matches!(lang, LangKind::Php | LangKind::Ruby) {
        return batch_e_heritage_targets(node, source, lang);
    }
    if matches!(
        lang,
        LangKind::JavaScript | LangKind::TypeScript | LangKind::Tsx
    ) {
        let mut clauses = Vec::new();
        for index in 0..node.named_child_count() {
            let Some(child) = node.named_child(index) else {
                continue;
            };
            if child.kind() == "class_heritage" {
                for clause_index in 0..child.named_child_count() {
                    if let Some(clause) = child.named_child(clause_index) {
                        clauses.push(clause);
                    }
                }
            } else if matches!(
                child.kind(),
                "extends_clause" | "extends_type_clause" | "implements_clause"
            ) {
                clauses.push(child);
            }
        }

        let mut out = Vec::new();
        for clause in clauses {
            let predicate = if clause.kind() == "implements_clause" {
                "IMPLEMENTS"
            } else {
                "EXTENDS"
            };
            if clause.kind() == "extends_clause" {
                if let Some(target) = clause.child_by_field_name("value") {
                    if let Some(name) = heritage_target_name(target, source) {
                        out.push((predicate, name));
                    }
                }
                continue;
            }
            for index in 0..clause.named_child_count() {
                if let Some(target) = clause.named_child(index) {
                    if let Some(name) = heritage_target_name(target, source) {
                        out.push((predicate, name));
                    }
                }
            }
        }
        out.sort();
        out.dedup();
        return out;
    }

    heritage_targets_from_text(node_text(node, source))
}

fn batch_e_heritage_targets(
    node: Node<'_>,
    source: &[u8],
    lang: LangKind,
) -> Vec<(&'static str, String)> {
    if lang == LangKind::Php {
        return heritage_targets_from_text(node_text(node, source));
    }
    let header = node_text(node, source).lines().next().unwrap_or("");
    let Some((_, superclass)) = header.split_once('<') else {
        return Vec::new();
    };
    last_identifier(superclass)
        .and_then(|name| sanitize_symbol(&name))
        .map(|name| vec![("EXTENDS", name)])
        .unwrap_or_default()
}

fn batch_d_heritage_targets(
    node: Node<'_>,
    source: &[u8],
    lang: LangKind,
) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    match lang {
        LangKind::Cpp => {
            for index in 0..node.named_child_count() {
                if let Some(child) = node.named_child(index) {
                    if child.kind() == "base_class_clause" {
                        collect_heritage_names(child, source, "INHERITS", &mut out);
                    }
                }
            }
        }
        LangKind::Swift => {
            if node_text(node, source)
                .trim_start()
                .starts_with("extension ")
            {
                if let Some(name) = declaration_name(node, source) {
                    out.push(("EXTENDS_TYPE", name));
                }
            } else {
                for index in 0..node.named_child_count() {
                    if let Some(child) = node.named_child(index) {
                        if child.kind() == "inheritance_specifier" {
                            collect_heritage_names(child, source, "INHERITS", &mut out);
                        }
                    }
                }
            }
        }
        LangKind::Dart if node.kind() == "extension_declaration" => {
            if let Some(target) = node
                .child_by_field_name("class")
                .and_then(|child| heritage_target_name(child, source))
            {
                out.push(("EXTENDS_TYPE", target));
            }
        }
        LangKind::Dart => {
            if let Some(superclass) = node.child_by_field_name("superclass") {
                for index in 0..superclass.named_child_count() {
                    let Some(child) = superclass.named_child(index) else {
                        continue;
                    };
                    if child.kind() == "mixins" {
                        collect_heritage_names(child, source, "MIXES_IN", &mut out);
                    } else if let Some(name) = heritage_target_name(child, source) {
                        out.push(("EXTENDS", name));
                    }
                }
            }
            if let Some(interfaces) = node.child_by_field_name("interfaces") {
                collect_heritage_names(interfaces, source, "IMPLEMENTS", &mut out);
            }
        }
        _ => {}
    }
    out.sort();
    out.dedup();
    out
}

fn batch_c_heritage_targets(
    node: Node<'_>,
    source: &[u8],
    lang: LangKind,
) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    if lang == LangKind::Java {
        if let Some(superclass) = node.child_by_field_name("superclass") {
            if let Some(name) = heritage_target_name(superclass, source) {
                out.push(("EXTENDS", name));
            }
        }
        if let Some(interfaces) = node.child_by_field_name("interfaces") {
            collect_heritage_names(interfaces, source, "IMPLEMENTS", &mut out);
        }
        for index in 0..node.named_child_count() {
            let Some(child) = node.named_child(index) else {
                continue;
            };
            if child.kind() == "extends_interfaces" {
                collect_heritage_names(child, source, "EXTENDS", &mut out);
            }
        }
    } else {
        for index in 0..node.named_child_count() {
            let Some(child) = node.named_child(index) else {
                continue;
            };
            if matches!(child.kind(), "delegation_specifiers" | "base_list") {
                collect_heritage_names(child, source, "INHERITS", &mut out);
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

fn collect_heritage_names(
    node: Node<'_>,
    source: &[u8],
    predicate: &'static str,
    out: &mut Vec<(&'static str, String)>,
) {
    if matches!(
        node.kind(),
        "type_identifier"
            | "identifier"
            | "user_type"
            | "generic_name"
            | "qualified_name"
            | "scoped_type_identifier"
    ) {
        if let Some(name) = heritage_target_name(node, source) {
            out.push((predicate, name));
        }
        return;
    }
    for index in 0..node.named_child_count() {
        if let Some(child) = node.named_child(index) {
            collect_heritage_names(child, source, predicate, out);
        }
    }
}

fn heritage_target_name(node: Node<'_>, source: &[u8]) -> Option<String> {
    let target = if node.kind() == "generic_type" {
        node.child_by_field_name("type")
            .or_else(|| node.child_by_field_name("name"))
            .or_else(|| node.named_child(0))
            .unwrap_or(node)
    } else if node.kind() == "subscript" {
        node.child_by_field_name("value").unwrap_or(node)
    } else if node.kind() == "call_expression" {
        node.child_by_field_name("function").unwrap_or(node)
    } else {
        node
    };
    last_identifier(node_text(target, source)).and_then(|name| sanitize_symbol(&name))
}

fn heritage_targets_from_text(text: &str) -> Vec<(&'static str, String)> {
    let header = text.split('{').next().unwrap_or(text);
    let mut out = Vec::new();
    for (keyword, predicate) in [("extends", "EXTENDS"), ("implements", "IMPLEMENTS")] {
        let Some((_, tail)) = header.split_once(keyword) else {
            continue;
        };
        let tail = tail
            .split("implements")
            .next()
            .unwrap_or(tail)
            .split("extends")
            .next()
            .unwrap_or(tail);
        for raw in tail.split(',') {
            let candidate = raw
                .split_whitespace()
                .next()
                .and_then(last_identifier)
                .and_then(|name| sanitize_symbol(&name));
            if let Some(name) = candidate {
                out.push((predicate, name));
            }
        }
    }
    out
}

fn node_name(node: Node<'_>, source: &[u8]) -> Option<String> {
    node.child_by_field_name("name")
        .map(|child| node_text(child, source).to_string())
        .or_else(|| {
            (0..node.named_child_count())
                .filter_map(|index| node.named_child(index))
                .find(|child| {
                    matches!(
                        child.kind(),
                        "identifier"
                            | "type_identifier"
                            | "property_identifier"
                            | "field_identifier"
                            | "constant"
                            | "simple_identifier"
                            | "variable_name"
                            | "name"
                            | "method_identifier"
                            | "word"
                    )
                })
                .map(|child| node_text(child, source).to_string())
        })
}

fn callable_node_name(node: Node<'_>, source: &[u8], context: &WalkContext) -> Option<String> {
    if matches!(
        context.lang,
        LangKind::C | LangKind::Cpp | LangKind::ObjectiveC
    ) && matches!(node.kind(), "function_definition" | "field_declaration")
    {
        return first_descendant_matching(node, &|child| child.kind() == "function_declarator")
            .and_then(|declarator| {
                let name = declarator
                    .child_by_field_name("declarator")
                    .unwrap_or(declarator);
                last_identifier(node_text(name, source))
            })
            .or_else(|| node_name(node, source));
    }
    if context.lang == LangKind::Sql && node.kind() == "create_function" {
        return descendant_identifier_name(node, source);
    }
    if context.lang == LangKind::Julia && node.kind() == "function_definition" {
        return node
            .named_children(&mut node.walk())
            .find(|child| child.kind() == "signature")
            .and_then(|signature| descendant_identifier_name(signature, source))
            .or_else(|| node_name(node, source));
    }
    if context.lang == LangKind::Dart
        && matches!(node.kind(), "function_declaration" | "method_declaration")
    {
        return node
            .child_by_field_name("signature")
            .and_then(|signature| descendant_field_name(signature, source, "name"))
            .or_else(|| node_name(node, source));
    }
    node_name(node, source)
}

fn descendant_field_name(node: Node<'_>, source: &[u8], field: &str) -> Option<String> {
    if let Some(child) = node.child_by_field_name(field) {
        return Some(node_text(child, source).to_string());
    }
    for index in 0..node.named_child_count() {
        if let Some(child) = node.named_child(index) {
            if let Some(name) = descendant_field_name(child, source, field) {
                return Some(name);
            }
        }
    }
    None
}

fn descendant_identifier_name(node: Node<'_>, source: &[u8]) -> Option<String> {
    if matches!(
        node.kind(),
        "identifier"
            | "type_identifier"
            | "property_identifier"
            | "field_identifier"
            | "constant"
            | "simple_identifier"
            | "variable_name"
            | "name"
            | "method_identifier"
            | "operator_identifier"
            | "word"
    ) {
        return Some(node_text(node, source).to_string());
    }
    for index in 0..node.named_child_count() {
        if let Some(child) = node.named_child(index) {
            if let Some(name) = descendant_identifier_name(child, source) {
                return Some(name);
            }
        }
    }
    None
}

fn callee_name(node: Node<'_>, source: &[u8]) -> Option<String> {
    if node.kind() == "method_invocation" {
        return node
            .child_by_field_name("name")
            .map(|child| node_text(child, source))
            .and_then(sanitize_symbol);
    }
    if matches!(
        node.kind(),
        "member_call_expression"
            | "nullsafe_member_call_expression"
            | "scoped_call_expression"
            | "message_expression"
    ) {
        if let Some(name) = node
            .child_by_field_name("name")
            .or_else(|| node.child_by_field_name("method"))
        {
            return sanitize_symbol(node_text(name, source));
        }
        return last_identifier(node_text(node, source)).and_then(|name| sanitize_symbol(&name));
    }
    if node.kind() == "call" {
        if let Some(method) = node
            .child_by_field_name("method")
            .or_else(|| node.child_by_field_name("name"))
        {
            return sanitize_symbol(node_text(method, source));
        }
    }
    let function = node
        .child_by_field_name("function")
        .or_else(|| node.named_child(0))?;
    let text = node_text(function, source);
    last_identifier(text).and_then(|name| sanitize_symbol(&name))
}

fn is_transparent_kotlin_dsl_call(node: Node<'_>, source: &[u8], lang: LangKind) -> bool {
    if lang != LangKind::Kotlin || node.kind() != "call_expression" {
        return false;
    }
    let first = node.named_child(0);
    let wraps_trailing_lambda_call = first.is_some_and(|child| child.kind() == "call_expression")
        && (1..node.named_child_count()).any(|index| {
            node.named_child(index)
                .is_some_and(|child| child.kind() == "annotated_lambda")
        });
    wraps_trailing_lambda_call || callee_name(node, source).as_deref() == Some("routing")
}

fn constructor_callee(node: Node<'_>, source: &[u8]) -> Option<String> {
    node.child_by_field_name("constructor")
        .or_else(|| node.child_by_field_name("type"))
        .or_else(|| node.named_child(0))
        .map(|child| node_text(child, source))
        .and_then(last_identifier)
        .and_then(|name| sanitize_symbol(&name))
}

fn ruby_constructor_type(node: Node<'_>, source: &[u8]) -> Option<String> {
    let receiver = node.child_by_field_name("receiver")?;
    let method = node
        .child_by_field_name("method")
        .or_else(|| node.child_by_field_name("name"))?;
    if node_text(method, source) != "new" {
        return None;
    }
    let type_name =
        last_identifier(node_text(receiver, source)).and_then(|name| sanitize_symbol(&name))?;
    looks_like_type_name(&type_name).then_some(type_name)
}

fn rust_associated_constructor(
    node: Node<'_>,
    source: &[u8],
    context: &WalkContext,
) -> Option<String> {
    if context.lang != LangKind::Rust {
        return None;
    }
    let function = node
        .child_by_field_name("function")
        .or_else(|| node.named_child(0))?;
    let (receiver, method) = node_text(function, source).rsplit_once("::")?;
    if method.trim() != "new" {
        return None;
    }
    let receiver = last_identifier(receiver).and_then(|name| sanitize_symbol(&name))?;
    if receiver == "Self" {
        context.impl_name.clone()
    } else {
        Some(receiver)
    }
}

fn typed_call_target(
    node: Node<'_>,
    source: &[u8],
    context: &WalkContext,
) -> Option<TypedCallHint> {
    let function = node
        .child_by_field_name("function")
        .or_else(|| node.named_child(0))?;
    let function_text = node_text(function, source);
    let receiver_and_method = if node.kind() == "call" && context.lang == LangKind::Ruby {
        node.child_by_field_name("receiver")
            .zip(
                node.child_by_field_name("method")
                    .or_else(|| node.child_by_field_name("name")),
            )
            .and_then(|(receiver, method)| {
                Some((
                    sanitize_symbol(node_text(receiver, source))?,
                    sanitize_symbol(node_text(method, source))?,
                ))
            })
    } else if matches!(
        node.kind(),
        "method_invocation" | "member_call_expression" | "nullsafe_member_call_expression"
    ) {
        node.child_by_field_name("object")
            .zip(node.child_by_field_name("name"))
            .and_then(|(receiver, method)| {
                Some((
                    sanitize_symbol(node_text(receiver, source))?,
                    sanitize_symbol(node_text(method, source))?,
                ))
            })
    } else {
        receiver_method(function_text)
    };
    let (receiver_type, method) = if let Some((receiver, method)) = receiver_and_method {
        let receiver_key = receiver.trim_start_matches('$');
        let receiver_type = if matches!(receiver_key, "this" | "self") {
            context.class_name.clone()?
        } else if let Some(bound) = context
            .type_bindings
            .get(&receiver)
            .or_else(|| context.type_bindings.get(receiver_key))
        {
            bound.clone()
        } else if looks_like_type_name(receiver_key) {
            receiver_key.to_string()
        } else if matches!(
            context.lang,
            LangKind::JavaScript | LangKind::TypeScript | LangKind::Tsx
        ) {
            receiver_key.to_string()
        } else {
            return None;
        };
        (receiver_type, method)
    } else if let Some(class_name) = context.class_name.as_ref() {
        let method = sanitize_symbol(function_text)?;
        (class_name.clone(), method)
    } else {
        return None;
    };
    let receiver_alias = receiver_type.rsplit('.').next().unwrap_or(&receiver_type);
    Some(TypedCallHint {
        target_name: format!("{receiver_alias}_{method}"),
        note: typed_call_note(context.lang)?,
    })
}

fn typed_call_note(lang: LangKind) -> Option<&'static str> {
    match lang {
        LangKind::Python => Some("oaf.ingest:typed-call-python"),
        LangKind::Go => Some("oaf.ingest:typed-call-go"),
        LangKind::Rust => Some("oaf.ingest:typed-call-rust"),
        LangKind::Java => Some("oaf.ingest:typed-call-java"),
        LangKind::CSharp => Some("oaf.ingest:typed-call-csharp"),
        LangKind::Cpp => Some("oaf.ingest:typed-call-cpp"),
        LangKind::Swift => Some("oaf.ingest:typed-call-swift"),
        LangKind::Kotlin => Some("oaf.ingest:typed-call-kotlin"),
        LangKind::Dart => Some("oaf.ingest:typed-call-dart"),
        LangKind::Php => Some("oaf.ingest:typed-call-php"),
        LangKind::Ruby => Some("oaf.ingest:typed-call-ruby"),
        LangKind::JavaScript => Some("oaf.ingest:typed-call-javascript"),
        LangKind::TypeScript | LangKind::Tsx => Some("oaf.ingest:typed-call-typescript"),
        _ => None,
    }
}

fn local_type_bindings(
    node: Node<'_>,
    source: &[u8],
    context: &WalkContext,
) -> BTreeMap<String, String> {
    let mut bindings = context.type_bindings.clone();
    if context.lang == LangKind::Python {
        bindings.extend(python_type_bindings(node, source));
        if let Some(class_name) = context.class_name.as_deref() {
            bindings.insert("self".to_string(), class_name.to_string());
        }
        return bindings;
    }
    if context.lang == LangKind::Go {
        bindings.extend(go_type_bindings(node_text(node, source)));
        return bindings;
    }
    if context.lang == LangKind::Rust {
        bindings.extend(rust_type_bindings(node_text(node, source)));
        if let Some(type_name) = context.impl_name.as_deref() {
            bindings.insert("self".to_string(), type_name.to_string());
        }
        return bindings;
    }
    if matches!(
        context.lang,
        LangKind::Java
            | LangKind::Kotlin
            | LangKind::CSharp
            | LangKind::Cpp
            | LangKind::Swift
            | LangKind::Dart
            | LangKind::Php
    ) {
        bindings.extend(batch_c_type_bindings(node, source, context.lang));
        if context.lang == LangKind::Php {
            bindings.extend(php_type_bindings(node_text(node, source)));
        }
        bindings.extend(constructor_type_bindings(node_text(node, source)));
        if let Some(type_name) = context.class_name.as_deref() {
            bindings.insert("this".to_string(), type_name.to_string());
            bindings.insert("self".to_string(), type_name.to_string());
        }
        return bindings;
    }
    if context.lang == LangKind::Ruby {
        bindings.extend(ruby_constructor_type_bindings(node_text(node, source)));
        if let Some(type_name) = context.class_name.as_deref() {
            bindings.insert("self".to_string(), type_name.to_string());
        }
        return bindings;
    }
    if matches!(
        context.lang,
        LangKind::JavaScript
            | LangKind::TypeScript
            | LangKind::Tsx
            | LangKind::Java
            | LangKind::CSharp
            | LangKind::Swift
            | LangKind::Kotlin
    ) {
        bindings.extend(constructor_type_bindings(node_text(node, source)));
    }
    bindings
}

fn batch_c_type_bindings(
    node: Node<'_>,
    source: &[u8],
    lang: LangKind,
) -> BTreeMap<String, String> {
    let mut bindings = BTreeMap::new();
    collect_batch_c_type_bindings(node, source, lang, &mut bindings);
    bindings
}

fn collect_batch_c_type_bindings(
    node: Node<'_>,
    source: &[u8],
    lang: LangKind,
    bindings: &mut BTreeMap<String, String>,
) {
    if matches!(
        node.kind(),
        "formal_parameter"
            | "spread_parameter"
            | "receiver_parameter"
            | "parameter"
            | "parameter_declaration"
            | "simple_parameter"
            | "variadic_parameter"
            | "property_promotion_parameter"
    ) {
        let text = node_text(node, source);
        let name = node
            .child_by_field_name("name")
            .map(|child| node_text(child, source).to_string())
            .or_else(|| {
                node.child_by_field_name("declarator")
                    .map(|child| node_text(child, source).to_string())
            })
            .or_else(|| {
                matches!(lang, LangKind::Kotlin | LangKind::Swift)
                    .then(|| {
                        text.split_once(':')
                            .map(|(value, _)| value.trim().to_string())
                    })
                    .flatten()
            })
            .and_then(|value| last_identifier(&value))
            .and_then(|value| sanitize_symbol(&value));
        let type_name = node
            .child_by_field_name("type")
            .map(|child| node_text(child, source))
            .and_then(signature_type_name)
            .or_else(|| {
                (lang == LangKind::Dart)
                    .then(|| {
                        (0..node.named_child_count())
                            .filter_map(|index| node.named_child(index))
                            .find(|child| child.kind() == "type")
                            .map(|child| node_text(child, source))
                    })
                    .flatten()
                    .and_then(signature_type_name)
            })
            .or_else(|| {
                matches!(lang, LangKind::Kotlin | LangKind::Swift)
                    .then(|| text.split_once(':').map(|(_, value)| value))
                    .flatten()
                    .and_then(signature_type_name)
            });
        if let (Some(name), Some(type_name)) = (name, type_name) {
            bindings.insert(name, type_name);
        }
        return;
    }
    for index in 0..node.named_child_count() {
        if let Some(child) = node.named_child(index) {
            collect_batch_c_type_bindings(child, source, lang, bindings);
        }
    }
}

fn go_type_bindings(text: &str) -> BTreeMap<String, String> {
    let header = text.split('{').next().unwrap_or(text);
    let mut bindings = BTreeMap::new();
    for parameters in parenthesized_segments(header) {
        for parameter in parameters.split(',') {
            let parts = parameter.split_whitespace().collect::<Vec<_>>();
            if parts.len() < 2 {
                continue;
            }
            let Some(type_name) =
                last_identifier(parts.last().unwrap()).and_then(|name| sanitize_symbol(&name))
            else {
                continue;
            };
            for name in &parts[..parts.len() - 1] {
                if let Some(name) = sanitize_symbol(name.trim_matches(['(', ')', '*', '&'])) {
                    bindings.insert(name, type_name.clone());
                }
            }
        }
    }
    bindings
}

fn rust_type_bindings(text: &str) -> BTreeMap<String, String> {
    let header = text.split('{').next().unwrap_or(text);
    let mut bindings = BTreeMap::new();
    let Some(parameters) = parenthesized_segments(header).into_iter().next() else {
        return bindings;
    };
    for parameter in parameters.split(',') {
        let Some((name, type_name)) = parameter.split_once(':') else {
            continue;
        };
        let Some(name) = sanitize_symbol(name.trim()) else {
            continue;
        };
        let Some(type_name) = last_identifier(type_name).and_then(|value| sanitize_symbol(&value))
        else {
            continue;
        };
        bindings.insert(name, type_name);
    }
    bindings
}

fn php_type_bindings(text: &str) -> BTreeMap<String, String> {
    let mut bindings = BTreeMap::new();
    let Some(parameters) = parenthesized_segments(text).into_iter().next() else {
        return bindings;
    };
    for parameter in parameters.split(',') {
        let parts = parameter.split_whitespace().collect::<Vec<_>>();
        if parts.len() < 2 {
            continue;
        }
        let Some(name) = sanitize_symbol(parts.last().unwrap()) else {
            continue;
        };
        let Some(type_name) =
            last_identifier(parts[parts.len() - 2]).and_then(|value| sanitize_symbol(&value))
        else {
            continue;
        };
        bindings.insert(name, type_name);
    }
    bindings
}

fn parenthesized_segments(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut start = None;
    for (index, ch) in text.char_indices() {
        if ch == '(' {
            if depth == 0 {
                start = Some(index + ch.len_utf8());
            }
            depth += 1;
        } else if ch == ')' && depth > 0 {
            depth -= 1;
            if depth == 0 {
                if let Some(start) = start.take() {
                    out.push(&text[start..index]);
                }
            }
        }
    }
    out
}

fn constructor_type_bindings(text: &str) -> BTreeMap<String, String> {
    let mut bindings = BTreeMap::new();
    for line in text.lines() {
        let line = line.split("//").next().unwrap_or("").trim();
        let Some((lhs, rhs)) = line.split_once('=') else {
            continue;
        };
        let Some(variable) = last_identifier(lhs) else {
            continue;
        };
        let type_name = if let Some((_, after_new)) = rhs.split_once("new ") {
            constructor_name(after_new)
        } else if starts_with_binding_keyword(lhs) {
            constructor_name(rhs)
        } else {
            None
        };
        let Some(type_name) = type_name else {
            continue;
        };
        if looks_like_type_name(&type_name) {
            bindings.insert(variable, type_name);
        }
    }
    bindings
}

fn ruby_constructor_type_bindings(text: &str) -> BTreeMap<String, String> {
    let mut bindings = BTreeMap::new();
    for line in text.lines() {
        let Some((lhs, rhs)) = line.split_once('=') else {
            continue;
        };
        let Some(variable) = last_identifier(lhs).and_then(|name| sanitize_symbol(&name)) else {
            continue;
        };
        let Some((receiver, _)) = rhs.trim().split_once(".new") else {
            continue;
        };
        let Some(type_name) = last_identifier(receiver).and_then(|name| sanitize_symbol(&name))
        else {
            continue;
        };
        if looks_like_type_name(&type_name) {
            bindings.insert(variable, type_name);
        }
    }
    bindings
}

fn starts_with_binding_keyword(lhs: &str) -> bool {
    lhs.split_whitespace()
        .next()
        .is_some_and(|token| matches!(token, "let" | "var" | "val" | "final" | "const"))
}

fn constructor_name(rhs: &str) -> Option<String> {
    let before_paren = rhs.split_once('(')?.0;
    last_identifier(before_paren)
}

fn looks_like_type_name(name: &str) -> bool {
    name.chars().next().is_some_and(char::is_uppercase)
}

fn receiver_method(value: &str) -> Option<(String, String)> {
    let value = value.trim();
    let (index, separator) = ["->", "::", "."]
        .into_iter()
        .filter_map(|separator| value.rfind(separator).map(|index| (index, separator)))
        .max_by_key(|(index, _)| *index)?;
    let receiver = &value[..index];
    let method = &value[index + separator.len()..];
    let receiver = sanitize_symbol(receiver)?;
    let method = sanitize_symbol(method)?;
    Some((receiver, method))
}

fn route_registration(node: Node<'_>, source: &[u8], context: &WalkContext) -> Option<RouteRef> {
    let text = node_text(node, source);
    if context.lang == LangKind::Ruby {
        let method = callee_name(node, source).and_then(|name| http_method(&name))?;
        let path = first_quoted_route_path(text)?;
        let rails = context.source.ends_with("config/routes.rb") || text.contains("to:");
        return Some(RouteRef {
            method,
            path,
            handler_subject: (!rails).then(|| context.module.clone()),
            handler_name: rails.then(|| ruby_rails_handler_name(text)).flatten(),
            source: context.source.clone(),
            note: if rails {
                "oaf.ingest:route-rails"
            } else {
                "oaf.ingest:route-sinatra"
            },
            span: CodeSpan::from_node(node),
        });
    }
    if context.lang == LangKind::Php && node.kind() == "scoped_call_expression" {
        let function = text.split_once('(').map_or(text, |(head, _)| head);
        let (receiver, method) = receiver_method(function)?;
        if receiver != "Route" {
            return None;
        }
        return Some(RouteRef {
            method: http_method(&method)?,
            path: first_quoted_route_path(text)?,
            handler_subject: None,
            handler_name: Some(php_route_handler_name(text)?),
            source: context.source.clone(),
            note: "oaf.ingest:route-laravel",
            span: CodeSpan::from_node(node),
        });
    }
    if context.lang == LangKind::Python {
        let callee = callee_name(node, source)?;
        if matches!(callee.as_str(), "path" | "re_path") {
            return Some(RouteRef {
                method: "ANY".to_string(),
                path: first_quoted_route_path(text)?,
                handler_subject: None,
                handler_name: Some(route_handler_name(text)?),
                source: context.source.clone(),
                note: "oaf.ingest:route-django",
                span: CodeSpan::from_node(node),
            });
        }
    }
    if context.lang == LangKind::Kotlin {
        let method = callee_name(node, source).and_then(|name| http_method(&name))?;
        return Some(RouteRef {
            method,
            path: first_quoted_route_path(text)?,
            handler_subject: context.caller.clone(),
            handler_name: None,
            source: context.source.clone(),
            note: "oaf.ingest:route-ktor",
            span: CodeSpan::from_node(node),
        });
    }
    let function = node
        .child_by_field_name("function")
        .or_else(|| node.named_child(0))?;
    let function_text = node_text(function, source);
    let (receiver, method) = receiver_method(function_text)?;
    let (method, handler_name, note) = match context.lang {
        LangKind::JavaScript | LangKind::TypeScript | LangKind::Tsx => {
            let direct = javascript_route_receiver(&receiver);
            let route_receiver = direct
                .then_some(receiver.clone())
                .or_else(|| javascript_route_chain_receiver(node, source))?;
            let handler = if direct {
                route_handler_name(text)?
            } else {
                call_argument_handler_name(node, source)?
            };
            (
                http_method(&method)?,
                handler,
                if route_receiver == "fastify" {
                    "oaf.ingest:route-fastify"
                } else {
                    "oaf.ingest:route-javascript"
                },
            )
        }
        LangKind::Go => {
            if receiver == "http" && method == "HandleFunc" {
                let (method, path) = go_http_route_pattern(text)?;
                return Some(RouteRef {
                    method,
                    path,
                    handler_subject: None,
                    handler_name: Some(route_handler_name(text)?),
                    source: context.source.clone(),
                    note: "oaf.ingest:route-go-net-http",
                    span: CodeSpan::from_node(node),
                });
            }
            if !matches!(
                receiver.as_str(),
                "router" | "r" | "engine" | "group" | "e" | "g" | "mux"
            ) {
                return None;
            }
            (
                http_method(&method)?,
                route_handler_name(text)?,
                "oaf.ingest:route-go",
            )
        }
        LangKind::Rust if method == "route" => {
            let (method, handler) = rust_route_handler(text)?;
            (method, handler, "oaf.ingest:route-rust")
        }
        LangKind::CSharp if method.starts_with("Map") => (
            http_method(method.trim_start_matches("Map"))?,
            route_handler_name(text)?,
            "oaf.ingest:route-aspnet-minimal",
        ),
        LangKind::Swift if matches!(receiver.as_str(), "app" | "router" | "routes") => (
            http_method(&method)?,
            context.caller.clone()?,
            "oaf.ingest:route-vapor",
        ),
        LangKind::Dart if receiver == "router" => (
            http_method(&method)?,
            context.caller.clone()?,
            "oaf.ingest:route-shelf",
        ),
        _ => return None,
    };
    let path = if context.lang == LangKind::Swift {
        vapor_route_path(node, source)?
    } else {
        first_quoted_route_path(text)?
    };
    Some(RouteRef {
        method,
        path,
        handler_subject: matches!(context.lang, LangKind::Swift | LangKind::Dart)
            .then_some(handler_name.clone()),
        handler_name: (!matches!(context.lang, LangKind::Swift | LangKind::Dart))
            .then_some(handler_name),
        source: context.source.clone(),
        note,
        span: CodeSpan::from_node(node),
    })
}

fn javascript_route_receiver(receiver: &str) -> bool {
    matches!(receiver, "app" | "router" | "fastify" | "server")
}

fn javascript_route_chain_receiver(node: Node<'_>, source: &[u8]) -> Option<String> {
    let mut function = node.child_by_field_name("function")?;
    loop {
        let object = function.child_by_field_name("object")?;
        if object.kind() != "call_expression" {
            return None;
        }
        let inner_function = object.child_by_field_name("function")?;
        let (receiver, method) = receiver_method(node_text(inner_function, source))?;
        if method == "route" && javascript_route_receiver(&receiver) {
            return Some(receiver);
        }
        function = inner_function;
    }
}

fn call_argument_handler_name(node: Node<'_>, source: &[u8]) -> Option<String> {
    let arguments = node.child_by_field_name("arguments")?;
    let candidate = arguments.named_child(arguments.named_child_count().checked_sub(1)?)?;
    if matches!(
        candidate.kind(),
        "arrow_function" | "function" | "function_expression"
    ) {
        return None;
    }
    sanitize_symbol(node_text(candidate, source))
}

fn vapor_route_path(node: Node<'_>, source: &[u8]) -> Option<String> {
    let arguments = first_descendant_matching(node, &|child| child.kind() == "value_arguments")?;
    let segments = (0..arguments.named_child_count())
        .filter_map(|index| arguments.named_child(index))
        .filter_map(|argument| {
            quoted_literals(node_text(argument, source))
                .into_iter()
                .next()
        })
        .take(8)
        .collect::<Vec<_>>();
    if segments.is_empty() {
        return None;
    }
    Some(canon_route_path(&format!("/{}", segments.join("/"))))
}

fn rust_route_handler(text: &str) -> Option<(String, String)> {
    for method in ["get", "post", "put", "patch", "delete", "options", "head"] {
        let marker = format!("{method}(");
        let Some((_, tail)) = text.split_once(&marker) else {
            continue;
        };
        let handler = tail
            .split_once(".to(")
            .map(|(_, value)| value)
            .unwrap_or(tail);
        let handler = handler
            .split_once(')')
            .map(|(value, _)| value)
            .unwrap_or(handler);
        let handler = last_identifier(handler).and_then(|name| sanitize_symbol(&name))?;
        return Some((method.to_ascii_uppercase(), handler));
    }
    None
}

fn go_http_route_pattern(text: &str) -> Option<(String, String)> {
    let pattern = quoted_literals(text).into_iter().next()?;
    if let Some((method, path)) = pattern.split_once(' ') {
        return Some((http_method(method)?, canon_route_path(path)));
    }
    Some(("ANY".to_string(), canon_route_path(&pattern)))
}

fn node_http_server(node: Node<'_>, source: &[u8], context: &WalkContext) -> Option<FrameworkRef> {
    if !matches!(
        context.lang,
        LangKind::JavaScript | LangKind::TypeScript | LangKind::Tsx
    ) {
        return None;
    }
    let function = node
        .child_by_field_name("function")
        .or_else(|| node.named_child(0))?;
    let (receiver, method) = receiver_method(node_text(function, source))?;
    if receiver != "http" || method != "createServer" {
        return None;
    }
    Some(FrameworkRef {
        owner: context.module.clone(),
        component: "framework:node_http_server".to_string(),
        handler_name: route_handler_name(node_text(node, source)),
        source: context.source.clone(),
        span: CodeSpan::from_node(node),
    })
}

fn callable_route(
    node: Node<'_>,
    source: &[u8],
    context: &WalkContext,
    handler_subject: &str,
) -> Option<RouteRef> {
    if context.lang == LangKind::Java {
        let (method, method_path) = annotation_http_route(
            node_text(node, source),
            &[
                ("@GetMapping", "GET"),
                ("@PostMapping", "POST"),
                ("@PutMapping", "PUT"),
                ("@PatchMapping", "PATCH"),
                ("@DeleteMapping", "DELETE"),
            ],
        )?;
        let prefix = context.route_prefix.as_deref().unwrap_or("/");
        return Some(RouteRef {
            method,
            path: join_route_paths(prefix, &method_path),
            handler_subject: Some(handler_subject.to_string()),
            handler_name: None,
            source: context.source.clone(),
            note: "oaf.ingest:route-spring",
            span: CodeSpan::from_node(node),
        });
    }
    if context.lang == LangKind::CSharp {
        let (method, method_path) = annotation_http_route(
            node_text(node, source),
            &[
                ("HttpGet", "GET"),
                ("HttpPost", "POST"),
                ("HttpPut", "PUT"),
                ("HttpPatch", "PATCH"),
                ("HttpDelete", "DELETE"),
            ],
        )?;
        let prefix = context.route_prefix.as_deref().unwrap_or("/");
        return Some(RouteRef {
            method,
            path: join_route_paths(prefix, &method_path),
            handler_subject: Some(handler_subject.to_string()),
            handler_name: None,
            source: context.source.clone(),
            note: "oaf.ingest:route-aspnet-controller",
            span: CodeSpan::from_node(node),
        });
    }
    if matches!(
        context.lang,
        LangKind::JavaScript | LangKind::TypeScript | LangKind::Tsx
    ) {
        let name = callable_node_name(node, source, context)?;
        let (method, path, note) = if let (Some(method), Some(path)) =
            (http_method(&name), next_server_route_path(&context.source))
        {
            (method, path, "oaf.ingest:route-nextjs")
        } else {
            let (method, method_path) = nest_method_route(node, source)?;
            let prefix = context.route_prefix.as_deref().unwrap_or("/");
            (
                method,
                join_route_paths(prefix, &method_path),
                "oaf.ingest:route-nestjs",
            )
        };
        return Some(RouteRef {
            method,
            path,
            handler_subject: Some(handler_subject.to_string()),
            handler_name: None,
            source: context.source.clone(),
            note,
            span: decorator_aware_span(node, source),
        });
    }
    if context.lang == LangKind::Rust {
        let attribute = preceding_rust_attribute(node, source)?;
        let name = attribute.trim_start_matches("#[").split_once('(')?.0;
        return Some(RouteRef {
            method: http_method(name)?,
            path: first_quoted_route_path(attribute)?,
            handler_subject: Some(handler_subject.to_string()),
            handler_name: None,
            source: context.source.clone(),
            note: "oaf.ingest:route-rocket",
            span: preceding_line_span(node),
        });
    }
    if context.lang == LangKind::Php {
        let attribute = php_route_attribute(node, source)?;
        let path = first_quoted_route_path(&attribute)?;
        let method = quoted_literals(&attribute)
            .into_iter()
            .skip(1)
            .find_map(|value| http_method(&value))?;
        return Some(RouteRef {
            method,
            path,
            handler_subject: Some(handler_subject.to_string()),
            handler_name: None,
            source: context.source.clone(),
            note: "oaf.ingest:route-symfony",
            span: CodeSpan::from_node(node),
        });
    }
    if context.lang != LangKind::Python {
        return None;
    }
    let parent = node.parent()?;
    if parent.kind() != "decorated_definition" {
        return None;
    }
    for line in node_text(parent, source).lines() {
        let line = line.trim();
        if !line.starts_with('@') {
            continue;
        }
        if let Some((method, path)) = python_route_decorator(line) {
            return Some(RouteRef {
                method,
                path,
                handler_subject: Some(handler_subject.to_string()),
                handler_name: None,
                source: context.source.clone(),
                note: "oaf.ingest:route-flask",
                span: CodeSpan::from_node(parent),
            });
        }
    }
    None
}

fn php_route_handler_name(text: &str) -> Option<String> {
    let (controller, _) = text.split_once("::class")?;
    let controller = last_identifier(controller).and_then(|name| sanitize_symbol(&name))?;
    let method = quoted_literals(text).into_iter().last()?;
    let method = sanitize_symbol(&method)?;
    Some(format!("{controller}_{method}"))
}

fn ruby_rails_handler_name(text: &str) -> Option<String> {
    let target = quoted_literals(text)
        .into_iter()
        .find(|value| value.contains('#'))?;
    let (controller, action) = target.split_once('#')?;
    let controller = controller
        .split('/')
        .map(|segment| {
            let mut chars = segment.chars();
            chars
                .next()
                .map(|first| format!("{}{}", first.to_ascii_uppercase(), chars.as_str()))
                .unwrap_or_default()
        })
        .collect::<String>();
    let controller = format!("{controller}Controller");
    Some(format!("{controller}_{}", sanitize_symbol(action)?))
}

fn php_route_attribute(node: Node<'_>, source: &[u8]) -> Option<String> {
    if let Some(attribute) = first_descendant_matching(node, &|child| {
        matches!(child.kind(), "attribute_list" | "attribute_group")
    }) {
        return Some(node_text(attribute, source).to_string());
    }
    if let Some(attribute) = node
        .prev_named_sibling()
        .filter(|sibling| matches!(sibling.kind(), "attribute_list" | "attribute_group"))
    {
        return Some(node_text(attribute, source).to_string());
    }
    let prefix = std::str::from_utf8(source.get(..node.start_byte())?).ok()?;
    prefix
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .filter(|line| line.trim_start().starts_with("#[Route("))
        .map(|line| line.trim().to_string())
}

fn controller_route_prefix(text: &str, lang: LangKind) -> Option<String> {
    let marker = match lang {
        LangKind::Java => "@RequestMapping",
        LangKind::CSharp => "Route",
        _ => return None,
    };
    annotation_route_path(text, marker).or_else(|| Some("/".to_string()))
}

fn annotation_http_route(text: &str, mappings: &[(&str, &str)]) -> Option<(String, String)> {
    for (marker, method) in mappings {
        if !text.contains(marker) {
            continue;
        }
        let path = annotation_route_path(text, marker).unwrap_or_else(|| "/".to_string());
        return Some(((*method).to_string(), path));
    }
    None
}

fn annotation_route_path(text: &str, marker: &str) -> Option<String> {
    let (_, tail) = text.split_once(marker)?;
    let arguments = tail.split_once('(')?.1.split_once(')')?.0;
    let path = quoted_literals(arguments).into_iter().next()?;
    Some(ensure_route_path(&path))
}

fn ensure_route_path(path: &str) -> String {
    let path = path.trim();
    if path.starts_with('/') {
        canon_route_path(path)
    } else {
        canon_route_path(&format!("/{path}"))
    }
}

fn preceding_rust_attribute<'a>(node: Node<'_>, source: &'a [u8]) -> Option<&'a str> {
    let prefix = std::str::from_utf8(source.get(..node.start_byte())?).ok()?;
    prefix
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .map(str::trim)
        .filter(|line| line.starts_with("#["))
}

fn preceding_line_span(node: Node<'_>) -> CodeSpan {
    let mut span = CodeSpan::from_node(node);
    if span.start_line > 1 {
        span.start_line -= 1;
        span.start_column = 0;
    }
    span
}

fn nest_controller_prefix(text: &str) -> Option<String> {
    text.lines()
        .find(|line| line.trim_start().starts_with("@Controller"))
        .and_then(first_quoted_route_path)
        .or_else(|| text.contains("@Controller()").then(|| "/".to_string()))
}

fn nest_method_route(node: Node<'_>, source: &[u8]) -> Option<(String, String)> {
    let decorator = preceding_decorator(node, source)?;
    for line in decorator.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix('@') else {
            continue;
        };
        let decorator = rest.split_once('(')?.0;
        let method = http_method(decorator)?;
        let path = first_quoted_route_path(line).unwrap_or_else(|| "/".to_string());
        return Some((method, path));
    }
    None
}

fn preceding_decorator<'a>(node: Node<'_>, source: &'a [u8]) -> Option<&'a str> {
    let parent = node.parent()?;
    let prefix = source.get(parent.start_byte()..node.start_byte())?;
    let current_line_start = prefix.iter().rposition(|byte| *byte == b'\n')?;
    let before_current_line = &prefix[..current_line_start];
    let previous_line_start = before_current_line
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |index| index + 1);
    let previous_line = std::str::from_utf8(&before_current_line[previous_line_start..]).ok()?;
    previous_line
        .trim_start()
        .starts_with('@')
        .then_some(previous_line)
}

fn decorator_aware_span(node: Node<'_>, source: &[u8]) -> CodeSpan {
    let mut span = CodeSpan::from_node(node);
    if preceding_decorator(node, source).is_some() && span.start_line > 1 {
        span.start_line -= 1;
        span.start_column = 0;
    }
    span
}

fn join_route_paths(prefix: &str, suffix: &str) -> String {
    let prefix = prefix.trim_end_matches('/');
    let suffix = suffix.trim_start_matches('/');
    canon_route_path(&format!("{prefix}/{suffix}"))
}

fn next_server_route_path(source: &str) -> Option<String> {
    let relative = source.strip_prefix("workspace://")?;
    let parts = relative.split('/').collect::<Vec<_>>();
    let app_index = parts.iter().position(|part| *part == "app")?;
    let file = *parts.last()?;
    if !matches!(file, "route.ts" | "route.tsx" | "route.js" | "route.jsx") {
        return None;
    }
    let segments = parts[app_index + 1..parts.len() - 1]
        .iter()
        .filter(|segment| !segment.starts_with('(') || !segment.ends_with(')'))
        .map(|segment| {
            if segment.starts_with('[') && segment.ends_with(']') {
                ":param"
            } else {
                *segment
            }
        })
        .collect::<Vec<_>>();
    Some(canon_route_path(&format!("/{}", segments.join("/"))))
}

fn python_route_decorator(line: &str) -> Option<(String, String)> {
    let before_paren = line.split_once('(')?.0;
    let method = before_paren
        .rsplit_once('.')
        .and_then(|(_, method)| http_method(method))
        .or_else(|| before_paren.ends_with(".route").then(|| "GET".to_string()))?;
    let path = first_quoted_route_path(line)?;
    let method = if before_paren.ends_with(".route") {
        route_methods_argument(line).unwrap_or(method)
    } else {
        method
    };
    Some((method, path))
}

fn route_methods_argument(line: &str) -> Option<String> {
    let methods = line.split("methods").nth(1)?;
    for quoted in quoted_literals(methods) {
        let method = quoted.to_ascii_uppercase();
        if is_http_method(&method) {
            return Some(method);
        }
    }
    None
}

fn first_quoted_route_path(text: &str) -> Option<String> {
    quoted_literals(text)
        .into_iter()
        .find(|value| value.starts_with('/'))
        .map(|value| canon_route_path(&value))
}

fn route_handler_name(text: &str) -> Option<String> {
    let args = text.split_once('(')?.1.rsplit_once(')')?.0;
    let candidate = args.rsplit(',').next()?.trim();
    if candidate.starts_with(['(', '{']) || candidate.contains("=>") {
        return None;
    }
    sanitize_symbol(candidate)
}

fn http_method(value: &str) -> Option<String> {
    let method = value.to_ascii_uppercase();
    is_http_method(&method).then_some(method)
}

fn is_http_method(method: &str) -> bool {
    matches!(
        method,
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD"
    )
}

fn route_id(method: &str, path: &str) -> String {
    let path_token = path
        .trim_start_matches('/')
        .replace(":param", "param")
        .replace('/', "_");
    let token = sanitize_symbol(&format!(
        "{}_{}",
        method,
        if path_token.is_empty() {
            "root".to_string()
        } else {
            path_token
        }
    ))
    .unwrap_or_else(|| format!("{}_root", method));
    format!("route:{token}")
}

fn canon_route_path(path: &str) -> String {
    let mut out = String::new();
    let mut chars = path.trim().chars().peekable();
    while let Some(ch) = chars.next() {
        let at_segment_start = out.is_empty() || out.ends_with('/');
        if ch == ':' && at_segment_start && chars.peek().is_some_and(|next| is_route_ident(*next)) {
            while chars.peek().is_some_and(|next| is_route_ident(*next)) {
                chars.next();
            }
            out.push_str(":param");
        } else if ch == '<' {
            for next in chars.by_ref() {
                if next == '>' || next == '/' {
                    break;
                }
            }
            out.push_str(":param");
        } else if ch == '{' {
            for next in chars.by_ref() {
                if next == '}' || next == '/' {
                    break;
                }
            }
            out.push_str(":param");
        } else if ch == '$' && chars.peek() == Some(&'{') {
            chars.next();
            for next in chars.by_ref() {
                if next == '}' || next == '/' {
                    break;
                }
            }
            out.push_str(":param");
        } else {
            out.push(ch);
        }
    }
    if out.is_empty() {
        "/".to_string()
    } else {
        out
    }
}

fn is_route_ident(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

fn is_import_node(kind: &str) -> bool {
    matches!(
        kind,
        "import_statement"
            | "import_from_statement"
            | "import_declaration"
            | "import_spec"
            | "import"
            | "library_import"
            | "use_declaration"
            | "namespace_use_declaration"
            | "preproc_include"
            | "include_expression"
            | "include_once_expression"
            | "source_command"
            | "using_directive"
    )
}

fn import_targets(node: Node<'_>, source: &[u8], lang: LangKind) -> Vec<ImportTarget> {
    if lang == LangKind::Go
        && node.kind() == "import_declaration"
        && descendant_has_kind(node, "import_spec")
    {
        return Vec::new();
    }
    let text = node_text(node, source);
    let mut out = Vec::new();
    for quoted in quoted_literals(text) {
        let target = if lang == LangKind::Go {
            go_import_target_from_raw(&quoted)
        } else {
            import_target_from_raw(&quoted)
        };
        if let Some(target) = target {
            out.push(target);
        }
    }
    if out.is_empty() {
        match lang {
            LangKind::Python => {
                let cleaned = text.trim();
                let raw = cleaned
                    .strip_prefix("from ")
                    .and_then(|rest| rest.split_whitespace().next())
                    .or_else(|| {
                        cleaned
                            .strip_prefix("import ")
                            .and_then(|rest| rest.split([',', ' ']).next())
                    });
                if let Some(raw) = raw.and_then(import_target_from_raw) {
                    out.push(raw);
                }
            }
            LangKind::Rust => {
                if let Some(raw) = text
                    .trim()
                    .strip_prefix("use ")
                    .and_then(import_target_from_raw)
                {
                    out.push(raw);
                }
            }
            LangKind::Java => {
                if let Some(raw) = text
                    .trim()
                    .strip_prefix("import ")
                    .and_then(import_target_from_raw)
                {
                    out.push(raw);
                }
            }
            LangKind::CSharp => {
                let cleaned = text.trim().trim_start_matches("global ");
                if let Some(raw) = cleaned
                    .strip_prefix("using ")
                    .map(|value| value.split_once('=').map_or(value, |(_, target)| target))
                    .and_then(import_target_from_raw)
                {
                    out.push(raw);
                }
            }
            LangKind::Php => {
                let cleaned = text.trim();
                let raw = cleaned
                    .strip_prefix("use ")
                    .or_else(|| cleaned.strip_prefix("include "));
                if let Some(raw) = raw.and_then(import_target_from_raw) {
                    out.push(raw);
                }
            }
            LangKind::Kotlin
            | LangKind::Swift
            | LangKind::Scala
            | LangKind::Dart
            | LangKind::Julia => {
                if let Some(raw) = text
                    .trim()
                    .strip_prefix("import ")
                    .or_else(|| text.trim().strip_prefix("include "))
                    .and_then(import_target_from_raw)
                {
                    out.push(raw);
                }
            }
            _ => {}
        }
    }
    out.sort_by(|left, right| {
        left.raw
            .cmp(&right.raw)
            .then(left.fallback.cmp(&right.fallback))
    });
    out.dedup_by(|left, right| left.raw == right.raw && left.fallback == right.fallback);
    out
}

fn php_use_alias(text: &str) -> Option<(String, String)> {
    let declaration = text
        .trim()
        .strip_prefix("use ")?
        .trim_end_matches(';')
        .trim();
    let declaration = declaration
        .strip_prefix("function ")
        .or_else(|| declaration.strip_prefix("const "))
        .unwrap_or(declaration)
        .trim();
    if declaration.contains(['{', '}', ',']) {
        return None;
    }
    let lower = declaration.to_ascii_lowercase();
    let (target, alias) = if let Some(index) = lower.find(" as ") {
        (&declaration[..index], declaration[index + 4..].to_string())
    } else {
        (declaration, last_identifier(declaration)?)
    };
    let target = normalize_container_name(target.trim().trim_start_matches('\\'))?;
    let alias = sanitize_symbol(&alias)?;
    Some((alias, target))
}

fn php_trait_use_targets(text: &str) -> Vec<String> {
    let Some(declaration) = text.trim().strip_prefix("use ") else {
        return Vec::new();
    };
    let declaration = declaration
        .split_once('{')
        .map(|(head, _)| head)
        .unwrap_or(declaration)
        .trim_end_matches(';')
        .trim();
    declaration
        .split(',')
        .filter_map(|target| last_identifier(target).and_then(|name| sanitize_symbol(&name)))
        .collect()
}

fn ruby_mixin_target(text: &str) -> Option<String> {
    let trimmed = text.trim();
    let remainder = trimmed
        .strip_prefix("include ")
        .or_else(|| trimmed.strip_prefix("include("))?
        .trim();
    let candidate = remainder.trim_end_matches(')').split(',').next()?.trim();
    if candidate.is_empty()
        || !candidate.split("::").all(|segment| {
            segment
                .chars()
                .next()
                .is_some_and(|first| first.is_ascii_uppercase())
                && segment
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        })
    {
        return None;
    }
    last_identifier(candidate).and_then(|name| sanitize_symbol(&name))
}

fn descendant_has_kind(node: Node<'_>, expected: &str) -> bool {
    for index in 0..node.named_child_count() {
        let Some(child) = node.named_child(index) else {
            continue;
        };
        if child.kind() == expected || descendant_has_kind(child, expected) {
            return true;
        }
    }
    false
}

fn import_target_from_raw(value: &str) -> Option<ImportTarget> {
    Some(ImportTarget {
        raw: clean_import_raw(value)?,
        fallback: module_from_import(value)?,
    })
}

fn go_import_target_from_raw(value: &str) -> Option<ImportTarget> {
    let raw = clean_import_raw(value)?;
    if raw.len() > 512
        || raw
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    {
        return None;
    }
    Some(ImportTarget {
        fallback: format!("module:{raw}"),
        raw,
    })
}

fn clean_import_raw(value: &str) -> Option<String> {
    let mut trimmed = value
        .trim()
        .trim_matches(['"', '\'', '`', ';', '{', '}', '(', ')']);
    trimmed = trimmed.strip_prefix("static ").unwrap_or(trimmed);
    trimmed = trimmed
        .split_once(" as ")
        .map_or(trimmed, |(target, _)| target);
    trimmed = trimmed
        .split_once('=')
        .map_or(trimmed, |(_, target)| target.trim());
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

fn module_from_import(value: &str) -> Option<String> {
    let relative = value.trim().starts_with('.');
    let trimmed = value
        .trim()
        .trim_matches(['"', '\'', '`', ';', '{', '}', '(', ')'])
        .trim_start_matches("crate::")
        .trim_start_matches("super::")
        .trim_start_matches("./")
        .trim_start_matches("../");
    let trimmed = if relative {
        trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed)
    } else {
        trimmed
    };
    if let Some(builtin) = trimmed.strip_prefix("node:").and_then(sanitize_symbol) {
        return Some(format!("module:node:{builtin}"));
    }
    if !relative {
        if let Some((scope, package)) = trimmed
            .strip_prefix('@')
            .and_then(|value| value.split_once('/'))
        {
            if !package.contains('/')
                && valid_npm_package_segment(scope)
                && valid_npm_package_segment(package)
            {
                return Some(format!("module:{trimmed}"));
            }
        }
    }
    let first = trimmed
        .split([':', '/', '.', ' ', ',', '{', '}'])
        .find(|part| !part.is_empty())?;
    if !relative && !trimmed.starts_with('@') && valid_npm_package_segment(first) {
        return Some(format!("module:{first}"));
    }
    sanitize_symbol(first).map(|token| format!("module:{token}"))
}

fn valid_npm_package_segment(value: &str) -> bool {
    value
        .bytes()
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn is_relative_source_reference(value: &str) -> bool {
    let value = value.trim();
    !value.contains(':') && strip_known_extension(value) != value
}

fn resolve_relative_import(source_rel: &str, raw: &str) -> Option<String> {
    let raw = raw.trim();
    if !raw.starts_with('.') {
        return None;
    }
    let source_dir = source_rel
        .rsplit_once('/')
        .map(|(dir, _)| dir)
        .unwrap_or("");
    let mut parts = Vec::new();
    for part in source_dir.split('/') {
        if !part.is_empty() {
            parts.push(part);
        }
    }
    for part in raw.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            value => parts.push(value),
        }
    }
    let joined = parts.join("/");
    Some(strip_known_extension(&joined).to_string())
}

fn resolve_package_import(entries: &BTreeMap<String, String>, raw: &str) -> Option<String> {
    let raw = raw
        .trim()
        .trim_start_matches("crate::")
        .trim_start_matches("self::")
        .trim_start_matches("super::");
    if raw.is_empty() {
        return None;
    }
    if let Some(stem) = entries.get(raw) {
        return Some(stem.clone());
    }
    for (pattern, stem) in entries.iter().filter(|(key, _)| key.ends_with("/*")) {
        let prefix = pattern.trim_end_matches('*');
        let Some(suffix) = raw.strip_prefix(prefix) else {
            continue;
        };
        if !suffix.is_empty() {
            return Some(format!("{stem}/{suffix}"));
        }
    }
    for separator in ['/', '.', ':'] {
        if let Some(stem) = resolve_package_prefix(entries, raw, separator) {
            return Some(stem);
        }
    }
    None
}

fn resolve_package_prefix(
    entries: &BTreeMap<String, String>,
    raw: &str,
    separator: char,
) -> Option<String> {
    let mut split_points = raw
        .char_indices()
        .filter_map(|(index, ch)| (ch == separator).then_some(index))
        .collect::<Vec<_>>();
    split_points.reverse();
    for index in split_points {
        let prefix = &raw[..index];
        let Some(stem) = entries.get(prefix) else {
            continue;
        };
        if stem == "." {
            let suffix = raw[index + separator.len_utf8()..]
                .replace("::", "/")
                .replace('.', "/");
            return (!suffix.is_empty()).then_some(suffix);
        }
        if separator == '.' {
            let suffix = raw[index + 1..].replace('.', "/");
            if !suffix.is_empty() && !stem.ends_with("src/lib") && !stem.ends_with("src/index") {
                return Some(format!("{stem}/{suffix}"));
            }
        }
        return Some(stem.clone());
    }
    None
}

fn strip_known_extension(path: &str) -> &str {
    for ext in [
        ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".rs", ".go", ".java", ".c", ".h",
        ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx", ".rb", ".php", ".cs", ".swift", ".kt",
        ".kts", ".lua", ".sh", ".bash", ".zsh", ".sql", ".m", ".mm", ".scala", ".sc", ".dart",
        ".r", ".R", ".jl", ".zig",
    ] {
        if let Some(stem) = path.strip_suffix(ext) {
            return stem;
        }
    }
    path
}

fn quoted_literals(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut quote = None;
    let mut current = String::new();
    for ch in value.chars() {
        match quote {
            Some(active) if ch == active => {
                out.push(current.clone());
                current.clear();
                quote = None;
            }
            Some(_) => current.push(ch),
            None if ch == '"' || ch == '\'' || ch == '`' => quote = Some(ch),
            None => {}
        }
    }
    out
}

fn rust_impl_name(node: Node<'_>, source: &[u8]) -> Option<String> {
    if let Some(child) = node.child_by_field_name("type") {
        return heritage_target_name(child, source);
    }
    let text = node_text(node, source);
    let before_body = text.split('{').next().unwrap_or(text);
    before_body
        .split_whitespace()
        .rev()
        .find_map(|part| sanitize_symbol(part.trim_matches(['&', '*', '<', '>', ','])))
}

fn go_receiver_name(text: &str) -> Option<String> {
    let receiver = text.strip_prefix("func (")?.split(')').next()?;
    receiver
        .split_whitespace()
        .last()
        .and_then(|part| sanitize_symbol(part.trim_start_matches('*')))
}

fn python_type_bindings(node: Node<'_>, source: &[u8]) -> BTreeMap<String, String> {
    let mut bindings = BTreeMap::new();
    for line in node_text(node, source).lines() {
        if let Some((name, class_name)) = python_assignment_type(line) {
            bindings.insert(name, class_name);
        }
    }
    bindings
}

fn python_assignment_type(line: &str) -> Option<(String, String)> {
    let without_comment = line.split('#').next().unwrap_or(line).trim();
    let (left, right) = without_comment.split_once('=')?;
    if left
        .chars()
        .last()
        .is_some_and(|ch| matches!(ch, '!' | '<' | '>' | '='))
        || right.starts_with('=')
    {
        return None;
    }
    let name = python_assignment_lhs(left.trim())?;
    let class_name = python_constructor_name(right.trim())?;
    Some((name, class_name))
}

fn python_assignment_lhs(value: &str) -> Option<String> {
    let name = value.split_once(':').map(|(name, _)| name).unwrap_or(value);
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '.')
    {
        return None;
    }
    sanitize_symbol(trimmed)
}

fn python_constructor_name(value: &str) -> Option<String> {
    let before_paren = value.split_once('(')?.0.trim();
    let name = before_paren.rsplit('.').next()?.trim();
    if !name
        .chars()
        .next()
        .is_some_and(|ch| ch.is_ascii_uppercase())
    {
        return None;
    }
    sanitize_symbol(name)
}

fn node_text<'a>(node: Node<'_>, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or("")
}

fn last_identifier(value: &str) -> Option<String> {
    let mut current = String::new();
    let mut best = None;
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            current.push(ch);
        } else if !current.is_empty() {
            best = Some(current.clone());
            current.clear();
        }
    }
    if !current.is_empty() {
        best = Some(current);
    }
    best
}

fn symbol_kind(subject: &str) -> &'static str {
    if subject.starts_with("method:") {
        "Method"
    } else if subject.starts_with("class:") {
        "Class"
    } else if subject.starts_with("module:") {
        "Module"
    } else if subject.starts_with("file:") {
        "File"
    } else {
        "Function"
    }
}

fn sanitize_symbol(value: &str) -> Option<String> {
    let mut out = String::new();
    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '$') {
            out.push(ch);
        } else if ch == '-' && !out.ends_with('_') {
            out.push('_');
        }
    }
    if out.is_empty() {
        return None;
    }
    if out.chars().next().is_some_and(|ch| ch.is_ascii_digit()) {
        out.insert(0, 'n');
    }
    if out.len() > 96 {
        out.truncate(96);
    }
    Some(out)
}

fn normalize_symbol_lookup_name(value: &str) -> Option<String> {
    normalize_container_name(value.trim().trim_start_matches('\\'))
        .or_else(|| sanitize_symbol(value))
}

fn path_token(rel: &str) -> String {
    sanitize_symbol(&rel.replace(['/', '.', '-'], "_")).unwrap_or_else(|| "root".to_string())
}

fn module_token(rel: &str) -> String {
    let without_ext = rel.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(rel);
    path_token(without_ext)
}

fn language_for_path(path: &Path) -> Option<LangKind> {
    match path.extension().and_then(|value| value.to_str())? {
        "js" | "jsx" | "mjs" | "cjs" => Some(LangKind::JavaScript),
        "ts" | "mts" | "cts" => Some(LangKind::TypeScript),
        "tsx" => Some(LangKind::Tsx),
        "py" => Some(LangKind::Python),
        "rs" => Some(LangKind::Rust),
        "go" => Some(LangKind::Go),
        "java" => Some(LangKind::Java),
        "c" | "h" => Some(LangKind::C),
        "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" => Some(LangKind::Cpp),
        "rb" => Some(LangKind::Ruby),
        "php" => Some(LangKind::Php),
        "cs" => Some(LangKind::CSharp),
        "swift" => Some(LangKind::Swift),
        "kt" | "kts" => Some(LangKind::Kotlin),
        "lua" => Some(LangKind::Lua),
        "sh" | "bash" | "zsh" => Some(LangKind::Bash),
        "sql" => Some(LangKind::Sql),
        "m" | "mm" => Some(LangKind::ObjectiveC),
        "scala" | "sc" => Some(LangKind::Scala),
        "dart" => Some(LangKind::Dart),
        "r" | "R" => Some(LangKind::R),
        "jl" => Some(LangKind::Julia),
        "zig" => Some(LangKind::Zig),
        _ => None,
    }
}

fn language_for_path_with_options(path: &Path, options: &IngestOptions) -> Option<LangKind> {
    if options.prefer_cpp_headers && path.extension().and_then(|value| value.to_str()) == Some("h")
    {
        Some(LangKind::Cpp)
    } else {
        language_for_path(path)
    }
}

fn is_build_configuration(path: &Path) -> bool {
    path.file_name().and_then(|name| name.to_str()) == Some("CMakeLists.txt") || is_makefile(path)
}

fn is_makefile(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == "Makefile" || name.starts_with("Makefile."))
}

fn should_descend(entry: &DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy();
    !matches!(
        name.as_ref(),
        ".git" | ".local" | "node_modules" | "target" | "dist" | "build" | "coverage"
    )
}

fn workspace_rel(root: &Path, path: &Path) -> Result<String> {
    let rel = path
        .strip_prefix(root)
        .with_context(|| format!("path escaped workspace root: {}", path.display()))?;
    let mut parts = Vec::new();
    for component in rel.components() {
        match component {
            Component::Normal(value) => parts.push(value.to_string_lossy().to_string()),
            Component::CurDir => {}
            _ => bail!("path escaped workspace root: {}", path.display()),
        }
    }
    Ok(parts.join("/"))
}

fn short_hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
        .chars()
        .take(16)
        .collect()
}

fn stable_hash64(parts: &[&str]) -> u64 {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update((part.len() as u64).to_le_bytes());
        hasher.update(part.as_bytes());
    }
    let digest = hasher.finalize();
    u64::from_le_bytes(digest[..8].try_into().unwrap())
}

#[cfg(test)]
include!("../test-support/lib_unit.rs");

#[cfg(test)]
mod bounded_hash_discovery_tests {
    use super::*;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn fixture_root() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "memory-recall-hash-discovery-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn bounded_hash_discovery_fails_closed_at_each_resource_cap() {
        let root = fixture_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("a.ts"), "export const a = 1;\n").unwrap();
        fs::write(root.join("b.ts"), "export const b = 2;\n").unwrap();
        let options = IngestOptions::new(&root);

        let complete = discover_file_hashes_bounded(
            &options,
            &FileHashDiscoveryBounds {
                max_candidate_files: 2,
                max_hashed_bytes: 1024,
                selected_file_limit: None,
                deadline: Instant::now() + Duration::from_secs(1),
            },
            |_| true,
        )
        .unwrap();
        assert!(complete.complete);
        assert_eq!(complete.hashes.len(), 2);

        let candidate_capped = discover_file_hashes_bounded(
            &options,
            &FileHashDiscoveryBounds {
                max_candidate_files: 1,
                max_hashed_bytes: 1024,
                selected_file_limit: None,
                deadline: Instant::now() + Duration::from_secs(1),
            },
            |_| true,
        )
        .unwrap();
        assert!(!candidate_capped.complete);
        assert_eq!(
            candidate_capped.reason_codes,
            vec!["source_index_freshness_candidate_cap"]
        );

        let byte_capped = discover_file_hashes_bounded(
            &options,
            &FileHashDiscoveryBounds {
                max_candidate_files: 2,
                max_hashed_bytes: 1,
                selected_file_limit: None,
                deadline: Instant::now() + Duration::from_secs(1),
            },
            |_| true,
        )
        .unwrap();
        assert!(!byte_capped.complete);
        assert_eq!(
            byte_capped.reason_codes,
            vec!["source_index_freshness_byte_cap"]
        );

        let deadline_capped = discover_file_hashes_bounded(
            &options,
            &FileHashDiscoveryBounds {
                max_candidate_files: 2,
                max_hashed_bytes: 1024,
                selected_file_limit: None,
                deadline: Instant::now(),
            },
            |_| true,
        )
        .unwrap();
        assert!(!deadline_capped.complete);
        assert_eq!(
            deadline_capped.reason_codes,
            vec!["source_index_freshness_deadline_exceeded"]
        );

        fs::remove_dir_all(root).unwrap();
    }
}
