use anyhow::{bail, Context, Result};
use oaf_index::{
    GoRepositoryQuery, RepositoryGoOutput, RepositoryRegistry, RepositorySearchOutput,
    REPOSITORY_REGISTRY_LOCATOR, REPOSITORY_SEARCH_MAX_OUTPUT_BYTES,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::env;
use std::io::{self, BufRead, BufReader, Write};
use std::time::Instant;

const PROTOCOL_VERSION: &str = "1.0.0";
const RESPONSE_SCHEMA_VERSION: &str = "1.0.0";
const MAX_LINE_BYTES: usize = 64 * 1024;
const FALLBACK_REQUEST_ID: &str = "cireporeq_00000000000000000000000000000000";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestFrame {
    protocol_version: String,
    request_id: String,
    workspace_id: String,
    operation: String,
    root: String,
    registry_locator: String,
    deadline_ms: u64,
    response_schema_version: String,
    arguments: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegisterArguments {
    write: bool,
    display_name: String,
    root_locator: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListArguments {
    limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchArguments {
    query: String,
    repository_ids: Vec<String>,
    per_repository_limit: usize,
    limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GoArguments {
    repository_ids: Vec<String>,
    client_repository_id: String,
    service_repository_id: String,
    client_entry_native_id: String,
    service_target_native_id: String,
    limit: Option<usize>,
}

struct ParsedRequest {
    request_id: String,
    workspace_id: String,
    deadline_ms: u64,
    operation: Operation,
}

enum Operation {
    Register(RegisterArguments),
    List(ListArguments),
    Search(SearchArguments),
    Go(GoOperation, GoArguments),
}

#[derive(Clone, Copy)]
enum GoOperation {
    Resolve,
    Trace,
    Impact,
}

impl GoOperation {
    fn name(self) -> &'static str {
        match self {
            Self::Resolve => "repository.go.resolve",
            Self::Trace => "repository.go.trace",
            Self::Impact => "repository.go.impact",
        }
    }

    fn run(
        self,
        registry: &RepositoryRegistry,
        query: &GoRepositoryQuery<'_>,
        limit: Option<usize>,
    ) -> Result<RepositoryGoOutput> {
        match self {
            Self::Resolve => registry.resolve_go(query),
            Self::Trace => registry.trace_go(query, limit.context("repository_request_invalid")?),
            Self::Impact => registry.impact_go(query, limit.context("repository_request_invalid")?),
        }
    }
}

impl GoArguments {
    fn parse(value: Value, deadline_ms: u64, operation: GoOperation) -> Result<Self> {
        let has_limit = value
            .as_object()
            .is_some_and(|arguments| arguments.contains_key("limit"));
        let arguments: Self = serde_json::from_value(value)
            .map_err(|_| anyhow::anyhow!("repository_request_invalid"))?;
        let limit_valid = match (operation, has_limit, arguments.limit) {
            (GoOperation::Resolve, false, None) => true,
            (GoOperation::Trace | GoOperation::Impact, true, Some(limit)) => {
                (1..=25).contains(&limit)
            }
            _ => false,
        };
        if deadline_ms > 2_000
            || !limit_valid
            || !valid_go_selectors(
                &arguments.repository_ids,
                &arguments.client_repository_id,
                &arguments.service_repository_id,
                &arguments.client_entry_native_id,
                &arguments.service_target_native_id,
            )
        {
            bail!("repository_request_invalid");
        }
        Ok(arguments)
    }

    fn query(&self, deadline_ms: u64) -> GoRepositoryQuery<'_> {
        GoRepositoryQuery {
            repository_ids: &self.repository_ids,
            client_repository_id: &self.client_repository_id,
            service_repository_id: &self.service_repository_id,
            client_entry_native_id: &self.client_entry_native_id,
            service_target_native_id: &self.service_target_native_id,
            deadline_ms,
        }
    }
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
                &failure_frame(FALLBACK_REQUEST_ID, "repository_input_too_large"),
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
                            &failure_frame(FALLBACK_REQUEST_ID, "repository_invalid_json"),
                        )?;
                        continue;
                    }
                };
                let request_id = value
                    .get("requestId")
                    .and_then(Value::as_str)
                    .filter(|value| valid_prefixed_hex(value, "cireporeq_"))
                    .unwrap_or(FALLBACK_REQUEST_ID)
                    .to_string();
                let root = env::current_dir().context("repository_current_directory_failed")?;
                let frame = match parse_request(value)
                    .and_then(|request| execute_request(request, &root, engine_version))
                {
                    Ok(frame) => frame,
                    Err(error) => failure_frame(&request_id, safe_error_code(&error)),
                };
                write_frame(&mut writer, &frame)?;
            }
        }
    }
    Ok(())
}

fn parse_request(value: Value) -> Result<ParsedRequest> {
    let frame: RequestFrame =
        serde_json::from_value(value).map_err(|_| anyhow::anyhow!("repository_request_invalid"))?;
    if frame.protocol_version != PROTOCOL_VERSION
        || frame.response_schema_version != RESPONSE_SCHEMA_VERSION
        || frame.root != "."
        || frame.registry_locator != REPOSITORY_REGISTRY_LOCATOR
        || !valid_prefixed_hex(&frame.request_id, "cireporeq_")
        || !valid_workspace_id(&frame.workspace_id)
        || !(1..=120_000).contains(&frame.deadline_ms)
    {
        bail!("repository_request_invalid");
    }
    let operation = match frame.operation.as_str() {
        "repository.register" => {
            let arguments: RegisterArguments = serde_json::from_value(frame.arguments)
                .map_err(|_| anyhow::anyhow!("repository_request_invalid"))?;
            if !arguments.write {
                bail!("repository_request_invalid");
            }
            Operation::Register(arguments)
        }
        "repository.list" => {
            let arguments: ListArguments = serde_json::from_value(frame.arguments)
                .map_err(|_| anyhow::anyhow!("repository_request_invalid"))?;
            if !(1..=64).contains(&arguments.limit) {
                bail!("repository_request_invalid");
            }
            Operation::List(arguments)
        }
        "repository.search" => {
            let arguments: SearchArguments = serde_json::from_value(frame.arguments)
                .map_err(|_| anyhow::anyhow!("repository_request_invalid"))?;
            if frame.deadline_ms > 2_000 {
                bail!("repository_request_invalid");
            }
            Operation::Search(arguments)
        }
        "repository.go.resolve" => Operation::Go(
            GoOperation::Resolve,
            GoArguments::parse(frame.arguments, frame.deadline_ms, GoOperation::Resolve)?,
        ),
        "repository.go.trace" => Operation::Go(
            GoOperation::Trace,
            GoArguments::parse(frame.arguments, frame.deadline_ms, GoOperation::Trace)?,
        ),
        "repository.go.impact" => Operation::Go(
            GoOperation::Impact,
            GoArguments::parse(frame.arguments, frame.deadline_ms, GoOperation::Impact)?,
        ),
        _ => bail!("repository_operation_unsupported"),
    };
    Ok(ParsedRequest {
        request_id: frame.request_id,
        workspace_id: frame.workspace_id,
        deadline_ms: frame.deadline_ms,
        operation,
    })
}

fn execute_request(
    request: ParsedRequest,
    root: &std::path::Path,
    engine_version: &str,
) -> Result<Value> {
    let started = Instant::now();
    match request.operation {
        Operation::Register(arguments) => {
            let mut registry =
                RepositoryRegistry::open(root, &request.workspace_id, engine_version)?;
            let repository = registry.register(&arguments.display_name, &arguments.root_locator)?;
            Ok(success_frame(
                &request.request_id,
                "repository.register",
                vec![serde_json::to_value(repository)?],
                Vec::new(),
                Vec::new(),
                false,
                false,
                elapsed_ms(started),
                1,
                1,
                0,
                1,
                false,
            ))
        }
        Operation::List(arguments) => {
            let registry =
                RepositoryRegistry::open_read_only(root, &request.workspace_id, engine_version)?;
            let repositories = registry
                .list(arguments.limit)?
                .into_iter()
                .map(serde_json::to_value)
                .collect::<serde_json::Result<Vec<_>>>()?;
            Ok(success_frame(
                &request.request_id,
                "repository.list",
                repositories,
                Vec::new(),
                Vec::new(),
                false,
                false,
                elapsed_ms(started),
                0,
                0,
                0,
                0,
                true,
            ))
        }
        Operation::Search(arguments) => {
            let registry =
                RepositoryRegistry::open_read_only(root, &request.workspace_id, engine_version)?;
            let output = registry.search(
                &arguments.query,
                &arguments.repository_ids,
                arguments.per_repository_limit,
                arguments.limit,
                request.deadline_ms,
            )?;
            search_success_frame(&request.request_id, output, elapsed_ms(started))
        }
        Operation::Go(operation, arguments) => {
            let registry =
                RepositoryRegistry::open_read_only(root, &request.workspace_id, engine_version)?;
            let query = arguments.query(request.deadline_ms);
            let output = operation.run(&registry, &query, arguments.limit)?;
            go_success_frame(
                &request.request_id,
                operation.name(),
                output,
                elapsed_ms(started),
            )
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn success_frame(
    request_id: &str,
    operation: &str,
    repositories: Vec<Value>,
    results: Vec<Value>,
    per_repository: Vec<Value>,
    partial: bool,
    truncated: bool,
    duration_ms: u64,
    selected_repository_count: usize,
    opened_repository_count: usize,
    result_count: usize,
    local_files_written: usize,
    read_only: bool,
) -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "ok": true,
        "result": {
            "responseSchemaVersion": RESPONSE_SCHEMA_VERSION,
            "operation": operation,
            "registryLocator": REPOSITORY_REGISTRY_LOCATOR,
            "state": if partial { "partial" } else { "ready" },
            "repositories": repositories,
            "results": results,
            "perRepository": per_repository,
            "partial": partial,
            "truncated": truncated,
            "measurements": {
                "durationMs": duration_ms.min(120_000),
                "selectedRepositoryCount": selected_repository_count,
                "openedRepositoryCount": opened_repository_count,
                "resultCount": result_count,
                "localFilesWritten": local_files_written
            },
            "safeguards": {
                "readOnly": read_only,
                "localFilesWritten": local_files_written,
                "canonicalMemoryWrites": 0,
                "networkCalls": 0,
                "modelCalls": 0,
                "rawSourceBodiesIncluded": false,
                "absolutePathsIncluded": false
            }
        }
    })
}

fn search_success_frame(
    request_id: &str,
    output: RepositorySearchOutput,
    duration_ms: u64,
) -> Result<Value> {
    let selected_repository_count = output.per_repository.len();
    let result_count = output.results.len();
    let repositories = output
        .repositories
        .into_iter()
        .map(serde_json::to_value)
        .collect::<serde_json::Result<Vec<_>>>()?;
    let results = output
        .results
        .into_iter()
        .map(serde_json::to_value)
        .collect::<serde_json::Result<Vec<_>>>()?;
    let per_repository = output
        .per_repository
        .into_iter()
        .map(serde_json::to_value)
        .collect::<serde_json::Result<Vec<_>>>()?;
    Ok(success_frame(
        request_id,
        "repository.search",
        repositories,
        results,
        per_repository,
        output.partial,
        output.truncated,
        duration_ms,
        selected_repository_count,
        output.opened_repository_count,
        result_count,
        0,
        true,
    ))
}

fn go_success_frame(
    request_id: &str,
    operation: &str,
    output: RepositoryGoOutput,
    duration_ms: u64,
) -> Result<Value> {
    let result_count = output
        .go_relationships
        .len()
        .saturating_add(output.impacted_nodes.len());
    Ok(json!({
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "ok": true,
        "result": {
            "responseSchemaVersion": RESPONSE_SCHEMA_VERSION,
            "operation": operation,
            "registryLocator": REPOSITORY_REGISTRY_LOCATOR,
            "state": "ready",
            "repositories": output.repositories,
            "results": [],
            "perRepository": [],
            "goModules": output.go_modules,
            "goRelationships": output.go_relationships,
            "paths": output.paths,
            "impactedNodes": output.impacted_nodes,
            "partial": output.partial,
            "truncated": output.truncated,
            "measurements": {
                "durationMs": duration_ms.min(120_000),
                "selectedRepositoryCount": 2,
                "openedRepositoryCount": output.opened_repository_count,
                "resultCount": result_count,
                "localFilesWritten": 0
            },
            "safeguards": {
                "readOnly": true,
                "localFilesWritten": 0,
                "canonicalMemoryWrites": 0,
                "networkCalls": 0,
                "modelCalls": 0,
                "rawSourceBodiesIncluded": false,
                "absolutePathsIncluded": false
            }
        }
    }))
}

fn failure_frame(request_id: &str, code: &str) -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "ok": false,
        "error": {
            "code": code,
            "retryable": false,
            "details": []
        }
    })
}

fn safe_error_code(error: &anyhow::Error) -> &'static str {
    let message = format!("{error:#}");
    const SAFE_CODES: &[&str] = &[
        "repository_not_registered",
        "repository_operation_unsupported",
        "repository_request_invalid",
        "repository_registry_wrong_workspace",
        "repository_registry_schema_newer",
        "repository_registry_migration_required",
        "repository_registry_metadata_missing",
        "repository_registry_read_only_open_failed",
        "repository_root_locator_invalid",
        "repository_root_unavailable",
        "repository_root_outside_workspace",
        "repository_display_name_invalid",
        "repository_index_unavailable",
        "repository_index_active_generation_missing",
        "repository_search_request_invalid",
        "repository_search_output_too_large",
        "repository_go_request_invalid",
        "repository_go_module_unavailable",
        "repository_go_module_mismatch",
        "repository_go_import_not_found",
        "repository_go_entry_not_found",
        "repository_go_target_not_found",
        "repository_go_relationship_not_found",
        "repository_go_deadline_exceeded",
        "repository_go_output_too_large",
    ];
    SAFE_CODES
        .iter()
        .copied()
        .find(|code| message.contains(code))
        .unwrap_or("repository_operation_failed")
}

fn valid_prefixed_hex(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|suffix| {
        suffix.len() == 32
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn valid_go_selectors(
    repository_ids: &[String],
    client_repository_id: &str,
    service_repository_id: &str,
    client_entry_native_id: &str,
    service_target_native_id: &str,
) -> bool {
    repository_ids.len() == 2
        && repository_ids[0] == client_repository_id
        && repository_ids[1] == service_repository_id
        && client_repository_id != service_repository_id
        && valid_prefixed_hex(client_repository_id, "repo_")
        && valid_prefixed_hex(service_repository_id, "repo_")
        && valid_prefixed_hex(client_entry_native_id, "cinode_")
        && valid_prefixed_hex(service_target_native_id, "cinode_")
}

fn valid_workspace_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || (index > 0 && (byte.is_ascii_digit() || matches!(byte, b'_' | b'-')))
        })
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
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
) -> Result<LineRead> {
    line.clear();
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return Ok(if line.is_empty() {
                LineRead::Eof
            } else {
                LineRead::Line
            });
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(buffer.len(), |index| index + 1);
        if line.len().saturating_add(take) > max_bytes {
            reader.consume(take);
            if newline.is_none() {
                discard_to_newline(reader)?;
            }
            line.clear();
            return Ok(LineRead::Overflow);
        }
        line.extend_from_slice(&buffer[..take]);
        reader.consume(take);
        if newline.is_some() {
            while matches!(line.last(), Some(b'\n' | b'\r')) {
                line.pop();
            }
            return Ok(LineRead::Line);
        }
    }
}

fn discard_to_newline<R: BufRead>(reader: &mut R) -> Result<()> {
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return Ok(());
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(buffer.len(), |index| index + 1);
        reader.consume(take);
        if newline.is_some() {
            return Ok(());
        }
    }
}

fn write_frame<W: Write>(writer: &mut W, frame: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(frame)?;
    if bytes.len() > REPOSITORY_SEARCH_MAX_OUTPUT_BYTES {
        bail!("repository_response_too_large");
    }
    writer.write_all(&bytes)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(operation: &str, deadline_ms: u64, arguments: Value) -> Value {
        json!({
            "protocolVersion": "1.0.0",
            "requestId": "cireporeq_11111111111111111111111111111111",
            "workspaceId": "fleet-test",
            "operation": operation,
            "root": ".",
            "registryLocator": "workspace://.local/source-index/registry.v1.sqlite",
            "deadlineMs": deadline_ms,
            "responseSchemaVersion": "1.0.0",
            "arguments": arguments
        })
    }

    #[test]
    fn parser_accepts_only_closed_bounded_repository_operations() {
        assert!(matches!(
            parse_request(request(
                "repository.register",
                120_000,
                json!({
                    "write": true,
                    "displayName": "Repository A",
                    "rootLocator": "workspace://repo-a"
                })
            ))
            .unwrap()
            .operation,
            Operation::Register(_)
        ));
        assert!(matches!(
            parse_request(request("repository.list", 120_000, json!({ "limit": 64 })))
                .unwrap()
                .operation,
            Operation::List(_)
        ));
        assert!(matches!(
            parse_request(request(
                "repository.search",
                2_000,
                json!({
                    "query": "sharedEntry",
                    "repositoryIds": ["repo_11111111111111111111111111111111"],
                    "perRepositoryLimit": 25,
                    "limit": 50
                })
            ))
            .unwrap()
            .operation,
            Operation::Search(_)
        ));
        let go_selectors = json!({
            "repositoryIds": [
                "repo_11111111111111111111111111111111",
                "repo_22222222222222222222222222222222"
            ],
            "clientRepositoryId": "repo_11111111111111111111111111111111",
            "serviceRepositoryId": "repo_22222222222222222222222222222222",
            "clientEntryNativeId": "cinode_33333333333333333333333333333333",
            "serviceTargetNativeId": "cinode_44444444444444444444444444444444"
        });
        assert!(matches!(
            parse_request(request(
                "repository.go.resolve",
                2_000,
                go_selectors.clone()
            ))
            .unwrap()
            .operation,
            Operation::Go(GoOperation::Resolve, _)
        ));
        let mut resolve_with_limit = go_selectors.clone();
        resolve_with_limit["limit"] = Value::Null;
        assert!(
            parse_request(request("repository.go.resolve", 2_000, resolve_with_limit)).is_err()
        );
        let mut bounded = go_selectors.clone();
        bounded["limit"] = json!(25);
        assert!(matches!(
            parse_request(request("repository.go.trace", 2_000, bounded.clone()))
                .unwrap()
                .operation,
            Operation::Go(GoOperation::Trace, _)
        ));
        assert!(matches!(
            parse_request(request("repository.go.impact", 2_000, bounded.clone()))
                .unwrap()
                .operation,
            Operation::Go(GoOperation::Impact, _)
        ));
        bounded["limit"] = json!(26);
        assert!(parse_request(request("repository.go.trace", 2_000, bounded)).is_err());
        assert!(parse_request(request("repository.go.resolve", 2_001, go_selectors)).is_err());
        assert!(parse_request(request(
            "repository.search",
            2_001,
            json!({
                "query": "sharedEntry",
                "repositoryIds": ["repo_11111111111111111111111111111111"],
                "perRepositoryLimit": 25,
                "limit": 50
            })
        ))
        .is_err());
        let mut unknown = request("repository.list", 100, json!({ "limit": 1 }));
        unknown
            .as_object_mut()
            .unwrap()
            .insert("unexpected".to_string(), Value::Bool(true));
        assert!(parse_request(unknown).is_err());
    }

    #[test]
    fn response_frames_never_expose_error_messages_or_paths() {
        let failure = failure_frame(
            "cireporeq_11111111111111111111111111111111",
            "repository_operation_failed",
        );
        assert_eq!(failure["error"]["details"], json!([]));
        assert!(failure.get("message").is_none());
        let success = success_frame(
            "cireporeq_11111111111111111111111111111111",
            "repository.list",
            Vec::new(),
            Vec::new(),
            Vec::new(),
            false,
            false,
            0,
            0,
            0,
            0,
            0,
            true,
        );
        assert_eq!(
            success["result"]["safeguards"]["absolutePathsIncluded"],
            false
        );
        assert_eq!(success["result"]["safeguards"]["canonicalMemoryWrites"], 0);
    }
}
