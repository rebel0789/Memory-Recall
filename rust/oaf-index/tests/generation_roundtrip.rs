use oaf_index::{
    CoverageRecord, DiagnosticRecord, EdgeDirection, EdgeRecord, FileRecord, GenerationInput,
    NodeRecord, QueryBounds, SourceIndex, SourceIndexOptions, UnresolvedRecord,
};
use tempfile::tempdir;

fn options() -> SourceIndexOptions {
    SourceIndexOptions::new(
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "1.1.1",
    )
}

fn sample_generation(fingerprint: &str, suffix: &str) -> GenerationInput {
    let file = format!("workspace://src/{suffix}.ts");
    let caller = format!("node_{suffix}_caller");
    let callee = format!("node_{suffix}_callee");
    GenerationInput {
        reason: "test_build".into(),
        created_at: "2026-07-16T00:00:00.000Z".into(),
        structural_fingerprint: fingerprint.into(),
        ignore_fingerprint: None,
        files: vec![FileRecord {
            locator: file.clone(),
            content_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                .into(),
            byte_size: 128,
            language: "typescript".into(),
            parse_state: "parsed".into(),
            diagnostic_count: 1,
            owner_identity: format!("file_{suffix}"),
        }],
        nodes: vec![
            NodeRecord {
                canonical_id: caller.clone(),
                kind: "function".into(),
                language_kind: "function".into(),
                qualified_name: format!("src/{suffix}.ts::caller"),
                locator: file.clone(),
                start_line: 1,
                end_line: 3,
                content_hash: None,
                visibility: "internal".into(),
            },
            NodeRecord {
                canonical_id: callee.clone(),
                kind: "function".into(),
                language_kind: "function".into(),
                qualified_name: format!("src/{suffix}.ts::callee"),
                locator: file.clone(),
                start_line: 5,
                end_line: 7,
                content_hash: None,
                visibility: "public".into(),
            },
        ],
        edges: vec![EdgeRecord {
            canonical_id: format!("edge_{suffix}_call"),
            source_id: caller.clone(),
            target_id: callee.clone(),
            kind: "calls".into(),
            locator: file.clone(),
            start_line: 2,
            end_line: 2,
            resolver: "memory-recall.typed-call".into(),
            resolver_version: "0.1.0".into(),
            confidence: 0.95,
            resolution_class: "typed".into(),
            stale: false,
        }],
        unresolved: vec![UnresolvedRecord {
            canonical_id: format!("unresolved_{suffix}"),
            source_id: caller,
            relationship_kind: "calls".into(),
            target_text_hash:
                "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".into(),
            locator: file.clone(),
            start_line: 3,
            end_line: 3,
            reason_code: "target_not_found".into(),
            confidence_class: "unresolved".into(),
        }],
        coverage: vec![CoverageRecord {
            language: "typescript".into(),
            capability: "calls".into(),
            represented_count: 1,
            omitted_count: 0,
            failed_count: 0,
            reason_code: None,
        }],
        diagnostics: vec![DiagnosticRecord {
            canonical_id: format!("diagnostic_{suffix}"),
            severity: "warning".into(),
            code: "recovered_parse".into(),
            locator: file,
            start_line: 8,
            end_line: 8,
            message_hash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                .into(),
        }],
    }
}

#[test]
fn round_trips_every_normalized_record_class_without_source_bodies() {
    let root = tempdir().unwrap();
    let path = root.path().join("index.sqlite");
    let mut index = SourceIndex::open(&path, &options()).unwrap();
    let input = sample_generation(
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        "one",
    );

    let committed = index.commit_generation(&input).unwrap();
    assert_eq!(index.active_generation(), Some(committed.id));
    assert_eq!(committed.file_count, 1);
    assert_eq!(committed.node_count, 2);
    assert_eq!(committed.edge_count, 1);
    assert_eq!(committed.unresolved_count, 1);
    assert_eq!(committed.diagnostic_count, 1);

    drop(index);
    let index = SourceIndex::open_read_only(&path, &options()).unwrap();
    let loaded = index.load_active_generation().unwrap().unwrap();
    assert_eq!(loaded.input, input);
    assert_eq!(loaded.summary, committed);
}

#[test]
fn generation_activation_is_atomic_and_retains_only_one_previous_generation() {
    let root = tempdir().unwrap();
    let path = root.path().join("index.sqlite");
    let mut index = SourceIndex::open(&path, &options()).unwrap();
    let first = index
        .commit_generation(&sample_generation(
            "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            "one",
        ))
        .unwrap();

    let mut invalid = sample_generation(
        "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        "invalid",
    );
    invalid.edges[0].target_id = "missing_node".into();
    assert!(index.commit_generation(&invalid).is_err());
    assert_eq!(index.active_generation(), Some(first.id));
    assert_eq!(index.generation_summaries(10).unwrap().len(), 1);

    let second = index
        .commit_generation(&sample_generation(
            "sha256:3333333333333333333333333333333333333333333333333333333333333333",
            "two",
        ))
        .unwrap();
    let third = index
        .commit_generation(&sample_generation(
            "sha256:4444444444444444444444444444444444444444444444444444444444444444",
            "three",
        ))
        .unwrap();
    assert_eq!(index.active_generation(), Some(third.id));
    assert_eq!(
        index
            .generation_summaries(10)
            .unwrap()
            .iter()
            .map(|item| item.id)
            .collect::<Vec<_>>(),
        vec![third.id, second.id]
    );
}

#[test]
fn read_queries_are_stable_paginated_and_bounded() {
    let root = tempdir().unwrap();
    let path = root.path().join("index.sqlite");
    let mut writer = SourceIndex::open(&path, &options()).unwrap();
    writer
        .commit_generation(&sample_generation(
            "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            "one",
        ))
        .unwrap();
    drop(writer);
    let index = SourceIndex::open_read_only(&path, &options()).unwrap();

    let first = index
        .find_nodes("src/one.ts", &QueryBounds::new(1))
        .unwrap();
    assert_eq!(first.items.len(), 1);
    assert!(first.next_cursor.is_some());
    let second = index
        .find_nodes(
            "src/one.ts",
            &QueryBounds::new(1).with_cursor(first.next_cursor.unwrap()),
        )
        .unwrap();
    assert_eq!(second.items.len(), 1);
    assert_ne!(first.items[0].canonical_id, second.items[0].canonical_id);

    let exact = index
        .find_exact_nodes("caller", &QueryBounds::new(10))
        .unwrap();
    assert_eq!(exact.items.len(), 1);
    assert_eq!(exact.items[0].canonical_id, "node_one_caller");
    assert!(index
        .find_exact_nodes("one", &QueryBounds::new(10))
        .unwrap()
        .items
        .is_empty());

    let caller = "node_one_caller";
    let outgoing = index
        .dependency_edges(caller, EdgeDirection::Outgoing, &QueryBounds::new(10))
        .unwrap();
    assert_eq!(outgoing.items[0].target_id, "node_one_callee");
    let impact = index
        .impact_edges("node_one_callee", &QueryBounds::new(10))
        .unwrap();
    assert_eq!(impact.items[0].source_id, caller);
    let neighborhood = index
        .neighborhood(caller, &QueryBounds::new(10).with_depth(2))
        .unwrap();
    assert_eq!(neighborhood.nodes.len(), 2);
    assert_eq!(neighborhood.edges.len(), 1);
    let routes = index
        .trace_routes(
            caller,
            "node_one_callee",
            &QueryBounds::new(10).with_depth(2),
        )
        .unwrap();
    assert_eq!(routes.len(), 1);
    assert_eq!(routes[0].node_ids, vec![caller, "node_one_callee"]);

    assert!(index.find_nodes("src", &QueryBounds::new(101)).is_err());
    assert!(index
        .neighborhood(caller, &QueryBounds::new(10).with_depth(9))
        .is_err());
    assert!(index
        .find_nodes("src", &QueryBounds::new(10).with_cursor("bad\0cursor"))
        .is_err());
}

#[test]
fn dependency_neighborhood_keeps_relationship_endpoints_under_tight_bounds() {
    let root = tempdir().unwrap();
    let path = root.path().join("index.sqlite");
    let mut writer = SourceIndex::open(&path, &options()).unwrap();
    writer
        .commit_generation(&sample_generation(
            "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            "one",
        ))
        .unwrap();
    drop(writer);
    let index = SourceIndex::open_read_only(&path, &options()).unwrap();

    let bounded = index
        .dependency_neighborhood(
            "node_one_caller",
            EdgeDirection::Outgoing,
            &QueryBounds::new(1).with_depth(1),
        )
        .unwrap();
    assert_eq!(bounded.nodes.len(), 1);
    assert!(bounded.edges.is_empty());
    assert!(bounded.truncated);

    let complete = index
        .dependency_neighborhood(
            "node_one_caller",
            EdgeDirection::Outgoing,
            &QueryBounds::new(2).with_depth(1),
        )
        .unwrap();
    let node_ids = complete
        .nodes
        .iter()
        .map(|node| node.canonical_id.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    assert!(complete.edges.iter().all(|edge| {
        node_ids.contains(edge.source_id.as_str()) && node_ids.contains(edge.target_id.as_str())
    }));
}

#[test]
fn search_matches_all_natural_language_terms_and_keeps_pagination() {
    let root = tempdir().unwrap();
    let path = root.path().join("index.sqlite");
    let mut input = sample_generation(
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        "one",
    );
    for (canonical_id, qualified_name) in [
        ("node_auth_approve", "src/auth/token.ts::approveTokenReset"),
        (
            "node_auth_approve_handler",
            "src/auth/token.ts::approveTokenResetHandler",
        ),
    ] {
        input.nodes.push(NodeRecord {
            canonical_id: canonical_id.into(),
            kind: "function".into(),
            language_kind: "function".into(),
            qualified_name: qualified_name.into(),
            locator: "workspace://src/one.ts".into(),
            start_line: 1,
            end_line: 3,
            content_hash: None,
            visibility: "public".into(),
        });
    }
    let mut writer = SourceIndex::open(&path, &options()).unwrap();
    writer.commit_generation(&input).unwrap();
    drop(writer);
    let index = SourceIndex::open_read_only(&path, &options()).unwrap();

    let first = index
        .find_nodes("approve token reset", &QueryBounds::new(1))
        .unwrap();
    assert_eq!(first.items[0].canonical_id, "node_auth_approve");
    let second = index
        .find_nodes(
            "approve token reset",
            &QueryBounds::new(1).with_cursor(first.next_cursor.unwrap()),
        )
        .unwrap();
    assert_eq!(second.items[0].canonical_id, "node_auth_approve_handler");
    assert!(second.next_cursor.is_none());
}

#[test]
fn dependency_neighborhood_honors_direction_and_depth() {
    let root = tempdir().unwrap();
    let path = root.path().join("index.sqlite");
    let mut input = sample_generation(
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        "one",
    );
    input.nodes.push(NodeRecord {
        canonical_id: "node_one_terminal".into(),
        kind: "function".into(),
        language_kind: "function".into(),
        qualified_name: "src/one.ts::terminal".into(),
        locator: "workspace://src/one.ts".into(),
        start_line: 9,
        end_line: 10,
        content_hash: None,
        visibility: "internal".into(),
    });
    input.edges.push(EdgeRecord {
        canonical_id: "edge_one_terminal".into(),
        source_id: "node_one_callee".into(),
        target_id: "node_one_terminal".into(),
        kind: "calls".into(),
        locator: "workspace://src/one.ts".into(),
        start_line: 6,
        end_line: 6,
        resolver: "memory-recall.typed-call".into(),
        resolver_version: "0.1.0".into(),
        confidence: 0.95,
        resolution_class: "typed".into(),
        stale: false,
    });
    let mut writer = SourceIndex::open(&path, &options()).unwrap();
    writer.commit_generation(&input).unwrap();
    drop(writer);
    let index = SourceIndex::open_read_only(&path, &options()).unwrap();

    let depth_zero = index
        .dependency_neighborhood(
            "node_one_caller",
            EdgeDirection::Outgoing,
            &QueryBounds::new(10).with_depth(0),
        )
        .unwrap();
    assert_eq!(
        depth_zero
            .nodes
            .iter()
            .map(|node| node.canonical_id.as_str())
            .collect::<Vec<_>>(),
        ["node_one_caller"]
    );
    assert!(depth_zero.edges.is_empty());

    let depth_one = index
        .dependency_neighborhood(
            "node_one_caller",
            EdgeDirection::Outgoing,
            &QueryBounds::new(10).with_depth(1),
        )
        .unwrap();
    assert!(depth_one
        .nodes
        .iter()
        .any(|node| node.canonical_id == "node_one_callee"));
    assert!(!depth_one
        .nodes
        .iter()
        .any(|node| node.canonical_id == "node_one_terminal"));

    let outgoing = index
        .dependency_neighborhood(
            "node_one_caller",
            EdgeDirection::Outgoing,
            &QueryBounds::new(10).with_depth(2),
        )
        .unwrap();
    assert!(outgoing
        .nodes
        .iter()
        .any(|node| node.canonical_id == "node_one_terminal"));

    let incoming = index
        .dependency_neighborhood(
            "node_one_terminal",
            EdgeDirection::Incoming,
            &QueryBounds::new(10).with_depth(2),
        )
        .unwrap();
    assert!(incoming
        .nodes
        .iter()
        .any(|node| node.canonical_id == "node_one_caller"));
    assert_eq!(incoming.edges.len(), 2);
}
