use crate::code_intelligence::{
    build_index_generation_at_root, index_source_language, IndexGenerationBuild,
};
use anyhow::{bail, Context, Result};
use oaf_index::{
    doctor_index, inspect_index, logical_database_bytes, normalized_generation_fingerprint,
    repair_index, select_generation_files, CoverageRecord, DiscoveredFile, EdgeDirection,
    GenerationInput, HealthStatus, IndexDoctorReport, IndexHealth, NodeRecord, QueryBounds,
    SourceIndex, SourceIndexOptions,
};
use oaf_ingest::{discover_file_hashes, IngestOptions};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::io::{self, BufRead, BufReader, Write};
use std::path::Path;
use std::time::Instant;

const PROTOCOL_VERSION: &str = "1.0.0";
const RESPONSE_SCHEMA_VERSION: &str = "1.0.0";
const INDEX_LOCATOR: &str = "workspace://.local/source-index/index.v1.sqlite";
const INDEX_RELATIVE_PATH: &str = ".local/source-index/index.v1.sqlite";
const MAX_LINE_BYTES: usize = 64 * 1024;
const FALLBACK_REQUEST_ID: &str = "ciidxreq_00000000000000000000000000000000";
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestFrame {
    protocol_version: String,
    request_id: String,
    workspace_id: String,
    operation: String,
    root: String,
    index_locator: String,
    deadline_ms: u64,
    cancellation_token: Option<String>,
    response_schema_version: String,
    arguments: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriterArguments {
    write: bool,
    max_files: usize,
    max_file_bytes: u64,
    max_nodes: usize,
    max_edges: usize,
    #[serde(default)]
    languages: Vec<String>,
    #[serde(default)]
    confirm_repair_plan: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyArguments {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueryArguments {
    kind: String,
    limit: usize,
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    locator: Option<String>,
    #[serde(default)]
    direction: Option<String>,
    #[serde(default)]
    depth: Option<usize>,
    #[serde(default)]
    cursor: Option<String>,
}

struct ParsedRequest {
    request_id: String,
    workspace_id: String,
    operation: Operation,
    deadline_ms: u64,
}

enum Operation {
    Build(WriterArguments),
    Refresh(WriterArguments),
    Repair(WriterArguments),
    Status,
    Doctor,
    Query(QueryArguments),
}

struct Measurements {
    duration_ms: u64,
    parsed_file_count: usize,
    reused_file_count: usize,
    changed_file_count: usize,
    deleted_file_count: usize,
    local_files_written: usize,
}

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
                &failure_frame(FALLBACK_REQUEST_ID, "index_input_too_large", false),
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
                            &failure_frame(FALLBACK_REQUEST_ID, "index_invalid_json", false),
                        )?;
                        continue;
                    }
                };
                let request_id = value
                    .get("requestId")
                    .and_then(Value::as_str)
                    .filter(|value| valid_prefixed_hex(value, "ciidxreq_"))
                    .unwrap_or(FALLBACK_REQUEST_ID)
                    .to_string();
                let root = env::current_dir().context("index_current_directory_failed")?;
                let frame = match parse_request(value)
                    .and_then(|request| execute_request(request, &root, engine_version))
                {
                    Ok(frame) => frame,
                    Err(error) => {
                        let code = safe_error_code(&error);
                        failure_frame(&request_id, &code, false)
                    }
                };
                write_frame(&mut writer, &frame)?;
            }
        }
    }
    Ok(())
}

fn parse_request(value: Value) -> Result<ParsedRequest> {
    let frame: RequestFrame =
        serde_json::from_value(value).map_err(|_| anyhow::anyhow!("index_request_invalid"))?;
    if frame.protocol_version != PROTOCOL_VERSION
        || frame.response_schema_version != RESPONSE_SCHEMA_VERSION
        || frame.root != "."
        || frame.index_locator != INDEX_LOCATOR
        || !valid_prefixed_hex(&frame.request_id, "ciidxreq_")
        || !valid_workspace_id(&frame.workspace_id)
        || !(1..=300_000).contains(&frame.deadline_ms)
        || frame
            .cancellation_token
            .as_deref()
            .is_some_and(|token| !valid_prefixed_hex(token, "cancel_"))
    {
        bail!("index_request_invalid");
    }
    let operation = match frame.operation.as_str() {
        "index.build" => Operation::Build(parse_writer(frame.arguments, false)?),
        "index.refresh" => Operation::Refresh(parse_writer(frame.arguments, false)?),
        "index.repair" => Operation::Repair(parse_writer(frame.arguments, true)?),
        "index.status" => {
            parse_empty(frame.arguments)?;
            Operation::Status
        }
        "index.doctor" => {
            parse_empty(frame.arguments)?;
            Operation::Doctor
        }
        "index.query" => Operation::Query(parse_query(frame.arguments)?),
        _ => bail!("index_operation_unsupported"),
    };
    Ok(ParsedRequest {
        request_id: frame.request_id,
        workspace_id: frame.workspace_id,
        operation,
        deadline_ms: frame.deadline_ms,
    })
}

fn parse_writer(value: Value, repair: bool) -> Result<WriterArguments> {
    let arguments: WriterArguments =
        serde_json::from_value(value).map_err(|_| anyhow::anyhow!("index_request_invalid"))?;
    let mut languages = BTreeSet::new();
    if !arguments.write
        || !(1..=1_000_000).contains(&arguments.max_files)
        || !(1..=10_485_760).contains(&arguments.max_file_bytes)
        || !(1..=1_000_000).contains(&arguments.max_nodes)
        || !(1..=5_000_000).contains(&arguments.max_edges)
        || arguments.languages.len() > LANGUAGES.len()
        || arguments.languages.iter().any(|language| {
            !LANGUAGES.contains(&language.as_str()) || !languages.insert(language.clone())
        })
        || repair != arguments.confirm_repair_plan.is_some()
        || arguments
            .confirm_repair_plan
            .as_deref()
            .is_some_and(|value| !valid_hash(value))
    {
        bail!("index_request_invalid");
    }
    Ok(arguments)
}

fn parse_empty(value: Value) -> Result<()> {
    serde_json::from_value::<EmptyArguments>(value)
        .map(|_| ())
        .map_err(|_| anyhow::anyhow!("index_request_invalid"))
}

fn parse_query(value: Value) -> Result<QueryArguments> {
    let arguments: QueryArguments =
        serde_json::from_value(value).map_err(|_| anyhow::anyhow!("index_request_invalid"))?;
    if ![
        "summary",
        "exact",
        "search",
        "neighborhood",
        "dependencies",
        "trace",
        "impact",
        "routes",
    ]
    .contains(&arguments.kind.as_str())
        || !(1..=100).contains(&arguments.limit)
        || arguments.depth.unwrap_or(1) > 8
        || arguments
            .query
            .as_deref()
            .is_some_and(|value| !valid_query(value))
        || arguments
            .locator
            .as_deref()
            .is_some_and(|value| !valid_locator(value))
        || arguments
            .direction
            .as_deref()
            .is_some_and(|value| !["inbound", "outbound", "both"].contains(&value))
        || arguments
            .cursor
            .as_deref()
            .is_some_and(|value| !valid_prefixed_hex(value, "idxcur_"))
    {
        bail!("index_request_invalid");
    }
    validate_query_shape(&arguments)?;
    Ok(arguments)
}

fn validate_query_shape(arguments: &QueryArguments) -> Result<()> {
    let seeds = usize::from(arguments.query.is_some()) + usize::from(arguments.locator.is_some());
    let valid = match arguments.kind.as_str() {
        "summary" => {
            seeds == 0
                && arguments.direction.is_none()
                && arguments.depth.is_none()
                && arguments.cursor.is_none()
        }
        "routes" => seeds == 0 && arguments.direction.is_none() && arguments.depth.is_none(),
        "exact" | "search" => {
            seeds == 1 && arguments.direction.is_none() && arguments.depth.is_none()
        }
        "neighborhood" => seeds == 1 && arguments.direction.is_none() && arguments.cursor.is_none(),
        "dependencies" => seeds == 1 && arguments.cursor.is_none(),
        "impact" => seeds == 1 && arguments.direction.is_none() && arguments.cursor.is_none(),
        "trace" => {
            arguments.query.is_some()
                && arguments.locator.is_some()
                && arguments.direction.is_none()
                && arguments.cursor.is_none()
        }
        _ => false,
    };
    if !valid {
        bail!("index_request_invalid");
    }
    Ok(())
}

fn execute_request(request: ParsedRequest, root: &Path, engine_version: &str) -> Result<Value> {
    let started = Instant::now();
    let root = root.canonicalize().context("index_workspace_invalid")?;
    let repository_identity = repository_identity(&root, &request.workspace_id);
    let options = SourceIndexOptions::new(&repository_identity, engine_version);
    let path = root.join(INDEX_RELATIVE_PATH);
    match &request.operation {
        Operation::Build(arguments) => {
            let build = build_generation(&root, &request, arguments, engine_version)?;
            let omitted_count = persisted_omitted_count(&build.generation);
            let mut index = SourceIndex::open(&path, &options)?;
            let summary = index.commit_generation(&build.generation)?;
            drop(index);
            let health = inspect_index(&path, &options);
            Ok(success_frame(
                &request.request_id,
                "index.build",
                &repository_identity,
                engine_version,
                &path,
                &health,
                None,
                Some(&summary),
                omitted_count,
                Vec::new(),
                None,
                Measurements {
                    duration_ms: elapsed_ms(started),
                    parsed_file_count: build.indexed_file_count,
                    reused_file_count: 0,
                    changed_file_count: build.indexed_file_count,
                    deleted_file_count: 0,
                    local_files_written: 1,
                },
                false,
                diagnostics(&build),
            ))
        }
        Operation::Refresh(arguments) => refresh_index(
            &request,
            &root,
            &path,
            &options,
            &repository_identity,
            engine_version,
            arguments,
            started,
        ),
        Operation::Repair(arguments) => {
            let build = build_generation(&root, &request, arguments, engine_version)?;
            let omitted_count = persisted_omitted_count(&build.generation);
            let confirmation = arguments
                .confirm_repair_plan
                .as_deref()
                .context("index_repair_confirmation_missing")?;
            let receipt = repair_index(&path, &options, confirmation, &build.generation)?;
            let health = inspect_index(&path, &options);
            let index = SourceIndex::open_read_only(&path, &options)?;
            let summary = index.load_generation(receipt.active_generation)?.summary;
            Ok(success_frame(
                &request.request_id,
                "index.repair",
                &repository_identity,
                engine_version,
                &path,
                &health,
                None,
                Some(&summary),
                omitted_count,
                Vec::new(),
                None,
                Measurements {
                    duration_ms: elapsed_ms(started),
                    parsed_file_count: build.indexed_file_count,
                    reused_file_count: 0,
                    changed_file_count: build.indexed_file_count,
                    deleted_file_count: 0,
                    local_files_written: 2,
                },
                false,
                diagnostics(&build),
            ))
        }
        Operation::Status => read_index(
            &request,
            &path,
            &options,
            &repository_identity,
            engine_version,
            false,
            None,
            started,
        ),
        Operation::Doctor => read_index(
            &request,
            &path,
            &options,
            &repository_identity,
            engine_version,
            true,
            None,
            started,
        ),
        Operation::Query(arguments) => read_index(
            &request,
            &path,
            &options,
            &repository_identity,
            engine_version,
            false,
            Some(arguments),
            started,
        ),
    }
}

#[allow(clippy::too_many_arguments)]
fn refresh_index(
    request: &ParsedRequest,
    root: &Path,
    path: &Path,
    options: &SourceIndexOptions,
    repository_identity: &str,
    engine_version: &str,
    arguments: &WriterArguments,
    started: Instant,
) -> Result<Value> {
    let languages = arguments.languages.iter().cloned().collect::<BTreeSet<_>>();
    let current = discover_files(root, &languages, arguments)?;
    let reader = SourceIndex::open_read_only(path, options)?;
    let plan = reader.plan_refresh(&current, None, &oaf_index::RefreshBounds::default())?;
    if plan.no_change {
        let active = reader
            .load_active_generation()?
            .context("source_index_active_generation_missing")?;
        let omitted_count = persisted_omitted_count(&active.input);
        let summary = active.summary;
        let health = inspect_index(path, options);
        return Ok(success_frame(
            &request.request_id,
            "index.refresh",
            repository_identity,
            engine_version,
            path,
            &health,
            None,
            Some(&summary),
            omitted_count,
            Vec::new(),
            None,
            Measurements {
                duration_ms: elapsed_ms(started),
                parsed_file_count: 0,
                reused_file_count: plan.unchanged_file_count,
                changed_file_count: 0,
                deleted_file_count: 0,
                local_files_written: 0,
            },
            false,
            Vec::new(),
        ));
    }
    drop(reader);
    let build = build_generation(root, request, arguments, engine_version)?;
    let mut writer = SourceIndex::open(path, options)?;
    let invalidated = plan
        .invalidated_files
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let replacement = select_generation_files(&build.generation, &invalidated);
    let summary = writer.commit_incremental(&plan, &replacement)?.summary;
    drop(writer);
    let omitted_count = persisted_omitted_count(&build.generation);
    let health = inspect_index(path, options);
    Ok(success_frame(
        &request.request_id,
        "index.refresh",
        repository_identity,
        engine_version,
        path,
        &health,
        None,
        Some(&summary),
        omitted_count,
        Vec::new(),
        None,
        Measurements {
            duration_ms: elapsed_ms(started),
            parsed_file_count: build.indexed_file_count,
            reused_file_count: plan.unchanged_file_count,
            changed_file_count: plan.changed_files.len()
                + plan.added_files.len()
                + plan.renamed_files.len(),
            deleted_file_count: plan.deleted_files.len(),
            local_files_written: 1,
        },
        false,
        diagnostics(&build),
    ))
}

#[allow(clippy::too_many_arguments)]
fn read_index(
    request: &ParsedRequest,
    path: &Path,
    options: &SourceIndexOptions,
    repository_identity: &str,
    engine_version: &str,
    doctor: bool,
    query: Option<&QueryArguments>,
    started: Instant,
) -> Result<Value> {
    let report = doctor.then(|| doctor_index(path, options)).transpose()?;
    let health = report.as_ref().map_or_else(
        || inspect_index(path, options),
        |value| value.health.clone(),
    );
    let mut summary = None;
    let mut omitted_count = 0;
    let mut results = Vec::new();
    let mut next_cursor = None;
    if path.is_file()
        && matches!(
            health.status,
            HealthStatus::Ready | HealthStatus::Stale | HealthStatus::Interrupted
        )
    {
        let index = SourceIndex::open_read_only(path, options)?;
        if let Some(active) = index.load_active_generation()? {
            omitted_count = persisted_omitted_count(&active.input);
            summary = Some(active.summary);
        }
        if let Some(arguments) = query {
            let elapsed = elapsed_ms(started);
            if elapsed >= request.deadline_ms {
                bail!("source_index_query_timeout");
            }
            (results, next_cursor) = execute_query(
                &index,
                arguments,
                request.deadline_ms.saturating_sub(elapsed),
            )?;
        }
    } else if query.is_some() {
        bail!("source_index_query_unavailable");
    }
    Ok(success_frame(
        &request.request_id,
        if doctor {
            "index.doctor"
        } else if query.is_some() {
            "index.query"
        } else {
            "index.status"
        },
        repository_identity,
        engine_version,
        path,
        &health,
        report.as_ref(),
        summary.as_ref(),
        omitted_count,
        results,
        next_cursor,
        Measurements {
            duration_ms: elapsed_ms(started),
            parsed_file_count: 0,
            reused_file_count: 0,
            changed_file_count: 0,
            deleted_file_count: 0,
            local_files_written: 0,
        },
        true,
        health
            .reason_codes
            .iter()
            .map(|code| json!({ "code": code, "count": 1 }))
            .collect(),
    ))
}

fn build_generation(
    root: &Path,
    request: &ParsedRequest,
    arguments: &WriterArguments,
    engine_version: &str,
) -> Result<IndexGenerationBuild> {
    let mut build = build_index_generation_at_root(
        root,
        &request.workspace_id,
        arguments.max_files,
        arguments.max_file_bytes,
        arguments.max_nodes,
        arguments.max_edges,
        arguments.languages.iter().cloned().collect(),
        request.deadline_ms,
        engine_version,
    )?;
    record_omissions(&mut build)?;
    Ok(build)
}

fn record_omissions(build: &mut IndexGenerationBuild) -> Result<()> {
    let counts = [
        (
            "omitted-files",
            build
                .scanned_file_count
                .saturating_sub(build.generation.files.len()),
        ),
        ("omitted-nodes", build.omitted_node_count),
        ("omitted-edges", build.omitted_edge_count),
    ];
    build.generation.coverage.retain(|record| {
        record.language != "source-index" || !record.capability.starts_with("omitted-")
    });
    build
        .generation
        .coverage
        .extend(
            counts
                .into_iter()
                .map(|(capability, count)| CoverageRecord {
                    language: "source-index".to_string(),
                    capability: capability.to_string(),
                    represented_count: 0,
                    omitted_count: i64::try_from(count).unwrap_or(i64::MAX),
                    failed_count: 0,
                    reason_code: (count > 0).then(|| format!("source_index_{capability}")),
                }),
        );
    build.generation.structural_fingerprint = normalized_generation_fingerprint(&build.generation)?;
    Ok(())
}

fn persisted_omitted_count(input: &GenerationInput) -> u64 {
    input
        .coverage
        .iter()
        .filter(|record| {
            record.language == "source-index" && record.capability.starts_with("omitted-")
        })
        .map(|record| u64::try_from(record.omitted_count).unwrap_or(0))
        .sum()
}

fn discover_files(
    root: &Path,
    languages: &BTreeSet<String>,
    arguments: &WriterArguments,
) -> Result<Vec<DiscoveredFile>> {
    let mut options = IngestOptions::new(root);
    options.max_file_bytes = arguments.max_file_bytes;
    options.prefer_cpp_headers = languages.contains("cpp") && !languages.contains("c");
    let mut hashes = discover_file_hashes(&options)?;
    hashes.retain(|item| index_source_language(&item.source, languages).is_some());
    hashes.sort_by(|left, right| left.source.cmp(&right.source));
    hashes.truncate(arguments.max_files);
    hashes
        .into_iter()
        .map(|item| {
            Ok(DiscoveredFile {
                locator: item.source,
                content_hash: format!("sha256:{}", item.sha256),
                byte_size: i64::try_from(item.bytes).context("source_index_file_size_invalid")?,
            })
        })
        .collect()
}

fn execute_query(
    index: &SourceIndex,
    arguments: &QueryArguments,
    deadline_ms: u64,
) -> Result<(Vec<Value>, Option<String>)> {
    let mut bounds = QueryBounds::new(arguments.limit).with_depth(arguments.depth.unwrap_or(1));
    bounds.timeout_ms = deadline_ms.min(2_000);
    if let Some(cursor) = arguments.cursor.as_deref() {
        bounds.cursor = Some(format!("cinode_{}", &cursor[7..]));
    }
    match arguments.kind.as_str() {
        "summary" => Ok((Vec::new(), None)),
        "exact" => {
            let query = query_seed(arguments)?;
            let page = index.find_exact_nodes(query, &bounds)?;
            let next = page.next_cursor.as_deref().and_then(node_cursor);
            Ok((nodes_to_results(page.items, index)?, next))
        }
        "search" => {
            let query = query_seed(arguments)?;
            let page = index.find_nodes(query, &bounds)?;
            let next = page.next_cursor.as_deref().and_then(node_cursor);
            Ok((nodes_to_results(page.items, index)?, next))
        }
        "routes" => {
            let page = index.nodes_by_kind("route", &bounds)?;
            let next = page.next_cursor.as_deref().and_then(node_cursor);
            Ok((nodes_to_results(page.items, index)?, next))
        }
        "neighborhood" => {
            let seed = find_seed(index, arguments, &bounds)?;
            let graph = index.neighborhood(&seed.canonical_id, &bounds)?;
            Ok((nodes_to_results(graph.nodes, index)?, None))
        }
        "dependencies" | "impact" => {
            let seed = find_seed(index, arguments, &bounds)?;
            let direction = if arguments.kind == "impact" {
                EdgeDirection::Incoming
            } else {
                match arguments.direction.as_deref().unwrap_or("both") {
                    "inbound" => EdgeDirection::Incoming,
                    "outbound" => EdgeDirection::Outgoing,
                    _ => EdgeDirection::Both,
                }
            };
            let graph = index.dependency_neighborhood(&seed.canonical_id, direction, &bounds)?;
            Ok((nodes_to_results(graph.nodes, index)?, None))
        }
        "trace" => {
            let from = find_seed(index, arguments, &bounds)?;
            let target_query = arguments
                .locator
                .as_deref()
                .context("source_index_trace_target_required")?;
            let target = index
                .find_exact_nodes(target_query, &query_bounds_without_cursor(&bounds, 1))?
                .items
                .into_iter()
                .next()
                .context("source_index_trace_target_not_found")?;
            let routes = index.trace_routes(&from.canonical_id, &target.canonical_id, &bounds)?;
            let mut nodes = BTreeMap::new();
            for route in routes {
                for node_id in route.node_ids {
                    if let Some(node) = index.node(&node_id)? {
                        nodes.insert(node.canonical_id.clone(), node);
                    }
                }
            }
            Ok((
                nodes_to_results(nodes.into_values().collect(), index)?,
                None,
            ))
        }
        _ => bail!("source_index_query_kind_invalid"),
    }
}

fn find_seed(
    index: &SourceIndex,
    arguments: &QueryArguments,
    bounds: &QueryBounds,
) -> Result<NodeRecord> {
    let query = query_seed(arguments)?;
    let seed_bounds = query_bounds_without_cursor(bounds, bounds.limit);
    if let Some(node) = index
        .find_exact_nodes(query, &seed_bounds)?
        .items
        .into_iter()
        .next()
    {
        return Ok(node);
    }
    index
        .find_nodes(query, &seed_bounds)?
        .items
        .into_iter()
        .next()
        .context("source_index_query_seed_not_found")
}

fn query_bounds_without_cursor(bounds: &QueryBounds, limit: usize) -> QueryBounds {
    let mut value = bounds.clone();
    value.limit = limit;
    value.cursor = None;
    value
}

fn query_seed(arguments: &QueryArguments) -> Result<&str> {
    arguments
        .query
        .as_deref()
        .or(arguments.locator.as_deref())
        .context("source_index_query_seed_required")
}

fn nodes_to_results(nodes: Vec<NodeRecord>, index: &SourceIndex) -> Result<Vec<Value>> {
    let generation = index
        .active_generation()
        .context("source_index_active_generation_missing")?;
    Ok(nodes
        .into_iter()
        .filter(|node| valid_node_id(&node.canonical_id) && valid_locator(&node.locator))
        .map(|node| {
            json!({
                "id": node.canonical_id,
                "kind": safe_code(&node.kind),
                "label": result_label(&node),
                "locator": node.locator,
                "confidence": 1.0,
                "generation": generation,
            })
        })
        .collect())
}

#[allow(clippy::too_many_arguments)]
fn success_frame(
    request_id: &str,
    operation: &str,
    repository_identity: &str,
    engine_version: &str,
    path: &Path,
    health: &IndexHealth,
    doctor: Option<&IndexDoctorReport>,
    summary: Option<&oaf_index::GenerationSummary>,
    omitted_count: u64,
    results: Vec<Value>,
    next_cursor: Option<String>,
    measurements: Measurements,
    read_only: bool,
    diagnostics: Vec<Value>,
) -> Value {
    let mut health_value = Map::new();
    health_value.insert(
        "status".into(),
        Value::String(health_status(health.status).into()),
    );
    health_value.insert("reasonCodes".into(), json!(health.reason_codes));
    health_value.insert("lastSuccessfulRefreshAt".into(), Value::Null);
    health_value.insert(
        "repairRequired".into(),
        Value::Bool(doctor.map_or_else(
            || !matches!(health.status, HealthStatus::Absent | HealthStatus::Ready),
            |report| report.repair_required,
        )),
    );
    if let Some(report) = doctor {
        health_value.insert(
            "lastValidGenerationReadable".into(),
            Value::Bool(report.last_valid_generation_readable),
        );
        health_value.insert(
            "repairPlanFingerprint".into(),
            report
                .repair_plan
                .as_ref()
                .map_or(Value::Null, |plan| Value::String(plan.fingerprint.clone())),
        );
        health_value.insert(
            "repairBackupFileName".into(),
            report.repair_plan.as_ref().map_or(Value::Null, |plan| {
                Value::String(plan.backup_file_name.clone())
            }),
        );
    }
    let file_count = summary.map_or(0, |value| value.file_count);
    let node_count = summary.map_or(0, |value| value.node_count);
    let edge_count = summary.map_or(0, |value| value.edge_count);
    let unresolved_count = summary.map_or(0, |value| value.unresolved_count);
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "ok": true,
        "result": {
            "responseSchemaVersion": RESPONSE_SCHEMA_VERSION,
            "operation": operation,
            "repositoryIdentityHash": if health.status == HealthStatus::Absent { Value::Null } else { Value::String(repository_identity.to_string()) },
            "indexLocator": INDEX_LOCATOR,
            "storageSchemaVersion": health.schema_version.map_or(Value::Null, |version| Value::String(version.to_string())),
            "engineVersion": engine_version,
            "state": response_state(health.status),
            "activeGeneration": summary.map(|value| value.id),
            "freshness": freshness(health.status),
            "health": Value::Object(health_value),
            "summary": {
                "fileCount": file_count,
                "nodeCount": node_count,
                "edgeCount": edge_count,
                "unresolvedCount": unresolved_count,
                "omittedCount": omitted_count,
                "databaseBytes": database_bytes(path),
            },
            "measurements": {
                "durationMs": measurements.duration_ms,
                "parsedFileCount": measurements.parsed_file_count,
                "reusedFileCount": measurements.reused_file_count,
                "changedFileCount": measurements.changed_file_count,
                "deletedFileCount": measurements.deleted_file_count,
                "localFilesWritten": measurements.local_files_written,
            },
            "results": results,
            "nextCursor": next_cursor,
            "diagnostics": diagnostics.into_iter().take(32).collect::<Vec<_>>(),
            "safeguards": {
                "readOnly": read_only,
                "localFilesWritten": measurements.local_files_written,
                "canonicalMemoryWrites": 0,
                "networkCalls": 0,
                "modelCalls": 0,
                "rawSourceBodiesIncluded": false,
                "absolutePathsIncluded": false,
                "repairPerformed": operation == "index.repair",
            }
        }
    })
}

fn diagnostics(build: &IndexGenerationBuild) -> Vec<Value> {
    let mut counts = BTreeMap::<String, u64>::new();
    for diagnostic in &build.generation.diagnostics {
        *counts.entry(safe_code(&diagnostic.code)).or_default() += 1;
    }
    let omitted_files = build
        .scanned_file_count
        .saturating_sub(build.generation.files.len());
    if omitted_files > 0 {
        counts.insert("source_index_files_omitted".into(), omitted_files as u64);
    }
    if build.omitted_node_count > 0 {
        counts.insert(
            "source_index_nodes_omitted".into(),
            build.omitted_node_count as u64,
        );
    }
    if build.omitted_edge_count > 0 {
        counts.insert(
            "source_index_edges_omitted".into(),
            build.omitted_edge_count as u64,
        );
    }
    counts
        .into_iter()
        .map(|(code, count)| json!({ "code": code, "count": count.max(1) }))
        .collect()
}

fn failure_frame(request_id: &str, code: &str, retryable: bool) -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "ok": false,
        "error": {
            "code": safe_code(code),
            "retryable": retryable,
            "details": [],
        }
    })
}

fn safe_error_code(error: &anyhow::Error) -> String {
    error
        .chain()
        .map(ToString::to_string)
        .find(|value| valid_safe_code(value))
        .unwrap_or_else(|| "index_internal_error".to_string())
}

fn health_status(status: HealthStatus) -> &'static str {
    match status {
        HealthStatus::Absent => "absent",
        HealthStatus::Ready => "ready",
        HealthStatus::Stale => "stale",
        HealthStatus::MigrationRequired => "migration-required",
        HealthStatus::Interrupted => "interrupted",
        HealthStatus::Corrupt => "corrupt",
        HealthStatus::WrongRepository => "wrong-repository",
        HealthStatus::UnsupportedSchema => "unsupported-schema",
    }
}

fn response_state(status: HealthStatus) -> &'static str {
    match status {
        HealthStatus::Absent => "absent",
        HealthStatus::Ready => "ready",
        HealthStatus::Stale => "stale",
        HealthStatus::Interrupted => "partial",
        _ => "invalid",
    }
}

fn freshness(status: HealthStatus) -> &'static str {
    match status {
        HealthStatus::Absent => "absent",
        HealthStatus::Ready => "current",
        HealthStatus::Stale => "stale",
        HealthStatus::Interrupted => "partial",
        _ => "unknown",
    }
}

fn repository_identity(root: &Path, workspace_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(root.as_os_str().to_string_lossy().as_bytes());
    hasher.update([0]);
    hasher.update(workspace_id.as_bytes());
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

fn database_bytes(path: &Path) -> u64 {
    logical_database_bytes(path)
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis())
        .unwrap_or(u64::MAX)
        .min(300_000)
}

fn node_cursor(value: &str) -> Option<String> {
    value
        .strip_prefix("cinode_")
        .filter(|suffix| suffix.len() == 32)
        .map(|suffix| format!("idxcur_{suffix}"))
}

fn valid_node_id(value: &str) -> bool {
    valid_prefixed_hex(value, "cinode_")
}

fn valid_hash(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|suffix| {
        suffix.len() == 64 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn valid_prefixed_hex(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|suffix| {
        suffix.len() == 32
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn valid_workspace_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || (index > 0 && (byte.is_ascii_digit() || matches!(byte, b'_' | b'-')))
        })
}

fn valid_query(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.$:/#@ -".contains(&byte))
}

fn valid_locator(value: &str) -> bool {
    value.starts_with("workspace://")
        && value.len() <= 512
        && !value.contains("..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.$:/#@+-".contains(&byte))
}

fn valid_safe_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| {
            (index == 0 && byte.is_ascii_lowercase())
                || (index > 0
                    && (byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || matches!(byte, b'_' | b'-' | b'.')))
        })
}

fn safe_code(value: &str) -> String {
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

fn safe_label(value: &str) -> String {
    let output = value
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

fn result_label(node: &NodeRecord) -> String {
    let concise = if node.kind == "file" {
        node.qualified_name.as_str()
    } else {
        node.qualified_name
            .rsplit("::")
            .next()
            .unwrap_or(&node.qualified_name)
    };
    safe_label(concise)
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

fn write_frame(writer: &mut impl Write, value: &Value) -> Result<()> {
    serde_json::to_writer(&mut *writer, value).context("write index frame")?;
    writer.write_all(b"\n").context("terminate index frame")?;
    writer.flush().context("flush index frame")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::SystemTime;
    use tempfile::tempdir;

    #[derive(Debug, PartialEq, Eq)]
    struct BundlePart {
        suffix: &'static str,
        byte_len: Option<u64>,
        fingerprint: Option<String>,
        modified: Option<SystemTime>,
    }

    fn bundle_snapshot(path: &Path) -> Vec<BundlePart> {
        ["", "-wal", "-shm"]
            .into_iter()
            .map(|suffix| {
                let candidate = if suffix.is_empty() {
                    path.to_path_buf()
                } else {
                    let mut value = path.as_os_str().to_os_string();
                    value.push(suffix);
                    std::path::PathBuf::from(value)
                };
                let metadata = fs::metadata(&candidate).ok();
                let bytes = metadata.as_ref().map(|_| fs::read(&candidate).unwrap());
                BundlePart {
                    suffix,
                    byte_len: metadata.as_ref().map(std::fs::Metadata::len),
                    fingerprint: bytes.map(|value| hex::encode(Sha256::digest(value))),
                    modified: metadata.and_then(|value| value.modified().ok()),
                }
            })
            .collect()
    }

    fn request(operation: &str, arguments: Value) -> Value {
        json!({
            "protocolVersion": "1.0.0",
            "requestId": "ciidxreq_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "workspaceId": "ws_local",
            "operation": operation,
            "root": ".",
            "indexLocator": INDEX_LOCATOR,
            "deadlineMs": 30_000,
            "cancellationToken": "cancel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "responseSchemaVersion": "1.0.0",
            "arguments": arguments,
        })
    }

    fn writer_arguments() -> Value {
        json!({
            "write": true,
            "maxFiles": 1000,
            "maxFileBytes": 524288,
            "maxNodes": 5000,
            "maxEdges": 10000,
            "languages": ["typescript"],
        })
    }

    #[test]
    fn request_parser_is_closed_and_keeps_readers_without_writer_authority() {
        assert!(parse_request(request("index.status", json!({}))).is_ok());
        assert!(parse_request(request("index.doctor", json!({ "write": true }))).is_err());
        assert!(parse_request(request("index.build", json!({}))).is_err());
        assert!(parse_request(request("index.repair", writer_arguments())).is_err());
        assert!(parse_request(request(
            "index.query",
            json!({ "kind": "summary", "query": "ignored", "limit": 10 })
        ))
        .is_err());
        assert!(parse_request(request(
            "index.query",
            json!({ "kind": "exact", "query": "main", "direction": "outbound", "limit": 10 })
        ))
        .is_err());
        assert!(parse_request(request(
            "index.query",
            json!({ "kind": "trace", "query": "main", "limit": 10 })
        ))
        .is_err());
        let mut unknown = request("index.status", json!({}));
        unknown["unexpected"] = json!(true);
        assert!(parse_request(unknown).is_err());
        let mut absolute = request("index.status", json!({}));
        absolute["root"] = json!("/private/repository");
        assert!(parse_request(absolute).is_err());
    }

    #[test]
    fn lifecycle_builds_reads_refreshes_queries_doctors_and_repairs_without_path_leakage() {
        let workspace = tempdir().unwrap();
        fs::create_dir_all(workspace.path().join("src")).unwrap();
        fs::write(
            workspace.path().join("src/index.ts"),
            "export function main(): number { return helper(); }\nexport function helper(): number { return leaf(); }\nexport function leaf(): number { return 1; }\n",
        )
        .unwrap();

        let build = execute_request(
            parse_request(request("index.build", writer_arguments())).unwrap(),
            workspace.path(),
            "1.1.1",
        )
        .unwrap();
        assert_eq!(build["result"]["operation"], "index.build");
        assert_eq!(build["result"]["state"], "ready");
        assert_eq!(build["result"]["safeguards"]["canonicalMemoryWrites"], 0);
        assert!(!build
            .to_string()
            .contains(workspace.path().to_string_lossy().as_ref()));

        let index_path = workspace.path().join(INDEX_RELATIVE_PATH);
        let before_status = fs::read(&index_path).unwrap();
        let before_modified = fs::metadata(&index_path).unwrap().modified().unwrap();
        let before_readers = bundle_snapshot(&index_path);
        let build_omitted = build["result"]["summary"]["omittedCount"].clone();
        let build_database_bytes = build["result"]["summary"]["databaseBytes"].clone();
        let status = execute_request(
            parse_request(request("index.status", json!({}))).unwrap(),
            workspace.path(),
            "1.1.1",
        )
        .unwrap();
        assert_eq!(status["result"]["operation"], "index.status");
        assert_eq!(status["result"]["safeguards"]["readOnly"], true);
        assert_eq!(status["result"]["summary"]["omittedCount"], build_omitted);
        assert_eq!(
            status["result"]["summary"]["databaseBytes"],
            build_database_bytes
        );
        assert_eq!(fs::read(&index_path).unwrap(), before_status);
        assert_eq!(
            fs::metadata(&index_path).unwrap().modified().unwrap(),
            before_modified
        );
        assert_eq!(bundle_snapshot(&index_path), before_readers);

        let query = execute_request(
            parse_request(request(
                "index.query",
                json!({ "kind": "exact", "query": "main", "limit": 10 }),
            ))
            .unwrap(),
            workspace.path(),
            "1.1.1",
        )
        .unwrap();
        assert!(query["result"]["results"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["label"].as_str().unwrap().contains("main")));
        assert_eq!(bundle_snapshot(&index_path), before_readers);

        let depth_one = execute_request(
            parse_request(request(
                "index.query",
                json!({ "kind": "dependencies", "query": "main", "direction": "outbound", "depth": 1, "limit": 10 }),
            ))
            .unwrap(),
            workspace.path(),
            "1.1.1",
        )
        .unwrap();
        assert!(depth_one["result"]["results"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["label"].as_str().unwrap().contains("helper")));
        assert!(!depth_one["result"]["results"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["label"].as_str().unwrap().contains("leaf")));

        let depth_two = execute_request(
            parse_request(request(
                "index.query",
                json!({ "kind": "dependencies", "query": "main", "direction": "outbound", "depth": 2, "limit": 10 }),
            ))
            .unwrap(),
            workspace.path(),
            "1.1.1",
        )
        .unwrap();
        assert!(depth_two["result"]["results"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["label"].as_str().unwrap().contains("leaf")));

        let healthy_doctor = execute_request(
            parse_request(request("index.doctor", json!({}))).unwrap(),
            workspace.path(),
            "1.1.1",
        )
        .unwrap();
        assert_eq!(healthy_doctor["result"]["health"]["status"], "ready");
        assert_eq!(bundle_snapshot(&index_path), before_readers);

        let no_change = execute_request(
            parse_request(request("index.refresh", writer_arguments())).unwrap(),
            workspace.path(),
            "1.1.1",
        )
        .unwrap();
        assert_eq!(no_change["result"]["measurements"]["localFilesWritten"], 0);
        assert_eq!(fs::read(&index_path).unwrap(), before_status);

        fs::write(
            workspace.path().join("src/index.ts"),
            "export function main(): number { return helper(); }\nexport function helper(): number { return leaf(); }\nexport function leaf(): number { return 2; }\n",
        )
        .unwrap();
        let refreshed = execute_request(
            parse_request(request("index.refresh", writer_arguments())).unwrap(),
            workspace.path(),
            "1.1.1",
        )
        .unwrap();
        assert_eq!(refreshed["result"]["operation"], "index.refresh");
        assert_eq!(refreshed["result"]["measurements"]["changedFileCount"], 1);

        fs::write(&index_path, b"corrupt source index").unwrap();
        let doctor = execute_request(
            parse_request(request("index.doctor", json!({}))).unwrap(),
            workspace.path(),
            "1.1.1",
        )
        .unwrap();
        assert_eq!(doctor["result"]["health"]["status"], "corrupt");
        let plan = doctor["result"]["health"]["repairPlanFingerprint"]
            .as_str()
            .unwrap();
        let mut repair_arguments = writer_arguments();
        repair_arguments["confirmRepairPlan"] = json!(plan);
        let repaired = execute_request(
            parse_request(request("index.repair", repair_arguments)).unwrap(),
            workspace.path(),
            "1.1.1",
        )
        .unwrap();
        assert_eq!(repaired["result"]["operation"], "index.repair");
        assert_eq!(repaired["result"]["health"]["status"], "ready");
        assert_eq!(repaired["result"]["safeguards"]["repairPerformed"], true);
    }
}
