use super::bridge::desktop_tts_synthesize_impl;
use super::cache_contract::{
    NativeTTSCacheEvidence, NativeTTSCacheEvidenceRequest, NativeTTSCachePruneRequest,
    NativeTTSCachePruneResult, NativeTTSCacheReadinessRequest, NativeTTSCacheReadinessResult,
    NativeTTSOperationCancelResult, NativeTTSRenderRequest, NativeTTSRenderResult,
};
use super::cache_identity::validate_render_request;
use super::cache_record::{cache_evidence, prune_cache_records};
use super::cache_runtime::{cache_readiness_at, render_cached_with, shared_runtime};
use super::job_manifest::{
    clear_pending, list_pending, mark_failed, persist_pending, NativeTTSPendingJobSummary,
    JOB_DIRECTORY,
};
use std::path::PathBuf;
use tauri::Manager;

pub(super) const CACHE_DIRECTORY: &str = "native-tts-render-cache-v2";

#[tauri::command]
pub(crate) async fn native_tts_render_cached(
    app: tauri::AppHandle,
    request: NativeTTSRenderRequest,
) -> Result<NativeTTSRenderResult, String> {
    validate_render_request(&request)?;
    let cache_dir = cache_directory(&app)?;
    let job_dir = if should_persist_pending(&request) {
        let directory = job_directory(&app)?;
        persist_pending(&directory, &request)?;
        #[cfg(target_os = "android")]
        let _ = super::android_recovery::schedule(&app, request.recovery_policy).await;
        Some(directory)
    } else {
        None
    };
    let operation_id = request.operation_id.clone();
    let result = render_cached_with(shared_runtime(), &cache_dir, request, |synthesis| async {
        desktop_tts_synthesize_impl(Some(&app), synthesis).await
    })
    .await;
    if result.is_ok() {
        // A completed cache item is authoritative. Do not turn usable audio into a
        // playback failure solely because best-effort manifest cleanup failed.
        if let Some(job_dir) = job_dir.as_ref() {
            let _ = clear_pending(job_dir, &operation_id);
        }
    } else if let (Some(job_dir), Err(error)) = (job_dir.as_ref(), &result) {
        // Preserve only a bounded failure class and next-attempt policy. Provider
        // response bodies and credentials never enter the durable manifest.
        let _ = mark_failed(job_dir, &operation_id, error);
    }
    result
}

fn should_persist_pending(request: &NativeTTSRenderRequest) -> bool {
    !request.cache_only
}

#[tauri::command]
pub(crate) async fn native_tts_cache_readiness(
    app: tauri::AppHandle,
    request: NativeTTSCacheReadinessRequest,
) -> Result<NativeTTSCacheReadinessResult, String> {
    let cache_dir = cache_directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || cache_readiness_at(&cache_dir, request))
        .await
        .map_err(|_| "native TTS readiness worker failed".to_string())?
}

#[tauri::command]
pub(crate) async fn native_tts_cache_prune(
    app: tauri::AppHandle,
    request: NativeTTSCachePruneRequest,
) -> Result<NativeTTSCachePruneResult, String> {
    let cache_dir = cache_directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        prune_cache_records(&cache_dir, request.max_bytes, &request.protected_cache_keys)
    })
    .await
    .map_err(|_| "native TTS cache cleanup worker failed".to_string())?
}

#[tauri::command]
pub(crate) async fn native_tts_cache_evidence(
    app: tauri::AppHandle,
    request: NativeTTSCacheEvidenceRequest,
) -> Result<Vec<NativeTTSCacheEvidence>, String> {
    let directory = cache_directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || cache_evidence(&directory, request))
        .await
        .map_err(|_| "native TTS cache evidence worker failed".to_string())?
}

#[tauri::command]
pub(crate) async fn native_tts_operation_cancel(
    app: tauri::AppHandle,
    operation_id: String,
) -> Result<NativeTTSOperationCancelResult, String> {
    let operation_id = operation_id.trim();
    if operation_id.is_empty()
        || operation_id.len() > 512
        || operation_id.chars().any(char::is_control)
    {
        return Err("native TTS operation id is invalid".to_string());
    }
    let result = NativeTTSOperationCancelResult {
        operation_id: operation_id.to_string(),
        cancelled: shared_runtime().cancel(operation_id).await,
    };
    clear_pending(&job_directory(&app)?, operation_id)?;
    Ok(result)
}

#[tauri::command]
pub(crate) async fn native_tts_pending_jobs(
    app: tauri::AppHandle,
) -> Result<Vec<NativeTTSPendingJobSummary>, String> {
    let directory = job_directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || list_pending(&directory))
        .await
        .map_err(|_| "native TTS pending job reader failed".to_string())?
}

fn cache_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|_| "native TTS cache path is unavailable".to_string())?
        .join(CACHE_DIRECTORY);
    Ok(directory)
}

fn job_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "native TTS job path is unavailable".to_string())?
        .join(JOB_DIRECTORY))
}

#[cfg(test)]
#[path = "render_cache.test.rs"]
mod tests;
