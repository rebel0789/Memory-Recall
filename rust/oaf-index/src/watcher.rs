use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WatcherRunState {
    Stopped,
    Running,
    Degraded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchEventKind {
    Upsert,
    Remove,
    Rename,
    DirectoryReplace,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchEvent {
    pub kind: WatchEventKind,
    pub locator: String,
    pub destination: Option<String>,
    pub observed_at_ms: u64,
}

impl WatchEvent {
    pub fn path(kind: WatchEventKind, locator: impl Into<String>, observed_at_ms: u64) -> Self {
        Self {
            kind,
            locator: locator.into(),
            destination: None,
            observed_at_ms,
        }
    }

    pub fn rename(from: impl Into<String>, to: impl Into<String>, observed_at_ms: u64) -> Self {
        Self {
            kind: WatchEventKind::Rename,
            locator: from.into(),
            destination: Some(to.into()),
            observed_at_ms,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WatchQueueConfig {
    pub capacity: usize,
    pub debounce_ms: u64,
}

impl Default for WatchQueueConfig {
    fn default() -> Self {
        Self {
            capacity: 4_096,
            debounce_ms: 150,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefreshBatch {
    pub sequence: u64,
    pub paths: Vec<String>,
    pub full_discovery: bool,
    pub drained_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WatcherStatus {
    pub run_state: WatcherRunState,
    pub queued_path_count: usize,
    pub overflow_count: u64,
    pub last_convergence_ms: Option<u64>,
    pub last_reason_code: Option<String>,
    pub reason_codes: Vec<String>,
}

pub struct BoundedWatchQueue {
    config: WatchQueueConfig,
    run_state: WatcherRunState,
    queued_paths: BTreeSet<String>,
    full_discovery: bool,
    overflow_count: u64,
    last_event_ms: Option<u64>,
    last_convergence_ms: Option<u64>,
    sequence: u64,
    last_reason_code: Option<String>,
    reason_codes: BTreeSet<String>,
}

impl BoundedWatchQueue {
    pub fn new(config: WatchQueueConfig) -> Result<Self> {
        if !(1..=100_000).contains(&config.capacity) || !(1..=60_000).contains(&config.debounce_ms)
        {
            bail!("source_index_watch_config_invalid");
        }
        Ok(Self {
            config,
            run_state: WatcherRunState::Stopped,
            queued_paths: BTreeSet::new(),
            full_discovery: false,
            overflow_count: 0,
            last_event_ms: None,
            last_convergence_ms: None,
            sequence: 0,
            last_reason_code: None,
            reason_codes: BTreeSet::new(),
        })
    }

    pub fn start(&mut self, started_at_ms: u64) -> Result<()> {
        if self.run_state != WatcherRunState::Stopped {
            bail!("source_index_watch_already_running");
        }
        self.run_state = WatcherRunState::Running;
        self.last_event_ms = Some(started_at_ms);
        self.reason_codes.clear();
        Ok(())
    }

    pub fn push(&mut self, event: WatchEvent) -> Result<()> {
        if self.run_state == WatcherRunState::Stopped {
            bail!("source_index_watch_stopped");
        }
        validate_watch_locator(&event.locator)?;
        if event.kind == WatchEventKind::Rename {
            let destination = event
                .destination
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("source_index_watch_rename_invalid"))?;
            validate_watch_locator(destination)?;
            self.queue_path(destination);
        } else if event.destination.is_some() {
            bail!("source_index_watch_event_invalid");
        }
        self.queue_path(&event.locator);
        if event.kind == WatchEventKind::DirectoryReplace {
            self.full_discovery = true;
            self.run_state = WatcherRunState::Degraded;
            self.record_reason("source_index_watch_directory_replaced");
        }
        self.last_event_ms = Some(self.last_event_ms.map_or(event.observed_at_ms, |current| {
            current.max(event.observed_at_ms)
        }));
        Ok(())
    }

    pub fn drain_ready(&mut self, now_ms: u64) -> Result<Option<RefreshBatch>> {
        if self.run_state == WatcherRunState::Stopped {
            bail!("source_index_watch_stopped");
        }
        let Some(last_event_ms) = self.last_event_ms else {
            return Ok(None);
        };
        if now_ms.saturating_sub(last_event_ms) < self.config.debounce_ms {
            return Ok(None);
        }
        Ok(self.take_batch(now_ms))
    }

    pub fn force_drain(&mut self, now_ms: u64) -> Result<Option<RefreshBatch>> {
        if self.run_state == WatcherRunState::Stopped {
            bail!("source_index_watch_stopped");
        }
        Ok(self.take_batch(now_ms))
    }

    pub fn stop(&mut self, now_ms: u64) -> Result<Option<RefreshBatch>> {
        if self.run_state == WatcherRunState::Stopped {
            bail!("source_index_watch_stopped");
        }
        let batch = self.take_batch(now_ms);
        self.run_state = WatcherRunState::Stopped;
        Ok(batch)
    }

    pub fn record_convergence(&mut self, elapsed_ms: u64, success: bool) {
        self.last_convergence_ms = Some(elapsed_ms);
        if success {
            if self.run_state != WatcherRunState::Stopped {
                self.run_state = WatcherRunState::Running;
            }
            self.reason_codes.clear();
        } else {
            self.run_state = WatcherRunState::Degraded;
            self.record_reason("source_index_watch_refresh_failed");
        }
    }

    pub fn status(&self) -> WatcherStatus {
        WatcherStatus {
            run_state: self.run_state,
            queued_path_count: self.queued_paths.len(),
            overflow_count: self.overflow_count,
            last_convergence_ms: self.last_convergence_ms,
            last_reason_code: self.last_reason_code.clone(),
            reason_codes: self.reason_codes.iter().cloned().collect(),
        }
    }

    fn queue_path(&mut self, locator: &str) {
        if self.queued_paths.contains(locator) {
            return;
        }
        if self.queued_paths.len() >= self.config.capacity {
            self.full_discovery = true;
            self.overflow_count = self.overflow_count.saturating_add(1);
            self.run_state = WatcherRunState::Degraded;
            self.record_reason("source_index_watch_overflow");
            return;
        }
        self.queued_paths.insert(locator.to_string());
    }

    fn take_batch(&mut self, now_ms: u64) -> Option<RefreshBatch> {
        if self.queued_paths.is_empty() && !self.full_discovery {
            return None;
        }
        self.sequence = self.sequence.saturating_add(1);
        let paths = std::mem::take(&mut self.queued_paths).into_iter().collect();
        let full_discovery = std::mem::take(&mut self.full_discovery);
        self.last_event_ms = None;
        Some(RefreshBatch {
            sequence: self.sequence,
            paths,
            full_discovery,
            drained_at_ms: now_ms,
        })
    }

    fn record_reason(&mut self, reason_code: &str) {
        self.last_reason_code = Some(reason_code.to_string());
        self.reason_codes.insert(reason_code.to_string());
    }
}

fn validate_watch_locator(locator: &str) -> Result<()> {
    if !locator.starts_with("workspace://")
        || locator.len() > 4_096
        || locator.chars().any(char::is_control)
        || locator.contains('\\')
        || locator
            .trim_start_matches("workspace://")
            .split('/')
            .any(|part| part.is_empty() || part == "..")
    {
        bail!("source_index_watch_locator_invalid");
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoordinatorStatus {
    pub active_sequence: Option<u64>,
    pub cancelled: bool,
    pub last_convergence_ms: Option<u64>,
    pub last_success: Option<bool>,
}

#[derive(Default)]
struct CoordinatorState {
    active_sequence: Option<u64>,
    cancelled: bool,
    last_convergence_ms: Option<u64>,
    last_success: Option<bool>,
}

#[derive(Clone, Default)]
pub struct RefreshCoordinator {
    state: Arc<Mutex<CoordinatorState>>,
}

impl RefreshCoordinator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn try_begin(&self, sequence: u64) -> Option<WriterLease> {
        let mut state = lock_state(&self.state);
        if state.cancelled || state.active_sequence.is_some() {
            return None;
        }
        state.active_sequence = Some(sequence);
        Some(WriterLease {
            state: Arc::clone(&self.state),
            sequence,
            finished: false,
        })
    }

    pub fn cancel(&self) {
        lock_state(&self.state).cancelled = true;
    }

    pub fn is_cancelled(&self) -> bool {
        lock_state(&self.state).cancelled
    }

    pub fn status(&self) -> CoordinatorStatus {
        let state = lock_state(&self.state);
        CoordinatorStatus {
            active_sequence: state.active_sequence,
            cancelled: state.cancelled,
            last_convergence_ms: state.last_convergence_ms,
            last_success: state.last_success,
        }
    }
}

pub struct WriterLease {
    state: Arc<Mutex<CoordinatorState>>,
    sequence: u64,
    finished: bool,
}

impl WriterLease {
    pub fn finish(mut self, elapsed_ms: u64, success: bool) {
        let mut state = lock_state(&self.state);
        if state.active_sequence == Some(self.sequence) {
            state.active_sequence = None;
            state.last_convergence_ms = Some(elapsed_ms);
            state.last_success = Some(success);
        }
        self.finished = true;
    }
}

impl Drop for WriterLease {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        let mut state = lock_state(&self.state);
        if state.active_sequence == Some(self.sequence) {
            state.active_sequence = None;
            state.last_success = Some(false);
        }
    }
}

fn lock_state(state: &Arc<Mutex<CoordinatorState>>) -> std::sync::MutexGuard<'_, CoordinatorState> {
    state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
