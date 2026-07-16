use oaf_index::{
    normalized_generation_fingerprint, BoundedWatchQueue, FileRecord, GenerationInput, NodeRecord,
    RefreshCoordinator, SourceIndex, SourceIndexOptions, WatchEvent, WatchEventKind,
    WatchQueueConfig, WatcherRunState,
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Barrier,
};
use tempfile::tempdir;

const REPOSITORY_ID: &str =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_BEFORE: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_AFTER: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

fn generation(content_hash: &str, created_at: &str) -> GenerationInput {
    let locator = "workspace://src/app.ts";
    let mut input = GenerationInput {
        reason: "watch_refresh".into(),
        created_at: created_at.into(),
        structural_fingerprint: REPOSITORY_ID.into(),
        ignore_fingerprint: None,
        files: vec![FileRecord {
            locator: locator.into(),
            content_hash: content_hash.into(),
            byte_size: 32,
            language: "typescript".into(),
            parse_state: "parsed".into(),
            diagnostic_count: 0,
            owner_identity: "node_app".into(),
        }],
        nodes: vec![NodeRecord {
            canonical_id: "node_app".into(),
            kind: "function".into(),
            language_kind: "function_declaration".into(),
            qualified_name: "src/app.ts::app".into(),
            locator: format!("{locator}#L1-L1"),
            start_line: 1,
            end_line: 1,
            content_hash: Some(content_hash.into()),
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

#[test]
fn debounce_coalesces_editor_sequences_and_rename_pairs() {
    let mut queue = BoundedWatchQueue::new(WatchQueueConfig {
        capacity: 16,
        debounce_ms: 50,
    })
    .unwrap();
    queue.start(0).unwrap();
    queue
        .push(WatchEvent::path(
            WatchEventKind::Upsert,
            "workspace://src/app.ts",
            1,
        ))
        .unwrap();
    queue
        .push(WatchEvent::path(
            WatchEventKind::Upsert,
            "workspace://src/.app.ts.tmp",
            5,
        ))
        .unwrap();
    queue
        .push(WatchEvent::path(
            WatchEventKind::Remove,
            "workspace://src/.app.ts.tmp",
            8,
        ))
        .unwrap();
    queue
        .push(WatchEvent::rename(
            "workspace://src/old.ts",
            "workspace://src/new.ts",
            10,
        ))
        .unwrap();
    assert!(queue.drain_ready(59).unwrap().is_none());
    let batch = queue.drain_ready(60).unwrap().unwrap();
    assert_eq!(
        batch.paths,
        [
            "workspace://src/.app.ts.tmp",
            "workspace://src/app.ts",
            "workspace://src/new.ts",
            "workspace://src/old.ts",
        ]
    );
    assert!(!batch.full_discovery);
    assert_eq!(queue.status().queued_path_count, 0);
}

#[test]
fn ten_thousand_event_storm_stays_bounded_and_falls_back_to_discovery() {
    let mut queue = BoundedWatchQueue::new(WatchQueueConfig {
        capacity: 32,
        debounce_ms: 25,
    })
    .unwrap();
    queue.start(0).unwrap();
    for index in 0..10_000 {
        queue
            .push(WatchEvent::path(
                WatchEventKind::Upsert,
                format!("workspace://src/file-{index}.ts"),
                index as u64,
            ))
            .unwrap();
    }
    let status = queue.status();
    assert_eq!(status.run_state, WatcherRunState::Degraded);
    assert!(status.queued_path_count <= 32);
    assert!(status.overflow_count > 0);
    assert_eq!(
        status.last_reason_code.as_deref(),
        Some("source_index_watch_overflow")
    );
    let batch = queue.force_drain(10_001).unwrap().unwrap();
    assert!(batch.full_discovery);
    assert!(batch.paths.len() <= 32);
    queue.record_convergence(73, true);
    assert_eq!(queue.status().last_convergence_ms, Some(73));
}

#[test]
fn directory_replacement_and_shutdown_request_full_safe_convergence() {
    let mut queue = BoundedWatchQueue::new(WatchQueueConfig::default()).unwrap();
    queue.start(0).unwrap();
    queue
        .push(WatchEvent::path(
            WatchEventKind::DirectoryReplace,
            "workspace://src",
            1,
        ))
        .unwrap();
    let final_batch = queue.stop(2).unwrap().unwrap();
    assert!(final_batch.full_discovery);
    assert_eq!(queue.status().run_state, WatcherRunState::Stopped);
    assert!(queue
        .push(WatchEvent::path(
            WatchEventKind::Upsert,
            "workspace://src/late.ts",
            3,
        ))
        .is_err());
}

#[test]
fn status_is_bounded_read_only_metadata_without_repository_paths() {
    let mut queue = BoundedWatchQueue::new(WatchQueueConfig::default()).unwrap();
    queue.start(0).unwrap();
    queue
        .push(WatchEvent::path(
            WatchEventKind::Upsert,
            "workspace://private/source.ts",
            1,
        ))
        .unwrap();
    let status = serde_json::to_value(queue.status()).unwrap();
    assert_eq!(status["run_state"], "running");
    assert_eq!(status["queued_path_count"], 1);
    assert!(!serde_json::to_string(&status)
        .unwrap()
        .contains("private/source.ts"));
}

#[test]
fn coordinator_allows_one_writer_and_cancellation_recovers_without_stale_lease() {
    let coordinator = RefreshCoordinator::new();
    let first = coordinator.try_begin(1).unwrap();
    assert!(coordinator.try_begin(2).is_none());
    drop(first);
    let second = coordinator.try_begin(3).unwrap();
    second.finish(40, true);
    assert_eq!(coordinator.status().last_convergence_ms, Some(40));
    coordinator.cancel();
    assert!(coordinator.try_begin(4).is_none());
    assert!(coordinator.is_cancelled());
    assert!(coordinator.status().cancelled);
}

#[test]
fn concurrent_refresh_requests_admit_one_writer_and_dropped_worker_releases_it() {
    let coordinator = RefreshCoordinator::new();
    let start = Arc::new(Barrier::new(33));
    let release = Arc::new(Barrier::new(33));
    let admitted = Arc::new(AtomicUsize::new(0));
    let threads = (1..=32)
        .map(|sequence| {
            let coordinator = coordinator.clone();
            let start = Arc::clone(&start);
            let release = Arc::clone(&release);
            let admitted = Arc::clone(&admitted);
            std::thread::spawn(move || {
                start.wait();
                let lease = coordinator.try_begin(sequence);
                if lease.is_some() {
                    admitted.fetch_add(1, Ordering::SeqCst);
                }
                release.wait();
                drop(lease);
            })
        })
        .collect::<Vec<_>>();
    start.wait();
    release.wait();
    for thread in threads {
        thread.join().unwrap();
    }
    assert_eq!(admitted.load(Ordering::SeqCst), 1);
    assert_eq!(coordinator.status().active_sequence, None);
    assert_eq!(coordinator.status().last_success, Some(false));
    assert!(coordinator.try_begin(100).is_some());
}

#[test]
fn overflow_storm_converges_to_clean_rebuild_without_hiding_the_previous_generation() {
    let root = tempdir().unwrap();
    let index_path = root.path().join("index.sqlite");
    let options = SourceIndexOptions::new(REPOSITORY_ID, "1.1.1");
    let mut writer = SourceIndex::open(&index_path, &options).unwrap();
    let before = generation(HASH_BEFORE, "2026-07-16T00:00:00.000Z");
    let clean_after = generation(HASH_AFTER, "2026-07-16T00:01:00.000Z");
    let first = writer.commit_generation(&before).unwrap();

    let mut queue = BoundedWatchQueue::new(WatchQueueConfig {
        capacity: 8,
        debounce_ms: 25,
    })
    .unwrap();
    queue.start(0).unwrap();
    for index in 0..10_000 {
        queue
            .push(WatchEvent::path(
                WatchEventKind::Upsert,
                format!("workspace://src/storm-{index}.ts"),
                index as u64,
            ))
            .unwrap();
    }
    let batch = queue.drain_ready(10_023).unwrap();
    assert!(batch.is_none());
    let batch = queue.drain_ready(10_024).unwrap().unwrap();
    assert!(batch.full_discovery);
    assert!(batch.paths.len() <= 8);
    assert_eq!(batch.drained_at_ms - 9_999, 25);

    let reader = SourceIndex::open_read_only(&index_path, &options).unwrap();
    assert_eq!(reader.active_generation(), Some(first.id));
    assert_eq!(
        reader
            .load_active_generation()
            .unwrap()
            .unwrap()
            .input
            .structural_fingerprint,
        before.structural_fingerprint
    );

    let coordinator = RefreshCoordinator::new();
    let lease = coordinator.try_begin(batch.sequence).unwrap();
    writer.commit_generation(&clean_after).unwrap();
    lease.finish(19, true);
    queue.record_convergence(19, true);

    assert_eq!(queue.status().queued_path_count, 0);
    assert_eq!(queue.status().run_state, WatcherRunState::Running);
    assert_eq!(coordinator.status().last_success, Some(true));
    let active = writer.load_active_generation().unwrap().unwrap().input;
    assert_eq!(
        normalized_generation_fingerprint(&active).unwrap(),
        normalized_generation_fingerprint(&clean_after).unwrap()
    );
}
