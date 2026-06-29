use oaf_store::{expand_token_text, BatchFact, Store, StoreOptions, Supersedes};
use std::fs;

const NOW: &str = "2026-06-29T00:00:00.000Z";

fn open_store(path: &std::path::Path) -> Store {
    Store::open(
        path,
        StoreOptions {
            workspace_id: "ws_local".to_string(),
            now: NOW.to_string(),
        },
    )
    .unwrap()
}

#[test]
fn tokenizer_keeps_originals_and_adds_camel_digit_namespace_terms() {
    let text = expand_token_text("MemoryBackendPort parseV2 provider:native-memory XMLParser");
    for expected in [
        "memorybackendport",
        "memory backend port",
        "parsev2",
        "parse v2",
        "provider native memory",
        "xmlparser",
        "xml parser",
    ] {
        assert!(text.contains(expected), "{expected} missing from {text}");
    }
}

#[test]
fn governed_batch_approve_supersedes_skips_unsafe_and_dedupes_entities_by_name() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join(".local")).unwrap();
    fs::write(dir.path().join("DECISIONS.md"), "decision source").unwrap();
    fs::write(dir.path().join("package.json"), "{}").unwrap();
    let db = dir.path().join(".local/memory.sqlite");
    let mut store = open_store(&db);

    let old = store
        .remember_single(
            "workspace",
            "auth",
            "token_expiry",
            "60 minutes",
            "workspace://DECISIONS.md",
            false,
        )
        .unwrap();
    assert_eq!(old.active_memory_created, 1);

    let batch = store
        .remember_batch(
            dir.path(),
            "workspace",
            &[
                BatchFact {
                    subject: "auth".into(),
                    predicate: "token_expiry".into(),
                    object: "15 minutes".into(),
                    source: "workspace://DECISIONS.md".into(),
                    source_trust: None,
                    confidence: None,
                    notes: Some("2026-03 review; replaces 60-minute decision".into()),
                    supersedes: Some(Supersedes {
                        subject: "auth".into(),
                        predicate: "token_expiry".into(),
                        object: None,
                    }),
                },
                BatchFact {
                    subject: "auth".into(),
                    predicate: "refresh_tokens".into(),
                    object: "enabled, 24h".into(),
                    source: "workspace://DECISIONS.md".into(),
                    source_trust: None,
                    confidence: None,
                    notes: None,
                    supersedes: None,
                },
                BatchFact {
                    subject: "MemoryBackendPort".into(),
                    predicate: "implemented_by".into(),
                    object: "MemoryBackendPort".into(),
                    source: "workspace://package.json".into(),
                    source_trust: None,
                    confidence: Some("inferred".into()),
                    notes: None,
                    supersedes: None,
                },
                BatchFact {
                    subject: "auth".into(),
                    predicate: "config_path".into(),
                    object: "/Users/rebel/private-config.json".into(),
                    source: "workspace://DECISIONS.md".into(),
                    source_trust: None,
                    confidence: None,
                    notes: None,
                    supersedes: None,
                },
                BatchFact {
                    subject: "auth".into(),
                    predicate: "credential".into(),
                    object: "token=SECRETVALUE".into(),
                    source: "workspace://DECISIONS.md".into(),
                    source_trust: None,
                    confidence: None,
                    notes: None,
                    supersedes: None,
                },
            ],
        )
        .unwrap();
    assert_eq!(batch.recorded_count, 3);
    assert_eq!(batch.skipped_unsafe_count, 2);

    let approved = store.approve_all_from("workspace://DECISIONS.md").unwrap();
    assert_eq!(approved.active_memory_created, 2);
    assert_eq!(approved.superseded_fact_count, 1);
    let approved_rest = store.approve_all().unwrap();
    assert_eq!(approved_rest.active_memory_created, 1);

    let facts = store
        .recall_current_truth("workspace", "auth", Some("auth"), None, 20)
        .unwrap();
    let rendered = serde_json::to_string(&facts).unwrap();
    assert!(rendered.contains("15 minutes"));
    assert!(rendered.contains("enabled, 24h"));
    assert!(!rendered.contains("60 minutes"));

    let entity_counts = store.entity_name_counts().unwrap();
    assert!(
        entity_counts.iter().all(|(_, count)| *count == 1),
        "{entity_counts:?}"
    );
}

#[test]
fn recall_splits_query_identifiers_like_node_oracle() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join(".local")).unwrap();
    fs::write(dir.path().join("package.json"), "{}").unwrap();
    let db = dir.path().join(".local/memory.sqlite");
    let mut store = open_store(&db);

    let batch = store
        .remember_batch(
            dir.path(),
            "workspace",
            &[
                BatchFact {
                    subject: "project:open-agent-fabric".into(),
                    predicate: "memory_backend".into(),
                    object: "MemoryBackendPort".into(),
                    source: "workspace://package.json".into(),
                    source_trust: None,
                    confidence: Some("inferred".into()),
                    notes: None,
                    supersedes: None,
                },
                BatchFact {
                    subject: "MemoryBackendPort".into(),
                    predicate: "implemented_by".into(),
                    object: "provider:native:memory".into(),
                    source: "workspace://package.json".into(),
                    source_trust: None,
                    confidence: None,
                    notes: None,
                    supersedes: None,
                },
                BatchFact {
                    subject: "provider:native:memory".into(),
                    predicate: "uses".into(),
                    object: "MemoryBackendPort".into(),
                    source: "workspace://package.json".into(),
                    source_trust: None,
                    confidence: None,
                    notes: None,
                    supersedes: None,
                },
            ],
        )
        .unwrap();
    assert_eq!(batch.recorded_count, 3);
    assert_eq!(store.approve_all().unwrap().active_memory_created, 3);

    let facts = store
        .recall_current_truth("workspace", "MemoryBackendPort", None, None, 20)
        .unwrap();
    assert_eq!(facts[0]["predicate"].as_str(), Some("memory_backend"));
}

#[test]
fn storage_survives_killed_uncommitted_write_without_success_on_empty() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join(".local")).unwrap();
    let db = dir.path().join(".local/memory.sqlite");
    let store = open_store(&db);
    assert_eq!(store.integrity_check().unwrap(), "ok");
    drop(store);

    let current_exe = std::env::current_exe().unwrap();
    let status = std::process::Command::new(current_exe)
        .arg("crash_child_aborts_mid_write")
        .arg("--exact")
        .arg("--nocapture")
        .env("OAF_STORE_CRASH_DB", &db)
        .env("OAF_STORE_ABORT_AFTER_UNCOMMITTED_WRITE", "1")
        .status()
        .unwrap();
    assert!(!status.success());

    let store = open_store(&db);
    assert_eq!(store.integrity_check().unwrap(), "ok");
    let facts = store
        .recall_current_truth("workspace", "auth", Some("auth"), None, 20)
        .unwrap();
    assert!(facts.is_empty(), "{facts:?}");
}

#[test]
fn crash_child_aborts_mid_write() {
    let Some(db) = std::env::var_os("OAF_STORE_CRASH_DB") else {
        return;
    };
    let mut store = open_store(std::path::Path::new(&db));
    let _ = store.remember_single(
        "workspace",
        "auth",
        "token_expiry",
        "60 minutes",
        "workspace://DECISIONS.md",
        false,
    );
}
