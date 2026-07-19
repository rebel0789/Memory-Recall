use oaf_index::{
    normalized_generation_fingerprint, CoverageRecord, DiscoveredFile, EdgeRecord, FileRecord,
    GenerationInput, NodeRecord, RefreshBounds, SourceIndex, SourceIndexOptions, UnresolvedRecord,
};
use std::collections::BTreeSet;
use std::fs;
use tempfile::tempdir;

const HASH_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const HASH_D: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const HASH_E: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

fn options() -> SourceIndexOptions {
    SourceIndexOptions::new(HASH_A, "2.0.0")
}

fn file(locator: &str, hash: &str, language: &str, owner: &str) -> FileRecord {
    FileRecord {
        locator: locator.into(),
        content_hash: hash.into(),
        byte_size: 100,
        language: language.into(),
        parse_state: "parsed".into(),
        diagnostic_count: 0,
        owner_identity: owner.into(),
    }
}

fn node(id: &str, locator: &str, language: &str) -> NodeRecord {
    NodeRecord {
        canonical_id: id.into(),
        kind: "function".into(),
        language_kind: "function".into(),
        qualified_name: format!("{}::{id}", locator.trim_start_matches("workspace://")),
        locator: format!("{locator}#L1-L3"),
        start_line: 1,
        end_line: 3,
        content_hash: None,
        visibility: format!("internal_{language}"),
    }
}

fn edge(id: &str, source: &str, target: &str, kind: &str, locator: &str) -> EdgeRecord {
    EdgeRecord {
        canonical_id: id.into(),
        source_id: source.into(),
        target_id: target.into(),
        kind: kind.into(),
        locator: format!("{locator}#L2-L2"),
        start_line: 2,
        end_line: 2,
        resolver: "memory-recall.incremental".into(),
        resolver_version: "0.1.0".into(),
        confidence: 1.0,
        resolution_class: if kind == "calls" { "typed" } else { "exact" }.into(),
        stale: false,
    }
}

fn base_generation() -> GenerationInput {
    GenerationInput {
        reason: "clean_build".into(),
        created_at: "2026-07-16T00:00:00.000Z".into(),
        structural_fingerprint: HASH_A.into(),
        ignore_fingerprint: Some(HASH_B.into()),
        files: vec![
            file("workspace://a.ts", HASH_A, "typescript", "node_a"),
            file("workspace://b.py", HASH_B, "python", "node_b"),
            file("workspace://c.go", HASH_C, "go", "node_c"),
            file("workspace://unrelated.rb", HASH_D, "ruby", "node_u"),
        ],
        nodes: vec![
            node("node_a", "workspace://a.ts", "typescript"),
            node("node_b", "workspace://b.py", "python"),
            node("node_c", "workspace://c.go", "go"),
            node("node_u", "workspace://unrelated.rb", "ruby"),
        ],
        edges: vec![
            edge(
                "edge_b_a",
                "node_b",
                "node_a",
                "imports",
                "workspace://b.py",
            ),
            edge("edge_c_b", "node_c", "node_b", "calls", "workspace://c.go"),
        ],
        unresolved: Vec::new(),
        coverage: ["typescript", "python", "go", "ruby"]
            .into_iter()
            .map(|language| CoverageRecord {
                language: language.into(),
                capability: "files".into(),
                represented_count: 1,
                omitted_count: 0,
                failed_count: 0,
                reason_code: None,
            })
            .collect(),
        diagnostics: Vec::new(),
    }
}

fn discovery(generation: &GenerationInput) -> Vec<DiscoveredFile> {
    generation
        .files
        .iter()
        .map(|file| DiscoveredFile {
            locator: file.locator.clone(),
            content_hash: file.content_hash.clone(),
            byte_size: file.byte_size,
        })
        .collect()
}

fn subset(generation: &GenerationInput, locators: &[&str]) -> GenerationInput {
    let selected = locators.iter().copied().collect::<BTreeSet<_>>();
    let node_ids = generation
        .nodes
        .iter()
        .filter(|node| selected.contains(node.locator.split('#').next().unwrap()))
        .map(|node| node.canonical_id.clone())
        .collect::<BTreeSet<_>>();
    GenerationInput {
        reason: "incremental_refresh".into(),
        created_at: "2026-07-16T00:01:00.000Z".into(),
        structural_fingerprint: HASH_E.into(),
        ignore_fingerprint: generation.ignore_fingerprint.clone(),
        files: generation
            .files
            .iter()
            .filter(|file| selected.contains(file.locator.as_str()))
            .cloned()
            .collect(),
        nodes: generation
            .nodes
            .iter()
            .filter(|node| node_ids.contains(&node.canonical_id))
            .cloned()
            .collect(),
        edges: generation
            .edges
            .iter()
            .filter(|edge| node_ids.contains(&edge.source_id))
            .cloned()
            .collect(),
        unresolved: generation
            .unresolved
            .iter()
            .filter(|item| node_ids.contains(&item.source_id))
            .cloned()
            .collect(),
        coverage: generation.coverage.clone(),
        diagnostics: Vec::new(),
    }
}

#[test]
fn plans_hash_changes_renames_deletes_and_ignore_rule_drift() {
    let root = tempdir().unwrap();
    let path = root.path().join("index.sqlite");
    let mut index = SourceIndex::open(&path, &options()).unwrap();
    let base = base_generation();
    index.commit_generation(&base).unwrap();

    let no_change = index
        .plan_refresh(
            &discovery(&base),
            base.ignore_fingerprint.as_deref(),
            &RefreshBounds::default(),
        )
        .unwrap();
    assert!(no_change.no_change);
    assert!(no_change.invalidated_files.is_empty());

    let mut current = discovery(&base);
    current[0].content_hash = HASH_E.into();
    current[0].byte_size = 100;
    current.retain(|item| item.locator != "workspace://c.go");
    current.retain(|item| item.locator != "workspace://unrelated.rb");
    current.push(DiscoveredFile {
        locator: "workspace://renamed.rb".into(),
        content_hash: HASH_D.into(),
        byte_size: 100,
    });
    let plan = index
        .plan_refresh(&current, Some(HASH_C), &RefreshBounds::default())
        .unwrap();
    assert_eq!(plan.changed_files, ["workspace://a.ts"]);
    assert_eq!(plan.deleted_files, ["workspace://c.go"]);
    assert_eq!(plan.renamed_files.len(), 1);
    assert_eq!(
        plan.renamed_files[0].from_locator,
        "workspace://unrelated.rb"
    );
    assert_eq!(plan.renamed_files[0].to_locator, "workspace://renamed.rb");
    assert!(plan.ignore_rules_changed);
    assert_eq!(plan.invalidated_files.len(), current.len());
}

#[test]
fn invalidation_follows_mixed_language_importers_and_typed_callers() {
    let root = tempdir().unwrap();
    let path = root.path().join("index.sqlite");
    let mut index = SourceIndex::open(&path, &options()).unwrap();
    let base = base_generation();
    index.commit_generation(&base).unwrap();
    let mut current = discovery(&base);
    current[0].content_hash = HASH_E.into();

    let plan = index
        .plan_refresh(
            &current,
            base.ignore_fingerprint.as_deref(),
            &RefreshBounds::default(),
        )
        .unwrap();
    assert_eq!(
        plan.invalidated_files,
        ["workspace://a.ts", "workspace://b.py", "workspace://c.go"]
    );
    assert!(!plan
        .invalidated_files
        .contains(&"workspace://unrelated.rb".into()));
}

#[test]
fn incremental_commit_matches_a_clean_normalized_generation_and_noop_does_not_write() {
    let root = tempdir().unwrap();
    let path = root.path().join("index.sqlite");
    let mut index = SourceIndex::open(&path, &options()).unwrap();
    let base = base_generation();
    let first = index.commit_generation(&base).unwrap();

    let no_change = index
        .plan_refresh(
            &discovery(&base),
            base.ignore_fingerprint.as_deref(),
            &RefreshBounds::default(),
        )
        .unwrap();
    let noop = index.commit_incremental(&no_change, &base).unwrap();
    assert!(!noop.wrote);
    assert_eq!(noop.summary.id, first.id);

    let mut clean = base.clone();
    clean.reason = "incremental_refresh".into();
    clean.created_at = "2026-07-16T00:01:00.000Z".into();
    clean.files[0].content_hash = HASH_E.into();
    clean.unresolved.push(UnresolvedRecord {
        canonical_id: "unresolved_b_a".into(),
        source_id: "node_b".into(),
        relationship_kind: "imports".into(),
        target_text_hash: HASH_A.into(),
        locator: "workspace://b.py#L2-L2".into(),
        start_line: 2,
        end_line: 2,
        reason_code: "target_changed".into(),
        confidence_class: "unresolved".into(),
    });
    clean.structural_fingerprint = normalized_generation_fingerprint(&clean).unwrap();
    let mut current = discovery(&clean);
    current.sort_by(|left, right| left.locator.cmp(&right.locator));
    let plan = index
        .plan_refresh(
            &current,
            clean.ignore_fingerprint.as_deref(),
            &RefreshBounds::default(),
        )
        .unwrap();
    let replacement = subset(
        &clean,
        &["workspace://a.ts", "workspace://b.py", "workspace://c.go"],
    );
    let committed = index.commit_incremental(&plan, &replacement).unwrap();
    assert!(committed.wrote);
    let loaded = index.load_active_generation().unwrap().unwrap().input;
    assert_eq!(
        normalized_generation_fingerprint(&loaded).unwrap(),
        normalized_generation_fingerprint(&clean).unwrap()
    );
    assert_eq!(loaded.structural_fingerprint, clean.structural_fingerprint);
    assert!(loaded
        .files
        .iter()
        .any(|file| file.locator == "workspace://unrelated.rb"));
}

#[test]
fn directory_renames_are_deterministic_and_deleted_targets_invalidate_dependents() {
    let root = tempdir().unwrap();
    let path = root.path().join("index.sqlite");
    let mut index = SourceIndex::open(&path, &options()).unwrap();
    let base = base_generation();
    index.commit_generation(&base).unwrap();

    let mut renamed = discovery(&base);
    renamed
        .iter_mut()
        .find(|file| file.locator == "workspace://b.py")
        .unwrap()
        .locator = "workspace://moved/b.py".into();
    renamed
        .iter_mut()
        .find(|file| file.locator == "workspace://c.go")
        .unwrap()
        .locator = "workspace://moved/c.go".into();
    let rename_plan = index
        .plan_refresh(
            &renamed,
            base.ignore_fingerprint.as_deref(),
            &RefreshBounds::default(),
        )
        .unwrap();
    assert_eq!(rename_plan.renamed_files.len(), 2);
    assert_eq!(
        rename_plan
            .renamed_files
            .iter()
            .map(|item| item.from_locator.as_str())
            .collect::<Vec<_>>(),
        ["workspace://b.py", "workspace://c.go"]
    );

    let mut deleted_target = discovery(&base);
    deleted_target.retain(|file| file.locator != "workspace://a.ts");
    let delete_plan = index
        .plan_refresh(
            &deleted_target,
            base.ignore_fingerprint.as_deref(),
            &RefreshBounds::default(),
        )
        .unwrap();
    assert_eq!(delete_plan.deleted_files, ["workspace://a.ts"]);
    assert_eq!(
        delete_plan.invalidated_files,
        ["workspace://b.py", "workspace://c.go"]
    );
}

#[test]
fn malformed_changed_file_commits_partial_truth_without_stale_nodes() {
    let root = tempdir().unwrap();
    let path = root.path().join("index.sqlite");
    let mut index = SourceIndex::open(&path, &options()).unwrap();
    let base = base_generation();
    index.commit_generation(&base).unwrap();
    let mut current = discovery(&base);
    current[0].content_hash = HASH_E.into();
    let plan = index
        .plan_refresh(
            &current,
            base.ignore_fingerprint.as_deref(),
            &RefreshBounds::default(),
        )
        .unwrap();

    let mut replacement = subset(
        &base,
        &["workspace://a.ts", "workspace://b.py", "workspace://c.go"],
    );
    replacement.files[0].content_hash = HASH_E.into();
    replacement.files[0].parse_state = "failed".into();
    replacement.files[0].diagnostic_count = 1;
    replacement
        .nodes
        .retain(|node| node.canonical_id != "node_a");
    replacement
        .edges
        .retain(|edge| edge.source_id != "node_b" && edge.target_id != "node_a");
    replacement.unresolved.push(UnresolvedRecord {
        canonical_id: "unresolved_b_a".into(),
        source_id: "node_b".into(),
        relationship_kind: "imports".into(),
        target_text_hash: HASH_A.into(),
        locator: "workspace://b.py#L2-L2".into(),
        start_line: 2,
        end_line: 2,
        reason_code: "target_parse_failed".into(),
        confidence_class: "unresolved".into(),
    });
    index.commit_incremental(&plan, &replacement).unwrap();
    let loaded = index.load_active_generation().unwrap().unwrap().input;
    assert!(loaded
        .files
        .iter()
        .any(|file| file.locator == "workspace://a.ts" && file.parse_state == "failed"));
    assert!(!loaded
        .nodes
        .iter()
        .any(|node| node.canonical_id == "node_a"));
    assert!(!loaded.edges.iter().any(|edge| edge.target_id == "node_a"));
    assert!(loaded
        .unresolved
        .iter()
        .any(|item| item.reason_code == "target_parse_failed"));
}

#[test]
fn incomplete_incremental_replacement_is_rejected_before_any_write() {
    let root = tempdir().unwrap();
    let path = root.path().join("index.sqlite");
    let mut index = SourceIndex::open(&path, &options()).unwrap();
    let base = base_generation();
    let committed = index.commit_generation(&base).unwrap();
    let before = fs::read(&path).unwrap();
    let before_modified = fs::metadata(&path).unwrap().modified().unwrap();

    let mut current = discovery(&base);
    current[0].content_hash = HASH_E.into();
    let plan = index
        .plan_refresh(
            &current,
            base.ignore_fingerprint.as_deref(),
            &RefreshBounds::default(),
        )
        .unwrap();
    assert!(plan
        .invalidated_files
        .contains(&"workspace://a.ts".to_string()));
    let replacement = subset(&base, &["workspace://b.py", "workspace://c.go"]);

    let error = index.commit_incremental(&plan, &replacement).unwrap_err();
    assert!(error
        .to_string()
        .contains("source_index_refresh_replacement_incomplete"));
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(
        fs::metadata(&path).unwrap().modified().unwrap(),
        before_modified
    );
    assert_eq!(
        index.load_active_generation().unwrap().unwrap().summary.id,
        committed.id
    );
}
