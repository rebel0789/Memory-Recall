use anyhow::{Context, Result};
use chrono::{SecondsFormat, Utc};
use oaf_ingest::{discover_file_hashes, extract_repo, CodeFactRecord, CodeSpan, IngestOptions};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::io::{self, BufRead, BufReader, Write};
use std::time::Instant;

const PROTOCOL_VERSION: &str = "1.0.0";
const GRAPH_VERSION: &str = "memory-recall-code-intelligence-1";
const MAX_LINE_BYTES: usize = 64 * 1024;
const FALLBACK_REQUEST_ID: &str = "cireq_00000000000000000000000000000000";
const REQUEST_KEYS: &[&str] = &[
    "protocolVersion",
    "requestId",
    "workspaceId",
    "operation",
    "root",
    "deadlineMs",
    "cancellationToken",
    "responseSchemaVersion",
    "arguments",
];
const ARGUMENT_KEYS: &[&str] = &[
    "maxFiles",
    "maxFileBytes",
    "maxNodes",
    "maxEdges",
    "languages",
];
const LANGUAGES: &[&str] = &[
    "typescript",
    "javascript",
    "python",
    "java",
    "kotlin",
    "csharp",
    "go",
    "rust",
    "php",
    "ruby",
    "swift",
    "c",
    "cpp",
    "dart",
    "lua",
    "bash",
    "sql",
    "objective-c",
    "scala",
    "r",
    "julia",
    "zig",
];

#[derive(Debug)]
struct EngineRequest {
    request_id: String,
    workspace_id: String,
    deadline_ms: u64,
    max_files: usize,
    max_file_bytes: u64,
    max_nodes: usize,
    max_edges: usize,
    languages: BTreeSet<String>,
}

#[derive(Debug, Clone, Copy)]
struct EngineFailure {
    code: &'static str,
    detail: &'static str,
    retryable: bool,
}

#[derive(Debug, Clone)]
struct NativeNode {
    subject: String,
    source: String,
    id: String,
    kind: &'static str,
    language: String,
    name: String,
    qualified_name: String,
    content_hash: Option<String>,
    span: CodeSpan,
}

#[derive(Debug)]
struct GraphBuild {
    graph: Value,
    scanned_file_count: usize,
    indexed_file_count: usize,
    omitted_node_count: usize,
    omitted_edge_count: usize,
}

type NodeLookup = BTreeMap<(String, String), String>;
type SubjectLookup = BTreeMap<String, Vec<(String, String)>>;
type NodeBuildOutput = (Vec<Value>, NodeLookup, SubjectLookup, usize);

pub fn serve_stdio(engine_version: &str) -> Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = stdout.lock();
    let mut line = Vec::new();
    loop {
        match read_bounded_line(&mut reader, &mut line, MAX_LINE_BYTES)? {
            LineRead::Eof => break,
            LineRead::Overflow => write_frame(
                &mut writer,
                &failure_frame(
                    FALLBACK_REQUEST_ID,
                    EngineFailure {
                        code: "engine_input_too_large",
                        detail: "request exceeds input limit",
                        retryable: false,
                    },
                ),
            )?,
            LineRead::Line => {
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                let value = match serde_json::from_slice::<Value>(&line) {
                    Ok(value) => value,
                    Err(_) => {
                        write_frame(
                            &mut writer,
                            &failure_frame(
                                FALLBACK_REQUEST_ID,
                                EngineFailure {
                                    code: "engine_invalid_json",
                                    detail: "invalid json",
                                    retryable: false,
                                },
                            ),
                        )?;
                        continue;
                    }
                };
                let request_id =
                    safe_request_id(&value).unwrap_or_else(|| FALLBACK_REQUEST_ID.to_string());
                let request = match parse_request(&value) {
                    Ok(request) => request,
                    Err(failure) => {
                        write_frame(&mut writer, &failure_frame(&request_id, failure))?;
                        continue;
                    }
                };
                let started = Instant::now();
                let frame = match build_graph(&request, engine_version, started) {
                    Ok(build) => success_frame(&request, build),
                    Err(failure) => failure_frame(&request.request_id, failure),
                };
                write_frame(&mut writer, &frame)?;
            }
        }
    }
    Ok(())
}

enum LineRead {
    Eof,
    Line,
    Overflow,
}

fn read_bounded_line<R: BufRead>(
    reader: &mut R,
    line: &mut Vec<u8>,
    max_bytes: usize,
) -> io::Result<LineRead> {
    line.clear();
    let mut overflow = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if line.is_empty() && !overflow {
                return Ok(LineRead::Eof);
            }
            return Ok(if overflow {
                LineRead::Overflow
            } else {
                LineRead::Line
            });
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        if !overflow {
            if line.len().saturating_add(consumed) > max_bytes {
                overflow = true;
                line.clear();
            } else {
                line.extend_from_slice(&available[..consumed]);
            }
        }
        reader.consume(consumed);
        if newline.is_some() {
            if !overflow && line.last() == Some(&b'\n') {
                line.pop();
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
            }
            return Ok(if overflow {
                LineRead::Overflow
            } else {
                LineRead::Line
            });
        }
    }
}

fn parse_request(value: &Value) -> std::result::Result<EngineRequest, EngineFailure> {
    let object = value.as_object().ok_or(invalid_request())?;
    if object.get("protocolVersion").and_then(Value::as_str) != Some(PROTOCOL_VERSION) {
        return Err(EngineFailure {
            code: "engine_unsupported_version",
            detail: "unsupported protocol version",
            retryable: false,
        });
    }
    if has_unknown_keys(object, REQUEST_KEYS) {
        return Err(invalid_request());
    }
    let request_id = object
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|value| valid_prefixed_hex(value, "cireq_"))
        .ok_or(invalid_request())?
        .to_string();
    let workspace_id = object
        .get("workspaceId")
        .and_then(Value::as_str)
        .filter(|value| valid_workspace_id(value))
        .ok_or(invalid_request())?
        .to_string();
    if object.get("operation").and_then(Value::as_str) != Some("graph.build") {
        return Err(EngineFailure {
            code: "engine_unsupported_operation",
            detail: "unsupported operation",
            retryable: false,
        });
    }
    if object.get("root").and_then(Value::as_str) != Some(".")
        || object.get("responseSchemaVersion").and_then(Value::as_str) != Some("1.0.0")
    {
        return Err(invalid_request());
    }
    if let Some(token) = object.get("cancellationToken") {
        if !token
            .as_str()
            .is_some_and(|value| valid_prefixed_hex(value, "cancel_"))
        {
            return Err(invalid_request());
        }
    }
    let deadline_ms = bounded_u64(object.get("deadlineMs"), 1, 120_000)?;
    let arguments = object
        .get("arguments")
        .and_then(Value::as_object)
        .ok_or(invalid_request())?;
    if has_unknown_keys(arguments, ARGUMENT_KEYS) {
        return Err(invalid_request());
    }
    let max_files = bounded_u64(arguments.get("maxFiles"), 1, 100_000)? as usize;
    let max_file_bytes = bounded_u64(arguments.get("maxFileBytes"), 1, 10_485_760)?;
    let max_nodes = bounded_u64(arguments.get("maxNodes"), 1, 5_000)? as usize;
    let max_edges = bounded_u64(arguments.get("maxEdges"), 1, 10_000)? as usize;
    let mut languages = BTreeSet::new();
    if let Some(values) = arguments.get("languages") {
        let values = values.as_array().ok_or(invalid_request())?;
        if values.len() > LANGUAGES.len() {
            return Err(invalid_request());
        }
        for value in values {
            let language = value.as_str().ok_or(invalid_request())?;
            if !LANGUAGES.contains(&language) || !languages.insert(language.to_string()) {
                return Err(invalid_request());
            }
        }
    }
    Ok(EngineRequest {
        request_id,
        workspace_id,
        deadline_ms,
        max_files,
        max_file_bytes,
        max_nodes,
        max_edges,
        languages,
    })
}

fn build_graph(
    request: &EngineRequest,
    engine_version: &str,
    started: Instant,
) -> std::result::Result<GraphBuild, EngineFailure> {
    let root = env::current_dir().map_err(|_| internal_failure())?;
    build_graph_at_root(request, engine_version, &root, started)
}

fn build_graph_at_root(
    request: &EngineRequest,
    engine_version: &str,
    root: &std::path::Path,
    started: Instant,
) -> std::result::Result<GraphBuild, EngineFailure> {
    check_deadline(request, started)?;
    let root = root.canonicalize().map_err(|_| internal_failure())?;
    let mut discovery_options = IngestOptions::new(&root);
    discovery_options.max_file_bytes = request.max_file_bytes;
    discovery_options.prefer_cpp_headers = prefers_cpp_headers(&request.languages);
    let mut hashes = discover_file_hashes(&discovery_options).map_err(|_| internal_failure())?;
    hashes.retain(|item| {
        source_language_for_request(&item.source, &request.languages).is_some_and(|language| {
            request.languages.is_empty() || request.languages.contains(language)
        })
    });
    hashes.sort_by(|left, right| left.source.cmp(&right.source));
    let discovered_file_count = hashes.len();
    let omitted_file_count = discovered_file_count.saturating_sub(request.max_files);
    hashes.truncate(request.max_files);
    let selected_sources = hashes
        .iter()
        .map(|item| item.source.clone())
        .collect::<BTreeSet<_>>();
    let mut options = IngestOptions::new(&root);
    options.max_file_bytes = request.max_file_bytes;
    options.only_sources = Some(selected_sources);
    options.prefer_cpp_headers = prefers_cpp_headers(&request.languages);
    let report = extract_repo(&options).map_err(|_| internal_failure())?;
    check_deadline(request, started)?;

    let hash_by_source = hashes
        .iter()
        .map(|item| (item.source.clone(), format!("sha256:{}", item.sha256)))
        .collect::<BTreeMap<_, _>>();
    let root_identity = fingerprint(&json!({
        "workspaceId": request.workspace_id,
        "files": hashes.iter().map(|item| json!({ "source": item.source, "sha256": item.sha256, "bytes": item.bytes })).collect::<Vec<_>>()
    }));
    let repository_id = format!("repo_{}", &root_identity[7..39]);
    let generation_fingerprint = fingerprint(&json!({
        "graphVersion": GRAPH_VERSION,
        "workspaceId": request.workspace_id,
        "rootIdentityHash": root_identity,
        "engineVersion": engine_version,
        "maxFiles": request.max_files,
        "maxFileBytes": request.max_file_bytes,
        "maxNodes": request.max_nodes,
        "maxEdges": request.max_edges,
        "languages": request.languages,
    }));
    let generation_id = format!("cigen_{}", &generation_fingerprint[7..39]);

    let (nodes, node_lookup, subject_lookup, candidate_node_count) = build_nodes(
        &report.code_facts,
        &hash_by_source,
        &request.workspace_id,
        &generation_id,
        &request.languages,
        request.max_nodes,
    );
    let (edges, candidate_edge_count) = build_edges(
        &report.code_facts,
        &node_lookup,
        &subject_lookup,
        &generation_id,
        &request.languages,
        request.max_edges,
    );
    let omitted_node_count = candidate_node_count.saturating_sub(nodes.len());
    let omitted_edge_count = candidate_edge_count.saturating_sub(edges.len());
    let coverage = build_coverage(
        request,
        &hashes,
        &report.language_counts,
        omitted_file_count,
    );
    let diagnostics = build_diagnostics(
        &report.skipped_files,
        &report.recovered_files,
        omitted_file_count,
        omitted_node_count,
        omitted_edge_count,
    );
    let built_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let structural = json!({
        "schemaVersion": "1.0.0",
        "graphVersion": GRAPH_VERSION,
        "repository": {
            "id": repository_id,
            "workspaceId": request.workspace_id,
            "rootIdentityHash": root_identity,
        },
        "engine": {
            "name": "memory-recall-native",
            "version": engine_version,
            "protocolVersion": PROTOCOL_VERSION,
        },
        "generation": {
            "id": generation_id,
            "freshness": if omitted_file_count + omitted_node_count + omitted_edge_count > 0 { "partial" } else { "current" },
        },
        "coverage": coverage,
        "nodes": nodes,
        "edges": edges,
        "diagnostics": diagnostics,
    });
    let graph_fingerprint = fingerprint(&structural);
    let mut graph = structural;
    graph["generation"]["builtAt"] = Value::String(built_at);
    graph["graphFingerprint"] = Value::String(graph_fingerprint);
    Ok(GraphBuild {
        graph,
        scanned_file_count: discovered_file_count,
        indexed_file_count: report.parsed_file_count,
        omitted_node_count,
        omitted_edge_count,
    })
}

fn build_nodes(
    facts: &[CodeFactRecord],
    hash_by_source: &BTreeMap<String, String>,
    workspace_id: &str,
    generation_id: &str,
    requested_languages: &BTreeSet<String>,
    max_nodes: usize,
) -> NodeBuildOutput {
    let parent_by_child = facts
        .iter()
        .filter(|fact| fact.predicate == "DEFINES")
        .map(|fact| {
            (
                (fact.object.clone(), fact.source.clone()),
                fact.subject.clone(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut candidates = facts
        .iter()
        .filter(|fact| fact.predicate == "IS_A")
        .filter_map(|fact| {
            native_node(
                fact,
                hash_by_source,
                workspace_id,
                &parent_by_child,
                requested_languages,
            )
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        left.source
            .cmp(&right.source)
            .then_with(|| node_priority(left.kind).cmp(&node_priority(right.kind)))
            .then_with(|| left.subject.cmp(&right.subject))
    });
    candidates.dedup_by(|left, right| left.subject == right.subject && left.source == right.source);
    let candidate_count = candidates.len();
    candidates.truncate(max_nodes);
    let mut node_lookup = BTreeMap::new();
    let mut subject_lookup: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    let nodes = candidates
        .into_iter()
        .map(|node| {
            node_lookup.insert((node.subject.clone(), node.source.clone()), node.id.clone());
            subject_lookup
                .entry(node.subject.clone())
                .or_default()
                .push((node.source.clone(), node.id.clone()));
            let mut value = json!({
                "id": node.id,
                "kind": node.kind,
                "language": node.language,
                "languageKind": language_kind(node.kind),
                "name": node.name,
                "qualifiedName": node.qualified_name,
                "locator": with_span(&node.source, node.span),
                "span": span_json(node.span),
                "generationId": generation_id,
                "freshness": "current",
            });
            if let Some(content_hash) = node.content_hash {
                value["contentHash"] = Value::String(content_hash);
            }
            value
        })
        .collect();
    (nodes, node_lookup, subject_lookup, candidate_count)
}

fn native_node(
    fact: &CodeFactRecord,
    hash_by_source: &BTreeMap<String, String>,
    workspace_id: &str,
    parent_by_child: &BTreeMap<(String, String), String>,
    requested_languages: &BTreeSet<String>,
) -> Option<NativeNode> {
    let kind = match fact.object.as_str() {
        "File" => "file",
        "Module" => "module",
        "Package" => "package",
        "Namespace" => "namespace",
        "Library" => "library",
        "Function" => "function",
        "Method" => "method",
        "Class" => "class",
        "Interface" => "interface",
        "Struct" => "struct",
        "Enum" => "enum",
        "Trait" => "trait",
        "Protocol" => "protocol",
        "Mixin" => "mixin",
        "Extension" => "extension",
        "TypeAlias" => "type_alias",
        "BuildTarget" => "build_target",
        "FrameworkComponent" => "framework_component",
        "Route" => "route",
        _ => return None,
    };
    let language = fact_language_for_request(fact, requested_languages)?.to_string();
    let raw_name = if kind == "file" {
        fact.source.rsplit('/').next().unwrap_or("source")
    } else {
        fact.subject
            .split_once(':')
            .map_or(fact.subject.as_str(), |(_, name)| name)
    };
    let parent = parent_by_child.get(&(fact.subject.clone(), fact.source.clone()));
    let name = safe_name(&display_symbol_name(raw_name, parent.map(String::as_str)));
    let relative = fact.source.strip_prefix("workspace://").unwrap_or("source");
    let qualified_name = qualified_symbol_name(
        relative,
        &fact.subject,
        &fact.source,
        &name,
        parent_by_child,
    );
    let id_fingerprint = fingerprint(&json!({
        "workspaceId": workspace_id,
        "source": fact.source,
        "subject": fact.subject,
        "kind": kind,
    }));
    Some(NativeNode {
        subject: fact.subject.clone(),
        source: fact.source.clone(),
        id: format!("cinode_{}", &id_fingerprint[7..39]),
        kind,
        language,
        name,
        qualified_name,
        content_hash: (kind == "file")
            .then(|| hash_by_source.get(&fact.source).cloned())
            .flatten(),
        span: fact.span,
    })
}

fn display_symbol_name(raw_name: &str, parent: Option<&str>) -> String {
    let Some(parent_name) = parent.and_then(|value| value.split_once(':').map(|(_, name)| name))
    else {
        return raw_name.to_string();
    };
    raw_name
        .strip_prefix(parent_name)
        .and_then(|value| value.strip_prefix(['_', '.']))
        .unwrap_or(raw_name)
        .to_string()
}

fn qualified_symbol_name(
    relative: &str,
    subject: &str,
    source: &str,
    name: &str,
    parent_by_child: &BTreeMap<(String, String), String>,
) -> String {
    let mut owners = Vec::new();
    let mut current = subject.to_string();
    let mut seen = BTreeSet::new();
    while seen.insert(current.clone()) {
        let Some(parent) = parent_by_child.get(&(current.clone(), source.to_string())) else {
            break;
        };
        if !parent.starts_with("file:") && !parent.starts_with("module:") {
            let raw = parent
                .split_once(':')
                .map_or(parent.as_str(), |(_, value)| value);
            let grandparent = parent_by_child.get(&(parent.clone(), source.to_string()));
            owners.push(display_symbol_name(raw, grandparent.map(String::as_str)));
        }
        current = parent.clone();
    }
    owners.reverse();
    owners.push(name.to_string());
    safe_name(&format!("{relative}::{}", owners.join("::")))
}

fn build_edges(
    facts: &[CodeFactRecord],
    node_lookup: &NodeLookup,
    subject_lookup: &SubjectLookup,
    generation_id: &str,
    requested_languages: &BTreeSet<String>,
    max_edges: usize,
) -> (Vec<Value>, usize) {
    let mut candidates = Vec::new();
    for fact in facts {
        let Some((kind, evidence_kind, resolver, confidence, resolution)) = edge_mapping(fact)
        else {
            continue;
        };
        let Some(from_node_id) =
            resolve_node(&fact.subject, &fact.source, node_lookup, subject_lookup)
        else {
            continue;
        };
        let Some(to_node_id) =
            resolve_node(&fact.object, &fact.source, node_lookup, subject_lookup)
        else {
            continue;
        };
        let language = match fact_language_for_request(fact, requested_languages) {
            Some(language) => language,
            None => continue,
        };
        let locator = with_span(&fact.source, fact.span);
        let edge_fingerprint = fingerprint(&json!({
            "kind": kind,
            "fromNodeId": from_node_id,
            "toNodeId": to_node_id,
            "locator": locator,
        }));
        candidates.push(json!({
            "id": format!("ciedge_{}", &edge_fingerprint[7..39]),
            "kind": kind,
            "fromNodeId": from_node_id,
            "toNodeId": to_node_id,
            "evidence": {
                "kind": evidence_kind,
                "locator": locator,
                "span": span_json(fact.span),
            },
            "resolver": {
                "name": resolver,
                "version": "0.1.0",
            },
            "confidence": confidence,
            "resolution": resolution,
            "language": language,
            "generationId": generation_id,
            "freshness": "current",
        }));
    }
    candidates.sort_by(|left, right| {
        edge_priority(
            left["kind"].as_str().unwrap_or(""),
            left["resolution"].as_str().unwrap_or("unresolved"),
        )
        .cmp(&edge_priority(
            right["kind"].as_str().unwrap_or(""),
            right["resolution"].as_str().unwrap_or("unresolved"),
        ))
        .then_with(|| left["kind"].as_str().cmp(&right["kind"].as_str()))
        .then_with(|| {
            left["fromNodeId"]
                .as_str()
                .cmp(&right["fromNodeId"].as_str())
        })
        .then_with(|| left["toNodeId"].as_str().cmp(&right["toNodeId"].as_str()))
    });
    candidates.dedup_by(|left, right| left["id"] == right["id"]);
    let candidate_count = candidates.len();
    candidates.truncate(max_edges);
    (candidates, candidate_count)
}

fn edge_priority(kind: &str, resolution: &str) -> u8 {
    match kind {
        "defines" | "contains" | "member_of" => 0,
        "imports" | "exports" | "re_exports" => 1,
        "inherits" | "implements" | "extends" | "mixes_in" | "extends_type" => 2,
        "depends_on" | "part_of" | "entry_point" | "handles_route" | "process_step" => 3,
        "constructs" | "references" | "reads" | "writes" | "emits" | "listens" => 4,
        "calls" if resolution == "typed" => 5,
        "calls" if resolution == "inferred" || resolution == "lexical" => 6,
        "calls" => 7,
        _ => 4,
    }
}

fn edge_mapping(
    fact: &CodeFactRecord,
) -> Option<(&'static str, &'static str, &'static str, f64, &'static str)> {
    match fact.predicate.as_str() {
        "DEFINES" => Some((
            "defines",
            "declaration",
            "memory-recall.declaration",
            1.0,
            "exact",
        )),
        "IMPORTS" if fact.note == "oaf.ingest:resolved-import" => {
            Some(("imports", "import", "memory-recall.import", 1.0, "exact"))
        }
        "IMPORTS" => Some((
            "imports",
            "import",
            "memory-recall.import",
            0.75,
            "unresolved",
        )),
        "RE_EXPORTS" if fact.note == "oaf.ingest:resolved-re-export" => {
            Some(("re_exports", "export", "memory-recall.export", 1.0, "exact"))
        }
        "RE_EXPORTS" => Some((
            "re_exports",
            "export",
            "memory-recall.export",
            0.75,
            "unresolved",
        )),
        "EXPORTS" => Some(("exports", "export", "memory-recall.export", 1.0, "exact")),
        "CALLS" if fact.note.starts_with("oaf.ingest:typed-call-") => {
            Some(("calls", "call", "memory-recall.typed-call", 0.95, "typed"))
        }
        "CALLS" if fact.note == "oaf.ingest:unresolved-call" => {
            Some(("calls", "call", "memory-recall.call", 0.25, "unresolved"))
        }
        "CALLS" => Some(("calls", "call", "memory-recall.call", 0.75, "inferred")),
        "CONSTRUCTS" if fact.note == "oaf.ingest:resolved-construct" => Some((
            "constructs",
            "call",
            "memory-recall.construct",
            1.0,
            "exact",
        )),
        "CONSTRUCTS" => Some((
            "constructs",
            "call",
            "memory-recall.construct",
            0.5,
            "unresolved",
        )),
        "EXTENDS" | "INHERITS" if fact.note == "oaf.ingest:resolved-heritage" => Some((
            "extends",
            "heritage",
            "memory-recall.heritage",
            1.0,
            "exact",
        )),
        "IMPLEMENTS" if fact.note == "oaf.ingest:resolved-heritage" => Some((
            "implements",
            "heritage",
            "memory-recall.heritage",
            1.0,
            "exact",
        )),
        "EXTENDS" | "INHERITS" => Some((
            "extends",
            "heritage",
            "memory-recall.heritage",
            0.5,
            "unresolved",
        )),
        "IMPLEMENTS" => Some((
            "implements",
            "heritage",
            "memory-recall.heritage",
            0.5,
            "unresolved",
        )),
        "MIXES_IN" if fact.note == "oaf.ingest:resolved-heritage" => Some((
            "mixes_in",
            "heritage",
            "memory-recall.heritage",
            1.0,
            "exact",
        )),
        "MIXES_IN" => Some((
            "mixes_in",
            "heritage",
            "memory-recall.heritage",
            0.5,
            "unresolved",
        )),
        "EXTENDS_TYPE" if fact.note == "oaf.ingest:resolved-heritage" => Some((
            "extends_type",
            "heritage",
            "memory-recall.extension",
            1.0,
            "exact",
        )),
        "EXTENDS_TYPE" => Some((
            "extends_type",
            "heritage",
            "memory-recall.extension",
            0.5,
            "unresolved",
        )),
        "PART_OF" => Some(("part_of", "import", "memory-recall.part", 1.0, "exact")),
        "ENTRY_POINT" => Some((
            "entry_point",
            "framework",
            "memory-recall.entry-point",
            1.0,
            "exact",
        )),
        "DEPENDS_ON" => Some((
            "depends_on",
            "framework",
            "memory-recall.framework",
            1.0,
            "exact",
        )),
        "LISTENS" => Some((
            "listens",
            "framework",
            "memory-recall.framework",
            1.0,
            "exact",
        )),
        "HANDLES" => Some((
            "handles_route",
            "framework",
            "memory-recall.route",
            0.95,
            "exact",
        )),
        _ => None,
    }
}

fn resolve_node(
    subject: &str,
    source: &str,
    node_lookup: &BTreeMap<(String, String), String>,
    subject_lookup: &BTreeMap<String, Vec<(String, String)>>,
) -> Option<String> {
    node_lookup
        .get(&(subject.to_string(), source.to_string()))
        .cloned()
        .or_else(|| {
            subject_lookup
                .get(subject)
                .and_then(|values| values.first())
                .map(|(_, id)| id.clone())
        })
}

fn build_coverage(
    request: &EngineRequest,
    hashes: &[oaf_ingest::IngestFileHash],
    parsed_counts: &BTreeMap<String, usize>,
    omitted_file_count: usize,
) -> Vec<Value> {
    let mut discovered = BTreeMap::<String, usize>::new();
    for item in hashes {
        if let Some(language) = source_language(&item.source) {
            *discovered.entry(language.to_string()).or_default() += 1;
        }
    }
    let mut languages = if request.languages.is_empty() {
        discovered.keys().cloned().collect::<BTreeSet<_>>()
    } else {
        request.languages.clone()
    };
    for group in parsed_counts.keys() {
        languages.insert(normalize_language_group(group).to_string());
    }
    languages
        .into_iter()
        .map(|language| {
            let discovered_count = discovered.get(&language).copied().unwrap_or(0);
            let indexed_count = parsed_counts
                .iter()
                .filter(|(group, _)| normalize_language_group(group) == language)
                .map(|(_, count)| *count)
                .sum::<usize>();
            let failed_count = discovered_count.saturating_sub(indexed_count);
            let mut reasons = vec!["native_preview"];
            if failed_count > 0 {
                reasons.push("parse_failed");
            }
            if omitted_file_count > 0 {
                reasons.push("file_budget_reached");
            }
            json!({
                "language": language,
                "support": "partial",
                "discoveredFileCount": discovered_count,
                "indexedFileCount": indexed_count,
                "failedFileCount": failed_count,
                "omittedFileCount": omitted_file_count,
                "reasonCodes": reasons,
            })
        })
        .collect()
}

fn build_diagnostics(
    skipped_files: &[oaf_ingest::SkippedFile],
    recovered_files: &[oaf_ingest::RecoveredFile],
    omitted_file_count: usize,
    omitted_node_count: usize,
    omitted_edge_count: usize,
) -> Vec<Value> {
    let mut diagnostics = skipped_files
        .iter()
        .filter_map(|file| {
            source_language(&file.workspace_ref).map(|language| {
                json!({
                    "code": if file.reason.contains("exceeds") { "file_too_large" } else { "parse_failed" },
                    "severity": "warning",
                    "language": language,
                    "locator": file.workspace_ref,
                    "count": 1,
                })
            })
        })
        .collect::<Vec<_>>();
    diagnostics.extend(recovered_files.iter().filter_map(|file| {
        source_language(&file.workspace_ref).map(|language| {
            json!({
                "code": "parse_recovered",
                "severity": "warning",
                "language": language,
                "locator": file.workspace_ref,
                "count": 1,
            })
        })
    }));
    for (code, count) in [
        ("file_budget_reached", omitted_file_count),
        ("node_budget_reached", omitted_node_count),
        ("edge_budget_reached", omitted_edge_count),
    ] {
        if count > 0 {
            diagnostics.push(json!({ "code": code, "severity": "warning", "count": count }));
        }
    }
    diagnostics.sort_by(|left, right| {
        left["code"]
            .as_str()
            .cmp(&right["code"].as_str())
            .then_with(|| left["locator"].as_str().cmp(&right["locator"].as_str()))
    });
    diagnostics.truncate(1000);
    diagnostics
}

fn success_frame(request: &EngineRequest, build: GraphBuild) -> Value {
    let node_count = build.graph["nodes"].as_array().map_or(0, Vec::len);
    let edge_count = build.graph["edges"].as_array().map_or(0, Vec::len);
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request.request_id,
        "ok": true,
        "result": {
            "responseSchemaVersion": "1.0.0",
            "graph": build.graph,
            "measurements": {
                "scannedFileCount": build.scanned_file_count,
                "indexedFileCount": build.indexed_file_count,
                "nodeCount": node_count,
                "edgeCount": edge_count,
                "omittedNodeCount": build.omitted_node_count,
                "omittedEdgeCount": build.omitted_edge_count,
            },
            "safeguards": {
                "readOnly": true,
                "localFilesWritten": 0,
                "networkCalls": 0,
                "modelCalls": 0,
                "rawSourceBodiesIncluded": false,
                "absolutePathsIncluded": false,
            }
        }
    })
}

fn failure_frame(request_id: &str, failure: EngineFailure) -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "ok": false,
        "error": {
            "code": failure.code,
            "retryable": failure.retryable,
            "details": [failure.detail],
        }
    })
}

fn invalid_request() -> EngineFailure {
    EngineFailure {
        code: "engine_invalid_request",
        detail: "request failed validation",
        retryable: false,
    }
}

fn internal_failure() -> EngineFailure {
    EngineFailure {
        code: "engine_internal",
        detail: "native extraction failed",
        retryable: false,
    }
}

fn check_deadline(
    request: &EngineRequest,
    started: Instant,
) -> std::result::Result<(), EngineFailure> {
    if started.elapsed().as_millis() > u128::from(request.deadline_ms) {
        Err(EngineFailure {
            code: "engine_deadline_exceeded",
            detail: "request deadline exceeded",
            retryable: true,
        })
    } else {
        Ok(())
    }
}

fn safe_request_id(value: &Value) -> Option<String> {
    value
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|value| valid_prefixed_hex(value, "cireq_"))
        .map(str::to_string)
}

fn bounded_u64(
    value: Option<&Value>,
    minimum: u64,
    maximum: u64,
) -> std::result::Result<u64, EngineFailure> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value >= minimum && *value <= maximum)
        .ok_or(invalid_request())
}

fn has_unknown_keys(object: &Map<String, Value>, allowed: &[&str]) -> bool {
    object.keys().any(|key| !allowed.contains(&key.as_str()))
}

fn valid_prefixed_hex(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|rest| {
        rest.len() == 32
            && rest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn valid_workspace_id(value: &str) -> bool {
    value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || (index > 0 && (byte.is_ascii_digit() || byte == b'_' || byte == b'-'))
        })
}

fn source_language(source: &str) -> Option<&'static str> {
    let lower = source.to_ascii_lowercase();
    if lower.ends_with(".d.ts") || lower.ends_with(".ts") || lower.ends_with(".tsx") {
        Some("typescript")
    } else if lower.ends_with(".js")
        || lower.ends_with(".jsx")
        || lower.ends_with(".mjs")
        || lower.ends_with(".cjs")
    {
        Some("javascript")
    } else if lower.ends_with(".py") {
        Some("python")
    } else if lower.ends_with(".java") {
        Some("java")
    } else if lower.ends_with(".kt") || lower.ends_with(".kts") {
        Some("kotlin")
    } else if lower.ends_with(".cs") {
        Some("csharp")
    } else if lower.ends_with(".go") {
        Some("go")
    } else if lower.ends_with(".rs") {
        Some("rust")
    } else if lower.ends_with(".php") {
        Some("php")
    } else if lower.ends_with(".rb") {
        Some("ruby")
    } else if lower.ends_with(".swift") {
        Some("swift")
    } else if lower.ends_with(".c") || lower.ends_with(".h") {
        Some("c")
    } else if lower.ends_with(".cc")
        || lower.ends_with(".cpp")
        || lower.ends_with(".cxx")
        || lower.ends_with(".hpp")
    {
        Some("cpp")
    } else if lower.ends_with(".dart") {
        Some("dart")
    } else if lower.ends_with(".lua") {
        Some("lua")
    } else if lower.ends_with(".sh") || lower.ends_with(".bash") {
        Some("bash")
    } else if lower.ends_with(".sql") {
        Some("sql")
    } else if lower.ends_with(".m") || lower.ends_with(".mm") {
        Some("objective-c")
    } else if lower.ends_with(".scala") {
        Some("scala")
    } else if lower.ends_with(".r") {
        Some("r")
    } else if lower.ends_with(".jl") {
        Some("julia")
    } else if lower.ends_with(".zig") {
        Some("zig")
    } else {
        None
    }
}

fn source_language_for_request(
    source: &str,
    requested_languages: &BTreeSet<String>,
) -> Option<&'static str> {
    if source.to_ascii_lowercase().ends_with(".h") && prefers_cpp_headers(requested_languages) {
        Some("cpp")
    } else {
        source_language(source)
    }
}

fn fact_language_for_request(
    fact: &CodeFactRecord,
    requested_languages: &BTreeSet<String>,
) -> Option<&'static str> {
    source_language_for_request(&fact.source, requested_languages).or(match fact.note.as_str() {
        "oaf.ingest:cmake-c" => Some("c"),
        "oaf.ingest:cmake-cpp" => Some("cpp"),
        _ => None,
    })
}

fn prefers_cpp_headers(requested_languages: &BTreeSet<String>) -> bool {
    requested_languages.contains("cpp") && !requested_languages.contains("c")
}

fn normalize_language_group(group: &str) -> &str {
    match group {
        "javascript-jsx" => "javascript",
        "typescript-tsx" => "typescript",
        other => other,
    }
}

fn safe_name(value: &str) -> String {
    let mut output = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || "_$@~./*+,:()[]<># -".contains(character) {
                character
            } else {
                '_'
            }
        })
        .take(240)
        .collect::<String>();
    if output.trim().is_empty() {
        output = "unknown".to_string();
    }
    output
}

fn with_span(source: &str, span: CodeSpan) -> String {
    format!("{source}#L{}-L{}", span.start_line, span.end_line)
}

fn span_json(span: CodeSpan) -> Value {
    json!({
        "startLine": span.start_line,
        "startColumn": span.start_column,
        "endLine": span.end_line,
        "endColumn": span.end_column,
    })
}

fn language_kind(kind: &str) -> &str {
    match kind {
        "file" => "source_file",
        "type_alias" => "type_alias",
        "configuration_resource" => "configuration_resource",
        "framework_component" => "framework_component",
        "execution_process" => "execution_process",
        other => other,
    }
}

fn node_priority(kind: &str) -> usize {
    match kind {
        "file" => 0,
        "module" | "package" | "namespace" | "library" => 1,
        "class" | "interface" | "struct" | "enum" | "trait" | "protocol" | "mixin"
        | "extension" => 2,
        "function" | "method" => 3,
        "route" | "build_target" => 4,
        _ => 5,
    }
}

fn fingerprint(value: &Value) -> String {
    let bytes = serde_json::to_vec(value).expect("serialize deterministic code intelligence value");
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

fn write_frame(writer: &mut impl Write, value: &Value) -> Result<()> {
    serde_json::to_writer(&mut *writer, value).context("write code intelligence frame")?;
    writer
        .write_all(b"\n")
        .context("terminate code intelligence frame")?;
    writer.flush().context("flush code intelligence frame")
}

#[cfg(test)]
include!("../test-support/code_intelligence_unit.rs");
