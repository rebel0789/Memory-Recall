use oaf_index::{
    normalized_generation_fingerprint, repository_identity_hash, FileRecord, GenerationInput,
    NodeRecord, RepositoryRegistry, SourceIndex, SourceIndexOptions,
    REPOSITORY_INDEX_RELATIVE_PATH, REPOSITORY_REGISTRY_RELATIVE_PATH,
};
use std::fs;
use std::path::Path;
use std::time::SystemTime;
use tempfile::tempdir;

const WORKSPACE_ID: &str = "fleet-test";
const ENGINE_VERSION: &str = "1.1.1";
const SHARED_NODE_ID: &str = "cinode_11111111111111111111111111111111";

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
