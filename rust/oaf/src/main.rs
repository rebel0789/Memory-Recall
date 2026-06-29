use anyhow::{anyhow, bail, Context, Result};
use chrono::{SecondsFormat, Utc};
use oaf_store::{ApproveReport, BatchFact, BatchReport, Store, StoreOptions};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

const PROVIDER: &str = "provider:native:memory:sqlite";
const PROTOCOL_VERSION: &str = "2025-06-18";
const SERVER_VERSION: &str = "0.1.0";

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("memory") => memory_command(&args[1..]),
        Some("mcp") => mcp_command(&args[1..]),
        Some(other) => bail!("unsupported command: {other}"),
        None => bail!("oaf rust m1 requires a command"),
    }
}

fn memory_command(args: &[String]) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("remember") => memory_remember(&args[1..]),
        Some("approve") => memory_approve(&args[1..]),
        Some("reject") => memory_reject(&args[1..]),
        Some("review") => memory_review(&args[1..]),
        Some(other) => bail!("memory unsupported command: {other}"),
        None => bail!("memory requires a subcommand"),
    }
}

fn memory_remember(args: &[String]) -> Result<()> {
    ensure_json(args)?;
    let config = CliConfig::from_args(args)?;
    let mut store = Store::open(&config.sqlite_abs, config.store_options())?;
    if let Some(batch) = option(args, "--batch") {
        let batch_path = config.root.join(&batch);
        let parsed: Value = serde_json::from_str(
            &fs::read_to_string(&batch_path)
                .with_context(|| format!("read batch {}", batch_path.display()))?,
        )?;
        let facts: Vec<BatchFact> =
            serde_json::from_value(parsed.get("facts").cloned().ok_or_else(|| {
                anyhow!("memory remember --batch requires JSON shaped as {{facts:[...]}}")
            })?)?;
        let report = store.remember_batch(&config.root, &config.scope, &facts)?;
        print_json(batch_report(&config, &batch, report));
        return Ok(());
    }

    let subject = required(args, "--subject")?;
    let predicate = required(args, "--predicate")?;
    let object = required(args, "--object")?;
    let source = required(args, "--source")?;
    let supersedes = has(args, "--supersedes-subject") || has(args, "--supersedes-predicate");
    let supersedes_subject =
        option(args, "--supersedes-subject").unwrap_or_else(|| subject.clone());
    let supersedes_predicate =
        option(args, "--supersedes-predicate").unwrap_or_else(|| predicate.clone());
    if supersedes && (supersedes_subject != subject || supersedes_predicate != predicate) {
        bail!("memory remember can only supersede the same subject and predicate as the new fact");
    }
    let report = store.remember_single(
        &config.scope,
        &subject,
        &predicate,
        &object,
        &source,
        supersedes,
    )?;
    print_json(remember_report(&config, &source, report));
    Ok(())
}

fn memory_approve(args: &[String]) -> Result<()> {
    ensure_json(args)?;
    let config = CliConfig::from_args(args)?;
    let mut store = Store::open(&config.sqlite_abs, config.store_options())?;
    let report = if has(args, "--all") {
        store.approve_all()?
    } else if let Some(source) = option(args, "--all-from") {
        store.approve_all_from(&source)?
    } else {
        let id = option(args, "--proposal").or_else(|| args.iter().find(|value| !value.starts_with("--")).cloned()).ok_or_else(|| anyhow!("memory approve requires <mpq_id>, --proposal <mpq_id>, --all-from <source>, or --all"))?;
        store.approve_one(&id)?
    };
    print_json(approve_report(&config, report));
    Ok(())
}

fn memory_reject(args: &[String]) -> Result<()> {
    ensure_json(args)?;
    let config = CliConfig::from_args(args)?;
    let mut store = Store::open(&config.sqlite_abs, config.store_options())?;
    let id = option(args, "--proposal")
        .or_else(|| args.iter().find(|value| !value.starts_with("--")).cloned())
        .ok_or_else(|| anyhow!("memory reject requires <mpq_id> or --proposal <mpq_id>"))?;
    let reason = option(args, "--reason").unwrap_or_else(|| "rejected_by_user".to_string());
    print_json(reject_report(&config, store.reject_one(&id, &reason)?));
    Ok(())
}

fn memory_review(args: &[String]) -> Result<()> {
    ensure_json(args)?;
    let config = CliConfig::from_args(args)?;
    let store = Store::open_read_only(&config.sqlite_abs, config.store_options())?;
    let proposal_facts = store.review_pending(500)?;
    let report = json!({
        "schemaVersion": "1.0.0",
        "command": "memory review",
        "generatedAt": config.now,
        "workspaceId": config.workspace_id,
        "source": source_block(&config),
        "summary": { "pendingProposalCount": proposal_facts.len(), "activeMemoryCreated": 0 },
        "proposalFacts": proposal_facts,
        "safeguards": safeguards(true, false, 0),
        "reportFingerprint": Value::Null
    });
    print_json(with_fingerprint(report));
    Ok(())
}

fn mcp_command(args: &[String]) -> Result<()> {
    if args.first().map(String::as_str) != Some("server") {
        bail!("mcp supports server only in Rust M1");
    }
    let config = CliConfig::from_args(&args[1..])?;
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    for line in input.lines().filter(|line| !line.trim().is_empty()) {
        let message: Value = serde_json::from_str(line).context("invalid JSON-RPC line")?;
        let response = handle_rpc(&config, &message);
        println!("{}", serde_json::to_string(&response)?);
    }
    Ok(())
}

fn handle_rpc(config: &CliConfig, message: &Value) -> Value {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    match message.get("method").and_then(Value::as_str).unwrap_or("") {
        "initialize" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "serverInfo": { "name": "open-agent-fabric", "version": SERVER_VERSION },
                "capabilities": {
                    "tools": { "listChanged": false },
                    "resources": { "subscribe": false, "listChanged": false },
                    "prompts": { "listChanged": false }
                }
            }
        }),
        "tools/list" => {
            json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": [memory_recall_tool()] } })
        }
        "tools/call" => match call_tool(config, message) {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(error) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32000, "message": "MCP tool failed", "data": { "code": "oaf_recall_error", "message": error.to_string() } }
            }),
        },
        _ => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": "Method not found", "data": { "code": "oaf_recall_error", "message": "unsupported MCP method" } }
        }),
    }
}

fn call_tool(config: &CliConfig, message: &Value) -> Result<Value> {
    let params = message
        .get("params")
        .and_then(Value::as_object)
        .context("params are required")?;
    if params.get("name").and_then(Value::as_str) != Some("memory.recall") {
        bail!("unknown MCP tool");
    }
    let args = params
        .get("arguments")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let payload = decorate_delivery(recall_payload(config, &args)?)?;
    Ok(json!({ "content": [{ "type": "text", "text": serde_json::to_string(&payload)? }] }))
}

fn recall_payload(config: &CliConfig, args: &serde_json::Map<String, Value>) -> Result<Value> {
    let query = required_json_string(args, "query", 240)?;
    let scope = json_string(args.get("scope"), "workspace", 64);
    let limit = json_i64(args.get("limit"), 8, 1, 20) as usize;
    let subject = optional_json_string(args.get("subject"), 128);
    let predicate = optional_json_string(args.get("predicate"), 128);
    let since = optional_json_string(args.get("since").or_else(|| args.get("cursor")), 80);
    let current_truth_only = args.get("currentTruthOnly").and_then(Value::as_bool) == Some(true)
        && args.get("verbose").and_then(Value::as_bool) != Some(true);
    if !config.sqlite_abs.is_file() {
        return Ok(base_payload(
            config,
            json!({ "available": false, "query": query, "scope": scope, "facts": [] }),
        ));
    }
    if !current_truth_only {
        bail!("rust M1 supports memory.recall currentTruthOnly only");
    }
    let store = Store::open_read_only(&config.sqlite_abs, config.store_options())?;
    if let Some(since) = since {
        return store.recall_delta(
            &scope,
            &query,
            subject.as_deref(),
            predicate.as_deref(),
            limit,
            &since,
        );
    }
    let facts = store.recall_current_truth(
        &scope,
        &query,
        subject.as_deref(),
        predicate.as_deref(),
        limit,
    )?;
    Ok(base_payload(
        config,
        json!({
            "available": true,
            "query": query,
            "scope": scope,
            "mode": "current-truth",
            "factCount": facts.len(),
            "activeFactCount": facts.len(),
            "proposalFactCount": 0,
            "summary": { "activeFactCount": facts.len(), "proposalFactCount": 0, "totalFactCount": facts.len() },
            "facts": facts,
            "cursor": { "previous": Value::Null, "next": config.now }
        }),
    ))
}

#[derive(Clone)]
struct CliConfig {
    root: PathBuf,
    sqlite_abs: PathBuf,
    sqlite_ref: String,
    workspace_id: String,
    scope: String,
    now: String,
}

impl CliConfig {
    fn from_args(args: &[String]) -> Result<Self> {
        let root = PathBuf::from(option(args, "--root").unwrap_or_else(|| ".".to_string()));
        let root = root.canonicalize().with_context(|| {
            format!(
                "memory --root must point at a local workspace directory: {}",
                root.display()
            )
        })?;
        let sqlite = option(args, "--sqlite").unwrap_or_else(|| ".local/memory.sqlite".to_string());
        let sqlite_abs = if Path::new(&sqlite).is_absolute() {
            PathBuf::from(&sqlite)
        } else {
            root.join(&sqlite)
        };
        let sqlite_ref = if Path::new(&sqlite).is_absolute() {
            "workspace://.local/memory.sqlite".to_string()
        } else {
            format!("workspace://{}", sqlite.replace('\\', "/"))
        };
        Ok(Self {
            root,
            sqlite_abs,
            sqlite_ref,
            workspace_id: option(args, "--workspace-id")
                .or_else(|| option(args, "--workspace"))
                .unwrap_or_else(|| "ws_local".to_string()),
            scope: option(args, "--scope").unwrap_or_else(|| "workspace".to_string()),
            now: fixed_now(),
        })
    }

    fn store_options(&self) -> StoreOptions {
        StoreOptions {
            workspace_id: self.workspace_id.clone(),
            now: self.now.clone(),
        }
    }
}

fn batch_report(config: &CliConfig, batch: &str, report: BatchReport) -> Value {
    with_fingerprint(json!({
        "schemaVersion": "1.0.0",
        "command": "memory remember --batch",
        "generatedAt": config.now,
        "workspaceId": config.workspace_id,
        "source": { "provider": PROVIDER, "sqliteRef": config.sqlite_ref, "batchRef": format!("workspace://{}", batch) },
        "summary": {
            "inputFactCount": report.recorded_count + report.skipped_unsafe_count + report.skipped_duplicate_count,
            "recordedCount": report.recorded_count,
            "proposalCount": report.recorded_count,
            "pendingProposalCount": report.recorded_count,
            "skippedUnsafeCount": report.skipped_unsafe_count,
            "skippedDuplicateCount": report.skipped_duplicate_count,
            "skipped": report.skipped,
            "supersededFactCount": 0,
            "activeMemoryCreated": 0
        },
        "proposalFacts": report.proposal_facts,
        "skipped": report.skipped,
        "safeguards": safeguards(false, true, 0),
        "reportFingerprint": Value::Null
    }))
}

fn remember_report(config: &CliConfig, source: &str, report: ApproveReport) -> Value {
    with_fingerprint(json!({
        "schemaVersion": "1.0.0",
        "command": "memory remember",
        "generatedAt": config.now,
        "workspaceId": config.workspace_id,
        "source": { "provider": PROVIDER, "sqliteRef": config.sqlite_ref, "sourceLocator": source },
        "summary": {
            "activeMemoryCreated": 1,
            "supersededFactCount": report.superseded_fact_count,
            "pendingProposalCount": 0
        },
        "proposal": report.proposal,
        "fact": report.fact,
        "supersededFacts": report.superseded_facts,
        "safeguards": safeguards(false, true, 1),
        "reportFingerprint": Value::Null
    }))
}

fn approve_report(config: &CliConfig, report: ApproveReport) -> Value {
    with_fingerprint(json!({
        "schemaVersion": "1.0.0",
        "command": "memory approve",
        "generatedAt": config.now,
        "workspaceId": config.workspace_id,
        "source": source_block(config),
        "summary": {
            "pendingProposalCount": report.pending_proposal_count,
            "activeMemoryCreated": report.active_memory_created,
            "rejectedProposalCount": 0,
            "supersededFactCount": report.superseded_fact_count
        },
        "proposal": report.proposal,
        "fact": report.fact,
        "facts": report.facts,
        "supersededFacts": report.superseded_facts,
        "safeguards": safeguards(false, true, report.active_memory_created),
        "reportFingerprint": Value::Null
    }))
}

fn reject_report(config: &CliConfig, report: ApproveReport) -> Value {
    with_fingerprint(json!({
        "schemaVersion": "1.0.0",
        "command": "memory reject",
        "generatedAt": config.now,
        "workspaceId": config.workspace_id,
        "source": source_block(config),
        "summary": { "pendingProposalCount": 0, "activeMemoryCreated": 0, "rejectedProposalCount": report.rejected_proposal_count },
        "proposal": report.proposal,
        "safeguards": safeguards(false, true, 0),
        "reportFingerprint": Value::Null
    }))
}

fn source_block(config: &CliConfig) -> Value {
    json!({ "provider": PROVIDER, "sqliteRef": config.sqlite_ref })
}

fn safeguards(read_only: bool, mutated: bool, active_created: usize) -> Value {
    json!({
        "readOnly": read_only,
        "proposalGated": true,
        "canonicalStateMutated": mutated,
        "activeMemoryCreated": active_created,
        "hardDeleted": false,
        "networkCalls": 0,
        "modelCalls": 0,
        "externalWritesEnabled": false,
        "rawSourceBodiesIncluded": false,
        "absoluteFilesystemLocationsIncluded": false
    })
}

fn base_payload(config: &CliConfig, data: Value) -> Value {
    json!({
        "schemaVersion": "1.0.0",
        "command": "memory.recall",
        "workspaceId": config.workspace_id,
        "generatedAt": config.now,
        "data": data,
        "safeguards": {
            "readOnly": true,
            "canonicalStateMutated": false,
            "externalWritesEnabled": false,
            "networkCalls": 0,
            "modelCalls": 0,
            "activeMemoryCreated": 0,
            "sourceSnapshotsWritten": 0,
            "deliveryStatsRecorded": false,
            "privateContentIncluded": false,
            "absoluteFilesystemLocationsIncluded": false
        }
    })
}

fn decorate_delivery(payload: Value) -> Result<Value> {
    let mut final_payload = payload.clone();
    let mut entry = delivery_entry(&final_payload)?;
    let preview_totals = totals(&entry);
    final_payload = decorate_payload(payload.clone(), &entry, &preview_totals);
    entry = delivery_entry(&final_payload)?;
    let final_totals = totals(&entry);
    Ok(decorate_payload(payload, &entry, &final_totals))
}

struct DeliveryEntry {
    delivered_tokens: i64,
    baseline_tokens: i64,
    tokens_saved: i64,
}

fn delivery_entry(payload: &Value) -> Result<DeliveryEntry> {
    let delivered_tokens = estimate_tokens(&serde_json::to_string(payload)?);
    let baseline_tokens = mcp_stats_baseline_tokens(payload)?;
    Ok(DeliveryEntry {
        delivered_tokens,
        baseline_tokens,
        tokens_saved: 0.max(baseline_tokens - delivered_tokens),
    })
}

fn decorate_payload(mut payload: Value, entry: &DeliveryEntry, totals: &Value) -> Value {
    if let Some(root) = payload.as_object_mut() {
        let data = root.entry("data").or_insert_with(|| json!({}));
        if let Some(data) = data.as_object_mut() {
            data.insert(
                "deliveryEstimate".to_string(),
                json!({
                    "toolName": "memory.recall",
                    "deliveredTokens": entry.delivered_tokens,
                    "baselineTokens": entry.baseline_tokens,
                    "tokensSaved": entry.tokens_saved,
                    "providerBillingClaimed": false,
                    "basis": "estimated tokens over exact MCP JSON tool payload text",
                    "requestFingerprint": format!("sha256:{}", "0".repeat(64))
                }),
            );
            data.insert("sessionStats".to_string(), totals.clone());
        }
        let safeguards = root.entry("safeguards").or_insert_with(|| json!({}));
        if let Some(safeguards) = safeguards.as_object_mut() {
            safeguards.insert("deliveryStatsRecorded".to_string(), Value::Bool(true));
        }
    }
    payload
}

fn totals(entry: &DeliveryEntry) -> Value {
    let percent = if entry.baseline_tokens > 0 {
        ((entry.tokens_saved as f64 / entry.baseline_tokens as f64) * 100.0).round() as i64
    } else {
        0
    };
    json!({
        "sessionId": "mcpsess_000000000000000000000000",
        "statsRef": "workspace://.local/mcp-stats.jsonl",
        "callCount": 1,
        "deliveredTokens": entry.delivered_tokens,
        "baselineTokens": entry.baseline_tokens,
        "tokensSaved": entry.tokens_saved,
        "tokenSavingPercent": percent,
        "providerBillingClaimed": false
    })
}

fn mcp_stats_baseline_tokens(payload: &Value) -> Result<i64> {
    let compact = estimate_tokens(&serde_json::to_string(&json!({
        "activeFacts": payload.pointer("/data/activeFacts").cloned().unwrap_or_else(|| json!([])),
        "facts": payload.pointer("/data/facts").cloned().unwrap_or_else(|| json!([])),
        "proposalFacts": payload.pointer("/data/proposalFacts").cloned().unwrap_or_else(|| json!([]))
    }))?);
    let verbose = payload
        .pointer("/data/recallBenchmark/baselineTokens")
        .and_then(Value::as_i64)
        .unwrap_or(compact);
    Ok(estimate_tokens(&serde_json::to_string(payload)?) + 0.max(verbose - compact))
}

fn memory_recall_tool() -> Value {
    json!({
        "name": "memory.recall",
        "description": "Recall governed active bi-temporal memory facts for a query and scope.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "required": ["query"],
            "properties": {
                "query": { "type": "string", "minLength": 1, "maxLength": 240 },
                "scope": { "type": "string", "maxLength": 64, "default": "workspace" },
                "client": { "type": "string", "maxLength": 80, "default": "default" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 20, "default": 8 },
                "since": { "type": "string", "maxLength": 80 },
                "verbose": { "type": "boolean", "default": false }
            }
        },
        "annotations": { "sideEffectClass": "read-only", "oafOperation": "memory.recall" }
    })
}

fn with_fingerprint(mut report: Value) -> Value {
    let fingerprint = format!("sha256:{}", sha256_hex(&canonical_json(&report)));
    if let Some(object) = report.as_object_mut() {
        object.insert("reportFingerprint".to_string(), Value::String(fingerprint));
    }
    report
}

fn print_json(value: Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(&value).expect("json report")
    );
}

fn ensure_json(args: &[String]) -> Result<()> {
    if option(args, "--format").as_deref().unwrap_or("json") != "json" {
        bail!("Rust M1 only supports --format json");
    }
    Ok(())
}

fn option(args: &[String], flag: &str) -> Option<String> {
    args.windows(2)
        .find_map(|pair| (pair[0] == flag).then(|| pair[1].clone()))
}

fn has(args: &[String], flag: &str) -> bool {
    args.iter().any(|arg| arg == flag)
}

fn required(args: &[String], flag: &str) -> Result<String> {
    option(args, flag).ok_or_else(|| anyhow!("{flag} requires a value"))
}

fn fixed_now() -> String {
    env::var("OAF_FIXED_NOW")
        .unwrap_or_else(|_| Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn required_json_string(
    args: &serde_json::Map<String, Value>,
    name: &str,
    max_len: usize,
) -> Result<String> {
    let value = args
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("mcp tool requires {name}"))?;
    let value = sanitize(value, max_len);
    if value.is_empty() {
        bail!("mcp tool requires {name}");
    }
    Ok(value)
}

fn optional_json_string(value: Option<&Value>, max_len: usize) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(|value| sanitize(value, max_len))
        .filter(|value| !value.is_empty())
}

fn json_string(value: Option<&Value>, fallback: &str, max_len: usize) -> String {
    optional_json_string(value, max_len).unwrap_or_else(|| fallback.to_string())
}

fn json_i64(value: Option<&Value>, fallback: i64, min: i64, max: i64) -> i64 {
    value
        .and_then(Value::as_i64)
        .unwrap_or(fallback)
        .clamp(min, max)
}

fn sanitize(value: &str, max_len: usize) -> String {
    let mut out = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if out.len() > max_len {
        out.truncate(max_len);
    }
    out
}

fn estimate_tokens(text: &str) -> i64 {
    1.max(((text.len() as f64) / 4.0).ceil() as i64)
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
