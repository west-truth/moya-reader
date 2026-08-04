use super::cache_contract::{
    NativeTTSCacheReadinessRequest, NativeTTSCacheReadinessResult, NativeTTSRenderRequest,
    NativeTTSRenderResult, MAX_READINESS_HASHES,
};
use super::cache_identity::{
    normalize_synthesis_result, validate_readiness_request, validate_render_request,
};
use super::cache_record::{
    persist_cache_record, prepare_cache_access, read_cache_record, NativeTTSCacheRecord,
};
use super::command_contract::{DesktopTTSSynthesisRequest, DesktopTTSSynthesisResult};
use crate::native_identity::integrity_hash;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock, Weak};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Notify};

pub(super) struct NativeTTSCacheRuntime {
    operations: Mutex<OperationRegistry>,
    key_locks: Mutex<HashMap<String, Weak<Mutex<()>>>>,
    last_temporary_cleanup: Mutex<Option<Instant>>,
}

const MAX_PENDING_CANCELLATIONS: usize = 256;
const PENDING_CANCELLATION_TTL: Duration = Duration::from_secs(120);
const TEMPORARY_CLEANUP_INTERVAL: Duration = Duration::from_secs(60);

struct OperationRegistry {
    active: HashMap<String, Arc<OperationCancellation>>,
    pending: VecDeque<PendingCancellation>,
}

struct PendingCancellation {
    operation_id: String,
    created_at: Instant,
}

impl NativeTTSCacheRuntime {
    fn new() -> Self {
        Self {
            operations: Mutex::new(OperationRegistry {
                active: HashMap::new(),
                pending: VecDeque::new(),
            }),
            key_locks: Mutex::new(HashMap::new()),
            last_temporary_cleanup: Mutex::new(None),
        }
    }

    async fn register_operation(
        &self,
        operation_id: &str,
    ) -> Result<Arc<OperationCancellation>, String> {
        let mut operations = self.operations.lock().await;
        operations.prune_pending();
        if operations.active.contains_key(operation_id) {
            return Err("native TTS operation id is already active".to_string());
        }
        let operation = Arc::new(OperationCancellation::new());
        if let Some(index) = operations
            .pending
            .iter()
            .position(|pending| pending.operation_id == operation_id)
        {
            operations.pending.remove(index);
            operation.cancel();
        }
        operations
            .active
            .insert(operation_id.to_string(), operation.clone());
        Ok(operation)
    }

    async fn finish_operation(&self, operation_id: &str, operation: &Arc<OperationCancellation>) {
        let mut operations = self.operations.lock().await;
        if operations
            .active
            .get(operation_id)
            .is_some_and(|active| Arc::ptr_eq(active, operation))
        {
            operations.active.remove(operation_id);
        }
    }

    pub(super) async fn cancel(&self, operation_id: &str) -> bool {
        let operation = {
            let mut operations = self.operations.lock().await;
            operations.prune_pending();
            if let Some(operation) = operations.active.get(operation_id).cloned() {
                Some(operation)
            } else {
                if !operations
                    .pending
                    .iter()
                    .any(|pending| pending.operation_id == operation_id)
                {
                    while operations.pending.len() >= MAX_PENDING_CANCELLATIONS {
                        operations.pending.pop_front();
                    }
                    operations.pending.push_back(PendingCancellation {
                        operation_id: operation_id.to_string(),
                        created_at: Instant::now(),
                    });
                }
                return true;
            }
        };
        operation.is_some_and(|operation| operation.cancel())
    }

    async fn key_lock(&self, key: &str) -> Arc<Mutex<()>> {
        let mut locks = self.key_locks.lock().await;
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(key).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(key.to_string(), Arc::downgrade(&lock));
        lock
    }

    async fn prepare_cache_access(&self, cache_dir: &Path) -> Result<(), String> {
        let now = Instant::now();
        let mut last_cleanup = self.last_temporary_cleanup.lock().await;
        if last_cleanup
            .is_some_and(|last| now.saturating_duration_since(last) < TEMPORARY_CLEANUP_INTERVAL)
        {
            return Ok(());
        }
        prepare_cache_access(cache_dir)?;
        *last_cleanup = Some(now);
        Ok(())
    }
}

impl OperationRegistry {
    fn prune_pending(&mut self) {
        let now = Instant::now();
        self.pending.retain(|pending| {
            now.saturating_duration_since(pending.created_at) < PENDING_CANCELLATION_TTL
        });
    }
}

pub(super) fn shared_runtime() -> &'static NativeTTSCacheRuntime {
    static RUNTIME: OnceLock<NativeTTSCacheRuntime> = OnceLock::new();
    RUNTIME.get_or_init(NativeTTSCacheRuntime::new)
}

enum OperationPhase {
    Active,
    Cancelled,
    Committing,
    Completed,
}

struct OperationCancellation {
    cancelled: AtomicBool,
    notify: Notify,
    phase: StdMutex<OperationPhase>,
}

impl OperationCancellation {
    fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            notify: Notify::new(),
            phase: StdMutex::new(OperationPhase::Active),
        }
    }

    fn cancel(&self) -> bool {
        let mut phase = self
            .phase
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !matches!(*phase, OperationPhase::Active) {
            return false;
        }
        *phase = OperationPhase::Cancelled;
        self.cancelled.store(true, Ordering::Release);
        self.notify.notify_waiters();
        true
    }

    async fn cancelled(&self) {
        loop {
            if self.cancelled.load(Ordering::Acquire) {
                return;
            }
            let notified = self.notify.notified();
            if self.cancelled.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }

    fn commit<T>(&self, persist: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let mut phase = self
            .phase
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !matches!(*phase, OperationPhase::Active) {
            return Err("native TTS operation was cancelled".to_string());
        }
        *phase = OperationPhase::Committing;
        let result = persist();
        *phase = OperationPhase::Completed;
        result
    }

    fn complete_without_commit(&self) {
        let mut phase = self
            .phase
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if matches!(*phase, OperationPhase::Active) {
            *phase = OperationPhase::Completed;
        }
    }
}

pub(super) async fn render_cached_with<F, Fut>(
    runtime: &NativeTTSCacheRuntime,
    cache_dir: &Path,
    request: NativeTTSRenderRequest,
    synthesize: F,
) -> Result<NativeTTSRenderResult, String>
where
    F: FnOnce(DesktopTTSSynthesisRequest) -> Fut,
    Fut: Future<Output = Result<DesktopTTSSynthesisResult, String>>,
{
    let identity = validate_render_request(&request)?;
    let operation_id = request.operation_id.trim().to_string();
    let operation = runtime.register_operation(&operation_id).await?;
    let result = async {
        let key_lock = runtime.key_lock(&identity.cache_key).await;
        let _guard = race_cancellation(&operation, key_lock.lock()).await?;
        runtime.prepare_cache_access(cache_dir).await?;
        if let Some(record) = read_cache_record(cache_dir, &identity)? {
            operation.complete_without_commit();
            return Ok(render_result(&identity, record, true));
        }
        if request.cache_only {
            operation.complete_without_commit();
            return Err("native TTS cache miss in offline-only playback".to_string());
        }
        let synthesis = race_cancellation(&operation, synthesize(request.synthesis)).await??;
        let synthesis = normalize_synthesis_result(&identity, synthesis)?;
        let record = NativeTTSCacheRecord::from_result(&identity, &synthesis)?;
        operation.commit(|| persist_cache_record(cache_dir, &identity, &record))?;
        Ok(NativeTTSRenderResult {
            cache_key: identity.cache_key,
            render_spec_hash: identity.render_spec_hash,
            content_revision: identity.content_revision,
            cache_hit: false,
            synthesis,
        })
    }
    .await;
    runtime.finish_operation(&operation_id, &operation).await;
    result
}

async fn race_cancellation<F: Future>(
    operation: &OperationCancellation,
    future: F,
) -> Result<F::Output, String> {
    let mut cancelled = std::pin::pin!(operation.cancelled());
    let mut future = std::pin::pin!(future);
    std::future::poll_fn(|context| {
        if cancelled.as_mut().poll(context).is_ready() {
            return std::task::Poll::Ready(Err("native TTS operation was cancelled".to_string()));
        }
        future.as_mut().poll(context).map(Ok)
    })
    .await
}

fn render_result(
    identity: &super::cache_identity::ValidatedRenderIdentity,
    record: NativeTTSCacheRecord,
    cache_hit: bool,
) -> NativeTTSRenderResult {
    NativeTTSRenderResult {
        cache_key: identity.cache_key.clone(),
        render_spec_hash: identity.render_spec_hash.clone(),
        content_revision: identity.content_revision.clone(),
        cache_hit,
        synthesis: record.synthesis_result(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadinessEvidence<'a> {
    novel_id: &'a str,
    content_revision: &'a str,
    planned: usize,
    ready: usize,
    missing: usize,
    byte_size: u64,
    ready_render_spec_hashes: &'a [String],
    missing_render_spec_hashes: &'a [String],
    ok: bool,
}

pub(super) fn cache_readiness_at(
    cache_dir: &Path,
    request: NativeTTSCacheReadinessRequest,
) -> Result<NativeTTSCacheReadinessResult, String> {
    let identities = validate_readiness_request(&request)?;
    prepare_cache_access(cache_dir)?;
    let mut ready = Vec::new();
    let mut missing = Vec::new();
    let mut byte_size = 0_u64;
    for identity in &identities {
        match read_cache_record(cache_dir, identity)? {
            Some(record) => {
                byte_size = byte_size.saturating_add(record.byte_size() as u64);
                ready.push(identity.render_spec_hash.clone());
            }
            None => missing.push(identity.render_spec_hash.clone()),
        }
    }
    let planned = identities.len();
    let ready_count = ready.len();
    let missing_count = missing.len();
    let ok = planned > 0 && missing_count == 0;
    let evidence_hash = integrity_hash(&ReadinessEvidence {
        novel_id: request.novel_id.trim(),
        content_revision: request.content_revision.trim(),
        planned,
        ready: ready_count,
        missing: missing_count,
        byte_size,
        ready_render_spec_hashes: &ready,
        missing_render_spec_hashes: &missing,
        ok,
    })?;
    ready.truncate(MAX_READINESS_HASHES);
    missing.truncate(MAX_READINESS_HASHES);
    Ok(NativeTTSCacheReadinessResult {
        ok,
        planned,
        ready: ready_count,
        missing: missing_count,
        byte_size,
        ready_render_spec_hashes: ready,
        missing_render_spec_hashes: missing,
        evidence_hash,
        checked_at_ms: now_ms(),
    })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
pub(super) fn test_runtime() -> NativeTTSCacheRuntime {
    NativeTTSCacheRuntime::new()
}

#[cfg(test)]
impl NativeTTSCacheRuntime {
    pub(super) async fn pending_cancellation_count(&self) -> usize {
        self.operations.lock().await.pending.len()
    }
}
