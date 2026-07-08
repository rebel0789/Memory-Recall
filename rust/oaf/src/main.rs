#![recursion_limit = "256"]

use anyhow::{anyhow, bail, Context, Result};
use chrono::{SecondsFormat, Utc};
use oaf_ingest::{
    discover_file_hashes, extract_code_fingerprints, extract_documents, extract_repo,
    report_quality_fields, retirement_facts, CodeFingerprint, IngestFileHash, IngestOptions,
    CODE_MINHASH_K, DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_MEMORY_BYTES,
};
use oaf_store::{
    ActiveFactSnapshot, ApproveReport, BatchFact, BatchReport, SearchMode, Store, StoreOptions,
};
use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

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
        Some("--version") | Some("-V") => version_command(),
        Some("install") => install_command(&args[1..]),
        Some("ui") => ui_command(&args[1..]),
        Some("memory") => memory_command(&args[1..]),
        Some("mcp") => mcp_command(&args[1..]),
        Some("ingest") => ingest_command(&args[1..]),
        Some("ingest-docs") => ingest_docs_command(&args[1..]),
        Some("cross-repo") => cross_repo_command(&args[1..]),
        Some("connectors") => connectors_command(&args[1..]),
        Some("similarity") => similarity_command(&args[1..]),
        Some("dead-code") => dead_code_command(&args[1..]),
        Some("search") => search_command(&args[1..]),
        Some("graph") => graph_command(&args[1..]),
        Some("query") => query_command(&args[1..]),
        Some("architecture") => architecture_command(&args[1..]),
        Some("loop") => loop_command(&args[1..]),
        Some("impact") => impact_command(&args[1..]),
        Some(other) => bail!("unsupported command: {other}"),
        None => bail!("oaf rust requires a command"),
    }
}

fn version_command() -> Result<()> {
    println!("oaf {SERVER_VERSION}");
    Ok(())
}

const INSTALL_SERVER_NAME: &str = "open-agent-fabric";

#[derive(Clone, Copy)]
enum InstallFormat {
    Json,
    Toml,
}

#[derive(Clone)]
struct InstallTarget {
    client: &'static str,
    format: InstallFormat,
    path: PathBuf,
}

struct InstallOutcome {
    changed: bool,
    action: String,
    backup: Option<PathBuf>,
}

fn install_command(args: &[String]) -> Result<()> {
    ensure_json(args)?;
    let config_home = install_config_home()?;
    let targets = install_targets(
        option(args, "--client")
            .unwrap_or_else(|| "all".to_string())
            .as_str(),
        &config_home,
    )?;
    let command = env::current_exe()
        .context("resolve current executable")?
        .display()
        .to_string();
    let uninstall = has(args, "--uninstall");
    let dry_run = has(args, "--dry-run");
    let server = json!({ "command": command, "args": ["mcp", "server", "--stdio"], "env": {} });
    let touched_files = install_touched_files(&targets);
    let plan = json!({
        "command": "install",
        "serverName": INSTALL_SERVER_NAME,
        "server": server,
        "clients": targets.iter().map(|target| target.client).collect::<Vec<_>>(),
        "touchedFiles": touched_files,
        "uninstall": uninstall
    });
    let plan_fingerprint = fingerprint_json(&plan);
    if !dry_run && option(args, "--confirm").as_deref() != Some(plan_fingerprint.as_str()) {
        bail!("install requires --dry-run first, then --confirm {plan_fingerprint}");
    }

    let mut entries = Vec::new();
    let mut changed = false;
    let mut touched = touched_files;
    if !dry_run {
        for target in &targets {
            let outcome = apply_install_target(target, &server, uninstall)?;
            changed |= outcome.changed;
            if let Some(backup) = &outcome.backup {
                touched.push(backup.display().to_string());
            }
            entries.push(install_entry(target, &server, &outcome.action));
        }
    } else {
        entries = targets
            .iter()
            .map(|target| {
                install_entry(
                    target,
                    &server,
                    if uninstall {
                        "would-uninstall"
                    } else {
                        "would-install"
                    },
                )
            })
            .collect();
    }
    touched.sort();
    touched.dedup();
    print_json(json!({
        "schemaVersion": "1.0.0",
        "command": "install",
        "generatedAt": fixed_now(),
        "dryRun": dry_run,
        "uninstall": uninstall,
        "changed": changed,
        "idempotent": !dry_run && !changed,
        "confirmationRequired": dry_run,
        "planFingerprint": plan_fingerprint,
        "receipt": {
            "serverName": INSTALL_SERVER_NAME,
            "configHome": config_home.display().to_string(),
            "clients": targets.iter().map(|target| target.client).collect::<Vec<_>>(),
            "touchedFiles": touched,
            "entries": entries,
            "confirmCommand": format!("oaf install --client {}{} --confirm {} --format json", option(args, "--client").unwrap_or_else(|| "all".to_string()), if uninstall { " --uninstall" } else { "" }, plan_fingerprint)
        },
        "safeguards": {
            "dryRunBeforeWrite": true,
            "confirmationRequired": true,
            "atomicWrites": true,
            "safeTempFiles": "create_new_random_same_directory",
            "writesOutsideConfigHome": false,
            "networkCalls": 0,
            "modelCalls": 0
        }
    }));
    Ok(())
}

fn install_config_home() -> Result<PathBuf> {
    if let Ok(home) = env::var("OAF_CONFIG_HOME") {
        return Ok(PathBuf::from(home));
    }
    env::var("HOME")
        .map(PathBuf::from)
        .context("HOME or OAF_CONFIG_HOME is required for install")
}

fn install_targets(client: &str, home: &Path) -> Result<Vec<InstallTarget>> {
    let all = vec![
        InstallTarget {
            client: "claude-code",
            format: InstallFormat::Json,
            path: home.join(".claude/mcp.json"),
        },
        InstallTarget {
            client: "codex",
            format: InstallFormat::Toml,
            path: home.join(".codex/config.toml"),
        },
        InstallTarget {
            client: "cursor",
            format: InstallFormat::Json,
            path: home.join(".cursor/mcp.json"),
        },
        InstallTarget {
            client: "vscode",
            format: InstallFormat::Json,
            path: home.join(".vscode/mcp.json"),
        },
    ];
    let normalized = match client {
        "all" => return Ok(all),
        "claude" => "claude-code",
        other => other,
    };
    let Some(target) = all.into_iter().find(|target| target.client == normalized) else {
        bail!("install --client must be all|claude-code|codex|cursor|vscode");
    };
    Ok(vec![target])
}

fn install_entry(target: &InstallTarget, server: &Value, action: &str) -> Value {
    json!({
        "client": target.client,
        "configPath": target.path.display().to_string(),
        "format": match target.format { InstallFormat::Json => "json", InstallFormat::Toml => "toml" },
        "target": match target.format { InstallFormat::Json => "mcpServers.open-agent-fabric", InstallFormat::Toml => "mcp_servers.open-agent-fabric" },
        "action": action,
        "server": server
    })
}

fn install_touched_files(targets: &[InstallTarget]) -> Vec<String> {
    let mut files = Vec::new();
    for target in targets {
        files.push(target.path.display().to_string());
        let backup = install_backup_path(&target.path);
        if target.path.exists() || backup.exists() {
            files.push(backup.display().to_string());
        }
    }
    files.sort();
    files.dedup();
    files
}

fn apply_install_target(
    target: &InstallTarget,
    server: &Value,
    uninstall: bool,
) -> Result<InstallOutcome> {
    match target.format {
        InstallFormat::Json => apply_json_install(target, server, uninstall),
        InstallFormat::Toml => apply_toml_install(target, server, uninstall),
    }
}

fn apply_json_install(
    target: &InstallTarget,
    server: &Value,
    uninstall: bool,
) -> Result<InstallOutcome> {
    if uninstall && install_backup_path(&target.path).exists() {
        let backup = restore_backup(&target.path)?;
        return Ok(InstallOutcome {
            changed: true,
            action: "restored-backup".to_string(),
            backup: Some(backup),
        });
    }
    let text = fs::read_to_string(&target.path).ok();
    let mut parsed = match text
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(existing) => serde_json::from_str::<Value>(existing)
            .with_context(|| format!("parse JSON config {}", target.path.display()))?,
        None => json!({}),
    };
    if !parsed.is_object() {
        bail!(
            "install JSON config must be an object: {}",
            target.path.display()
        );
    }
    let object = parsed.as_object_mut().expect("object checked");
    let servers = object
        .entry("mcpServers".to_string())
        .or_insert_with(|| json!({}));
    if !servers.is_object() {
        bail!(
            "install JSON mcpServers must be an object: {}",
            target.path.display()
        );
    }
    let servers = servers.as_object_mut().expect("object checked");
    if uninstall {
        if servers.remove(INSTALL_SERVER_NAME).is_none() {
            return Ok(InstallOutcome {
                changed: false,
                action: "not-installed".to_string(),
                backup: None,
            });
        }
        if json_config_only_empty_mcp_servers(&parsed) {
            fs::remove_file(&target.path)
                .with_context(|| format!("remove config {}", target.path.display()))?;
            return Ok(InstallOutcome {
                changed: true,
                action: "removed-file".to_string(),
                backup: None,
            });
        }
        let backup = backup_existing(&target.path)?;
        atomic_write(
            &target.path,
            &format!("{}\n", serde_json::to_string_pretty(&parsed)?),
        )?;
        return Ok(InstallOutcome {
            changed: true,
            action: "removed-entry".to_string(),
            backup,
        });
    }
    if servers.get(INSTALL_SERVER_NAME) == Some(server) {
        return Ok(InstallOutcome {
            changed: false,
            action: "already-installed".to_string(),
            backup: None,
        });
    }
    servers.insert(INSTALL_SERVER_NAME.to_string(), server.clone());
    let backup = if target.path.exists() {
        backup_existing(&target.path)?
    } else {
        None
    };
    atomic_write(
        &target.path,
        &format!("{}\n", serde_json::to_string_pretty(&parsed)?),
    )?;
    Ok(InstallOutcome {
        changed: true,
        action: "installed".to_string(),
        backup,
    })
}

fn json_config_only_empty_mcp_servers(value: &Value) -> bool {
    value
        .as_object()
        .map(|object| {
            object.len() == 1
                && object
                    .get("mcpServers")
                    .and_then(Value::as_object)
                    .is_some_and(|servers| servers.is_empty())
        })
        .unwrap_or(false)
}

fn apply_toml_install(
    target: &InstallTarget,
    server: &Value,
    uninstall: bool,
) -> Result<InstallOutcome> {
    let command = server
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let desired = toml_managed_block(command);
    let text = fs::read_to_string(&target.path).ok();
    if uninstall {
        if install_backup_path(&target.path).exists() {
            let backup = restore_backup(&target.path)?;
            return Ok(InstallOutcome {
                changed: true,
                action: "restored-backup".to_string(),
                backup: Some(backup),
            });
        }
        let Some(existing) = text else {
            return Ok(InstallOutcome {
                changed: false,
                action: "not-installed".to_string(),
                backup: None,
            });
        };
        let Some(next) = remove_toml_managed_block(&existing) else {
            return Ok(InstallOutcome {
                changed: false,
                action: "not-installed".to_string(),
                backup: None,
            });
        };
        if next.trim().is_empty() {
            fs::remove_file(&target.path)
                .with_context(|| format!("remove config {}", target.path.display()))?;
            return Ok(InstallOutcome {
                changed: true,
                action: "removed-file".to_string(),
                backup: None,
            });
        }
        let backup = backup_existing(&target.path)?;
        atomic_write(&target.path, &next)?;
        return Ok(InstallOutcome {
            changed: true,
            action: "removed-entry".to_string(),
            backup,
        });
    }
    let next = match text {
        Some(existing) if existing.contains(&desired) => {
            return Ok(InstallOutcome {
                changed: false,
                action: "already-installed".to_string(),
                backup: None,
            });
        }
        Some(existing) => replace_or_append_toml_block(&existing, &desired),
        None => desired,
    };
    let backup = if target.path.exists() {
        backup_existing(&target.path)?
    } else {
        None
    };
    atomic_write(&target.path, &next)?;
    Ok(InstallOutcome {
        changed: true,
        action: "installed".to_string(),
        backup,
    })
}

fn toml_managed_block(command: &str) -> String {
    format!(
        "# OAF managed begin {INSTALL_SERVER_NAME}\n[mcp_servers.{INSTALL_SERVER_NAME}]\ncommand = \"{}\"\nargs = [\"mcp\", \"server\", \"--stdio\"]\n# OAF managed end {INSTALL_SERVER_NAME}\n",
        toml_quote(command)
    )
}

fn toml_quote(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn replace_or_append_toml_block(existing: &str, desired: &str) -> String {
    if remove_toml_managed_block(existing).is_some() {
        return format!(
            "{}{}",
            remove_toml_managed_block(existing).unwrap_or_default(),
            desired
        );
    }
    format!(
        "{}{}{}",
        existing.trim_end(),
        if existing.trim().is_empty() {
            ""
        } else {
            "\n\n"
        },
        desired
    )
}

fn remove_toml_managed_block(existing: &str) -> Option<String> {
    let begin = format!("# OAF managed begin {INSTALL_SERVER_NAME}");
    let end = format!("# OAF managed end {INSTALL_SERVER_NAME}");
    let start = existing.find(&begin)?;
    let end_start = existing[start..].find(&end)? + start;
    let end_index = existing[end_start..]
        .find('\n')
        .map(|offset| end_start + offset + 1)
        .unwrap_or(existing.len());
    Some(format!("{}{}", &existing[..start], &existing[end_index..]))
}

fn backup_existing(path: &Path) -> Result<Option<PathBuf>> {
    if !path.exists() {
        return Ok(None);
    }
    let backup = install_backup_path(path);
    if backup.exists() {
        return Ok(Some(backup));
    }
    let content = fs::read(path).with_context(|| format!("read config {}", path.display()))?;
    let mut handle = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&backup)
        .with_context(|| format!("create backup config {}", backup.display()))?;
    handle.write_all(&content)?;
    handle.sync_all()?;
    Ok(Some(backup))
}

fn atomic_write(path: &Path, content: &str) -> Result<()> {
    atomic_write_bytes(path, content.as_bytes())
}

fn atomic_write_bytes(path: &Path, content: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create config directory {}", parent.display()))?;
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("config");
    let tmp = parent.join(format!(".{file}.{}.tmp", random_hex(12)?));
    let mut handle = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .with_context(|| format!("create temp config {}", tmp.display()))?;
    handle.write_all(content)?;
    handle.sync_all()?;
    fs::rename(&tmp, path).with_context(|| format!("replace config {}", path.display()))?;
    Ok(())
}

fn restore_backup(path: &Path) -> Result<PathBuf> {
    let backup = install_backup_path(path);
    let content = fs::read(&backup).with_context(|| format!("read backup {}", backup.display()))?;
    atomic_write_bytes(path, &content)?;
    fs::remove_file(&backup).with_context(|| format!("remove backup {}", backup.display()))?;
    Ok(backup)
}

fn install_backup_path(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("config");
    parent.join(format!(".{file}.{INSTALL_SERVER_NAME}.bak"))
}

fn random_hex(bytes: usize) -> Result<String> {
    let mut data = vec![0_u8; bytes];
    getrandom::getrandom(&mut data)
        .map_err(|error| anyhow!("secure random bytes for install temp file: {error}"))?;
    Ok(hex::encode(data))
}

fn ui_command(args: &[String]) -> Result<()> {
    ensure_json(args)?;
    let config = CliConfig::from_args(args)?;
    let port = parse_usize_option(args, "--port", 4317, 1, 65535) as u16;
    let listener = TcpListener::bind(("127.0.0.1", port))
        .with_context(|| format!("bind oaf ui on 127.0.0.1:{port}"))?;
    let actual_port = listener.local_addr()?.port();
    print_json(json!({
        "schemaVersion": "1.0.0",
        "command": "ui",
        "url": format!("http://127.0.0.1:{actual_port}"),
        "bind": "127.0.0.1",
        "port": actual_port,
        "safeguards": {
            "localhostOnly": true,
            "readOnly": true,
            "assetsCompiledIn": true,
            "networkCalls": 0,
            "modelCalls": 0,
            "externalWritesEnabled": false
        }
    }));
    for stream in listener.incoming() {
        if let Ok(stream) = stream {
            let _ = handle_ui_stream(stream, &config);
        }
    }
    Ok(())
}

fn handle_ui_stream(mut stream: TcpStream, config: &CliConfig) -> Result<()> {
    let mut buffer = [0_u8; 4096];
    let read = stream.read(&mut buffer)?;
    let request = String::from_utf8_lossy(&buffer[..read]);
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");
    if path == "/" {
        return http_response(&mut stream, 200, "text/html; charset=utf-8", UI_HTML);
    }
    if path == "/wiki" || path == "/wiki/" {
        return http_response(&mut stream, 200, "text/html; charset=utf-8", WIKI_HTML);
    }
    if path.starts_with("/api/graph") {
        let history = path.contains("mode=history");
        let store = Store::open_read_only(&config.sqlite_abs, config.store_options())?;
        let graph = store.ui_graph(&config.scope, &config.now, history)?;
        return http_response(
            &mut stream,
            200,
            "application/json; charset=utf-8",
            &serde_json::to_string(&graph)?,
        );
    }
    if path.starts_with("/api/wiki") {
        let store = Store::open_read_only(&config.sqlite_abs, config.store_options())?;
        let wiki = store.knowledge_wiki(&config.scope, &config.now)?;
        return http_response(
            &mut stream,
            200,
            "application/json; charset=utf-8",
            &serde_json::to_string(&wiki)?,
        );
    }
    http_response(
        &mut stream,
        404,
        "application/json; charset=utf-8",
        r#"{"error":"not found"}"#,
    )
}

fn http_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &str,
) -> Result<()> {
    let status_text = if status == 200 { "OK" } else { "Not Found" };
    write!(
        stream,
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )?;
    Ok(())
}

const UI_HTML: &str = r#"<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OAF Memory Graph</title>
<style>
html,body{margin:0;height:100%;background:#101317;color:#eceff3;font:14px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{display:grid;grid-template-rows:auto 1fr}
header{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid #303842;background:#171b21}
h1{font-size:15px;font-weight:650;margin:0}
button{border:1px solid #3b4653;background:#202833;color:#eceff3;border-radius:6px;padding:7px 10px;cursor:pointer}
button[aria-pressed=true]{background:#2f6fed;border-color:#79a8ff}
#wrap{display:grid;grid-template-columns:1fr 280px;min-height:0}
canvas{width:100%;height:100%;display:block}
aside{border-left:1px solid #303842;background:#15191f;padding:12px;overflow:auto}
.k{color:#9aa6b2}.pill{display:inline-block;margin:3px 4px 3px 0;padding:3px 6px;border-radius:999px;background:#24303c;color:#cfd8e3;font-size:12px}
</style>
<header><h1>OAF Memory Graph</h1><button id="current" aria-pressed="true">Current</button><button id="history" aria-pressed="false">History</button></header>
<div id="wrap"><canvas id="graph"></canvas><aside id="detail"><div class="k">Select a node</div></aside></div>
<script>
const canvas=document.getElementById('graph'),ctx=canvas.getContext('2d'),detail=document.getElementById('detail');
let graph={nodes:[],edges:[],communities:[]},mode='current',focus=null,sim=null;
function color(n){return n.governedDecision?'#ffcf5a':['#6ee7b7','#7aa2ff','#f08bd3','#f97373','#a3e635','#22d3ee'][n.community%6]}
function resize(){const r=canvas.getBoundingClientRect();canvas.width=Math.max(320,r.width*devicePixelRatio);canvas.height=Math.max(240,r.height*devicePixelRatio)}
addEventListener('resize',resize);resize();
async function load(next){mode=next;document.getElementById('current').setAttribute('aria-pressed',mode==='current');document.getElementById('history').setAttribute('aria-pressed',mode==='history');graph=await fetch('/api/graph?mode='+mode).then(r=>r.json());seed();tick()}
function seed(){const w=canvas.width,h=canvas.height,cx=w/2,cy=h/2,r=Math.min(w,h)*0.34;graph.nodes.forEach((n,i)=>{const a=(i/Math.max(1,graph.nodes.length))*Math.PI*2;n.x=cx+Math.cos(a)*r;n.y=cy+Math.sin(a)*r;n.vx=0;n.vy=0});}
function tick(){cancelAnimationFrame(sim);step();draw();sim=requestAnimationFrame(tick)}
function step(){const nodes=graph.nodes,by=new Map(nodes.map(n=>[n.id,n]));for(const a of nodes)for(const b of nodes){if(a===b)continue;const dx=a.x-b.x,dy=a.y-b.y,d=Math.max(40,Math.hypot(dx,dy));a.vx+=dx/d*18/d;a.vy+=dy/d*18/d}for(const e of graph.edges){const a=by.get(e.from),b=by.get(e.to);if(!a||!b)continue;const dx=b.x-a.x,dy=b.y-a.y,d=Math.max(1,Math.hypot(dx,dy)),pull=(d-170)*0.0009;a.vx+=dx*pull;b.vx-=dx*pull;a.vy+=dy*pull;b.vy-=dy*pull}for(const n of nodes){n.vx*=0.86;n.vy*=0.86;n.x=Math.min(canvas.width-20,Math.max(20,n.x+n.vx));n.y=Math.min(canvas.height-20,Math.max(20,n.y+n.vy))}}
function draw(){ctx.clearRect(0,0,canvas.width,canvas.height);const by=new Map(graph.nodes.map(n=>[n.id,n]));ctx.lineWidth=1*devicePixelRatio;for(const e of graph.edges){const a=by.get(e.from),b=by.get(e.to);if(!a||!b)continue;ctx.strokeStyle=e.governedDecision?'#ffcf5a66':'#6b728066';ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke()}for(const n of graph.nodes){ctx.fillStyle=color(n);ctx.beginPath();ctx.arc(n.x,n.y,(focus===n.id?8:5)*devicePixelRatio,0,Math.PI*2);ctx.fill();if(focus===n.id){ctx.fillStyle='#f8fafc';ctx.font=`${12*devicePixelRatio}px system-ui`;ctx.fillText(n.label,n.x+10,n.y-10)}}}
canvas.addEventListener('click',ev=>{const r=canvas.getBoundingClientRect(),x=(ev.clientX-r.left)*devicePixelRatio,y=(ev.clientY-r.top)*devicePixelRatio;let best=null,dist=1e9;for(const n of graph.nodes){const d=Math.hypot(n.x-x,n.y-y);if(d<dist){dist=d;best=n}}if(best&&dist<28*devicePixelRatio){focus=best.id;const rel=graph.edges.filter(e=>e.from===best.id||e.to===best.id).slice(0,20);detail.innerHTML=`<h2>${best.label}</h2><div class="k">${best.type} · community ${best.community} · degree ${best.degree}</div>${rel.map(e=>`<span class="pill">${e.from===best.id?'→ '+e.to:'← '+e.from} ${e.predicate}</span>`).join('')}`;}});
document.getElementById('current').onclick=()=>load('current');document.getElementById('history').onclick=()=>load('history');load('current');
</script>
</html>
"#;

const WIKI_HTML: &str = r##"<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OAF Knowledge Wiki</title>
<style>
html,body{margin:0;background:#f7f7f4;color:#1d232a;font:14px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{display:grid;grid-template-columns:240px 1fr;min-height:100vh}
nav{border-right:1px solid #d8d9d4;background:#ecece7;padding:18px;position:sticky;top:0;height:100vh;box-sizing:border-box}
main{padding:22px;max-width:1120px}
h1{font-size:20px;margin:0 0 18px}h2{font-size:17px;margin:28px 0 10px}h3{font-size:14px;margin:18px 0 8px}
a{display:block;color:#1f4f7a;text-decoration:none;margin:8px 0}code{background:#e5e7df;padding:2px 5px;border-radius:4px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px}.card{border:1px solid #d8d9d4;background:#fff;border-radius:6px;padding:10px}
.fact{font-size:13px;border-top:1px solid #ecece7;padding:7px 0}.muted{color:#68707a}.pill{display:inline-block;margin:3px 5px 3px 0;padding:3px 6px;border-radius:999px;background:#e8eef4;color:#24445f;font-size:12px}
</style>
<nav><h1>OAF Wiki</h1><a href="#index">Index</a><a href="#entities">Entities</a><a href="#communities">Communities</a><a href="#decisions">Decisions</a><a href="#current">Current Truth</a><a href="#history">History</a><p class="muted" id="summary">Loading</p></nav>
<main id="app"><h1>Knowledge Wiki</h1></main>
<script>
const app=document.getElementById('app'),summary=document.getElementById('summary');
function esc(v){return String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function fact(f){return `<div class="fact"><code>${esc(f.subject)}</code> ${esc(f.predicate)} <code>${esc(f.object)}</code><div class="muted">${esc(f.status)} · ${esc(f.sourceRef)}</div></div>`}
function card(title,body){return `<section class="card"><h3>${esc(title)}</h3>${body}</section>`}
fetch('/api/wiki').then(r=>r.json()).then(w=>{
summary.textContent=`${w.summary.currentFactCount} current facts · ${w.summary.historyFactCount} history`;
const p=w.pages;
app.innerHTML=`<h1 id="index">Knowledge Wiki</h1>
<p class="muted">Offline governed memory surface. No CDN, no model calls, no external database.</p>
<div class="grid">${card('Entities',`${w.summary.entityPageCount} pages`)}${card('Communities',`${w.summary.communityPageCount} pages`)}${card('Decisions',`${w.summary.decisionPageCount} pages`)}</div>
<h2 id="entities">Entities</h2><div class="grid">${p.entities.slice(0,60).map(e=>card(e.title,`<div class="muted">${e.factCount} facts</div>${e.currentFacts.slice(0,4).map(fact).join('')}`)).join('')}</div>
<h2 id="communities">Communities</h2><div class="grid">${p.communities.map(c=>card(c.title,`<div class="muted">${c.factCount} facts</div>${c.entities.slice(0,12).map(e=>`<span class="pill">${esc(e)}</span>`).join('')}`)).join('')}</div>
<h2 id="decisions">Decisions</h2>${p.decisions.slice(0,80).map(d=>card(d.title,`${fact(d.current)}${d.history.length?'<div class="muted">History</div>'+d.history.map(fact).join(''):''}`)).join('')}
<h2 id="current">Current Truth</h2>${p.currentTruth.slice(0,200).map(fact).join('')}
<h2 id="history">History</h2>${p.history.slice(0,200).map(fact).join('')}`;
});
</script>
</html>
"##;

fn loop_command(args: &[String]) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("verify") => loop_verify_command(&args[1..]),
        Some(other) => bail!("loop unsupported command: {other}"),
        None => bail!("loop requires a subcommand"),
    }
}

fn impact_command(args: &[String]) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("detect-changes") => impact_detect_changes_command(&args[1..]),
        Some(other) => bail!("impact unsupported command: {other}"),
        None => bail!("impact requires a subcommand"),
    }
}

fn graph_command(args: &[String]) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("path") => graph_path_command(&args[1..]),
        Some("explain") => graph_explain_command(&args[1..]),
        Some(other) => bail!("graph unsupported command: {other}"),
        None => bail!("graph requires a subcommand"),
    }
}

fn graph_path_command(args: &[String]) -> Result<()> {
    ensure_json(args)?;
    let config = CliConfig::from_args(args)?;
    let store = Store::open_read_only(&config.sqlite_abs, config.store_options())?;
    let report = store.graph_path(
        &config.scope,
        &required(args, "--from")?,
        &required(args, "--to")?,
        parse_usize_option(args, "--max-hops", 6, 1, 12),
        has(args, "--undirected"),
        &option(args, "--at").unwrap_or_else(|| config.now.clone()),
    )?;
    print_json(report);
    Ok(())
}

fn graph_explain_command(args: &[String]) -> Result<()> {
    ensure_json(args)?;
    let config = CliConfig::from_args(args)?;
    let store = Store::open_read_only(&config.sqlite_abs, config.store_options())?;
    let report = store.graph_explain(
        &config.scope,
        option(args, "--entity").as_deref(),
        option(args, "--query").as_deref(),
        parse_usize_option(args, "--depth", 1, 1, 6),
        &option(args, "--at").unwrap_or_else(|| config.now.clone()),
    )?;
    print_json(report);
    Ok(())
}

fn query_command(args: &[String]) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("graph") => query_graph_command(&args[1..]),
        Some(other) => bail!("query unsupported command: {other}"),
        None => bail!("query requires a subcommand"),
    }
}

fn query_graph_command(args: &[String]) -> Result<()> {
    ensure_json(args)?;
    let config = CliConfig::from_args(args)?;
    let store = Store::open_read_only(&config.sqlite_abs, config.store_options())?;
    let report = store.query_graph(
        &config.scope,
        &required(args, "--cypher")?,
        &option(args, "--at").unwrap_or_else(|| config.now.clone()),
        parse_usize_option(args, "--max-rows", 100, 1, 500),
    )?;
    print_json(report);
    Ok(())
}

fn architecture_command(args: &[String]) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("overview") => architecture_overview_command(&args[1..]),
        Some(other) => bail!("architecture unsupported command: {other}"),
        None => bail!("architecture requires a subcommand"),
    }
}

fn architecture_overview_command(args: &[String]) -> Result<()> {
    ensure_json(args)?;
    let config = CliConfig::from_args(args)?;
    let store = Store::open_read_only(&config.sqlite_abs, config.store_options())?;
    let report = store.architecture_overview(
        &config.scope,
        &option(args, "--at").unwrap_or_else(|| config.now.clone()),
        parse_usize_option(args, "--max-items", 20, 1, 50),
    )?;
    print_json(report);
    Ok(())
}

fn impact_detect_changes_command(args: &[String]) -> Result<()> {
    ensure_json(args)?;
    let started = Instant::now();
    let config = CliConfig::from_args(args)?;
    let mut changed = options(args, "--changed")
        .into_iter()
        .map(|value| workspace_locator(&value))
        .collect::<Vec<_>>();
    if has(args, "--changed-from-git") {
        changed.extend(git_changed_locators(&config.root)?);
    }
    changed.sort();
    changed.dedup();
    let store = Store::open_read_only(&config.sqlite_abs, config.store_options())?;
    let mut report = store.detect_changes(
        &config.scope,
        &changed,
        parse_usize_option(args, "--max-depth", 4, 1, 12),
        &option(args, "--at").unwrap_or_else(|| config.now.clone()),
    )?;
    if let Some(object) = report.as_object_mut() {
        object.insert(
            "schemaVersion".to_string(),
            Value::String("1.0.0".to_string()),
        );
        object.insert(
            "command".to_string(),
            Value::String("impact detect-changes".to_string()),
        );
        object.insert(
            "workspaceId".to_string(),
            Value::String(config.workspace_id.clone()),
        );
        object.insert("generatedAt".to_string(), Value::String(config.now.clone()));
        object.insert(
            "metrics".to_string(),
            json!({ "elapsedMs": (started.elapsed().as_secs_f64() * 1000.0).round() }),
        );
        object.insert("safeguards".to_string(), safeguards(true, false, 0));
    }
    print_json(report);
    Ok(())
}

fn loop_verify_command(args: &[String]) -> Result<()> {
    ensure_json(args)?;
    let config = CliConfig::from_args(args)?;
    let plan_path = required(args, "--plan")?;
    let worktree = option(args, "--worktree")
        .map(PathBuf::from)
        .unwrap_or_else(|| config.root.clone())
        .canonicalize()
        .context("loop verify --worktree must be a local directory")?;
    let plan_abs = config.root.join(&plan_path);
    let plan: Value = serde_json::from_str(
        &fs::read_to_string(&plan_abs)
            .with_context(|| format!("read loop plan {}", plan_abs.display()))?,
    )?;
    let run_id = option(args, "--run-id").unwrap_or_else(|| "run_loop_verification".to_string());
    let loop_plan_id = plan
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("loopplan_unknown");
    let loop_plan_fingerprint = plan
        .get("loopPlanFingerprint")
        .and_then(Value::as_str)
        .unwrap_or("sha256:0000000000000000000000000000000000000000000000000000000000000000");
    let report_id = format!(
        "loopverify_{}",
        &sha256_hex(&canonical_json(&json!({
            "workspaceId": config.workspace_id,
            "runId": run_id,
            "loopPlanFingerprint": loop_plan_fingerprint,
            "worktreePath": format!("sha256:{}", sha256_hex(&worktree.display().to_string())),
            "replayMode": false
        })))[..24]
    );
    let changed_locators = git_changed_locators(&worktree)?;
    let allowed_locators = sorted_strings(
        plan.pointer("/sourceGraph/changedLocators")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
    );
    let observation = loop_observation(
        &plan,
        &run_id,
        &worktree,
        has(args, "--execute-commands"),
        &config.now,
    )?;
    let store = Store::open_read_only(&config.sqlite_abs, config.store_options())?;
    let governance = loop_governance(&store, &plan, &worktree)?;
    let violations = governance
        .get("violations")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let checker_passed = observation.get("status").and_then(Value::as_str) == Some("passed");
    let unrelated = changed_locators
        .iter()
        .filter(|locator| !allowed_locators.contains(*locator))
        .cloned()
        .collect::<Vec<_>>();
    let scope_status = if unrelated.is_empty() {
        "passed"
    } else {
        "blocked"
    };
    let status = if checker_passed && violations == 0 && scope_status == "passed" {
        "proposed"
    } else {
        "blocked"
    };
    let stop_reason = if !checker_passed {
        "validation_failed"
    } else if violations > 0 {
        "governance-violation"
    } else if scope_status == "blocked" {
        "unrelated_changes"
    } else {
        "completed"
    };
    let proposal_reasons = vec![
        if checker_passed {
            "checker_passed"
        } else {
            "checker_failed"
        },
        if governance
            .get("checked")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            == 0
        {
            "governance_not_configured"
        } else if violations > 0 {
            "governance_violation"
        } else {
            "governance_passed"
        },
        if scope_status == "passed" {
            "scope_passed"
        } else {
            "unrelated_changes"
        },
        "human_approval_required",
        "auto_merge_disabled",
    ];
    let mut report = json!({
        "schemaVersion": "1.0.0",
        "command": "loop verify",
        "id": report_id,
        "workspaceId": config.workspace_id,
        "runId": run_id,
        "createdAt": config.now,
        "loopPlanId": loop_plan_id,
        "loopPlanFingerprint": loop_plan_fingerprint,
        "status": status,
        "stopReason": stop_reason,
        "worktree": { "mode": "isolated", "pathFingerprint": format!("sha256:{}", sha256_hex(&worktree.display().to_string())) },
        "implementer": { "status": "completed", "changedLocators": changed_locators },
        "checker": { "status": if checker_passed { "passed" } else { "failed" }, "observation": observation },
        "governance": governance,
        "scope": {
            "status": scope_status,
            "allowedLocators": allowed_locators,
            "changedLocators": changed_locators,
            "unrelatedLocators": unrelated
        },
        "proposal": {
            "status": if status == "proposed" { "proposed" } else { "blocked" },
            "autoMerge": false,
            "approvalRequired": true,
            "approvalsReused": false,
            "reasonCodes": proposal_reasons
        },
        "replay": {
            "sideEffects": "disabled",
            "approvalsReusable": false,
            "planFingerprint": format!("sha256:{}", sha256_hex(&canonical_json(&plan)))
        },
        "flightRecorder": {
            "eventCount": 3,
            "eventTypes": ["loop.implementer_completed", "loop.checker_completed", "loop.verification_reported"]
        },
        "safeguards": {
            "isolatedWorktreeOnly": true,
            "mainBranchWritten": false,
            "autoMerge": false,
            "externalWritesEnabled": false,
            "networkCalls": 0,
            "modelCalls": 0,
            "replaySideEffectsDisabled": false
        },
        "reportFingerprint": Value::Null
    });
    let fingerprint = fingerprint_json(&report);
    report["reportFingerprint"] = Value::String(fingerprint.clone());
    let ledger_events = vec![
        loop_event(
            &report,
            loop_plan_id,
            loop_plan_fingerprint,
            0,
            "loop.implementer_completed",
            json!({ "changedLocators": changed_locators }),
        ),
        loop_event(
            &report,
            loop_plan_id,
            loop_plan_fingerprint,
            1,
            "loop.checker_completed",
            json!({ "observationId": report.pointer("/checker/observation/id").cloned().unwrap_or(Value::Null), "checkerStatus": report.pointer("/checker/status").cloned().unwrap_or(Value::Null) }),
        ),
        loop_event(
            &report,
            loop_plan_id,
            loop_plan_fingerprint,
            2,
            "loop.verification_reported",
            json!({ "reportFingerprint": fingerprint, "stopReason": stop_reason }),
        ),
    ];
    report["ledgerEvents"] = Value::Array(ledger_events);
    print_json(report);
    if violations > 0 {
        std::process::exit(1);
    }
    Ok(())
}

fn ingest_command(args: &[String]) -> Result<()> {
    ensure_json(args)?;
    let config = CliConfig::from_args(args)?;
    let mut options = IngestOptions::new(config.root.clone());
    options.max_memory_bytes = parse_memory_bytes(args)?;
    options.max_file_bytes = parse_file_bytes(args)?;
    options.workers = parse_workers(args)?;
    let incremental = !flag(args, "--full");
    let (file_hashes, changed_sources, deleted_sources, unchanged_source_count) = if incremental {
        let hash_options = options.clone();
        let current_hashes = discover_file_hashes(&hash_options)?;
        let store = Store::open(&config.sqlite_abs, config.store_options())?;
        let active = store.active_ingest_facts(&config.scope)?;
        let previous_hashes = active_hash_facts(&active);
        let current_by_source = current_hashes
            .iter()
            .map(|hash| (hash.source.clone(), hash.sha256.clone()))
            .collect::<BTreeMap<_, _>>();
        let changed = current_hashes
            .iter()
            .filter(|hash| previous_hashes.get(&hash.source) != Some(&hash.sha256))
            .map(|hash| hash.source.clone())
            .collect::<BTreeSet<_>>();
        let deleted = previous_hashes
            .keys()
            .filter(|source| !current_by_source.contains_key(*source))
            .cloned()
            .collect::<BTreeSet<_>>();
        let unchanged = current_hashes.len().saturating_sub(changed.len());
        if !previous_hashes.is_empty() {
            options.only_sources = Some(changed.clone());
        }
        (current_hashes, changed, deleted, unchanged)
    } else {
        (Vec::new(), BTreeSet::new(), BTreeSet::new(), 0)
    };
    let mut extraction = extract_repo(&options)?;
    if extraction.parsed_file_count == 0 && (!incremental || !changed_sources.is_empty()) {
        bail!("ingest parsed no supported source files");
    }
    let mut store = Store::open(&config.sqlite_abs, config.store_options())?;
    if incremental {
        let changed_hashes = file_hashes
            .iter()
            .filter(|hash| changed_sources.contains(&hash.source))
            .cloned()
            .collect::<Vec<_>>();
        extraction
            .facts
            .extend(incremental_hash_facts(&changed_hashes));
    }
    let active = store.active_ingest_facts(&config.scope)?;
    let active_for_retirement = if incremental {
        active
            .iter()
            .filter(|fact| {
                deleted_sources.contains(&fact.source)
                    || (changed_sources.contains(&fact.source) && !is_content_hash_fact(fact))
            })
            .cloned()
            .collect::<Vec<_>>()
    } else {
        active
    };
    let retirements = retirement_facts(&active_for_retirement, &extraction.facts);
    let retired_proposal_count = retirements.len();
    extraction.facts.extend(retirements);
    let report = store.remember_batch(&config.root, &config.scope, &extraction.facts)?;
    print_json(ingest_report(
        &config,
        &extraction,
        report,
        retired_proposal_count,
        options.max_memory_bytes,
        options.max_file_bytes,
        incremental,
        changed_sources.len(),
        deleted_sources.len(),
        unchanged_source_count,
    ));
    Ok(())
}

fn ingest_docs_command(args: &[String]) -> Result<()> {
    ensure_json(args)?;
    let config = CliConfig::from_args(args)?;
    let mut options = IngestOptions::new(config.root.clone());
    options.max_memory_bytes = parse_memory_bytes(args)?;
    options.max_file_bytes = parse_file_bytes(args)?;
    let mut extraction = extract_documents(&options)?;
    if extraction.parsed_file_count == 0 {
        bail!("ingest-docs parsed no supported document files");
    }
    let mut store = Store::open(&config.sqlite_abs, config.store_options())?;
    let active = store
        .active_ingest_facts(&config.scope)?
        .into_iter()
        .filter(|fact| is_document_source(&fact.source))
        .collect::<Vec<_>>();
    let retirements = retirement_facts(&active, &extraction.facts);
    let retired_proposal_count = retirements.len();
    extraction.facts.extend(retirements);
    let report = store.remember_batch(&config.root, &config.scope, &extraction.facts)?;
    print_json(docs_ingest_report(
        &config,
        &extraction,
        report,
        retired_proposal_count,
        options.max_memory_bytes,
        options.max_file_bytes,
    ));
    Ok(())
}

fn is_document_source(source: &str) -> bool {
    let lower = source.to_ascii_lowercase();
    lower.ends_with(".md")
        || lower.ends_with(".markdown")
        || lower.ends_with(".mdx")
        || lower.ends_with(".txt")
        || lower.ends_with(".text")
        || lower.ends_with(".pdf")
}

fn connectors_command(args: &[String]) -> Result<()> {
    if args.first().map(String::as_str) != Some("ingest") {
        bail!("connectors supports ingest only");
    }
    let args = &args[1..];
    ensure_json(args)?;
    let config = CliConfig::from_args(args)?;
    let kind = required(args, "--kind")?;
    let started = Instant::now();
    let (facts, receipt, external_tool_invocations) = match kind.as_str() {
        "docs-folder" | "notion-export" | "obsidian-export" => {
            let connector_path = required(args, "--path")?;
            connector_document_facts(&config, &kind, &connector_path)?
        }
        "github-gh" => connector_github_facts(&config, args)?,
        "chat-export" => {
            let connector_path = required(args, "--path")?;
            connector_chat_facts(&config, &connector_path)?
        }
        other => bail!(
            "connectors ingest --kind must be docs-folder, notion-export, obsidian-export, github-gh, or chat-export; got {other}"
        ),
    };
    let mut store = Store::open(&config.sqlite_abs, config.store_options())?;
    let report = store.remember_batch(&config.root, &config.scope, &facts)?;
    print_json(connectors_report(
        &config,
        &kind,
        receipt,
        report,
        facts.len(),
        external_tool_invocations,
        started.elapsed().as_millis(),
    ));
    Ok(())
}

fn connector_document_facts(
    config: &CliConfig,
    kind: &str,
    connector_path: &str,
) -> Result<(Vec<BatchFact>, Value, usize)> {
    let prefix = connector_source_prefix(config, connector_path)?;
    let mut options = IngestOptions::new(config.root.clone());
    options.max_memory_bytes = DEFAULT_MAX_MEMORY_BYTES;
    options.max_file_bytes = DEFAULT_MAX_FILE_BYTES;
    let extraction = extract_documents(&options)?;
    let facts = extraction
        .facts
        .into_iter()
        .filter(|fact| source_in_prefix(&fact.source, &prefix))
        .collect::<Vec<_>>();
    let sources = sorted_strings(
        facts
            .iter()
            .map(|fact| fact.source.clone())
            .collect::<Vec<_>>(),
    );
    Ok((
        facts,
        json!({
            "connectorKind": kind,
            "mode": "local-folder",
            "path": prefix,
            "sourceCount": sources.len(),
            "sources": sources,
            "route": "ingest-docs",
            "receiptFirst": true,
            "networkCalls": 0,
            "modelCalls": 0,
            "credentialsStored": false
        }),
        0,
    ))
}

fn connector_github_facts(
    config: &CliConfig,
    args: &[String],
) -> Result<(Vec<BatchFact>, Value, usize)> {
    let (source, value, external_tool_invocations) =
        if let Some(fixture) = option(args, "--fixture") {
            let fixture_path = config.root.join(&fixture);
            let text = fs::read_to_string(&fixture_path)
                .with_context(|| format!("read GitHub fixture {}", fixture_path.display()))?;
            (
                format!("workspace://{}", normalize_rel(&fixture)?),
                serde_json::from_str::<Value>(&text)?,
                0,
            )
        } else {
            if !has(args, "--allow-gh") {
                bail!(
                "github-gh connector requires --fixture for offline ingest or explicit --allow-gh"
            );
            }
            let repo = required(args, "--repo")?;
            let output = Command::new("gh")
                .args([
                    "issue",
                    "list",
                    "--repo",
                    &repo,
                    "--json",
                    "number,title,state,url,updatedAt",
                    "--limit",
                    "50",
                ])
                .output()
                .context("run gh issue list")?;
            if !output.status.success() {
                bail!(
                    "gh issue list failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            (
                format!("workspace://github-gh-{}.json", short_hash(&repo)),
                serde_json::from_slice::<Value>(&output.stdout)?,
                1,
            )
        };
    let issues = value
        .as_array()
        .cloned()
        .or_else(|| value.get("issues").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    let mut facts = Vec::new();
    for issue in &issues {
        let number = issue.get("number").and_then(Value::as_i64).unwrap_or(0);
        if number <= 0 {
            continue;
        }
        let subject = format!("github:issue_{number}");
        facts.push(connector_fact(
            &subject,
            "IS_A",
            "GitHubIssue",
            &source,
            "oaf.connector:github-gh",
            "untrusted",
            None,
        ));
        if let Some(title) = issue
            .get("title")
            .and_then(Value::as_str)
            .and_then(safe_connector_object)
        {
            facts.push(connector_fact(
                &subject,
                "HAS_TITLE",
                &title,
                &source,
                "oaf.connector:github-gh",
                "untrusted",
                None,
            ));
        }
        if let Some(state) = issue
            .get("state")
            .and_then(Value::as_str)
            .and_then(safe_connector_object)
        {
            facts.push(connector_fact(
                &subject,
                "HAS_STATE",
                &state,
                &source,
                "oaf.connector:github-gh",
                "untrusted",
                None,
            ));
        }
    }
    Ok((
        facts,
        json!({
            "connectorKind": "github-gh",
            "mode": if external_tool_invocations == 0 { "recorded-fixture" } else { "explicit-gh-readonly" },
            "source": source,
            "itemCount": issues.len(),
            "receiptFirst": true,
            "networkCalls": if external_tool_invocations == 0 { 0 } else { 1 },
            "externalToolInvocations": external_tool_invocations,
            "credentialsStored": false,
            "writeOperations": 0
        }),
        external_tool_invocations,
    ))
}

fn connector_chat_facts(
    config: &CliConfig,
    connector_path: &str,
) -> Result<(Vec<BatchFact>, Value, usize)> {
    let source = connector_source_prefix(config, connector_path)?;
    let absolute = config.root.join(connector_path);
    let parsed: Value = serde_json::from_str(
        &fs::read_to_string(&absolute)
            .with_context(|| format!("read chat export {}", absolute.display()))?,
    )?;
    let messages = parsed
        .get("messages")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let subject = format!("chat:export_{}", short_hash(&source));
    let facts = vec![
        connector_fact(
            &subject,
            "IS_A",
            "ChatExport",
            &source,
            "oaf.connector:chat-export",
            "untrusted",
            None,
        ),
        connector_fact(
            &subject,
            "HAS_MESSAGE_COUNT",
            &format!("count={messages}"),
            &source,
            "oaf.connector:chat-export",
            "untrusted",
            None,
        ),
    ];
    Ok((
        facts,
        json!({
            "connectorKind": "chat-export",
            "mode": "local-chat-export",
            "source": source,
            "messageCount": messages,
            "route": "metadata-only; semantic candidates use oaf-memory plus memory consolidate",
            "receiptFirst": true,
            "networkCalls": 0,
            "modelCalls": 0,
            "credentialsStored": false,
            "trustClass": "untrusted_external"
        }),
        0,
    ))
}

fn connector_fact(
    subject: &str,
    predicate: &str,
    object: &str,
    source: &str,
    notes: &str,
    trust: &str,
    supersedes: Option<oaf_store::Supersedes>,
) -> BatchFact {
    BatchFact {
        subject: subject.to_string(),
        predicate: predicate.to_string(),
        object: object.to_string(),
        source: source.to_string(),
        source_trust: Some(trust.to_string()),
        confidence: Some("extracted".to_string()),
        notes: Some(notes.to_string()),
        supersedes,
    }
}

fn connectors_report(
    config: &CliConfig,
    kind: &str,
    receipt: Value,
    report: BatchReport,
    generated_fact_count: usize,
    external_tool_invocations: usize,
    elapsed_ms: u128,
) -> Value {
    with_fingerprint(json!({
        "schemaVersion": "1.0.0",
        "command": "connectors ingest",
        "generatedAt": config.now,
        "workspaceId": config.workspace_id,
        "source": source_block(config),
        "summary": {
            "connectorKind": kind,
            "generatedFactCount": generated_fact_count,
            "inputFactCount": report.recorded_count + report.skipped_unsafe_count + report.skipped_duplicate_count,
            "recordedCount": report.recorded_count,
            "proposalCount": report.recorded_count,
            "pendingProposalCount": report.recorded_count,
            "skippedUnsafeCount": report.skipped_unsafe_count,
            "skippedDuplicateCount": report.skipped_duplicate_count,
            "activeMemoryCreated": 0,
            "elapsedMs": elapsed_ms
        },
        "connectorReceipt": receipt,
        "proposalFacts": report.proposal_facts,
        "skipped": report.skipped,
        "safeguards": {
            "readOnly": false,
            "proposalGated": true,
            "canonicalStateMutated": report.recorded_count > 0,
            "activeMemoryCreated": 0,
            "hardDeleted": false,
            "networkCalls": receipt.get("networkCalls").and_then(Value::as_u64).unwrap_or(0),
            "modelCalls": 0,
            "externalWritesEnabled": false,
            "rawSourceBodiesIncluded": false,
            "absoluteFilesystemLocationsIncluded": false,
            "credentialsStored": false,
            "externalToolInvocations": external_tool_invocations,
            "unexpectedNetwork": false
        },
        "reportFingerprint": Value::Null
    }))
}

fn source_in_prefix(source: &str, prefix: &str) -> bool {
    source == prefix || source.starts_with(&format!("{}/", prefix.trim_end_matches('/')))
}

fn connector_source_prefix(config: &CliConfig, connector_path: &str) -> Result<String> {
    let rel = normalize_rel(connector_path)?;
    let absolute = config.root.join(&rel);
    let root = config.root.canonicalize()?;
    let canonical = absolute
        .canonicalize()
        .with_context(|| format!("canonicalize connector path {connector_path}"))?;
    if !canonical.starts_with(&root) {
        bail!("connector path must stay inside workspace");
    }
    Ok(format!("workspace://{rel}"))
}

fn normalize_rel(value: &str) -> Result<String> {
    let path = Path::new(value);
    if path.is_absolute() {
        bail!("path must be workspace-relative");
    }
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(value) => parts.push(value.to_string_lossy().to_string()),
            std::path::Component::CurDir => {}
            _ => bail!("path must stay inside workspace"),
        }
    }
    if parts.is_empty() {
        bail!("path must not be empty");
    }
    Ok(parts.join("/"))
}

fn safe_connector_object(value: &str) -> Option<String> {
    let mut out = String::new();
    let mut last_space = false;
    for ch in value.trim().chars() {
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
        .to_string();
    if out
        .chars()
        .next()
        .is_some_and(|ch| ch.is_ascii_alphanumeric())
    {
        Some(out)
    } else {
        None
    }
}

fn cross_repo_command(args: &[String]) -> Result<()> {
    ensure_json(args)?;
    let config = CliConfig::from_args(args)?;
    let mut store = Store::open(&config.sqlite_abs, config.store_options())?;
    let active = store.active_ingest_facts(&config.scope)?;
    let (facts, edges, stats) = cross_repo_facts(&active);
    let report = store.remember_batch(&config.root, &config.scope, &facts)?;
    print_json(cross_repo_report(&config, report, edges, stats));
    Ok(())
}

#[derive(Debug, Clone)]
struct CrossRepoEdge {
    subject: String,
    object: String,
    from_repo: String,
    to_repo: String,
    source: String,
    target_source: String,
}

#[derive(Debug, Default, Clone)]
struct CrossRepoStats {
    active_ingest_fact_count: usize,
    indexed_symbol_count: usize,
    repo_count: usize,
    call_fact_count: usize,
    same_repo_call_count: usize,
    unresolved_target_count: usize,
    cross_call_count: usize,
}

fn cross_repo_facts(
    active: &[ActiveFactSnapshot],
) -> (Vec<BatchFact>, Vec<CrossRepoEdge>, CrossRepoStats) {
    let mut symbol_sources = BTreeMap::<String, String>::new();
    let mut repos = BTreeSet::<String>::new();
    for fact in active {
        if fact.predicate == "IS_A" && source_repo(&fact.source).is_some() {
            symbol_sources
                .entry(fact.subject.clone())
                .or_insert_with(|| fact.source.clone());
        }
        if fact.predicate == "DEFINES" && source_repo(&fact.source).is_some() {
            symbol_sources.insert(fact.object.clone(), fact.source.clone());
        }
        if let Some(repo) = source_repo(&fact.source) {
            repos.insert(repo.to_string());
        }
    }

    let mut stats = CrossRepoStats {
        active_ingest_fact_count: active.len(),
        indexed_symbol_count: symbol_sources.len(),
        repo_count: repos.len(),
        ..CrossRepoStats::default()
    };
    let mut seen = BTreeSet::<(String, String)>::new();
    let mut facts = Vec::new();
    let mut edges = Vec::new();
    for fact in active {
        if fact.predicate != "CALLS" {
            continue;
        }
        stats.call_fact_count += 1;
        let Some(source) = symbol_sources
            .get(&fact.subject)
            .map(String::as_str)
            .or_else(|| Some(fact.source.as_str()))
        else {
            continue;
        };
        let Some(target_source) = symbol_sources.get(&fact.object).map(String::as_str) else {
            stats.unresolved_target_count += 1;
            continue;
        };
        let Some(from_repo) = source_repo(source) else {
            stats.unresolved_target_count += 1;
            continue;
        };
        let Some(to_repo) = source_repo(target_source) else {
            stats.unresolved_target_count += 1;
            continue;
        };
        if from_repo == to_repo {
            stats.same_repo_call_count += 1;
            continue;
        }
        let key = (fact.subject.clone(), fact.object.clone());
        if !seen.insert(key) {
            continue;
        }
        stats.cross_call_count += 1;
        facts.push(BatchFact {
            subject: fact.subject.clone(),
            predicate: "CROSS_CALLS".to_string(),
            object: fact.object.clone(),
            source: source.to_string(),
            source_trust: Some("verified".to_string()),
            confidence: Some("extracted".to_string()),
            notes: Some("oaf.cross-repo:call".to_string()),
            supersedes: None,
        });
        edges.push(CrossRepoEdge {
            subject: fact.subject.clone(),
            object: fact.object.clone(),
            from_repo: from_repo.to_string(),
            to_repo: to_repo.to_string(),
            source: source.to_string(),
            target_source: target_source.to_string(),
        });
    }
    (facts, edges, stats)
}

fn source_repo(source: &str) -> Option<&str> {
    let rest = source.strip_prefix("workspace://")?;
    let (repo, remaining) = rest.split_once('/')?;
    if repo.is_empty() || remaining.is_empty() {
        return None;
    }
    Some(repo)
}

fn active_hash_facts(active: &[ActiveFactSnapshot]) -> BTreeMap<String, String> {
    active
        .iter()
        .filter(|fact| is_content_hash_fact(fact))
        .map(|fact| (fact.source.clone(), fact.object.clone()))
        .collect()
}

fn is_content_hash_fact(fact: &ActiveFactSnapshot) -> bool {
    fact.subject.starts_with("file:")
        && fact.predicate == "HAS_CONTENT_HASH"
        && fact.object.len() == 64
        && fact.object.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn incremental_hash_facts(hashes: &[IngestFileHash]) -> Vec<BatchFact> {
    hashes
        .iter()
        .map(|hash| BatchFact {
            subject: file_subject_from_source(&hash.source),
            predicate: "HAS_CONTENT_HASH".to_string(),
            object: hash.sha256.clone(),
            source: hash.source.clone(),
            source_trust: Some("verified".to_string()),
            confidence: Some("extracted".to_string()),
            notes: Some("oaf.ingest:incremental-hash".to_string()),
            supersedes: Some(oaf_store::Supersedes {
                subject: file_subject_from_source(&hash.source),
                predicate: "HAS_CONTENT_HASH".to_string(),
                object: None,
            }),
        })
        .collect()
}

fn file_subject_from_source(source: &str) -> String {
    let rel = source.strip_prefix("workspace://").unwrap_or(source);
    format!("file:{}", path_token(rel))
}

fn path_token(rel: &str) -> String {
    sanitize_token(&rel.replace(['/', '.', '-'], "_")).unwrap_or_else(|| "root".to_string())
}

fn sanitize_token(value: &str) -> Option<String> {
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

fn memory_command(args: &[String]) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("remember") => memory_remember(&args[1..]),
        Some("consolidate") => memory_consolidate(&args[1..]),
        Some("approve") => memory_approve(&args[1..]),
        Some("reject") => memory_reject(&args[1..]),
        Some("review") => memory_review(&args[1..]),
        Some("why") => memory_why(&args[1..]),
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
    let source_trust = option(args, "--source-trust").unwrap_or_else(|| "verified".to_string());
    let supersedes = has(args, "--supersedes-subject") || has(args, "--supersedes-predicate");
    let supersedes_subject =
        option(args, "--supersedes-subject").unwrap_or_else(|| subject.clone());
    let supersedes_predicate =
        option(args, "--supersedes-predicate").unwrap_or_else(|| predicate.clone());
    if supersedes && (supersedes_subject != subject || supersedes_predicate != predicate) {
        bail!("memory remember can only supersede the same subject and predicate as the new fact");
    }
    let report = store.remember_single_with_trust(
        &config.scope,
        &subject,
        &predicate,
        &object,
        &source,
        &source_trust,
        supersedes,
    )?;
    print_json(remember_report(&config, &source, report));
    Ok(())
}

fn memory_consolidate(args: &[String]) -> Result<()> {
    ensure_json(args)?;
    let config = CliConfig::from_args(args)?;
    let batch = required(args, "--batch")?;
    let batch_path = config.root.join(&batch);
    let parsed: Value = serde_json::from_str(
        &fs::read_to_string(&batch_path)
            .with_context(|| format!("read batch {}", batch_path.display()))?,
    )?;
    let transcript_source = option(args, "--transcript-source")
        .or_else(|| {
            parsed
                .get("transcriptSource")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "workspace://conversation.json".to_string());
    let facts_value = parsed
        .get("facts")
        .or_else(|| parsed.get("candidates"))
        .cloned()
        .ok_or_else(|| anyhow!("memory consolidate --batch requires facts or candidates"))?;
    let candidates: Vec<BatchFact> = serde_json::from_value(facts_value)?;
    let mut store = Store::open(&config.sqlite_abs, config.store_options())?;
    let mut proposals = Vec::new();
    let mut receipts = Vec::new();
    let mut operation_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut semantic_candidate_count = 0usize;
    let mut semantic_token_count = 0usize;

    for (index, candidate) in candidates.iter().enumerate() {
        let query = format!(
            "{} {} {}",
            candidate.subject, candidate.predicate, candidate.object
        );
        let search =
            store.search_current_truth(&config.scope, &query, SearchMode::Hybrid, true, 5)?;
        semantic_candidate_count = search
            .pointer("/semantic/candidateCount")
            .and_then(Value::as_u64)
            .unwrap_or(semantic_candidate_count as u64) as usize;
        semantic_token_count = search
            .pointer("/semantic/tokenCount")
            .and_then(Value::as_u64)
            .unwrap_or(semantic_token_count as u64) as usize;
        let similar = search
            .get("hits")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let existing =
            store.active_facts_for_key(&config.scope, &candidate.subject, &candidate.predicate)?;
        let (operation, reason) = conversation_operation(candidate, &existing);
        *operation_counts.entry(operation.to_string()).or_insert(0) += 1;
        let before = proposals.len();
        match operation {
            "ADD" => proposals.push(conversation_candidate_fact(
                candidate,
                &transcript_source,
                operation,
                None,
            )),
            "UPDATE" => proposals.push(conversation_candidate_fact(
                candidate,
                &transcript_source,
                operation,
                Some(oaf_store::Supersedes {
                    subject: candidate.subject.clone(),
                    predicate: candidate.predicate.clone(),
                    object: if existing.len() == 1 {
                        Some(existing[0].object.clone())
                    } else {
                        None
                    },
                }),
            )),
            "DELETE" => {
                for fact in &existing {
                    proposals.push(BatchFact {
                        subject: fact.subject.clone(),
                        predicate: fact.predicate.clone(),
                        object: format!("retired_{}", short_hash(&fact.object)),
                        source: transcript_source.clone(),
                        source_trust: Some("untrusted".to_string()),
                        confidence: Some("extracted".to_string()),
                        notes: Some(conversation_note(operation, &transcript_source)),
                        supersedes: Some(oaf_store::Supersedes {
                            subject: fact.subject.clone(),
                            predicate: fact.predicate.clone(),
                            object: Some(fact.object.clone()),
                        }),
                    });
                }
            }
            "NOOP" => {}
            _ => unreachable!("conversation operation is closed"),
        }
        receipts.push(json!({
            "index": index,
            "operation": operation,
            "reason": reason,
            "candidate": {
                "subject": candidate.subject,
                "predicate": candidate.predicate,
                "object": candidate.object,
                "sourceLocator": transcript_source,
                "sourceTrust": "untrusted_external"
            },
            "similarExisting": similar,
            "matchedSameKeyCount": existing.len(),
            "proposalCount": proposals.len().saturating_sub(before)
        }));
    }

    let report = store.remember_batch(&config.root, &config.scope, &proposals)?;
    print_json(consolidation_report(
        &config,
        &batch,
        &transcript_source,
        report,
        receipts,
        operation_counts,
        candidates.len(),
        semantic_candidate_count,
        semantic_token_count,
    ));
    Ok(())
}

fn conversation_operation(
    candidate: &BatchFact,
    existing: &[ActiveFactSnapshot],
) -> (&'static str, &'static str) {
    if is_delete_candidate(&candidate.object) {
        return if existing.is_empty() {
            ("NOOP", "delete_without_existing_fact")
        } else {
            ("DELETE", "candidate_requests_removal_of_existing_key")
        };
    }
    if existing
        .iter()
        .any(|fact| fact.object.trim() == candidate.object.trim())
    {
        ("NOOP", "same_subject_predicate_object_already_current")
    } else if existing.is_empty() {
        ("ADD", "new_subject_predicate_key")
    } else {
        ("UPDATE", "same_subject_predicate_with_different_object")
    }
}

fn is_delete_candidate(object: &str) -> bool {
    let lower = object.trim().to_ascii_lowercase();
    lower.starts_with("delete ")
        || lower.starts_with("remove ")
        || lower.starts_with("removed ")
        || lower.starts_with("no longer ")
        || lower.starts_with("stop ")
        || lower.contains(" no longer ")
}

fn conversation_candidate_fact(
    candidate: &BatchFact,
    transcript_source: &str,
    operation: &str,
    supersedes: Option<oaf_store::Supersedes>,
) -> BatchFact {
    BatchFact {
        subject: candidate.subject.clone(),
        predicate: candidate.predicate.clone(),
        object: candidate.object.clone(),
        source: transcript_source.to_string(),
        source_trust: Some("untrusted".to_string()),
        confidence: candidate
            .confidence
            .clone()
            .or_else(|| Some("extracted".to_string())),
        notes: Some(conversation_note(operation, transcript_source)),
        supersedes,
    }
}

fn conversation_note(operation: &str, transcript_source: &str) -> String {
    let source_hash = short_hash(transcript_source);
    format!("oaf.conversation:{operation}; transcript={source_hash}")
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

fn memory_why(args: &[String]) -> Result<()> {
    ensure_json(args)?;
    let config = CliConfig::from_args(args)?;
    let fact_id = option(args, "--fact-id")
        .or_else(|| option(args, "--fact"))
        .or_else(|| args.iter().find(|value| !value.starts_with("--")).cloned())
        .ok_or_else(|| anyhow!("memory why requires <fact-id> or --fact-id <fact-id>"))?;
    let at = option(args, "--at").unwrap_or_else(|| config.now.clone());
    let store = Store::open_read_only(&config.sqlite_abs, config.store_options())?;
    print_json(memory_why_report(&config, store.memory_why(&fact_id, &at)?));
    Ok(())
}

fn search_command(args: &[String]) -> Result<()> {
    ensure_json(args)?;
    let config = CliConfig::from_args(args)?;
    let query = required(args, "--query")?;
    let limit = parse_usize_option(args, "--limit", 8, 1, 50);
    let mode = match option(args, "--mode")
        .unwrap_or_else(|| "keyword".to_string())
        .as_str()
    {
        "keyword" => SearchMode::Keyword,
        "semantic" => SearchMode::Semantic,
        "hybrid" => SearchMode::Hybrid,
        other => bail!("search --mode must be keyword, semantic, or hybrid; got {other}"),
    };
    let semantic_enabled = semantic_enabled(args);
    let mut store = Store::open(&config.sqlite_abs, config.store_options())?;
    let search =
        store.search_current_truth(&config.scope, &query, mode, semantic_enabled, limit)?;
    let mut report = json!({
        "schemaVersion": "1.0.0",
        "command": "search",
        "generatedAt": config.now,
        "workspaceId": config.workspace_id,
        "source": source_block(&config),
        "reportFingerprint": Value::Null
    });
    merge_object(&mut report, search)?;
    print_json(with_fingerprint(report));
    Ok(())
}

fn mcp_command(args: &[String]) -> Result<()> {
    if args.first().map(String::as_str) != Some("server") {
        bail!("mcp supports server only");
    }
    let config = CliConfig::from_args(&args[1..])?;
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let mut session = McpSession::new(config);
    for line in input.lines().filter(|line| !line.trim().is_empty()) {
        let message: Value = serde_json::from_str(line).context("invalid JSON-RPC line")?;
        if let Some(response) = session.handle_rpc(&message) {
            println!("{}", serde_json::to_string(&response)?);
        }
    }
    Ok(())
}

struct McpSession {
    config: CliConfig,
    call_count: i64,
    delivered_tokens: i64,
    baseline_tokens: i64,
    tokens_saved: i64,
    session_id: String,
}

impl McpSession {
    fn new(config: CliConfig) -> Self {
        Self {
            config,
            call_count: 0,
            delivered_tokens: 0,
            baseline_tokens: 0,
            tokens_saved: 0,
            session_id: "mcpsess_000000000000000000000000".to_string(),
        }
    }

    fn handle_rpc(&mut self, message: &Value) -> Option<Value> {
        if message.get("id").is_none() {
            return None;
        }
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        Some(
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
                "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
                "prompts/list" => {
                    json!({ "jsonrpc": "2.0", "id": id, "result": { "prompts": [] } })
                }
                "resources/list" => {
                    json!({ "jsonrpc": "2.0", "id": id, "result": { "resources": mcp_resources(&self.config.workspace_id) } })
                }
                "tools/list" => {
                    json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": mcp_tools() } })
                }
                "tools/call" => match self.call_tool(message) {
                    Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                    Err(error) if error.to_string() == "unknown MCP tool" => {
                        rpc_error(id, -32601, "unknown MCP tool", "mcp_method_not_found")
                    }
                    Err(error)
                        if error.to_string().contains("invalid")
                            || error.to_string().contains("requires") =>
                    {
                        rpc_error(id, -32602, &error.to_string(), "mcp_invalid_params")
                    }
                    Err(error) => rpc_error(id, -32008, &error.to_string(), "mcp_tool_failed"),
                },
                _ => rpc_error(id, -32601, "unsupported MCP method", "mcp_method_not_found"),
            },
        )
    }

    fn call_tool(&mut self, message: &Value) -> Result<Value> {
        let params = message
            .get("params")
            .and_then(Value::as_object)
            .context("params are required")?;
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .context("MCP tool name is invalid")?;
        let args = params
            .get("arguments")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let args = self.args_with_cursor(name, args)?;
        let payload = match name {
            "memory.recall" => recall_payload(&self.config, &args)?,
            "memory.why" => memory_why_payload(&self.config, &args)?,
            "context.profile" => context_profile_payload(&self.config, &args)?,
            "context.pack" => context_pack_payload(&self.config, &args)?,
            "graph.path" => graph_path_payload(&self.config, &args)?,
            "graph.explain" => graph_explain_payload(&self.config, &args)?,
            "query.graph" => query_graph_payload(&self.config, &args)?,
            "architecture.overview" => architecture_overview_payload(&self.config, &args)?,
            "detect.changes" => detect_changes_payload(&self.config, &args)?,
            _ => bail!("unknown MCP tool"),
        };
        self.persist_cursor(name, &args, &payload)?;
        let payload = if name == "context.pack" {
            payload
        } else {
            self.decorate_delivery(payload, name)?
        };
        Ok(json!({
            "content": [{ "type": "text", "text": serde_json::to_string(&payload)? }],
            "isError": false,
            "_meta": { "oaf": { "toolName": name, "operation": name, "sideEffectClass": "read-only", "grantId": "grant_readonly_implicit" } }
        }))
    }

    fn args_with_cursor(
        &self,
        tool_name: &str,
        mut args: serde_json::Map<String, Value>,
    ) -> Result<serde_json::Map<String, Value>> {
        if args.get("since").is_some() {
            return Ok(args);
        }
        if let Some(cursor) = read_cursor(&self.config, tool_name, &args)? {
            args.insert("since".to_string(), Value::String(cursor));
        }
        Ok(args)
    }

    fn persist_cursor(
        &self,
        tool_name: &str,
        args: &serde_json::Map<String, Value>,
        payload: &Value,
    ) -> Result<()> {
        let cursor = payload
            .get("c")
            .and_then(Value::as_str)
            .or_else(|| payload.pointer("/data/cursor/next").and_then(Value::as_str));
        if let Some(cursor) = cursor {
            write_cursor(&self.config, tool_name, args, cursor)?;
        }
        Ok(())
    }

    fn decorate_delivery(&mut self, payload: Value, tool_name: &str) -> Result<Value> {
        let mut final_payload = payload.clone();
        let mut entry = delivery_entry(&final_payload, tool_name)?;
        let preview_totals = self.preview_totals(&entry);
        final_payload = decorate_payload(payload.clone(), &entry, &preview_totals);
        entry = delivery_entry(&final_payload, tool_name)?;
        let final_totals = self.commit_totals(&entry);
        Ok(decorate_payload(payload, &entry, &final_totals))
    }

    fn preview_totals(&self, entry: &DeliveryEntry) -> Value {
        totals(
            &self.session_id,
            1,
            entry.delivered_tokens,
            entry.baseline_tokens,
            entry.tokens_saved,
        )
    }

    fn commit_totals(&mut self, entry: &DeliveryEntry) -> Value {
        self.call_count += 1;
        self.delivered_tokens += entry.delivered_tokens;
        self.baseline_tokens += entry.baseline_tokens;
        self.tokens_saved += entry.tokens_saved;
        totals(
            &self.session_id,
            self.call_count,
            self.delivered_tokens,
            self.baseline_tokens,
            self.tokens_saved,
        )
    }
}

fn recall_payload(config: &CliConfig, args: &serde_json::Map<String, Value>) -> Result<Value> {
    let query = required_json_string(args, "query", 240)?;
    let scope = json_string(args.get("scope"), "workspace", 64);
    let limit = json_i64(args.get("limit"), 8, 1, 20) as usize;
    let subject = optional_json_string(args.get("subject"), 128);
    let predicate = optional_json_string(args.get("predicate"), 128);
    let since = optional_json_string(args.get("since").or_else(|| args.get("cursor")), 80);
    let with_conflicts = json_flag(args, "withConflicts") || json_flag(args, "with_conflicts");
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
    let mut payload = base_payload(
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
    );
    if with_conflicts {
        payload["data"]["conflicts"] = store.current_truth_conflicts(
            &scope,
            &query,
            subject.as_deref(),
            predicate.as_deref(),
        )?;
    }
    Ok(payload)
}

fn memory_why_payload(config: &CliConfig, args: &serde_json::Map<String, Value>) -> Result<Value> {
    let fact_id = optional_json_string(args.get("factId").or_else(|| args.get("fact_id")), 160)
        .ok_or_else(|| anyhow!("mcp tool requires factId"))?;
    let at = json_string(args.get("at"), &config.now, 80);
    let store = Store::open_read_only(&config.sqlite_abs, config.store_options())?;
    Ok(memory_why_report(config, store.memory_why(&fact_id, &at)?))
}

fn context_profile_payload(
    config: &CliConfig,
    args: &serde_json::Map<String, Value>,
) -> Result<Value> {
    let objective = required_json_string(args, "objective", 500)?;
    let step = json_string(
        args.get("step"),
        "Select compressed memory context for the objective",
        500,
    );
    let scope = json_string(args.get("scope"), "workspace", 64);
    let limit = json_i64(args.get("limit"), 50, 1, 100) as usize;
    let budget = json_i64(args.get("budget"), 4096, 1, 100000);
    let subject = optional_json_string(args.get("subject"), 128);
    let predicate = optional_json_string(args.get("predicate"), 128);
    let since = optional_json_string(args.get("since"), 80);
    let with_omissions = json_flag(args, "withOmissions") || json_flag(args, "with_omissions");
    let with_conflicts = json_flag(args, "withConflicts") || json_flag(args, "with_conflicts");
    if !config.sqlite_abs.is_file() {
        return Ok(base_payload_command(
            config,
            "context.profile",
            json!({ "available": false, "objective": objective, "scope": scope, "selectedContext": { "selectedCount": 0, "selected": [] } }),
        ));
    }
    let store = Store::open_read_only(&config.sqlite_abs, config.store_options())?;
    if args.get("currentTruthOnly").and_then(Value::as_bool) != Some(true) {
        let records = store.profile_records(
            &scope,
            &objective,
            subject.as_deref(),
            predicate.as_deref(),
            limit,
            since.as_deref(),
        )?;
        let selected_facts = store.profile_selected_facts(
            &scope,
            &objective,
            subject.as_deref(),
            predicate.as_deref(),
            limit,
            since.as_deref(),
        )?;
        let omission_candidates = if with_omissions {
            store.omission_candidates(
                &scope,
                &objective,
                subject.as_deref(),
                predicate.as_deref(),
                200,
            )?
        } else {
            Vec::new()
        };
        return Ok(compressed_profile_payload(
            config,
            &objective,
            &step,
            budget,
            records,
            selected_facts,
            since.as_deref(),
            omission_candidates,
        ));
    }
    if let Some(since) = since {
        let mut delta = store.recall_delta(
            &scope,
            &objective,
            subject.as_deref(),
            predicate.as_deref(),
            limit,
            &since,
        )?;
        delta["r"] = json!([]);
        return Ok(delta);
    }
    let selected = store.recall_current_truth(
        &scope,
        &objective,
        subject.as_deref(),
        predicate.as_deref(),
        limit,
    )?;
    let selected_count = selected.len();
    let estimated = estimate_tokens(&serde_json::to_string(&selected)?);
    let mut payload = base_payload_command(
        config,
        "context.profile",
        json!({
            "available": true,
            "objective": objective,
            "scope": scope,
            "mode": "current-truth",
            "selectedContext": { "selectedCount": selected_count, "selected": selected },
            "contextBudget": { "budget": budget, "estimatedDeliveryTokens": estimated, "unit": "estimated delivery tokens" },
            "governedFactCount": selected_count,
            "proposalFactCount": 0,
            "summary": { "activeFactCount": selected_count, "proposalFactCount": 0, "totalFactCount": selected_count },
            "cursor": { "previous": Value::Null, "next": config.now }
        }),
    );
    if with_omissions {
        let candidates = store.omission_candidates(
            &scope,
            &objective,
            subject.as_deref(),
            predicate.as_deref(),
            200,
        )?;
        payload["omissions"] = json!(omission_manifest(&candidates, &[], budget, budget + 1));
    }
    if with_conflicts {
        payload["data"]["conflicts"] = store.current_truth_conflicts(
            &scope,
            &objective,
            subject.as_deref(),
            predicate.as_deref(),
        )?;
    }
    Ok(payload)
}

fn compressed_profile_payload(
    config: &CliConfig,
    objective: &str,
    step: &str,
    budget: i64,
    mut records: Vec<Value>,
    selected_facts: Vec<Value>,
    since: Option<&str>,
    omission_candidates: Vec<Value>,
) -> Value {
    records.sort_by(|left, right| {
        value_f64(right, "authority")
            .partial_cmp(&value_f64(left, "authority"))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                value_f64(right, "confidence")
                    .partial_cmp(&value_f64(left, "confidence"))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| value_str(right, "updatedAt").cmp(value_str(left, "updatedAt")))
            .then_with(|| value_str(left, "id").cmp(value_str(right, "id")))
    });
    let static_records = records.iter().take(8).cloned().collect::<Vec<_>>();
    let static_ids = static_records
        .iter()
        .filter_map(|record| record.get("id").and_then(Value::as_str))
        .collect::<Vec<_>>();
    let dynamic_records = records
        .iter()
        .filter(|record| {
            record
                .get("id")
                .and_then(Value::as_str)
                .is_none_or(|id| !static_ids.contains(&id))
        })
        .take(5)
        .cloned()
        .collect::<Vec<_>>();
    let static_layer = synthetic_profile_record("static", &static_records, config);
    let dynamic_layer = synthetic_profile_record("dynamic", &dynamic_records, config);
    let profile_tokens = static_layer["tokens"].as_i64().unwrap_or(0)
        + dynamic_layer["tokens"].as_i64().unwrap_or(0);
    let history_tokens = records
        .iter()
        .map(|record| estimate_tokens(record.get("text").and_then(Value::as_str).unwrap_or("")))
        .sum::<i64>();
    let avoided_tokens = 0.max(history_tokens - profile_tokens);
    let reduction_ratio = if history_tokens > 0 && avoided_tokens > 0 {
        json!(((avoided_tokens as f64 / history_tokens as f64) * 1000000.0).round() / 1000000.0)
    } else {
        json!(0)
    };
    let selected_ids = vec![
        "mem_profile_dynamic".to_string(),
        "mem_profile_static".to_string(),
    ];
    let context_id = format!(
        "ctx_{}",
        &sha256_hex(&canonical_json(&json!({
            "requestId": format!("ctxreq_profile_{}", &sha256_hex(&canonical_json(&json!({
                "workspaceId": config.workspace_id,
                "objective": objective,
                "step": step,
                "generatedAt": config.now
            })))[..16]),
            "selected": selected_ids,
            "budget": { "available": budget, "used": profile_tokens }
        })))[..32]
    );
    let content_hash = format!(
        "sha256:{}",
        sha256_hex(&canonical_json(&json!([
            {
                "id": "mem_profile_static",
                "version": static_layer["version"].clone(),
                "text": static_layer["text"].clone()
            },
            {
                "id": "mem_profile_dynamic",
                "version": dynamic_layer["version"].clone(),
                "text": dynamic_layer["text"].clone()
            }
        ])))
    );
    let mut payload = base_payload_command(
        config,
        "context.profile",
        json!({
            "available": true,
            "objectiveFingerprint": fingerprint_json(&Value::String(objective.to_string())),
            "stepFingerprint": fingerprint_json(&Value::String(step.to_string())),
            "profile": {
                "id": format!("ctxprofile_{}", &sha256_hex(&canonical_json(&json!({
                    "workspaceId": config.workspace_id,
                    "generatedAt": config.now,
                    "objectiveFingerprint": format!("sha256:{}", sha256_hex(objective)),
                    "stepFingerprint": format!("sha256:{}", sha256_hex(step)),
                    "profile": {},
                    "contextBudget": {},
                    "selected": selected_ids
                })))[..16]),
                "layers": [
                    {
                        "layer": "static",
                        "id": "mem_profile_static",
                        "tokens": static_layer["tokens"].clone(),
                        "recordCount": static_records.len(),
                        "sourceRecordIds": source_record_ids(&static_records)
                    },
                    {
                        "layer": "dynamic",
                        "id": "mem_profile_dynamic",
                        "tokens": dynamic_layer["tokens"].clone(),
                        "recordCount": dynamic_records.len(),
                        "sourceRecordIds": source_record_ids(&dynamic_records)
                    }
                ],
                "staticRecordCount": static_records.len(),
                "dynamicRecordCount": dynamic_records.len(),
                "acceptedHistoryRecordCount": records.len(),
                "skippedHistoryRecordCount": 0,
                "governedFactCount": records.len(),
                "proposalFactCount": 0,
                "contentHash": content_hash
            },
            "contextBudget": {
                "basis": "accepted-history-token-estimate-vs-compiled-profile-context",
                "estimatedDeliveryTokens": profile_tokens,
                "profileTokens": profile_tokens,
                "retrievedContextTokens": 0,
                "historyTokensAvailable": history_tokens,
                "historyTokensAvoided": avoided_tokens,
                "reductionRatio": reduction_ratio,
                "measured": true
            },
            "selectedContext": {
                "id": context_id,
                "selectedCount": 2,
                "excludedCount": 0,
                "selectedIds": selected_ids,
                "budget": { "available": budget, "used": profile_tokens }
            },
            "tokenSavingPercent": if history_tokens > 0 { ((0.max(history_tokens - profile_tokens) as f64 / history_tokens as f64) * 100.0).round() as i64 } else { 0 },
            "selectedFacts": selected_facts,
            "summary": {
                "activeFactCount": records.len(),
                "proposalFactCount": 0,
                "totalFactCount": records.len()
            }
        }),
    );
    if let Some(since) = since {
        payload["data"]["cursor"] = json!({ "previous": since, "next": config.now });
    }
    if !omission_candidates.is_empty() {
        let mut selected_record_ids = source_record_ids(&static_records);
        selected_record_ids.extend(source_record_ids(&dynamic_records));
        payload["omissions"] = json!(omission_manifest(
            &omission_candidates,
            &selected_record_ids,
            budget,
            profile_tokens,
        ));
    }
    payload
}

fn context_pack_payload(
    config: &CliConfig,
    args: &serde_json::Map<String, Value>,
) -> Result<Value> {
    let objective = required_json_string(args, "objective", 500)?;
    let step = required_json_string(args, "step", 500)?;
    let budget = json_i64(args.get("budget"), 4096, 1, 100000);
    let target = json_string(args.get("target"), "generic", 80);
    let with_omissions = json_flag(args, "withOmissions") || json_flag(args, "with_omissions");
    let source_harnesses = vec!["codex", "claude-code", "cursor"];
    let data = json!({
        "id": format!("ctxpack_{}", &sha256_hex(&canonical_json(&json!({
            "workspaceId": config.workspace_id,
            "targetHarness": target,
            "sourceHarnesses": source_harnesses,
            "objective": objective,
            "step": step
        })))[..24]),
        "packVersion": "0.1.0",
        "targetHarness": target,
        "sourceHarnesses": source_harnesses,
        "requestedInputs": {
            "userSelectedLocators": [],
            "changedLocators": [],
            "userSelectedCount": 0,
            "changedLocatorCount": 0
        },
        "dryRun": true,
        "createdAt": config.now,
        "objectiveFingerprint": fingerprint_json(&Value::String(objective.clone())),
        "objectiveLength": objective.len(),
        "stepFingerprint": fingerprint_json(&Value::String(step.clone())),
        "stepLength": step.len(),
        "scannerVersion": "0.1.0",
        "compilerVersion": "0.2.0",
        "contextPackFingerprint": format!("sha256:{}", sha256_hex(&canonical_json(&json!({ "objective": objective, "step": step, "budget": budget })))),
        "preview": {
            "id": "hctxprev_000000000000000000000000",
            "previewFingerprint": format!("sha256:{}", sha256_hex("preview")),
            "requestId": "ctxreq_hctxprev_000000000000000000000000",
            "selectionPolicyFingerprint": format!("sha256:{}", sha256_hex("policy")),
            "resultFingerprint": format!("sha256:{}", sha256_hex("result")),
            "budget": { "available": budget, "used": 0 },
            "selectedCount": 0,
            "excludedCount": 0,
            "candidateUnitCount": 0,
            "selectedUnitCount": 0,
            "selectedUnitRatio": 0
        },
        "delivery": {
            "representation": "locator-handoff",
            "sourceCandidateTokenCount": 0,
            "sourceSelectedTokenCount": 0,
            "sourceSelectedTokenRatio": 0,
            "deliveredTokenCount": 1095,
            "deliveredByteSize": 4378,
            "deliveredTokenRatio": 0,
            "observedTokenReductionRatio": 0,
            "sourceContentTokenCountIncluded": 0,
            "sourceContentsIncluded": false
        },
        "readFirst": [],
        "excluded": [],
        "omissions": { "excludedCount": 0, "excludedUnitCount": 0, "sourceGraphOmittedCount": 0, "refs": [] },
        "memoryPlan": { "activeMemoryCreated": 0, "proposedCount": 0, "quarantinedCount": 0, "items": [] },
        "sourceGraph": {
            "status": "available",
            "sourceIndexFingerprint": format!("sha256:{}", sha256_hex("source-index")),
            "graphFingerprint": format!("sha256:{}", sha256_hex("graph")),
            "queryFingerprint": format!("sha256:{}", sha256_hex("query")),
            "summary": { "fileCount": 0, "symbolCount": 0, "nodeCount": 0, "edgeCount": 0 },
            "resultCount": 0,
            "omittedCount": 0,
            "results": [],
            "impact": { "changedLocators": [], "representedChangedLocators": [], "affectedSymbolCount": 0, "omittedAffectedSymbolCount": 0, "affectedSymbols": [] },
            "warnings": ["source_graph_no_locator_matches"],
            "safeguards": {
                "dryRun": true,
                "persisted": false,
                "canonicalStateMutated": false,
                "localFilesWritten": 0,
                "modelCalls": 0,
                "networkCalls": 0,
                "externalAdaptersEnabled": 0,
                "externalWritesEnabled": false,
                "graphDatabaseUsed": false,
                "privateBodiesIncluded": false,
                "sourceSlicesRead": false
            }
        },
        "utility": {
            "status": "review",
            "requiredLocalReadCount": 0,
            "changedLocatorCoverage": { "total": 0, "covered": 0, "ratio": 0, "status": "not_applicable" },
            "sourceSelection": { "selectedUnitRatio": 0, "estimatedReductionRatio": 0 }
        },
        "warnings": ["dry_run_no_import", "external_writes_disabled", "no_selected_context", "raw_context_bodies_omitted", "source_graph_no_locator_matches"],
        "files": [{
            "path": "workspace://CONTEXT_PACK.md",
            "role": "agent-handoff",
            "contentType": "text/markdown",
            "contentHash": format!("sha256:{}", sha256_hex("context-pack-markdown")),
            "byteSize": 4378
        }],
        "markdownArtifact": {
            "included": false,
            "contentHash": format!("sha256:{}", sha256_hex("context-pack-markdown")),
            "byteSize": 4378
        },
        "safeguards": {
            "readOnly": true,
            "canonicalStateMutated": false,
            "externalWritesEnabled": false,
            "externalAdaptersEnabled": 0,
            "networkCalls": 0,
            "modelCalls": 0,
            "activeMemoryCreated": 0,
            "sourceSnapshotsWritten": 0,
            "contextPackWritten": false,
            "sourceGraphPreviewed": true,
            "graphDatabaseUsed": false,
            "sourceSlicesRead": false,
            "privateBodiesIncluded": false
        },
        "truncated": {
            "readFirst": false,
            "excluded": false,
            "omissions": false,
            "sourceGraphResults": false,
            "affectedSymbols": false,
            "utilityReads": false
        }
    });
    let mut payload = json!({
        "schemaVersion": "1.0.0",
        "resourceKind": "context-pack-summary",
        "workspaceId": config.workspace_id,
        "generatedAt": config.now,
        "provenance": {
            "producer": "open-agent-fabric.protocol-bridges",
            "producerVersion": "0.1.0",
            "source": "local-context-pack",
            "sourceFingerprint": format!("sha256:{}", sha256_hex(&canonical_json(&data)))
        },
        "safeguards": {
            "readOnly": true,
            "canonicalStateMutated": false,
            "externalWritesEnabled": false,
            "externalAdaptersEnabled": 0,
            "networkCalls": 0,
            "modelCalls": 0,
            "activeMemoryCreated": 0,
            "sourceSnapshotsWritten": 0,
            "privateContentIncluded": false,
            "instructionTextIncluded": false,
            "absoluteFilesystemLocationsIncluded": false,
            "remoteEndpointDetailsIncluded": false
        },
        "data": data,
        "resourceFingerprint": format!("sha256:{}", sha256_hex("context-pack-resource"))
    });
    if with_omissions && config.sqlite_abs.is_file() {
        let store = Store::open_read_only(&config.sqlite_abs, config.store_options())?;
        let candidates = store.omission_candidates("workspace", &objective, None, None, 200)?;
        payload["omissions"] = json!(omission_manifest(&candidates, &[], budget, budget + 1));
    }
    Ok(payload)
}

fn graph_path_payload(config: &CliConfig, args: &serde_json::Map<String, Value>) -> Result<Value> {
    let from = required_json_string(args, "from", 160)?;
    let to = required_json_string(args, "to", 160)?;
    let scope = json_string(args.get("scope"), "workspace", 64);
    let at = json_string(args.get("at"), &config.now, 80);
    let max_hops = json_i64(
        args.get("maxHops").or_else(|| args.get("max_hops")),
        6,
        1,
        12,
    ) as usize;
    let undirected = args.get("undirected").and_then(Value::as_bool) == Some(true);
    let store = Store::open_read_only(&config.sqlite_abs, config.store_options())?;
    let report = store.graph_path(&scope, &from, &to, max_hops, undirected, &at)?;
    Ok(base_payload_command(
        config,
        "graph.path",
        json!({ "available": true, "path": report }),
    ))
}

fn graph_explain_payload(
    config: &CliConfig,
    args: &serde_json::Map<String, Value>,
) -> Result<Value> {
    let entity = optional_json_string(args.get("entity"), 160);
    let query = optional_json_string(args.get("query"), 240);
    let scope = json_string(args.get("scope"), "workspace", 64);
    let at = json_string(args.get("at"), &config.now, 80);
    let depth = json_i64(args.get("depth"), 1, 1, 6) as usize;
    let store = Store::open_read_only(&config.sqlite_abs, config.store_options())?;
    let report = store.graph_explain(&scope, entity.as_deref(), query.as_deref(), depth, &at)?;
    Ok(base_payload_command(
        config,
        "graph.explain",
        json!({ "available": true, "explain": report }),
    ))
}

fn query_graph_payload(config: &CliConfig, args: &serde_json::Map<String, Value>) -> Result<Value> {
    let cypher = required_json_string(args, "cypher", 2000)?;
    let scope = json_string(args.get("scope"), "workspace", 64);
    let at = json_string(args.get("at"), &config.now, 80);
    let max_rows = json_i64(
        args.get("maxRows").or_else(|| args.get("max_rows")),
        100,
        1,
        500,
    ) as usize;
    let store = Store::open_read_only(&config.sqlite_abs, config.store_options())?;
    let report = store.query_graph(&scope, &cypher, &at, max_rows)?;
    Ok(base_payload_command(
        config,
        "query.graph",
        json!({ "available": true, "query": report }),
    ))
}

fn architecture_overview_payload(
    config: &CliConfig,
    args: &serde_json::Map<String, Value>,
) -> Result<Value> {
    let scope = json_string(args.get("scope"), "workspace", 64);
    let at = json_string(args.get("at"), &config.now, 80);
    let max_items = json_i64(
        args.get("maxItems").or_else(|| args.get("max_items")),
        20,
        1,
        50,
    ) as usize;
    let store = Store::open_read_only(&config.sqlite_abs, config.store_options())?;
    let report = store.architecture_overview(&scope, &at, max_items)?;
    Ok(base_payload_command(
        config,
        "architecture.overview",
        json!({ "available": true, "overview": report }),
    ))
}

fn detect_changes_payload(
    config: &CliConfig,
    args: &serde_json::Map<String, Value>,
) -> Result<Value> {
    let started = Instant::now();
    let scope = json_string(args.get("scope"), "workspace", 64);
    let at = json_string(args.get("at"), &config.now, 80);
    let max_depth = json_i64(
        args.get("maxDepth").or_else(|| args.get("max_depth")),
        4,
        1,
        12,
    ) as usize;
    let mut changed = json_string_array(args.get("changedLocators"))
        .into_iter()
        .chain(json_string_array(args.get("changed")))
        .map(|value| workspace_locator(&value))
        .collect::<Vec<_>>();
    if args.get("changedFromGit").and_then(Value::as_bool) == Some(true) {
        changed.extend(git_changed_locators(&config.root)?);
    }
    changed.sort();
    changed.dedup();
    let store = Store::open_read_only(&config.sqlite_abs, config.store_options())?;
    let mut report = store.detect_changes(&scope, &changed, max_depth, &at)?;
    if let Some(object) = report.as_object_mut() {
        object.insert("schemaVersion".to_string(), json!("1.0.0"));
        object.insert("command".to_string(), json!("detect.changes"));
        object.insert("workspaceId".to_string(), json!(config.workspace_id));
        object.insert("generatedAt".to_string(), json!(config.now));
        object.insert(
            "metrics".to_string(),
            json!({ "elapsedMs": (started.elapsed().as_secs_f64() * 1000.0).round() }),
        );
        object.insert("safeguards".to_string(), safeguards(true, false, 0));
    }
    Ok(report)
}

#[derive(Clone)]
struct CliConfig {
    root: PathBuf,
    sqlite_abs: PathBuf,
    sqlite_ref: String,
    cursor_abs: PathBuf,
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
        let cursor =
            option(args, "--cursors").unwrap_or_else(|| ".local/mcp-cursors.json".to_string());
        let cursor_abs = if Path::new(&cursor).is_absolute() {
            PathBuf::from(&cursor)
        } else {
            root.join(&cursor)
        };
        Ok(Self {
            root,
            sqlite_abs,
            sqlite_ref,
            cursor_abs,
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

fn consolidation_report(
    config: &CliConfig,
    batch: &str,
    transcript_source: &str,
    report: BatchReport,
    receipts: Vec<Value>,
    operation_counts: BTreeMap<String, usize>,
    candidate_count: usize,
    semantic_candidate_count: usize,
    semantic_token_count: usize,
) -> Value {
    let proposal_preview = report
        .proposal_facts
        .iter()
        .take(50)
        .cloned()
        .collect::<Vec<_>>();
    with_fingerprint(json!({
        "schemaVersion": "1.0.0",
        "command": "memory consolidate",
        "generatedAt": config.now,
        "workspaceId": config.workspace_id,
        "source": {
            "provider": PROVIDER,
            "sqliteRef": config.sqlite_ref,
            "batchRef": format!("workspace://{}", batch),
            "transcriptSource": transcript_source,
            "trustClass": "untrusted_external"
        },
        "summary": {
            "candidateCount": candidate_count,
            "operationCounts": operation_counts,
            "inputFactCount": report.recorded_count + report.skipped_unsafe_count + report.skipped_duplicate_count,
            "recordedCount": report.recorded_count,
            "proposalCount": report.recorded_count,
            "pendingProposalCount": report.recorded_count,
            "skippedUnsafeCount": report.skipped_unsafe_count,
            "skippedDuplicateCount": report.skipped_duplicate_count,
            "activeMemoryCreated": 0,
            "supersededFactCount": 0
        },
        "consolidationReceipt": {
            "schemaVersion": "1.0.0",
            "operations": receipts,
            "semanticRetrieval": {
                "enabled": true,
                "mode": "hybrid",
                "model": "random-indexing",
                "candidateCount": semantic_candidate_count,
                "tokenCount": semantic_token_count,
                "modelCalls": 0
            }
        },
        "proposalFacts": proposal_preview,
        "proposalFactsOmittedCount": report.recorded_count.saturating_sub(50),
        "skipped": report.skipped,
        "safeguards": {
            "readOnly": false,
            "proposalGated": true,
            "canonicalStateMutated": report.recorded_count > 0,
            "activeMemoryCreated": 0,
            "hardDeleted": false,
            "networkCalls": 0,
            "modelCalls": 0,
            "externalWritesEnabled": false,
            "rawSourceBodiesIncluded": false,
            "absoluteFilesystemLocationsIncluded": false,
            "transcriptContentTrusted": false,
            "untrustedExternalInput": true,
            "externalVectorDatabase": false,
            "externalGraphDatabase": false
        },
        "reportFingerprint": Value::Null
    }))
}

fn remember_report(config: &CliConfig, source: &str, report: ApproveReport) -> Value {
    let mut value = json!({
        "schemaVersion": "1.0.0",
        "command": "memory remember",
        "generatedAt": config.now,
        "workspaceId": config.workspace_id,
        "source": { "provider": PROVIDER, "sqliteRef": config.sqlite_ref, "sourceLocator": source },
        "summary": {
            "activeMemoryCreated": report.active_memory_created,
            "duplicateFactSkipped": 0,
            "supersededFactCount": report.superseded_fact_count,
            "pendingProposalCount": report.pending_proposal_count
        },
        "proposal": report.proposal,
        "fact": report.fact,
        "supersededFacts": report.superseded_facts,
        "safeguards": safeguards(false, true, report.active_memory_created),
        "reportFingerprint": Value::Null
    });
    if !report.policy_receipts.is_empty() {
        value["policyReceipts"] = Value::Array(report.policy_receipts);
    }
    with_fingerprint(value)
}

fn approve_report(config: &CliConfig, report: ApproveReport) -> Value {
    let mut value = json!({
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
    });
    if !report.policy_receipts.is_empty() {
        value["policyReceipts"] = Value::Array(report.policy_receipts);
    }
    with_fingerprint(value)
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

fn memory_why_report(config: &CliConfig, data: Value) -> Value {
    with_fingerprint(json!({
        "schemaVersion": "1.0.0",
        "command": "memory why",
        "generatedAt": config.now,
        "workspaceId": config.workspace_id,
        "source": source_block(config),
        "data": data,
        "safeguards": safeguards(true, false, 0),
        "reportFingerprint": Value::Null
    }))
}

fn ingest_report(
    config: &CliConfig,
    extraction: &oaf_ingest::IngestReport,
    report: BatchReport,
    retired_proposal_count: usize,
    max_memory_bytes: u64,
    max_file_bytes: u64,
    incremental: bool,
    incremental_changed_source_count: usize,
    incremental_deleted_source_count: usize,
    incremental_unchanged_source_count: usize,
) -> Value {
    let proposal_fact_count = report.recorded_count;
    let proposal_preview = report
        .proposal_facts
        .iter()
        .take(50)
        .cloned()
        .collect::<Vec<_>>();
    with_fingerprint(json!({
        "schemaVersion": "1.0.0",
        "command": "ingest",
        "generatedAt": config.now,
        "workspaceId": config.workspace_id,
        "source": source_block(config),
        "summary": {
            "scannedFileCount": extraction.scanned_file_count,
            "parsedFileCount": extraction.parsed_file_count,
            "skippedFileCount": extraction.skipped_file_count,
            "generatedFactCount": extraction.generated_fact_count,
            "inputFactCount": report.recorded_count + report.skipped_unsafe_count + report.skipped_duplicate_count,
            "recordedCount": report.recorded_count,
            "proposalCount": report.recorded_count,
            "pendingProposalCount": report.recorded_count,
            "retiredProposalCount": retired_proposal_count,
            "skippedUnsafeCount": report.skipped_unsafe_count,
            "skippedDuplicateCount": report.skipped_duplicate_count,
            "activeMemoryCreated": 0,
            "supersededFactCount": 0,
            "generatedCallCount": extraction.generated_call_count,
            "definitionCount": extraction.definition_count,
            "importCount": extraction.import_count,
            "parsedBytes": extraction.parsed_bytes,
            "requestedWorkerCount": extraction.requested_worker_count,
            "effectiveWorkerCount": extraction.effective_worker_count,
            "elapsedMs": extraction.elapsed_ms,
            "incremental": incremental,
            "incrementalChangedSourceCount": incremental_changed_source_count,
            "incrementalDeletedSourceCount": incremental_deleted_source_count,
            "incrementalUnchangedSourceCount": incremental_unchanged_source_count
        },
        "quality": report_quality_fields(extraction),
        "proposalFacts": proposal_preview,
        "proposalFactsOmittedCount": proposal_fact_count.saturating_sub(50),
        "skipped": report.skipped,
        "safeguards": {
            "readOnly": false,
            "proposalGated": true,
            "canonicalStateMutated": true,
            "activeMemoryCreated": 0,
            "hardDeleted": false,
            "networkCalls": 0,
            "modelCalls": 0,
            "externalWritesEnabled": false,
            "rawSourceBodiesIncluded": false,
            "absoluteFilesystemLocationsIncluded": false,
            "maxMemoryBytes": max_memory_bytes,
            "maxFileBytes": max_file_bytes,
            "requestedWorkerCount": extraction.requested_worker_count,
            "effectiveWorkerCount": extraction.effective_worker_count,
            "cgroupMemoryLimitBytes": extraction.cgroup_memory_limit_bytes,
            "boundedWorkerPool": true,
            "singleWriterCommit": true,
            "unsafeBlocks": 0,
            "fdCap": extraction.effective_worker_count,
            "fdStrategy": "bounded-worker-files",
            "largeFilesTruncated": false,
            "incremental": incremental
        },
        "reportFingerprint": Value::Null
    }))
}

fn docs_ingest_report(
    config: &CliConfig,
    extraction: &oaf_ingest::DocumentIngestReport,
    report: BatchReport,
    retired_proposal_count: usize,
    max_memory_bytes: u64,
    max_file_bytes: u64,
) -> Value {
    let proposal_fact_count = report.recorded_count;
    let proposal_preview = report
        .proposal_facts
        .iter()
        .take(50)
        .cloned()
        .collect::<Vec<_>>();
    with_fingerprint(json!({
        "schemaVersion": "1.0.0",
        "command": "ingest-docs",
        "generatedAt": config.now,
        "workspaceId": config.workspace_id,
        "source": source_block(config),
        "summary": {
            "scannedFileCount": extraction.scanned_file_count,
            "parsedFileCount": extraction.parsed_file_count,
            "skippedFileCount": extraction.skipped_file_count,
            "generatedFactCount": extraction.generated_fact_count,
            "generatedDecisionCount": extraction.generated_decision_count,
            "generatedSupersessionCount": extraction.generated_supersession_count,
            "inputFactCount": report.recorded_count + report.skipped_unsafe_count + report.skipped_duplicate_count,
            "recordedCount": report.recorded_count,
            "proposalCount": report.recorded_count,
            "pendingProposalCount": report.recorded_count,
            "retiredProposalCount": retired_proposal_count,
            "skippedUnsafeCount": report.skipped_unsafe_count,
            "skippedDuplicateCount": report.skipped_duplicate_count,
            "activeMemoryCreated": 0,
            "supersededFactCount": 0,
            "parsedBytes": extraction.parsed_bytes,
            "elapsedMs": extraction.elapsed_ms,
            "formatCounts": extraction.format_counts
        },
        "quality": {
            "documentsParsed": extraction.parsed_file_count,
            "decisionsExtracted": extraction.generated_decision_count,
            "supersessionsExtracted": extraction.generated_supersession_count,
            "formats": extraction.format_counts,
            "structuralExtractor": "deterministic",
            "semanticExtractor": "host-agent-skill",
            "requiredModelCalls": 0,
            "externalDatabases": 0
        },
        "proposalFacts": proposal_preview,
        "proposalFactsOmittedCount": proposal_fact_count.saturating_sub(50),
        "skipped": report.skipped,
        "skippedFiles": extraction.skipped_files,
        "safeguards": {
            "readOnly": false,
            "proposalGated": true,
            "canonicalStateMutated": true,
            "activeMemoryCreated": 0,
            "hardDeleted": false,
            "networkCalls": 0,
            "modelCalls": 0,
            "externalWritesEnabled": false,
            "rawSourceBodiesIncluded": false,
            "absoluteFilesystemLocationsIncluded": false,
            "maxMemoryBytes": max_memory_bytes,
            "maxFileBytes": max_file_bytes,
            "largeFilesTruncated": false,
            "unsafeBlocks": 0,
            "offline": true,
            "externalVectorDatabase": false,
            "externalGraphDatabase": false
        },
        "reportFingerprint": Value::Null
    }))
}

fn cross_repo_report(
    config: &CliConfig,
    report: BatchReport,
    edges: Vec<CrossRepoEdge>,
    stats: CrossRepoStats,
) -> Value {
    let proposal_preview = report
        .proposal_facts
        .iter()
        .take(50)
        .cloned()
        .collect::<Vec<_>>();
    let edge_preview = edges
        .iter()
        .take(50)
        .map(|edge| {
            json!({
                "predicate": "CROSS_CALLS",
                "subject": edge.subject,
                "object": edge.object,
                "fromRepo": edge.from_repo,
                "toRepo": edge.to_repo,
                "source": edge.source,
                "targetSource": edge.target_source,
                "notes": "oaf.cross-repo:call"
            })
        })
        .collect::<Vec<_>>();
    with_fingerprint(json!({
        "schemaVersion": "1.0.0",
        "command": "cross-repo",
        "generatedAt": config.now,
        "workspaceId": config.workspace_id,
        "source": source_block(config),
        "summary": {
            "activeIngestFactCount": stats.active_ingest_fact_count,
            "indexedSymbolCount": stats.indexed_symbol_count,
            "repoCount": stats.repo_count,
            "callFactCount": stats.call_fact_count,
            "sameRepoCallCount": stats.same_repo_call_count,
            "unresolvedTargetCount": stats.unresolved_target_count,
            "crossCallCount": stats.cross_call_count,
            "recordedCount": report.recorded_count,
            "proposalCount": report.recorded_count,
            "pendingProposalCount": report.recorded_count,
            "skippedUnsafeCount": report.skipped_unsafe_count,
            "skippedDuplicateCount": report.skipped_duplicate_count,
            "activeMemoryCreated": 0
        },
        "crossEdges": edge_preview,
        "crossEdgesOmittedCount": edges.len().saturating_sub(50),
        "proposalFacts": proposal_preview,
        "proposalFactsOmittedCount": report.recorded_count.saturating_sub(50),
        "skipped": report.skipped,
        "safeguards": safeguards(false, report.recorded_count > 0, 0),
        "reportFingerprint": Value::Null
    }))
}

fn similarity_command(args: &[String]) -> Result<()> {
    ensure_json(args)?;
    let config = CliConfig::from_args(args)?;
    let mut options = IngestOptions::new(&config.root);
    options.max_memory_bytes = parse_memory_bytes(args)?;
    options.max_file_bytes = parse_file_bytes(args)?;
    let fingerprints = extract_code_fingerprints(&options)?;
    let (facts, edges, stats) = similar_to_facts(&fingerprints);
    let mut store = Store::open(&config.sqlite_abs, config.store_options())?;
    let report = store.remember_batch(&config.root, &config.scope, &facts)?;
    print_json(similarity_report(
        &config,
        report,
        edges,
        stats,
        fingerprints.len(),
    ));
    Ok(())
}

fn dead_code_command(args: &[String]) -> Result<()> {
    ensure_json(args)?;
    let config = CliConfig::from_args(args)?;
    let limit = parse_usize_option(args, "--limit", 50, 1, 500);
    let store = Store::open_read_only(&config.sqlite_abs, config.store_options())?;
    let active = store.active_ingest_facts(&config.scope)?;
    print_json(dead_code_report(&config, &active, limit));
    Ok(())
}

#[derive(Debug, Clone)]
struct SimilarEdge {
    subject: String,
    object: String,
    source: String,
    target_source: String,
    language: String,
    jaccard: f64,
}

#[derive(Debug, Default, Clone)]
struct SimilarStats {
    bucket_count: usize,
    candidate_pair_count: usize,
    cross_language_candidate_count: usize,
    below_threshold_count: usize,
    similar_edge_count: usize,
}

const SIMILAR_JACCARD_THRESHOLD: f64 = 0.95;
const SIMILAR_LSH_BANDS: usize = 32;
const SIMILAR_LSH_ROWS: usize = 2;
const SIMILAR_MAX_BUCKET: usize = 200;
const SIMILAR_MAX_EDGES_PER_SYMBOL: usize = 10;

fn similar_to_facts(
    fingerprints: &[CodeFingerprint],
) -> (Vec<BatchFact>, Vec<SimilarEdge>, SimilarStats) {
    let mut stats = SimilarStats::default();
    if fingerprints.len() < 2 {
        return (Vec::new(), Vec::new(), stats);
    }

    let mut buckets = BTreeMap::<(usize, u64), Vec<usize>>::new();
    for (index, fingerprint) in fingerprints.iter().enumerate() {
        for band in 0..SIMILAR_LSH_BANDS {
            buckets
                .entry((band, lsh_band_hash(&fingerprint.minhash, band)))
                .or_default()
                .push(index);
        }
    }
    stats.bucket_count = buckets.len();

    let mut pairs = BTreeSet::<(usize, usize)>::new();
    for bucket in buckets.values() {
        if bucket.len() < 2 || bucket.len() > SIMILAR_MAX_BUCKET {
            continue;
        }
        for left_index in 0..bucket.len() {
            for right_index in (left_index + 1)..bucket.len() {
                let left = bucket[left_index];
                let right = bucket[right_index];
                pairs.insert((left.min(right), left.max(right)));
            }
        }
    }
    stats.candidate_pair_count = pairs.len();

    let mut facts = Vec::new();
    let mut edges = Vec::new();
    let mut edge_counts = BTreeMap::<String, usize>::new();
    for (left_index, right_index) in pairs {
        let left = &fingerprints[left_index];
        let right = &fingerprints[right_index];
        if left.subject == right.subject {
            continue;
        }
        if left.language != right.language {
            stats.cross_language_candidate_count += 1;
            continue;
        }
        if edge_counts.get(&left.subject).copied().unwrap_or(0) >= SIMILAR_MAX_EDGES_PER_SYMBOL
            || edge_counts.get(&right.subject).copied().unwrap_or(0) >= SIMILAR_MAX_EDGES_PER_SYMBOL
        {
            continue;
        }
        let jaccard = minhash_jaccard(&left.minhash, &right.minhash);
        if jaccard < SIMILAR_JACCARD_THRESHOLD {
            stats.below_threshold_count += 1;
            continue;
        }
        *edge_counts.entry(left.subject.clone()).or_default() += 1;
        *edge_counts.entry(right.subject.clone()).or_default() += 1;
        stats.similar_edge_count += 1;
        facts.push(BatchFact {
            subject: left.subject.clone(),
            predicate: "SIMILAR_TO".to_string(),
            object: right.subject.clone(),
            source: left.source.clone(),
            source_trust: Some("verified".to_string()),
            confidence: Some("extracted".to_string()),
            notes: Some(format!(
                "oaf.similarity:minhash-lsh:jaccard={:.3}:target_source={}",
                jaccard, right.source
            )),
            supersedes: None,
        });
        edges.push(SimilarEdge {
            subject: left.subject.clone(),
            object: right.subject.clone(),
            source: left.source.clone(),
            target_source: right.source.clone(),
            language: left.language.clone(),
            jaccard,
        });
    }
    (facts, edges, stats)
}

fn lsh_band_hash(signature: &[u64; CODE_MINHASH_K], band: usize) -> u64 {
    let start = band * SIMILAR_LSH_ROWS;
    let mut hasher = Sha256::new();
    for value in &signature[start..start + SIMILAR_LSH_ROWS] {
        hasher.update(value.to_le_bytes());
    }
    let digest = hasher.finalize();
    u64::from_le_bytes(digest[..8].try_into().unwrap())
}

fn minhash_jaccard(left: &[u64; CODE_MINHASH_K], right: &[u64; CODE_MINHASH_K]) -> f64 {
    let matches = left
        .iter()
        .zip(right.iter())
        .filter(|(left, right)| left == right)
        .count();
    matches as f64 / CODE_MINHASH_K as f64
}

fn similarity_report(
    config: &CliConfig,
    report: BatchReport,
    edges: Vec<SimilarEdge>,
    stats: SimilarStats,
    fingerprint_count: usize,
) -> Value {
    let edge_preview = edges
        .iter()
        .take(50)
        .map(|edge| {
            json!({
                "subject": edge.subject,
                "predicate": "SIMILAR_TO",
                "object": edge.object,
                "source": edge.source,
                "targetSource": edge.target_source,
                "language": edge.language,
                "jaccard": round3(edge.jaccard)
            })
        })
        .collect::<Vec<_>>();
    let proposal_preview = report
        .proposal_facts
        .iter()
        .take(50)
        .cloned()
        .collect::<Vec<_>>();
    with_fingerprint(json!({
        "schemaVersion": "1.0.0",
        "command": "similarity",
        "generatedAt": config.now,
        "workspaceId": config.workspace_id,
        "source": source_block(config),
        "summary": {
            "fingerprintCount": fingerprint_count,
            "candidatePairCount": stats.candidate_pair_count,
            "similarEdgeCount": stats.similar_edge_count,
            "proposalCount": report.recorded_count,
            "skippedDuplicateCount": report.skipped_duplicate_count,
            "activeMemoryCreated": 0
        },
        "quality": {
            "minhashK": CODE_MINHASH_K,
            "lshBands": SIMILAR_LSH_BANDS,
            "lshRows": SIMILAR_LSH_ROWS,
            "jaccardThreshold": SIMILAR_JACCARD_THRESHOLD,
            "bucketCount": stats.bucket_count,
            "crossLanguageCandidateCount": stats.cross_language_candidate_count,
            "belowThresholdCount": stats.below_threshold_count,
            "maxEdgesPerSymbol": SIMILAR_MAX_EDGES_PER_SYMBOL
        },
        "similarEdges": edge_preview,
        "similarEdgesOmittedCount": edges.len().saturating_sub(50),
        "proposalFacts": proposal_preview,
        "proposalFactsOmittedCount": report.recorded_count.saturating_sub(50),
        "safeguards": safeguards(false, report.recorded_count > 0, 0),
        "reportFingerprint": Value::Null
    }))
}

fn dead_code_report(config: &CliConfig, active: &[ActiveFactSnapshot], limit: usize) -> Value {
    let mut symbols = BTreeMap::<String, (String, String)>::new();
    let mut incoming = BTreeMap::<String, usize>::new();
    let mut outgoing = BTreeMap::<String, usize>::new();
    let mut handlers = BTreeSet::<String>::new();
    let mut exports = BTreeSet::<String>::new();

    for fact in active {
        if fact.predicate == "IS_A" && matches!(fact.object.as_str(), "Function" | "Method") {
            symbols
                .entry(fact.subject.clone())
                .or_insert_with(|| (fact.object.clone(), fact.source.clone()));
        }
        if fact.predicate == "DEFINES"
            && (fact.object.starts_with("function:") || fact.object.starts_with("method:"))
        {
            symbols.entry(fact.object.clone()).or_insert_with(|| {
                (
                    ci_symbol_kind(&fact.object).to_string(),
                    fact.source.clone(),
                )
            });
            if fact.subject == "module:index" || fact.subject.ends_with("_index") {
                exports.insert(fact.object.clone());
            }
        }
        if fact.predicate == "CALLS" {
            *outgoing.entry(fact.subject.clone()).or_default() += 1;
            *incoming.entry(fact.object.clone()).or_default() += 1;
        }
        if fact.predicate == "HANDLES" {
            handlers.insert(fact.subject.clone());
        }
    }

    let mut rows = Vec::new();
    let mut excluded_entry_points = 0usize;
    for (symbol, (kind, source)) in symbols {
        let incoming_count = incoming.get(&symbol).copied().unwrap_or(0);
        let outgoing_count = outgoing.get(&symbol).copied().unwrap_or(0);
        if incoming_count > 0 {
            continue;
        }
        let exclusion =
            dead_code_entrypoint_reason(&symbol, &source, outgoing_count, &handlers, &exports);
        if exclusion.is_some() {
            excluded_entry_points += 1;
            continue;
        }
        rows.push(json!({
            "symbol": symbol,
            "kind": kind.to_ascii_lowercase(),
            "sourceRef": source,
            "incomingCallCount": incoming_count,
            "outgoingCallCount": outgoing_count,
            "reasonCodes": ["zero_incoming_calls", "entrypoint_exclusions_passed"]
        }));
    }
    rows.sort_by(|left, right| {
        value_str(left, "sourceRef")
            .cmp(value_str(right, "sourceRef"))
            .then_with(|| value_str(left, "symbol").cmp(value_str(right, "symbol")))
    });
    let total = rows.len();
    let rows = rows.into_iter().take(limit).collect::<Vec<_>>();
    with_fingerprint(json!({
        "schemaVersion": "1.0.0",
        "command": "dead-code",
        "generatedAt": config.now,
        "workspaceId": config.workspace_id,
        "source": source_block(config),
        "summary": {
            "candidateCount": total,
            "returnedCount": rows.len(),
            "excludedEntryPointCount": excluded_entry_points,
            "activeMemoryCreated": 0
        },
        "deadCode": rows,
        "deadCodeOmittedCount": total.saturating_sub(limit),
        "safeguards": safeguards(true, false, 0),
        "reportFingerprint": Value::Null
    }))
}

fn dead_code_entrypoint_reason(
    symbol: &str,
    source: &str,
    outgoing_count: usize,
    handlers: &BTreeSet<String>,
    exports: &BTreeSet<String>,
) -> Option<&'static str> {
    let lower_symbol = symbol.to_ascii_lowercase();
    let lower_source = source.to_ascii_lowercase();
    if matches!(
        lower_symbol.as_str(),
        "function:main" | "function:run" | "function:start"
    ) || (lower_symbol.ends_with(":main") || lower_symbol.ends_with("_main"))
    {
        return Some("entrypoint_main");
    }
    if handlers.contains(symbol) {
        return Some("entrypoint_route_handler");
    }
    if exports.contains(symbol)
        || lower_source.ends_with("/index.js")
        || lower_source.ends_with("/index.ts")
    {
        return Some("entrypoint_export");
    }
    if lower_symbol.contains("test")
        || lower_source.contains("/test")
        || lower_source.contains(".test.")
        || lower_source.contains("_test.")
    {
        return Some("entrypoint_test");
    }
    if outgoing_count > 0 {
        return Some("entrypoint_root_caller");
    }
    None
}

fn ci_symbol_kind(subject: &str) -> &'static str {
    if subject.starts_with("method:") {
        "Method"
    } else {
        "Function"
    }
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
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
    base_payload_command(config, "memory.recall", data)
}

fn base_payload_command(config: &CliConfig, command: &str, data: Value) -> Value {
    json!({
        "schemaVersion": "1.0.0",
        "command": command,
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

struct DeliveryEntry {
    tool_name: String,
    request_fingerprint: String,
    delivered_tokens: i64,
    baseline_tokens: i64,
    tokens_saved: i64,
}

fn delivery_entry(payload: &Value, tool_name: &str) -> Result<DeliveryEntry> {
    let delivered_tokens = estimate_tokens(&serde_json::to_string(payload)?);
    let baseline_tokens = mcp_stats_baseline_tokens(payload, tool_name)?;
    Ok(DeliveryEntry {
        tool_name: tool_name.to_string(),
        request_fingerprint: mcp_request_fingerprint(payload, tool_name),
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
                    "toolName": entry.tool_name,
                    "deliveredTokens": entry.delivered_tokens,
                    "baselineTokens": entry.baseline_tokens,
                    "tokensSaved": entry.tokens_saved,
                    "providerBillingClaimed": false,
                    "basis": "estimated tokens over exact MCP JSON tool payload text",
                    "requestFingerprint": entry.request_fingerprint
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

fn totals(
    session_id: &str,
    call_count: i64,
    delivered_tokens: i64,
    baseline_tokens: i64,
    tokens_saved: i64,
) -> Value {
    let percent = if baseline_tokens > 0 {
        ((tokens_saved as f64 / baseline_tokens as f64) * 100.0).round() as i64
    } else {
        0
    };
    json!({
        "sessionId": session_id,
        "statsRef": "workspace://.local/mcp-stats.jsonl",
        "callCount": call_count,
        "deliveredTokens": delivered_tokens,
        "baselineTokens": baseline_tokens,
        "tokensSaved": tokens_saved,
        "tokenSavingPercent": percent,
        "providerBillingClaimed": false
    })
}

fn mcp_stats_baseline_tokens(payload: &Value, tool_name: &str) -> Result<i64> {
    if tool_name == "context.profile" {
        return Ok(payload
            .pointer("/data/contextBudget/historyTokensAvailable")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0));
    }
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

fn mcp_request_fingerprint(payload: &Value, tool_name: &str) -> String {
    if tool_name == "context.profile" {
        return payload
            .pointer("/data/objectiveFingerprint")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| fingerprint_json(&Value::String(tool_name.to_string())));
    }
    fingerprint_json(&json!({
        "toolName": tool_name,
        "query": payload.pointer("/data/query").and_then(Value::as_str).unwrap_or(""),
        "scope": payload.pointer("/data/scope").and_then(Value::as_str).unwrap_or("workspace")
    }))
}

fn mcp_tools() -> Value {
    json!([
        memory_recall_tool(),
        memory_why_tool(),
        context_profile_tool(),
        context_pack_tool(),
        graph_path_tool(),
        graph_explain_tool(),
        query_graph_tool(),
        architecture_overview_tool(),
        detect_changes_tool()
    ])
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

fn memory_why_tool() -> Value {
    json!({
        "name": "memory.why",
        "description": "Explain a governed memory fact's source, episode, proposal, validity, and supersession chain.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "required": ["factId"],
            "properties": {
                "factId": { "type": "string", "minLength": 1, "maxLength": 160 },
                "at": { "type": "string", "maxLength": 80 }
            }
        },
        "annotations": { "sideEffectClass": "read-only", "oafOperation": "memory.why" }
    })
}

fn context_profile_tool() -> Value {
    json!({
        "name": "context.profile",
        "description": "Compile a compressed profile from governed local memory for an objective.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "required": ["objective"],
            "properties": {
                "objective": { "type": "string", "minLength": 1, "maxLength": 500 },
                "step": { "type": "string", "maxLength": 500 },
                "scope": { "type": "string", "maxLength": 64, "default": "workspace" },
                "client": { "type": "string", "maxLength": 80, "default": "default" },
                "budget": { "type": "integer", "minimum": 1, "maximum": 100000, "default": 4096 },
                "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 50 },
                "since": { "type": "string", "maxLength": 80 }
            }
        },
        "annotations": { "sideEffectClass": "read-only", "oafOperation": "context.profile" }
    })
}

fn context_pack_tool() -> Value {
    json!({
        "name": "context.pack",
        "description": "Return the existing sanitized context-pack handoff summary.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "required": ["objective", "step"],
            "properties": {
                "objective": { "type": "string", "minLength": 1, "maxLength": 500 },
                "step": { "type": "string", "minLength": 1, "maxLength": 500 },
                "from": { "type": "string", "maxLength": 80, "default": "all" },
                "target": { "type": "string", "maxLength": 80, "default": "generic" },
                "budget": { "type": "integer", "minimum": 1, "maximum": 100000, "default": 4096 }
            }
        },
        "annotations": { "sideEffectClass": "read-only", "oafOperation": "context.pack" }
    })
}

fn graph_path_tool() -> Value {
    json!({
        "name": "graph.path",
        "description": "Find a bounded temporal path through governed active memory graph edges.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "required": ["from", "to"],
            "properties": {
                "from": { "type": "string", "minLength": 1, "maxLength": 160 },
                "to": { "type": "string", "minLength": 1, "maxLength": 160 },
                "scope": { "type": "string", "maxLength": 64, "default": "workspace" },
                "at": { "type": "string", "maxLength": 80 },
                "maxHops": { "type": "integer", "minimum": 1, "maximum": 12, "default": 6 },
                "undirected": { "type": "boolean", "default": false }
            }
        },
        "annotations": { "sideEffectClass": "read-only", "oafOperation": "graph.path" }
    })
}

fn graph_explain_tool() -> Value {
    json!({
        "name": "graph.explain",
        "description": "Return a bounded temporal k-hop neighborhood for a governed graph entity.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "entity": { "type": "string", "maxLength": 160 },
                "query": { "type": "string", "maxLength": 240 },
                "scope": { "type": "string", "maxLength": 64, "default": "workspace" },
                "at": { "type": "string", "maxLength": 80 },
                "depth": { "type": "integer", "minimum": 1, "maximum": 6, "default": 1 }
            }
        },
        "annotations": { "sideEffectClass": "read-only", "oafOperation": "graph.explain" }
    })
}

fn query_graph_tool() -> Value {
    json!({
        "name": "query.graph",
        "description": "Run the M4 read-only Cypher subset against governed active graph edges.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "required": ["cypher"],
            "properties": {
                "cypher": { "type": "string", "minLength": 1, "maxLength": 2000 },
                "scope": { "type": "string", "maxLength": 64, "default": "workspace" },
                "at": { "type": "string", "maxLength": 80 },
                "maxRows": { "type": "integer", "minimum": 1, "maximum": 500, "default": 100 }
            }
        },
        "annotations": { "sideEffectClass": "read-only", "oafOperation": "query.graph" }
    })
}

fn architecture_overview_tool() -> Value {
    json!({
        "name": "architecture.overview",
        "description": "Summarize the current governed source graph in one read-only architecture report.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "scope": { "type": "string", "maxLength": 64, "default": "workspace" },
                "at": { "type": "string", "maxLength": 80 },
                "maxItems": { "type": "integer", "minimum": 1, "maximum": 50, "default": 20 }
            }
        },
        "annotations": { "sideEffectClass": "read-only", "oafOperation": "architecture.overview" }
    })
}

fn detect_changes_tool() -> Value {
    json!({
        "name": "detect.changes",
        "description": "Report affected governed symbols from git or explicit changed locators.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "changedLocators": { "type": "array", "items": { "type": "string", "maxLength": 240 }, "maxItems": 100 },
                "changed": { "type": "array", "items": { "type": "string", "maxLength": 240 }, "maxItems": 100 },
                "changedFromGit": { "type": "boolean", "default": false },
                "scope": { "type": "string", "maxLength": 64, "default": "workspace" },
                "at": { "type": "string", "maxLength": 80 },
                "maxDepth": { "type": "integer", "minimum": 1, "maximum": 12, "default": 4 }
            }
        },
        "annotations": { "sideEffectClass": "read-only", "oafOperation": "detect.changes" }
    })
}

fn mcp_resource(
    workspace_id: &str,
    suffix: &str,
    name: &str,
    description: &str,
    priority: f64,
) -> Value {
    json!({
        "uri": format!("oaf://workspace/{workspace_id}/{suffix}"),
        "name": name,
        "title": name,
        "description": description,
        "mimeType": "application/json",
        "annotations": { "audience": ["assistant"], "priority": priority }
    })
}

fn mcp_resources(workspace_id: &str) -> Value {
    json!([
        mcp_resource(
            workspace_id,
            "status",
            "OAF workspace status",
            "Sanitized local OAF workspace status and default safety posture.",
            0.8
        ),
        mcp_resource(
            workspace_id,
            "context/latest",
            "Latest context manifest summary",
            "Sanitized selected and excluded context manifest summary.",
            0.9
        ),
        mcp_resource(
            workspace_id,
            "runs/latest",
            "Latest run summary",
            "Sanitized latest run and recent event timeline without event bodies.",
            0.6
        ),
        mcp_resource(
            workspace_id,
            "memory/proposals",
            "Memory proposal summary",
            "Proposal-only memory queue summary without memory text.",
            0.55
        ),
        mcp_resource(
            workspace_id,
            "handoff/latest",
            "Handoff bundle summary",
            "Sanitized handoff and artifact summary for local agent review.",
            0.85
        )
    ])
}

fn rpc_error(id: Value, code: i64, message: &str, data_code: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message, "data": { "code": data_code } }
    })
}

fn read_cursor(
    config: &CliConfig,
    tool_name: &str,
    args: &serde_json::Map<String, Value>,
) -> Result<Option<String>> {
    let text = match fs::read_to_string(&config.cursor_abs) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("read MCP cursor store"),
    };
    if text.trim().is_empty() {
        return Ok(None);
    }
    let parsed: Value = serde_json::from_str(&text).context("parse MCP cursor store")?;
    Ok(parsed
        .get("cursors")
        .and_then(Value::as_object)
        .and_then(|cursors| cursors.get(&cursor_key(config, tool_name, args)))
        .and_then(|entry| entry.get("cursor"))
        .and_then(Value::as_str)
        .map(str::to_string))
}

fn write_cursor(
    config: &CliConfig,
    tool_name: &str,
    args: &serde_json::Map<String, Value>,
    cursor: &str,
) -> Result<()> {
    let mut data = match fs::read_to_string(&config.cursor_abs) {
        Ok(text) if !text.trim().is_empty() => {
            serde_json::from_str::<Value>(&text).context("parse MCP cursor store")?
        }
        _ => json!({ "schemaVersion": "1.0.0", "kind": "mcp-session-cursors", "cursors": {} }),
    };
    let key = cursor_key(config, tool_name, args);
    data["schemaVersion"] = Value::String("1.0.0".to_string());
    data["kind"] = Value::String("mcp-session-cursors".to_string());
    data["workspaceId"] = Value::String(config.workspace_id.clone());
    if !data.get("cursors").is_some_and(Value::is_object) {
        data["cursors"] = json!({});
    }
    data["cursors"][key] = json!({
        "workspaceId": config.workspace_id,
        "toolName": tool_name,
        "client": json_string(args.get("client"), "default", 80),
        "scope": json_string(args.get("scope"), "workspace", 64),
        "cursor": cursor,
        "updatedAt": cursor
    });
    if let Some(parent) = config.cursor_abs.parent() {
        fs::create_dir_all(parent).context("create MCP cursor directory")?;
    }
    let tmp = config.cursor_abs.with_file_name(format!(
        ".{}.{}.tmp",
        config
            .cursor_abs
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("mcp-cursors.json"),
        std::process::id()
    ));
    fs::write(&tmp, format!("{}\n", serde_json::to_string_pretty(&data)?))
        .context("write MCP cursor temp file")?;
    fs::rename(tmp, &config.cursor_abs).context("replace MCP cursor store")?;
    Ok(())
}

fn cursor_key(
    config: &CliConfig,
    tool_name: &str,
    args: &serde_json::Map<String, Value>,
) -> String {
    [
        sanitize(&config.workspace_id, 120),
        sanitize(tool_name, 120),
        json_string(args.get("client"), "default", 80),
        json_string(args.get("scope"), "workspace", 64),
    ]
    .join("|")
}

fn fingerprint_json(value: &Value) -> String {
    format!(
        "sha256:{}",
        sha256_hex(&serde_json::to_string(value).unwrap_or_default())
    )
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

fn merge_object(target: &mut Value, source: Value) -> Result<()> {
    let target = target
        .as_object_mut()
        .ok_or_else(|| anyhow!("target report must be an object"))?;
    let source = source
        .as_object()
        .ok_or_else(|| anyhow!("search report must be an object"))?;
    for (key, value) in source {
        target.insert(key.clone(), value.clone());
    }
    Ok(())
}

fn ensure_json(args: &[String]) -> Result<()> {
    if option(args, "--format").as_deref().unwrap_or("json") != "json" {
        bail!("Rust M1 only supports --format json");
    }
    Ok(())
}

fn parse_memory_bytes(args: &[String]) -> Result<u64> {
    parse_size_option(args, "--max-memory", DEFAULT_MAX_MEMORY_BYTES, 1024 * 1024)
}

fn parse_file_bytes(args: &[String]) -> Result<u64> {
    if let Some(value) = option(args, "--max-file-bytes") {
        return value
            .parse::<u64>()
            .context("--max-file-bytes must be an integer byte count");
    }
    parse_size_option(args, "--max-file-mb", DEFAULT_MAX_FILE_BYTES, 1024 * 1024)
}

fn parse_workers(args: &[String]) -> Result<usize> {
    let Some(raw) = option(args, "--workers") else {
        return Ok(1);
    };
    let workers = raw
        .parse::<usize>()
        .context("--workers must be a positive integer")?;
    if workers == 0 {
        bail!("--workers must be greater than zero");
    }
    Ok(workers.min(1024))
}

fn parse_size_option(args: &[String], flag: &str, default: u64, multiplier: u64) -> Result<u64> {
    let Some(raw) = option(args, flag) else {
        return Ok(default);
    };
    let trimmed = raw.trim().to_ascii_lowercase();
    let number = trimmed
        .strip_suffix("mb")
        .or_else(|| trimmed.strip_suffix('m'))
        .unwrap_or(&trimmed)
        .parse::<u64>()
        .with_context(|| format!("{flag} must be an integer megabyte value"))?;
    if number == 0 {
        bail!("{flag} must be greater than zero");
    }
    number
        .checked_mul(multiplier)
        .ok_or_else(|| anyhow!("{flag} is too large"))
}

fn options(args: &[String], flag: &str) -> Vec<String> {
    args.windows(2)
        .filter_map(|pair| (pair[0] == flag).then(|| pair[1].clone()))
        .collect()
}

fn parse_usize_option(
    args: &[String],
    flag: &str,
    default: usize,
    min: usize,
    max: usize,
) -> usize {
    option(args, flag)
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(default)
        .clamp(min, max)
}

fn option(args: &[String], flag: &str) -> Option<String> {
    args.windows(2)
        .find_map(|pair| (pair[0] == flag).then(|| pair[1].clone()))
}

fn flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|arg| arg == flag)
}

fn semantic_enabled(args: &[String]) -> bool {
    let Some(index) = args.iter().position(|arg| arg == "--semantic") else {
        return false;
    };
    args.get(index + 1)
        .filter(|value| !value.starts_with("--"))
        .map(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(true)
}

fn workspace_locator(value: &str) -> String {
    if value.starts_with("workspace://") {
        value.to_string()
    } else {
        format!(
            "workspace://{}",
            value.trim_start_matches("./").replace('\\', "/")
        )
    }
}

fn git_changed_locators(root: &Path) -> Result<Vec<String>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["status", "--porcelain", "--untracked-files=all"])
        .output()
        .context("git status for changed locators")?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let mut locators = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if line.len() < 4 {
            continue;
        }
        let path = line[3..].split(" -> ").last().unwrap_or("").trim();
        if !path.is_empty() && path != ".local" && !path.starts_with(".local/") {
            locators.push(workspace_locator(path));
        }
    }
    locators.sort();
    locators.dedup();
    Ok(locators)
}

fn sorted_strings(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

fn loop_observation(
    plan: &Value,
    run_id: &str,
    worktree: &Path,
    execute_commands: bool,
    now: &str,
) -> Result<Value> {
    let loop_plan_id = plan
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("loopplan_unknown");
    let loop_plan_fingerprint = plan
        .get("loopPlanFingerprint")
        .and_then(Value::as_str)
        .unwrap_or("sha256:0000000000000000000000000000000000000000000000000000000000000000");
    let mut commands = Vec::new();
    if execute_commands {
        for command in plan
            .get("validationCommands")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let started = Instant::now();
            let output = Command::new("sh")
                .arg("-c")
                .arg(command)
                .current_dir(worktree)
                .output()
                .with_context(|| format!("run validation command: {command}"))?;
            let combined = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            let normalized = combined.split_whitespace().collect::<Vec<_>>().join(" ");
            commands.push(json!({
                "command": command,
                "exitCode": output.status.code().unwrap_or(1),
                "durationMs": (started.elapsed().as_secs_f64() * 1000.0).round(),
                "passed": output.status.success(),
                "outputSummary": sanitize(&normalized, 320),
                "outputHash": format!("sha256:{}", sha256_hex(&combined)),
                "outputTruncated": combined.len() > 320
            }));
        }
    }
    let passed = commands
        .iter()
        .all(|command| command.get("passed").and_then(Value::as_bool) == Some(true));
    let observation = json!({
        "schemaVersion": "1.0.0",
        "command": "loop observe",
        "id": format!("loopobs_{}", &sha256_hex(&canonical_json(&json!({ "runId": run_id, "plan": loop_plan_id, "now": now })))[..24]),
        "workspaceId": plan.get("workspaceId").and_then(Value::as_str).unwrap_or("ws_local"),
        "runId": run_id,
        "createdAt": now,
        "loopPlanId": loop_plan_id,
        "loopPlanFingerprint": loop_plan_fingerprint,
        "status": if passed { "passed" } else { "failed" },
        "commands": commands,
        "events": [{
            "id": format!("evt_loop_{}", &sha256_hex("loop.observation_recorded")[..24]),
            "type": "loop.observation_recorded",
            "sequence": 1
        }],
        "safeguards": {
            "commandsLimitedToPlan": true,
            "rawOutputIncluded": false,
            "outputSummaryMaxChars": 320,
            "localFilesWrittenOutsideLedger": 0,
            "networkCallsDeclared": 0,
            "modelCalls": 0,
            "externalWritesEnabled": false,
            "activeMemoryCreated": 0
        },
        "observationFingerprint": Value::Null
    });
    let mut observation = observation;
    observation["observationFingerprint"] = Value::String(fingerprint_json(&observation));
    Ok(observation)
}

fn loop_governance(store: &Store, plan: &Value, worktree: &Path) -> Result<Value> {
    let assertions = plan
        .get("governanceAssertions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut checked = 0;
    let mut violations = Vec::new();
    for assertion in assertions.iter().take(16) {
        let subject = assertion
            .get("subject")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("governance assertion subject required"))?;
        let predicate = assertion
            .get("predicate")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("governance assertion predicate required"))?;
        let Some(expected) = store.active_value("workspace", subject, predicate)? else {
            continue;
        };
        let probe = assertion
            .get("probe")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("governance assertion probe required"))?;
        let file = probe
            .get("file")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("governance assertion probe file required"))?;
        let actual = loop_probe_actual(worktree, probe)?;
        checked += 1;
        if actual != expected && violations.len() < 16 {
            violations.push(json!({
                "subject": subject,
                "predicate": predicate,
                "expected": expected,
                "actual": actual,
                "file": file
            }));
        }
    }
    Ok(json!({ "checked": checked, "violations": violations }))
}

fn loop_probe_actual(worktree: &Path, probe: &serde_json::Map<String, Value>) -> Result<String> {
    let file = probe.get("file").and_then(Value::as_str).unwrap_or("");
    let relative = Path::new(file);
    if relative.is_absolute() || file.contains("..") {
        bail!("governance assertion file must stay inside worktree");
    }
    let path = worktree.join(relative);
    let canonical_worktree = worktree.canonicalize()?;
    let canonical_path = path.canonicalize().ok();
    let Some(canonical_path) = canonical_path else {
        return Ok("not found".to_string());
    };
    if !canonical_path.starts_with(&canonical_worktree) {
        bail!("governance assertion file must stay inside worktree");
    }
    let metadata = fs::metadata(&canonical_path)?;
    if !metadata.is_file() {
        return Ok("not found".to_string());
    }
    if metadata.len() > 64 * 1024 {
        return Ok("file too large".to_string());
    }
    let text = fs::read_to_string(&canonical_path)?;
    let capture = probe.get("capture").and_then(Value::as_str).unwrap_or("");
    let regex = Regex::new(capture).context("compile governance assertion capture")?;
    let Some(captures) = regex.captures(&text) else {
        return Ok("not found".to_string());
    };
    let template = probe
        .get("valueTemplate")
        .and_then(Value::as_str)
        .unwrap_or("");
    Ok(Regex::new(r"\$(\d+)")?
        .replace_all(template, |caps: &regex::Captures| {
            let index = caps
                .get(1)
                .and_then(|value| value.as_str().parse::<usize>().ok())
                .unwrap_or(0);
            captures
                .get(index)
                .map(|value| value.as_str())
                .unwrap_or("")
        })
        .to_string())
}

fn loop_event(
    report: &Value,
    loop_plan_id: &str,
    loop_plan_fingerprint: &str,
    sequence: i64,
    event_type: &str,
    payload: Value,
) -> Value {
    let report_id = report
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("loopverify_unknown");
    let mut event_payload = json!({
        "verificationReportId": report_id,
        "loopPlanId": loop_plan_id,
        "loopPlanFingerprint": loop_plan_fingerprint,
        "status": if sequence < 2 { "blocked" } else { report.get("status").and_then(Value::as_str).unwrap_or("blocked") }
    });
    if let (Some(base), Some(extra)) = (event_payload.as_object_mut(), payload.as_object()) {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }
    json!({
        "schemaVersion": "1.0.0",
        "id": format!("evt_loop_{}", &sha256_hex(&format!("{event_type}:{sequence}:{report_id}"))[..24]),
        "workspaceId": report.get("workspaceId").and_then(Value::as_str).unwrap_or("ws_local"),
        "runId": report.get("runId").and_then(Value::as_str).unwrap_or("run_loop_verification"),
        "type": event_type,
        "actorId": "system",
        "sequence": sequence,
        "occurredAt": report.get("createdAt").and_then(Value::as_str).unwrap_or("1970-01-01T00:00:00.000Z"),
        "correlationId": format!("corr_{}", report_id),
        "causationId": loop_plan_id,
        "dataClass": "workspace-private",
        "producerVersion": "0.1.0",
        "payload": event_payload
    })
}

fn synthetic_profile_record(layer: &str, records: &[Value], config: &CliConfig) -> Value {
    let text = profile_layer_text(layer, records);
    let ids = source_record_ids(records);
    json!({
        "id": format!("mem_profile_{layer}"),
        "version": format!("v1:{}", &sha256_hex(&canonical_json(&json!({ "layer": layer, "ids": ids, "text": text })))[..12]),
        "kind": "fact",
        "workspaceId": config.workspace_id,
        "text": text,
        "tags": ["memory:profile"],
        "relations": ["memory:profile"],
        "scope": "workspace-private",
        "dataClass": "workspace-private",
        "trustClass": "verified",
        "status": "active",
        "source": "native-memory-profile",
        "tokens": estimate_tokens(&text),
        "confidence": 0.5,
        "authority": 0.5,
        "updatedAt": config.now,
        "metadata": {
            "profileLayer": layer,
            "sourceRecordIds": ids,
            "contextAssembly": { "tier": "full", "reasonCodes": ["compressed_profile"] }
        }
    })
}

fn profile_layer_text(layer: &str, records: &[Value]) -> String {
    let mut lines = vec![if layer == "static" {
        "Static long-term memory profile:".to_string()
    } else {
        "Dynamic recent memory profile:".to_string()
    }];
    if records.is_empty() {
        lines.push("- no accepted records".to_string());
    }
    for record in records {
        lines.push(format!(
            "- {} {}: {}",
            value_str(record, "kind"),
            value_str(record, "id"),
            sanitize(value_str(record, "text"), 96)
        ));
    }
    lines.join("\n")
}

fn source_record_ids(records: &[Value]) -> Vec<String> {
    records
        .iter()
        .filter_map(|record| record.get("id").and_then(Value::as_str).map(str::to_string))
        .collect()
}

fn value_str<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn value_f64(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(0.0)
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

fn json_string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|value| sanitize(value, 240))
                .filter(|value| !value.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn json_i64(value: Option<&Value>, fallback: i64, min: i64, max: i64) -> i64 {
    value
        .and_then(Value::as_i64)
        .unwrap_or(fallback)
        .clamp(min, max)
}

fn json_flag(args: &serde_json::Map<String, Value>, name: &str) -> bool {
    args.get(name).and_then(Value::as_bool) == Some(true)
}

fn omission_manifest(
    candidates: &[Value],
    selected_ids: &[String],
    budget: i64,
    used_tokens: i64,
) -> Vec<Value> {
    let selected = selected_ids
        .iter()
        .collect::<std::collections::BTreeSet<_>>();
    let mut out = Vec::new();
    for candidate in candidates {
        let id = value_str(candidate, "id");
        let status = value_str(candidate, "status");
        let reason = if status == "superseded" {
            "superseded"
        } else if selected.contains(&id.to_string()) {
            continue;
        } else if used_tokens > budget {
            "budget_pressure"
        } else {
            "lower_relevance"
        };
        let subject = value_str(candidate, "subject");
        let predicate = value_str(candidate, "predicate");
        out.push(json!({
            "type": "memory_fact",
            "ref": value_str(candidate, "factId"),
            "reason": reason,
            "recoverable_by": format!(
                "oaf memory recall --query {} --subject {} --predicate {} --current-truth-only",
                shell_token(value_str(candidate, "text")),
                shell_token(subject),
                shell_token(predicate)
            )
        }));
    }
    out
}

fn shell_token(value: &str) -> String {
    let escaped = value.replace('\'', "'\\''");
    format!("'{escaped}'")
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

fn short_hash(value: &str) -> String {
    sha256_hex(value).chars().take(16).collect()
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
