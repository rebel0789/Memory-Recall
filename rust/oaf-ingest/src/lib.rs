use anyhow::{bail, Context, Result};
use ignore::{DirEntry, WalkBuilder};
use oaf_store::{ActiveFactSnapshot, BatchFact, Supersedes};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::Instant;
use tree_sitter::{Language, Node, Parser};

pub const DEFAULT_MAX_MEMORY_BYTES: u64 = 350 * 1024 * 1024;
pub const DEFAULT_MAX_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone)]
pub struct IngestOptions {
    pub root: PathBuf,
    pub max_memory_bytes: u64,
    pub max_file_bytes: u64,
}

impl IngestOptions {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            max_memory_bytes: DEFAULT_MAX_MEMORY_BYTES,
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
        }
    }
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
    pub elapsed_ms: u128,
    pub skipped_files: Vec<SkippedFile>,
    #[serde(skip)]
    pub facts: Vec<BatchFact>,
    pub language_counts: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkippedFile {
    pub workspace_ref: String,
    pub reason: String,
    pub bytes: u64,
}

#[derive(Debug, Clone)]
struct ParsedRepo {
    facts: BTreeSet<FactKey>,
    calls: Vec<CallRef>,
    definitions_by_name: BTreeMap<String, BTreeSet<String>>,
    generated_call_count: usize,
    import_count: usize,
    definition_count: usize,
}

impl ParsedRepo {
    fn new() -> Self {
        Self {
            facts: BTreeSet::new(),
            calls: Vec::new(),
            definitions_by_name: BTreeMap::new(),
            generated_call_count: 0,
            import_count: 0,
            definition_count: 0,
        }
    }

    fn add_entity(
        &mut self,
        subject: String,
        kind: &'static str,
        source: &str,
        note: &'static str,
    ) {
        self.add_fact(subject, "IS_A", kind.to_string(), source, note);
    }

    fn add_definition(&mut self, owner: &str, symbol: &str, source: &str, note: &'static str) {
        self.definition_count += 1;
        self.add_fact(
            owner.to_string(),
            "DEFINES",
            symbol.to_string(),
            source,
            note,
        );
    }

    fn add_import(&mut self, owner: &str, target: &str, source: &str) {
        self.import_count += 1;
        self.add_entity(
            target.to_string(),
            "Module",
            source,
            "oaf.ingest:import-module",
        );
        self.add_fact(
            owner.to_string(),
            "IMPORTS",
            target.to_string(),
            source,
            "oaf.ingest:import",
        );
    }

    fn add_fact(
        &mut self,
        subject: String,
        predicate: &'static str,
        object: String,
        source: &str,
        note: &'static str,
    ) {
        self.facts.insert(FactKey {
            subject,
            predicate: predicate.to_string(),
            object,
            source: source.to_string(),
            note: note.to_string(),
        });
    }

    fn add_symbol_name(&mut self, name: &str, subject: &str) {
        self.definitions_by_name
            .entry(name.to_string())
            .or_default()
            .insert(subject.to_string());
    }

    fn add_call(&mut self, caller: &str, callee_name: &str, source: &str) {
        if callee_name.is_empty() || callee_name == "require" || callee_name == "super" {
            return;
        }
        self.generated_call_count += 1;
        self.calls.push(CallRef {
            caller: caller.to_string(),
            callee_name: callee_name.to_string(),
            source: source.to_string(),
        });
    }

    fn finish(mut self) -> Vec<BatchFact> {
        let calls = std::mem::take(&mut self.calls);
        for call in calls {
            let target = self.resolve_call_target(&call.callee_name);
            self.add_entity(
                target.clone(),
                symbol_kind(&target),
                &call.source,
                "oaf.ingest:call-target",
            );
            self.add_fact(
                call.caller,
                "CALLS",
                target,
                &call.source,
                "oaf.ingest:call",
            );
        }
        self.facts
            .into_iter()
            .map(FactKey::into_batch_fact)
            .collect()
    }

    fn resolve_call_target(&self, callee_name: &str) -> String {
        let name = sanitize_symbol(callee_name).unwrap_or_else(|| "unknown".to_string());
        match self.definitions_by_name.get(&name) {
            Some(subjects) if subjects.len() == 1 => subjects.iter().next().cloned().unwrap(),
            Some(subjects) => subjects
                .iter()
                .find(|subject| subject.starts_with("function:"))
                .cloned()
                .or_else(|| subjects.iter().next().cloned())
                .unwrap_or_else(|| format!("function:{name}")),
            None => format!("function:{name}"),
        }
    }
}

#[derive(Debug, Clone)]
struct CallRef {
    caller: String,
    callee_name: String,
    source: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
struct FactKey {
    subject: String,
    predicate: String,
    object: String,
    source: String,
    note: String,
}

impl FactKey {
    fn into_batch_fact(self) -> BatchFact {
        BatchFact {
            subject: self.subject,
            predicate: self.predicate,
            object: self.object,
            source: self.source,
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
}

impl LangKind {
    fn group(self) -> &'static str {
        match self {
            LangKind::JavaScript => "javascript-jsx",
            LangKind::TypeScript | LangKind::Tsx => "typescript-tsx",
            LangKind::Python => "python",
            LangKind::Rust => "rust",
            LangKind::Go => "go",
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
        }
    }
}

#[derive(Debug, Clone)]
struct WalkContext {
    module: String,
    source: String,
    lang: LangKind,
    class_name: Option<String>,
    impl_name: Option<String>,
    caller: Option<String>,
}

pub fn extract_repo(options: &IngestOptions) -> Result<IngestReport> {
    let started = Instant::now();
    let root = options.root.canonicalize().with_context(|| {
        format!(
            "ingest root must point at a local workspace directory: {}",
            options.root.display()
        )
    })?;
    let mut parsed = ParsedRepo::new();
    let mut skipped_files = Vec::new();
    let mut scanned_file_count = 0usize;
    let mut parsed_file_count = 0usize;
    let mut parsed_bytes = 0u64;
    let mut language_counts = BTreeMap::new();
    let mut parser = Parser::new();

    let mut builder = WalkBuilder::new(&root);
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
        let Some(lang) = language_for_path(path) else {
            continue;
        };
        scanned_file_count += 1;
        let rel = workspace_rel(&root, path)?;
        let source = format!("workspace://{rel}");
        let metadata = fs::metadata(path).with_context(|| format!("stat {source}"))?;
        let file_size = metadata.len();
        if file_size > options.max_file_bytes {
            skipped_files.push(SkippedFile {
                workspace_ref: source,
                reason: "file exceeds max-file-bytes and was not truncated".to_string(),
                bytes: file_size,
            });
            continue;
        }
        if parsed_bytes.saturating_add(file_size) > options.max_memory_bytes {
            skipped_files.push(SkippedFile {
                workspace_ref: source,
                reason: "max-memory cap reached before reading file".to_string(),
                bytes: file_size,
            });
            continue;
        }
        let canonical = path
            .canonicalize()
            .with_context(|| format!("canonicalize {source}"))?;
        if !canonical.starts_with(&root) {
            skipped_files.push(SkippedFile {
                workspace_ref: source,
                reason: "path resolves outside workspace root".to_string(),
                bytes: file_size,
            });
            continue;
        }
        let bytes = fs::read(path).with_context(|| format!("read {source}"))?;
        parsed_bytes += bytes.len() as u64;
        parser
            .set_language(&lang.language())
            .with_context(|| format!("load parser for {source}"))?;
        let tree = parser
            .parse(&bytes, None)
            .with_context(|| format!("parse {source}"))?;
        if tree.root_node().has_error() {
            skipped_files.push(SkippedFile {
                workspace_ref: source,
                reason: "tree-sitter parse error".to_string(),
                bytes: file_size,
            });
            continue;
        }
        let file_id = format!("file:{}", path_token(&rel));
        let module = format!("module:{}", module_token(&rel));
        parsed.add_entity(file_id.clone(), "File", &source, "oaf.ingest:file");
        parsed.add_entity(module.clone(), "Module", &source, "oaf.ingest:module");
        parsed.add_definition(&file_id, &module, &source, "oaf.ingest:file-defines-module");
        let context = WalkContext {
            module,
            source: source.clone(),
            lang,
            class_name: None,
            impl_name: None,
            caller: None,
        };
        walk_node(tree.root_node(), &bytes, &context, &mut parsed);
        parsed_file_count += 1;
        *language_counts.entry(lang.group().to_string()).or_insert(0) += 1;
    }

    let generated_call_count = parsed.generated_call_count;
    let import_count = parsed.import_count;
    let definition_count = parsed.definition_count;
    let facts = parsed.finish();
    Ok(IngestReport {
        scanned_file_count,
        parsed_file_count,
        skipped_file_count: skipped_files.len(),
        generated_fact_count: facts.len(),
        generated_call_count,
        import_count,
        definition_count,
        parsed_bytes,
        elapsed_ms: started.elapsed().as_millis(),
        skipped_files,
        facts,
        language_counts,
    })
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
        "elapsedMs": report.elapsed_ms,
        "languageCounts": report.language_counts,
        "skippedFiles": report.skipped_files
    })
}

fn walk_node(node: Node<'_>, source: &[u8], context: &WalkContext, parsed: &mut ParsedRepo) {
    if node.kind() == "call_expression" || node.kind() == "call" {
        if let Some(caller) = context.caller.as_deref() {
            if let Some(callee) = callee_name(node, source) {
                parsed.add_call(caller, &callee, &context.source);
            }
        }
    }

    if is_import_node(node.kind()) {
        for target in import_targets(node, source, context.lang) {
            parsed.add_import(&context.module, &target, &context.source);
        }
    }

    let mut next = context.clone();
    if let Some(class_name) = class_name(node, source, context.lang) {
        let class_id = format!("class:{class_name}");
        parsed.add_entity(
            class_id.clone(),
            "Class",
            &context.source,
            "oaf.ingest:class",
        );
        parsed.add_definition(
            &context.module,
            &class_id,
            &context.source,
            "oaf.ingest:define-class",
        );
        parsed.add_symbol_name(&class_name, &class_id);
        next.class_name = Some(class_name);
    }

    if context.lang == LangKind::Rust && node.kind() == "impl_item" {
        next.impl_name = rust_impl_name(node, source);
    }

    if let Some((name, subject, kind)) = callable_definition(node, source, context) {
        parsed.add_entity(
            subject.clone(),
            kind,
            &context.source,
            "oaf.ingest:callable",
        );
        parsed.add_definition(
            &context.module,
            &subject,
            &context.source,
            "oaf.ingest:define-callable",
        );
        if let Some(class_name) = context.class_name.as_deref() {
            parsed.add_definition(
                &format!("class:{class_name}"),
                &subject,
                &context.source,
                "oaf.ingest:class-defines-method",
            );
        }
        parsed.add_symbol_name(&name, &subject);
        if let Some((_, bare)) = name.rsplit_once('_') {
            parsed.add_symbol_name(bare, &subject);
        }
        next.caller = Some(subject);
    }

    for index in 0..node.named_child_count() {
        if let Some(child) = node.named_child(index) {
            walk_node(child, source, &next, parsed);
        }
    }
}

fn callable_definition(
    node: Node<'_>,
    source: &[u8],
    context: &WalkContext,
) -> Option<(String, String, &'static str)> {
    let kind = node.kind();
    match kind {
        "function_declaration" | "function_definition" | "function_item" => {
            let name = node_name(node, source)?;
            let sanitized = sanitize_symbol(&name)?;
            if context.lang == LangKind::Python && context.class_name.is_some() {
                let class_name = context.class_name.as_deref().unwrap();
                let method_name = format!("{class_name}_{sanitized}");
                return Some((
                    method_name.clone(),
                    format!("method:{method_name}"),
                    "Method",
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
            Some((
                sanitized.clone(),
                format!("function:{sanitized}"),
                "Function",
            ))
        }
        "method_definition" | "method_declaration" => {
            let name = node_name(node, source)?;
            let sanitized = sanitize_symbol(&name)?;
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
        _ => None,
    }
}

fn class_name(node: Node<'_>, source: &[u8], lang: LangKind) -> Option<String> {
    match node.kind() {
        "class_declaration" | "class" | "abstract_class_declaration" | "class_definition" => {
            node_name(node, source).and_then(|name| sanitize_symbol(&name))
        }
        "struct_item" | "enum_item" | "trait_item" if lang == LangKind::Rust => {
            node_name(node, source).and_then(|name| sanitize_symbol(&name))
        }
        "type_spec" if lang == LangKind::Go => {
            let text = node_text(node, source);
            if !text.contains("struct") && !text.contains("interface") {
                return None;
            }
            node_name(node, source).and_then(|name| sanitize_symbol(&name))
        }
        _ => None,
    }
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
                    )
                })
                .map(|child| node_text(child, source).to_string())
        })
}

fn callee_name(node: Node<'_>, source: &[u8]) -> Option<String> {
    let function = node
        .child_by_field_name("function")
        .or_else(|| node.named_child(0))?;
    let text = node_text(function, source);
    last_identifier(text).and_then(|name| sanitize_symbol(&name))
}

fn is_import_node(kind: &str) -> bool {
    matches!(
        kind,
        "import_statement"
            | "import_from_statement"
            | "import_declaration"
            | "import_spec"
            | "use_declaration"
    )
}

fn import_targets(node: Node<'_>, source: &[u8], lang: LangKind) -> Vec<String> {
    let text = node_text(node, source);
    let mut out = Vec::new();
    for quoted in quoted_literals(text) {
        if let Some(target) = module_from_import(&quoted) {
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
                if let Some(raw) = raw.and_then(module_from_import) {
                    out.push(raw);
                }
            }
            LangKind::Rust => {
                if let Some(raw) = text
                    .trim()
                    .strip_prefix("use ")
                    .and_then(module_from_import)
                {
                    out.push(raw);
                }
            }
            _ => {}
        }
    }
    out.sort();
    out.dedup();
    out
}

fn module_from_import(value: &str) -> Option<String> {
    let trimmed = value
        .trim()
        .trim_matches(['"', '\'', '`', ';', '{', '}', '(', ')'])
        .trim_start_matches("crate::")
        .trim_start_matches("super::")
        .trim_start_matches("./")
        .trim_start_matches("../");
    let first = trimmed
        .split([':', '/', '.', ' ', ',', '{', '}'])
        .find(|part| !part.is_empty())?;
    sanitize_symbol(first).map(|token| format!("module:{token}"))
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
        return sanitize_symbol(node_text(child, source));
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
    let mut last_underscore = false;
    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_underscore = false;
        } else if (ch == '_' || ch == '-') && !last_underscore && !out.is_empty() {
            out.push('_');
            last_underscore = true;
        }
    }
    while out.ends_with('_') {
        out.pop();
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
        "ts" => Some(LangKind::TypeScript),
        "tsx" => Some(LangKind::Tsx),
        "py" => Some(LangKind::Python),
        "rs" => Some(LangKind::Rust),
        "go" => Some(LangKind::Go),
        _ => None,
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_calls_to_functions_not_modules() {
        let mut parsed = ParsedRepo::new();
        parsed.add_symbol_name("runServer", "function:runServer");
        assert_eq!(
            parsed.resolve_call_target("runServer"),
            "function:runServer"
        );
        assert_eq!(
            parsed.resolve_call_target("missingModule"),
            "function:missingModule"
        );
    }

    #[test]
    fn emits_exact_retirement_facts() {
        let active = vec![ActiveFactSnapshot {
            subject: "function:OldName".to_string(),
            predicate: "IS_A".to_string(),
            object: "Function".to_string(),
            source: "workspace://src/a.ts".to_string(),
        }];
        let retirements = retirement_facts(&active, &[]);
        assert_eq!(retirements.len(), 1);
        assert_eq!(retirements[0].subject, "function:OldName");
        assert_eq!(
            retirements[0]
                .supersedes
                .as_ref()
                .and_then(|item| item.object.as_deref()),
            Some("Function")
        );
    }
}
