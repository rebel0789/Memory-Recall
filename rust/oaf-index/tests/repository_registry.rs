use oaf_index::{
    normalized_generation_fingerprint, repository_identity_hash, EdgeRecord, FileRecord,
    GenerationInput, GoRepositoryQuery, NodeRecord, RepositoryRegistry, SourceIndex,
    SourceIndexOptions, REPOSITORY_INDEX_RELATIVE_PATH, REPOSITORY_REGISTRY_RELATIVE_PATH,
};
use std::fs;
use std::path::Path;
use std::time::SystemTime;
use tempfile::tempdir;

const WORKSPACE_ID: &str = "fleet-test";
const ENGINE_VERSION: &str = "1.1.1";
const SHARED_NODE_ID: &str = "cinode_11111111111111111111111111111111";
const CLIENT_ENTRY_ID: &str = "cinode_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SERVICE_TARGET_ID: &str = "cinode_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DECOY_TARGET_ID: &str = "cinode_cccccccccccccccccccccccccccccccc";

fn generation() -> GenerationInput {
    let locator = "workspace://src/shared.ts#L1-L2";
    let mut input = GenerationInput {
        reason: "repository_registry_fixture".into(),
        created_at: "2026-07-17T00:00:00Z".into(),
        structural_fingerprint:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        ignore_fingerprint: None,
        files: vec![FileRecord {
            locator: "workspace://src/shared.ts".into(),
            content_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                .into(),
            byte_size: 32,
            language: "typescript".into(),
            parse_state: "parsed".into(),
            diagnostic_count: 0,
            owner_identity: "file_shared".into(),
        }],
        nodes: vec![NodeRecord {
            canonical_id: SHARED_NODE_ID.into(),
            kind: "function".into(),
            language_kind: "function_declaration".into(),
            qualified_name: "src/shared.ts::sharedEntry[]".into(),
            locator: locator.into(),
            start_line: 1,
            end_line: 2,
            content_hash: None,
            visibility: "exported".into(),
        }],
        edges: Vec::new(),
        unresolved: Vec::new(),
        coverage: Vec::new(),
        diagnostics: Vec::new(),
    };
    input.structural_fingerprint = normalized_generation_fingerprint(&input).unwrap();
    input
}

fn create_repository(fleet_root: &Path, name: &str) {
    let root = fleet_root.join(name);
    fs::create_dir_all(&root).unwrap();
    let identity = repository_identity_hash(&root.canonicalize().unwrap(), WORKSPACE_ID);
    let options = SourceIndexOptions::new(identity, ENGINE_VERSION);
    let mut index =
        SourceIndex::open(&root.join(REPOSITORY_INDEX_RELATIVE_PATH), &options).unwrap();
    index.commit_generation(&generation()).unwrap();
}

fn go_generation(role: &str) -> GenerationInput {
    let (nodes, edges) = match role {
        "client" => (
            vec![
                NodeRecord {
                    canonical_id: CLIENT_ENTRY_ID.into(),
                    kind: "function".into(),
                    language_kind: "function".into(),
                    qualified_name: "main.go::Build".into(),
                    locator: "workspace://main.go#L3-L3".into(),
                    start_line: 3,
                    end_line: 3,
                    content_hash: None,
                    visibility: "unknown".into(),
                },
                NodeRecord {
                    canonical_id: "cinode_dddddddddddddddddddddddddddddddd".into(),
                    kind: "module".into(),
                    language_kind: "module".into(),
                    qualified_name: "main.go::main".into(),
                    locator: "workspace://main.go#L1-L3".into(),
                    start_line: 1,
                    end_line: 3,
                    content_hash: None,
                    visibility: "unknown".into(),
                },
                NodeRecord {
                    canonical_id: "cinode_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".into(),
                    kind: "module".into(),
                    language_kind: "module".into(),
                    qualified_name: "main.go::example.com/demo/service".into(),
                    locator: "workspace://main.go#L2-L2".into(),
                    start_line: 2,
                    end_line: 2,
                    content_hash: None,
                    visibility: "unknown".into(),
                },
                NodeRecord {
                    canonical_id: "cinode_ffffffffffffffffffffffffffffffff".into(),
                    kind: "struct".into(),
                    language_kind: "struct".into(),
                    qualified_name: "main.go::Service".into(),
                    locator: "workspace://main.go#L3-L3".into(),
                    start_line: 3,
                    end_line: 3,
                    content_hash: None,
                    visibility: "unknown".into(),
                },
                NodeRecord {
                    canonical_id: "cinode_99999999999999999999999999999999".into(),
                    kind: "struct".into(),
                    language_kind: "struct".into(),
                    qualified_name: "other.go::Service".into(),
                    locator: "workspace://other.go#L1-L1".into(),
                    start_line: 1,
                    end_line: 1,
                    content_hash: None,
                    visibility: "unknown".into(),
                },
            ],
            vec![
                EdgeRecord {
                    canonical_id: "ciedge_11111111111111111111111111111111".into(),
                    source_id: "cinode_dddddddddddddddddddddddddddddddd".into(),
                    target_id: "cinode_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".into(),
                    kind: "imports".into(),
                    locator: "workspace://main.go#L2-L2".into(),
                    start_line: 2,
                    end_line: 2,
                    resolver: "memory-recall.import".into(),
                    resolver_version: "0.1.0".into(),
                    confidence: 0.75,
                    resolution_class: "unresolved".into(),
                    stale: false,
                },
                EdgeRecord {
                    canonical_id: "ciedge_00000000000000000000000000000000".into(),
                    source_id: CLIENT_ENTRY_ID.into(),
                    target_id: "cinode_99999999999999999999999999999999".into(),
                    kind: "constructs".into(),
                    locator: "workspace://other.go#L1-L1".into(),
                    start_line: 1,
                    end_line: 1,
                    resolver: "memory-recall.construct".into(),
                    resolver_version: "0.1.0".into(),
                    confidence: 0.5,
                    resolution_class: "unresolved".into(),
                    stale: false,
                },
                EdgeRecord {
                    canonical_id: "ciedge_22222222222222222222222222222222".into(),
                    source_id: CLIENT_ENTRY_ID.into(),
                    target_id: "cinode_ffffffffffffffffffffffffffffffff".into(),
                    kind: "constructs".into(),
                    locator: "workspace://main.go#L3-L3".into(),
                    start_line: 3,
                    end_line: 3,
                    resolver: "memory-recall.construct".into(),
                    resolver_version: "0.1.0".into(),
                    confidence: 0.5,
                    resolution_class: "unresolved".into(),
                    stale: false,
                },
            ],
        ),
        "service" | "decoy" => (
            vec![NodeRecord {
                canonical_id: if role == "service" {
                    SERVICE_TARGET_ID.into()
                } else {
                    DECOY_TARGET_ID.into()
                },
                kind: "struct".into(),
                language_kind: "struct".into(),
                qualified_name: "service/service.go::Service".into(),
                locator: "workspace://service/service.go#L2-L2".into(),
                start_line: 2,
                end_line: 2,
                content_hash: None,
                visibility: "unknown".into(),
            }],
            Vec::new(),
        ),
        _ => unreachable!(),
    };
    let file = if role == "client" {
        "workspace://main.go"
    } else {
        "workspace://service/service.go"
    };
    let mut input = GenerationInput {
        reason: "repository_go_fixture".into(),
        created_at: "2026-07-17T00:00:00Z".into(),
        structural_fingerprint:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        ignore_fingerprint: None,
        files: vec![FileRecord {
            locator: file.into(),
            content_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                .into(),
            byte_size: 96,
            language: "go".into(),
            parse_state: "parsed".into(),
            diagnostic_count: 0,
            owner_identity: format!("file_{role}"),
        }],
        nodes,
        edges,
        unresolved: Vec::new(),
        coverage: Vec::new(),
        diagnostics: Vec::new(),
    };
    if role == "client" {
        input.files.push(FileRecord {
            locator: "workspace://other.go".into(),
            content_hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                .into(),
            byte_size: 32,
            language: "go".into(),
            parse_state: "parsed".into(),
            diagnostic_count: 0,
            owner_identity: "file_client_other".into(),
        });
    }
    input.structural_fingerprint = normalized_generation_fingerprint(&input).unwrap();
    input
}

fn create_go_repository(fleet_root: &Path, name: &str, module: &str, role: &str) {
    let root = fleet_root.join(name);
    fs::create_dir_all(root.join("service")).unwrap();
    fs::write(
        root.join("go.mod"),
        if role == "client" {
            format!("module {module}\n\nrequire example.com/demo v1.0.0\n")
        } else {
            format!("module {module}\n")
        },
    )
    .unwrap();
    let identity = repository_identity_hash(&root.canonicalize().unwrap(), WORKSPACE_ID);
    let options = SourceIndexOptions::new(identity, ENGINE_VERSION);
    let mut index =
        SourceIndex::open(&root.join(REPOSITORY_INDEX_RELATIVE_PATH), &options).unwrap();
    index.commit_generation(&go_generation(role)).unwrap();
}

fn snapshot(path: &Path) -> (Vec<u8>, SystemTime) {
    (
        fs::read(path).unwrap(),
        fs::metadata(path).unwrap().modified().unwrap(),
    )
}

#[test]
fn registers_and_searches_repositories_without_identity_collisions_or_read_writes() {
    let fleet = tempdir().unwrap();
    create_repository(fleet.path(), "repo-a");
    create_repository(fleet.path(), "repo-b");

    let mut registry =
        RepositoryRegistry::open(fleet.path(), WORKSPACE_ID, ENGINE_VERSION).unwrap();
    let repo_a = registry
        .register("Repository A", "workspace://repo-a")
        .unwrap();
    let repo_b = registry
        .register("Repository B", "workspace://repo-b")
        .unwrap();
    assert_ne!(repo_a.repository_id, repo_b.repository_id);
    drop(registry);

    let registry_path = fleet.path().join(REPOSITORY_REGISTRY_RELATIVE_PATH);
    let repo_a_path = fleet
        .path()
        .join("repo-a")
        .join(REPOSITORY_INDEX_RELATIVE_PATH);
    let repo_b_path = fleet
        .path()
        .join("repo-b")
        .join(REPOSITORY_INDEX_RELATIVE_PATH);
    let before_registry = snapshot(&registry_path);
    let before_a = snapshot(&repo_a_path);
    let before_b = snapshot(&repo_b_path);

    let registry =
        RepositoryRegistry::open_read_only(fleet.path(), WORKSPACE_ID, ENGINE_VERSION).unwrap();
    let ids = vec![repo_b.repository_id.clone(), repo_a.repository_id.clone()];
    let first = registry.search("sharedEntry", &ids, 25, 50, 2_000).unwrap();
    let second = registry.search("sharedEntry", &ids, 25, 50, 2_000).unwrap();
    assert_eq!(first, second);
    assert!(!first.partial);
    assert!(!first.truncated);
    assert_eq!(first.results.len(), 2);
    assert_eq!(first.opened_repository_count, 2);
    assert_eq!(first.results[0].native_id, SHARED_NODE_ID);
    assert_eq!(first.results[1].native_id, SHARED_NODE_ID);
    assert_ne!(first.results[0].id, first.results[1].id);
    assert!(first
        .results
        .iter()
        .all(|result| result.id.starts_with("mrnode_") && result.generation == 1));
    assert!(first
        .results
        .iter()
        .all(|result| result.label == "sharedEntry__"));
    let serialized = serde_json::to_string(&first).unwrap();
    assert!(!serialized.contains(fleet.path().to_string_lossy().as_ref()));
    assert_eq!(snapshot(&registry_path), before_registry);
    assert_eq!(snapshot(&repo_a_path), before_a);
    assert_eq!(snapshot(&repo_b_path), before_b);

    let unknown = "repo_ffffffffffffffffffffffffffffffff".to_string();
    let error = registry
        .search("sharedEntry", &[unknown], 25, 50, 2_000)
        .unwrap_err();
    assert!(format!("{error:#}").contains("repository_not_registered"));
    assert_eq!(snapshot(&registry_path), before_registry);
    assert_eq!(snapshot(&repo_a_path), before_a);
    assert_eq!(snapshot(&repo_b_path), before_b);
}

#[test]
fn rejects_invalid_bounds_and_roots_outside_the_fleet() {
    let fleet = tempdir().unwrap();
    let outside = tempdir().unwrap();
    create_repository(fleet.path(), "repo-a");
    create_repository(outside.path(), "repo-outside");
    let mut registry =
        RepositoryRegistry::open(fleet.path(), WORKSPACE_ID, ENGINE_VERSION).unwrap();
    let repo = registry
        .register("Repository A", "workspace://repo-a")
        .unwrap();
    assert!(registry
        .search(
            "sharedEntry",
            std::slice::from_ref(&repo.repository_id),
            26,
            50,
            2_000,
        )
        .is_err());
    assert!(registry
        .search(
            "sharedEntry",
            std::slice::from_ref(&repo.repository_id),
            25,
            51,
            2_000,
        )
        .is_err());
    assert!(registry
        .search("sharedEntry", &[repo.repository_id], 25, 50, 2_001)
        .is_err());
    assert!(registry
        .register("Escape", "workspace://../repo-outside")
        .is_err());

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            outside.path().join("repo-outside"),
            fleet.path().join("escape"),
        )
        .unwrap();
        let error = registry
            .register("Escape", "workspace://escape")
            .unwrap_err();
        assert!(format!("{error:#}").contains("repository_root_outside_workspace"));
    }
}

#[test]
fn resolves_traces_and_reverses_go_impact_only_with_exact_module_evidence() {
    let fleet = tempdir().unwrap();
    create_go_repository(fleet.path(), "client", "example.com/client", "client");
    create_go_repository(fleet.path(), "service", "example.com/demo", "service");
    create_go_repository(fleet.path(), "decoy", "example.com/wrong", "decoy");
    let mut registry =
        RepositoryRegistry::open(fleet.path(), WORKSPACE_ID, ENGINE_VERSION).unwrap();
    let client = registry.register("Client", "workspace://client").unwrap();
    let service = registry.register("Service", "workspace://service").unwrap();
    let decoy = registry.register("Decoy", "workspace://decoy").unwrap();
    drop(registry);

    let registry_path = fleet.path().join(REPOSITORY_REGISTRY_RELATIVE_PATH);
    let client_path = fleet
        .path()
        .join("client")
        .join(REPOSITORY_INDEX_RELATIVE_PATH);
    let service_path = fleet
        .path()
        .join("service")
        .join(REPOSITORY_INDEX_RELATIVE_PATH);
    let decoy_path = fleet
        .path()
        .join("decoy")
        .join(REPOSITORY_INDEX_RELATIVE_PATH);
    let before = [
        snapshot(&registry_path),
        snapshot(&client_path),
        snapshot(&service_path),
        snapshot(&decoy_path),
    ];

    let registry =
        RepositoryRegistry::open_read_only(fleet.path(), WORKSPACE_ID, ENGINE_VERSION).unwrap();
    let ids = vec![client.repository_id.clone(), service.repository_id.clone()];
    let query = GoRepositoryQuery {
        repository_ids: &ids,
        client_repository_id: &client.repository_id,
        service_repository_id: &service.repository_id,
        client_entry_native_id: CLIENT_ENTRY_ID,
        service_target_native_id: SERVICE_TARGET_ID,
        deadline_ms: 2_000,
    };
    let resolved = registry.resolve_go(&query).unwrap();
    assert_eq!(resolved.opened_repository_count, 2);
    assert_eq!(resolved.go_modules[1].module_coordinate, "example.com/demo");
    assert_eq!(
        resolved
            .go_relationships
            .iter()
            .map(|relationship| relationship.kind.as_str())
            .collect::<Vec<_>>(),
        vec!["imports", "constructs"]
    );
    assert_eq!(
        resolved.go_relationships[1].evidence_native_relationship_ids,
        vec![
            "ciedge_11111111111111111111111111111111",
            "ciedge_22222222222222222222222222222222"
        ]
    );
    assert!(resolved.paths.is_empty());
    assert!(resolved.impacted_nodes.is_empty());

    let traced = registry.trace_go(&query, 25).unwrap();
    assert_eq!(traced.paths.len(), 1);
    assert_eq!(traced.paths[0].node_ids.len(), 2);
    assert!(traced.impacted_nodes.is_empty());

    let impacted = registry.impact_go(&query, 25).unwrap();
    assert_eq!(impacted.paths, traced.paths);
    assert_eq!(impacted.impacted_nodes.len(), 1);
    assert_eq!(impacted.impacted_nodes[0].native_id, CLIENT_ENTRY_ID);

    let decoy_ids = vec![client.repository_id.clone(), decoy.repository_id.clone()];
    let decoy_query = GoRepositoryQuery {
        repository_ids: &decoy_ids,
        client_repository_id: &client.repository_id,
        service_repository_id: &decoy.repository_id,
        client_entry_native_id: CLIENT_ENTRY_ID,
        service_target_native_id: DECOY_TARGET_ID,
        deadline_ms: 2_000,
    };
    let decoy_error = registry.resolve_go(&decoy_query).unwrap_err();
    assert!(format!("{decoy_error:#}").contains("repository_go_module_mismatch"));
    assert!(registry.trace_go(&query, 26).is_err());

    let after = [
        snapshot(&registry_path),
        snapshot(&client_path),
        snapshot(&service_path),
        snapshot(&decoy_path),
    ];
    assert_eq!(after, before);
    let serialized = serde_json::to_string(&impacted).unwrap();
    assert!(!serialized.contains(fleet.path().to_string_lossy().as_ref()));
}
