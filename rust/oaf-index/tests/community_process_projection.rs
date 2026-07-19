use oaf_index::{
    EdgeRecord, FileRecord, GenerationInput, NodeRecord, QueryBounds, SourceIndex,
    SourceIndexOptions, COMMUNITY_ALGORITHM_VERSION, PROCESS_ALGORITHM_VERSION,
};
use std::collections::BTreeSet;
use tempfile::tempdir;

fn options() -> SourceIndexOptions {
    SourceIndexOptions::new(
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "2.0.0",
    )
}

fn node(id: &str, name: &str, kind: &str, locator: &str) -> NodeRecord {
    NodeRecord {
        canonical_id: id.into(),
        kind: kind.into(),
        language_kind: kind.into(),
        qualified_name: format!("{locator}::{name}"),
        locator: locator.into(),
        start_line: 1,
        end_line: 2,
        content_hash: None,
        visibility: "internal".into(),
    }
}

fn edge(
    id: &str,
    source: &str,
    target: &str,
    kind: &str,
    confidence: f64,
    stale: bool,
) -> EdgeRecord {
    EdgeRecord {
        canonical_id: id.into(),
        source_id: source.into(),
        target_id: target.into(),
        kind: kind.into(),
        locator: "workspace://apps/cli/api.ts".into(),
        start_line: 1,
        end_line: 1,
        resolver: "memory-recall.test".into(),
        resolver_version: "1.0.0".into(),
        confidence,
        resolution_class: "resolved".into(),
        stale,
    }
}

fn generation() -> GenerationInput {
    let api = "workspace://apps/cli/api.ts";
    let worker = "workspace://apps/cli/worker.ts";
    GenerationInput {
        reason: "projection_test".into(),
        created_at: "2026-07-16T00:00:00.000Z".into(),
        structural_fingerprint:
            "sha256:1111111111111111111111111111111111111111111111111111111111111111".into(),
        ignore_fingerprint: None,
        files: vec![
            FileRecord {
                locator: api.into(),
                content_hash:
                    "sha256:2222222222222222222222222222222222222222222222222222222222222222".into(),
                byte_size: 128,
                language: "typescript".into(),
                parse_state: "parsed".into(),
                diagnostic_count: 0,
                owner_identity: "file_api".into(),
            },
            FileRecord {
                locator: worker.into(),
                content_hash:
                    "sha256:3333333333333333333333333333333333333333333333333333333333333333".into(),
                byte_size: 128,
                language: "typescript".into(),
                parse_state: "parsed".into(),
                diagnostic_count: 0,
                owner_identity: "file_worker".into(),
            },
        ],
        nodes: vec![
            node("node_a", "route", "route", api),
            node("node_b", "handler", "function", api),
            node("node_c", "service", "function", api),
            node("node_d", "database", "storage", api),
            node("node_e", "worker", "function", worker),
            node("node_f", "queue", "queue", worker),
        ],
        edges: vec![
            edge(
                "edge_01_entry",
                "node_b",
                "node_a",
                "handles_route",
                1.0,
                false,
            ),
            edge("edge_02_call", "node_b", "node_c", "calls", 0.9, false),
            edge("edge_03_write", "node_c", "node_d", "writes", 0.8, false),
            edge("edge_04_cycle", "node_c", "node_b", "calls", 0.95, false),
            edge("edge_05_low", "node_b", "node_d", "calls", 0.5, false),
            edge("edge_06_stale", "node_b", "node_d", "calls", 0.99, true),
            edge("edge_07_worker", "node_e", "node_f", "emits", 0.95, false),
        ],
        unresolved: Vec::new(),
        coverage: Vec::new(),
        diagnostics: Vec::new(),
    }
}

fn ready_index() -> (tempfile::TempDir, SourceIndex) {
    let root = tempdir().unwrap();
    let path = root.path().join("index.sqlite");
    let mut writer = SourceIndex::open(&path, &options()).unwrap();
    writer.commit_generation(&generation()).unwrap();
    drop(writer);
    let reader = SourceIndex::open_read_only(&path, &options()).unwrap();
    (root, reader)
}

#[test]
fn communities_are_topology_formed_path_labeled_and_deterministic() {
    let (_root, index) = ready_index();
    let bounds = QueryBounds::new(2);
    let first = index.communities(&bounds).unwrap();
    let second = index.communities(&bounds).unwrap();

    assert_eq!(first, second);
    assert_eq!(first.items.len(), 2);
    assert!(first
        .items
        .iter()
        .all(|item| item.algorithm_version == COMMUNITY_ALGORITHM_VERSION));
    assert!(first
        .items
        .iter()
        .all(|item| item.path_prefix == "workspace://apps/cli"));
    assert_ne!(first.items[0].id, first.items[1].id);
    assert_eq!(first.items[0].node_ids[0], "node_b");
    assert_eq!(
        first
            .nodes
            .iter()
            .map(|node| node.canonical_id.as_str())
            .collect::<BTreeSet<_>>(),
        first
            .items
            .iter()
            .flat_map(|item| item.node_ids.iter().map(String::as_str))
            .collect::<BTreeSet<_>>()
    );
    let edge_ids = first
        .edges
        .iter()
        .map(|edge| edge.canonical_id.as_str())
        .collect::<BTreeSet<_>>();
    assert!(first.items.iter().all(|item| item
        .relationship_ids
        .iter()
        .all(|id| edge_ids.contains(id.as_str()))));
}

#[test]
fn processes_follow_only_resolved_high_confidence_entry_paths() {
    let (_root, index) = ready_index();
    let projection = index
        .processes(&QueryBounds::new(10).with_depth(4))
        .unwrap();

    assert_eq!(projection.items.len(), 1);
    let process = &projection.items[0];
    assert_eq!(process.algorithm_version, PROCESS_ALGORITHM_VERSION);
    assert_eq!(process.entry_node_id, "node_b");
    assert_eq!(process.entry_relationship_id, "edge_01_entry");
    assert_eq!(process.sink_node_id, "node_d");
    assert_eq!(process.sink_kind, "writes");
    assert_eq!(process.node_ids, vec!["node_b", "node_c", "node_d"]);
    assert_eq!(
        process.relationship_ids,
        vec!["edge_01_entry", "edge_02_call", "edge_03_write"]
    );
    assert_eq!(process.confidence, 0.8);
    assert!(!process.truncated);
    assert!(projection
        .nodes
        .iter()
        .any(|node| node.canonical_id == "node_a"));
    assert!(!process.relationship_ids.contains(&"edge_05_low".into()));
    assert!(!process.relationship_ids.contains(&"edge_06_stale".into()));
}

#[test]
fn process_plain_function_dead_end_is_not_proven_complete() {
    let root = tempdir().unwrap();
    let path = root.path().join("index.sqlite");
    let mut input = generation();
    input
        .edges
        .retain(|edge| matches!(edge.canonical_id.as_str(), "edge_01_entry" | "edge_02_call"));
    let mut writer = SourceIndex::open(&path, &options()).unwrap();
    writer.commit_generation(&input).unwrap();
    drop(writer);
    let index = SourceIndex::open_read_only(&path, &options()).unwrap();

    let projection = index
        .processes(&QueryBounds::new(10).with_depth(4))
        .unwrap();

    assert_eq!(projection.items.len(), 1);
    let process = &projection.items[0];
    assert_eq!(process.sink_node_id, "node_c");
    assert_eq!(process.sink_kind, "function");
    assert!(process.truncated);
}

#[test]
fn process_depth_is_strict_and_reports_truncation_without_cycles() {
    let (_root, index) = ready_index();
    let projection = index
        .processes(&QueryBounds::new(10).with_depth(2))
        .unwrap();
    let process = &projection.items[0];
    assert!(process.truncated);
    assert_eq!(process.relationship_ids.len(), 2);
    assert_eq!(process.node_ids.len(), 2);
    assert_eq!(
        process.node_ids.iter().collect::<BTreeSet<_>>().len(),
        process.node_ids.len()
    );
}

#[test]
fn projection_cursors_page_continuously_and_reject_invalid_mismatched_or_stale_values() {
    let root = tempdir().unwrap();
    let path = root.path().join("index.sqlite");
    let mut input = generation();
    for index in 0..3 {
        let entry = format!("node_page_entry_{index}");
        let route = format!("node_page_route_{index}");
        let sink = format!("node_page_sink_{index}");
        input.nodes.extend([
            node(&entry, &entry, "function", "workspace://apps/cli/api.ts"),
            node(&route, &route, "route", "workspace://apps/cli/api.ts"),
            node(&sink, &sink, "storage", "workspace://apps/cli/api.ts"),
        ]);
        input.edges.extend([
            edge(
                &format!("edge_page_handles_{index}"),
                &entry,
                &route,
                "handles_route",
                1.0,
                false,
            ),
            edge(
                &format!("edge_page_writes_{index}"),
                &entry,
                &sink,
                "writes",
                0.9,
                false,
            ),
        ]);
    }
    let mut writer = SourceIndex::open(&path, &options()).unwrap();
    writer.commit_generation(&input).unwrap();
    drop(writer);
    let index = SourceIndex::open_read_only(&path, &options()).unwrap();

    let communities_one = index.communities(&QueryBounds::new(1)).unwrap();
    let communities_cursor = communities_one.next_cursor.clone().unwrap();
    let communities_two = index
        .communities(&QueryBounds::new(1).with_cursor(&communities_cursor))
        .unwrap();
    assert_ne!(communities_one.items[0].id, communities_two.items[0].id);

    let processes_one = index.processes(&QueryBounds::new(1).with_depth(4)).unwrap();
    let processes_cursor = processes_one.next_cursor.clone().unwrap();
    let processes_two = index
        .processes(
            &QueryBounds::new(1)
                .with_depth(4)
                .with_cursor(&processes_cursor),
        )
        .unwrap();
    assert_ne!(processes_one.items[0].id, processes_two.items[0].id);

    let malformed = QueryBounds::new(1).with_cursor("cinode_not_hex");
    assert!(index.communities(&malformed).is_err());
    assert!(index.processes(&malformed.with_depth(4)).is_err());
    assert!(index
        .processes(
            &QueryBounds::new(1)
                .with_depth(4)
                .with_cursor(&communities_cursor)
        )
        .is_err());
    assert!(index
        .communities(&QueryBounds::new(1).with_cursor(&processes_cursor))
        .is_err());
    drop(index);

    let mut writer = SourceIndex::open(&path, &options()).unwrap();
    let mut replacement = input;
    replacement.created_at = "2026-07-17T00:00:00.000Z".into();
    replacement.structural_fingerprint =
        "sha256:9999999999999999999999999999999999999999999999999999999999999999".into();
    writer.commit_generation(&replacement).unwrap();
    drop(writer);
    let index = SourceIndex::open_read_only(&path, &options()).unwrap();
    assert!(index
        .communities(&QueryBounds::new(1).with_cursor(communities_cursor))
        .is_err());
    assert!(index
        .processes(
            &QueryBounds::new(1)
                .with_depth(4)
                .with_cursor(processes_cursor)
        )
        .is_err());
}
