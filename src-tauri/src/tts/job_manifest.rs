use super::cache_contract::NativeTTSRenderRequest;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) const JOB_DIRECTORY: &str = "native-tts-jobs-v1";
const JOB_SCHEMA_VERSION: u32 = 1;
const MAX_RECOVERY_DELAY_SECONDS: u64 = 5 * 60;
#[cfg(any(target_os = "android", test))]
const STALE_RUNNING_AGE_MS: u64 = 5 * 60 * 1_000;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum NativeTTSJobState {
    Running,
    RetryWait,
    Failed,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeTTSJobManifest {
    schema_version: u32,
    request: NativeTTSRenderRequest,
    state: NativeTTSJobState,
    attempt_count: u32,
    updated_at_ms: u64,
    next_attempt_at_ms: Option<u64>,
    failure_kind: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeTTSPendingJobSummary {
    pub(crate) operation_id: String,
    pub(crate) novel_id: String,
    pub(crate) chapter_id: String,
    pub(crate) provider_id: String,
    pub(crate) render_spec_hash: String,
    pub(crate) state: String,
    pub(crate) attempt_count: u32,
    pub(crate) updated_at_ms: u64,
    pub(crate) next_attempt_at_ms: Option<u64>,
    pub(crate) failure_kind: Option<String>,
}

fn manifest_path(directory: &Path, operation_id: &str) -> PathBuf {
    let digest = Sha256::digest(operation_id.as_bytes());
    directory.join(format!("{:x}.json", digest))
}

pub(super) fn persist_pending(
    directory: &Path,
    request: &NativeTTSRenderRequest,
) -> Result<(), String> {
    fs::create_dir_all(directory)
        .map_err(|_| "native TTS job directory is unavailable".to_string())?;
    let path = manifest_path(directory, &request.operation_id);
    let attempt_count = read_manifest(&path)
        .ok()
        .flatten()
        .map(|manifest| manifest.attempt_count.saturating_add(1))
        .unwrap_or(1);
    write_manifest(
        &path,
        &NativeTTSJobManifest {
            schema_version: JOB_SCHEMA_VERSION,
            request: request.clone(),
            state: NativeTTSJobState::Running,
            attempt_count,
            updated_at_ms: now_ms(),
            next_attempt_at_ms: None,
            failure_kind: None,
        },
    )
}

pub(super) fn mark_failed(directory: &Path, operation_id: &str, error: &str) -> Result<(), String> {
    let path = manifest_path(directory, operation_id);
    let Some(mut manifest) = read_manifest(&path)? else {
        return Ok(());
    };
    let retryable = is_retryable_failure(error);
    manifest.state = if retryable {
        NativeTTSJobState::RetryWait
    } else {
        NativeTTSJobState::Failed
    };
    manifest.updated_at_ms = now_ms();
    manifest.failure_kind = Some(
        if retryable {
            "transient"
        } else {
            "configuration"
        }
        .to_string(),
    );
    manifest.next_attempt_at_ms = retryable.then(|| {
        manifest.updated_at_ms.saturating_add(
            recovery_delay_seconds(error, manifest.attempt_count).saturating_mul(1_000),
        )
    });
    write_manifest(&path, &manifest)
}

#[cfg(any(target_os = "android", test))]
pub(super) fn claim_due(
    directory: &Path,
    operation_id: &str,
    claimed_at_ms: u64,
) -> Result<Option<NativeTTSRenderRequest>, String> {
    let path = manifest_path(directory, operation_id);
    let Some(mut manifest) = read_manifest(&path)? else {
        return Ok(None);
    };
    if manifest.request.operation_id != operation_id {
        return Err("native TTS recovery operation identity is invalid".to_string());
    }
    let due = match manifest.state {
        NativeTTSJobState::RetryWait => manifest
            .next_attempt_at_ms
            .is_none_or(|next_attempt| next_attempt <= claimed_at_ms),
        NativeTTSJobState::Running => {
            claimed_at_ms.saturating_sub(manifest.updated_at_ms) >= STALE_RUNNING_AGE_MS
        }
        NativeTTSJobState::Failed => false,
    };
    if !due {
        return Ok(None);
    }
    manifest.state = NativeTTSJobState::Running;
    manifest.attempt_count = manifest.attempt_count.saturating_add(1);
    manifest.updated_at_ms = claimed_at_ms;
    manifest.next_attempt_at_ms = None;
    manifest.failure_kind = None;
    let request = manifest.request.clone();
    write_manifest(&path, &manifest)?;
    Ok(Some(request))
}

pub(super) fn clear_pending(directory: &Path, operation_id: &str) -> Result<(), String> {
    let path = manifest_path(directory, operation_id);
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("native TTS job manifest could not be removed".to_string()),
    }
}

pub(super) fn list_pending(directory: &Path) -> Result<Vec<NativeTTSPendingJobSummary>, String> {
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut summaries = Vec::new();
    for entry in fs::read_dir(directory)
        .map_err(|_| "native TTS job directory could not be read".to_string())?
    {
        let entry = entry.map_err(|_| "native TTS job directory entry is invalid".to_string())?;
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let manifest = read_manifest(&entry.path())?
            .ok_or_else(|| "native TTS job manifest could not be decoded".to_string())?;
        let state = match manifest.state {
            NativeTTSJobState::Running => "running",
            NativeTTSJobState::RetryWait => "retry_wait",
            NativeTTSJobState::Failed => "failed",
        };
        summaries.push(NativeTTSPendingJobSummary {
            operation_id: manifest.request.operation_id,
            novel_id: manifest.request.render_spec.novel_id,
            chapter_id: manifest.request.render_spec.chapter_id,
            provider_id: manifest.request.synthesis.provider_id,
            render_spec_hash: manifest.request.render_spec_hash,
            state: state.to_string(),
            attempt_count: manifest.attempt_count,
            updated_at_ms: manifest.updated_at_ms,
            next_attempt_at_ms: manifest.next_attempt_at_ms,
            failure_kind: manifest.failure_kind,
        });
    }
    summaries.sort_by(|left, right| left.operation_id.cmp(&right.operation_id));
    Ok(summaries)
}

fn read_manifest(path: &Path) -> Result<Option<NativeTTSJobManifest>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("native TTS job manifest could not be read".to_string()),
    };
    if let Ok(manifest) = serde_json::from_slice::<NativeTTSJobManifest>(&bytes) {
        if manifest.schema_version == JOB_SCHEMA_VERSION {
            return Ok(Some(manifest));
        }
        return Err("native TTS job manifest schema is unsupported".to_string());
    }
    // One-time compatibility with the initial unversioned request-only manifest.
    let request = serde_json::from_slice::<NativeTTSRenderRequest>(&bytes)
        .map_err(|_| "native TTS job manifest could not be decoded".to_string())?;
    Ok(Some(NativeTTSJobManifest {
        schema_version: JOB_SCHEMA_VERSION,
        request,
        state: NativeTTSJobState::Running,
        attempt_count: 1,
        updated_at_ms: fs::metadata(path)
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .and_then(|value| value.as_millis().try_into().ok())
            .unwrap_or_default(),
        next_attempt_at_ms: None,
        failure_kind: None,
    }))
}

fn write_manifest(path: &Path, manifest: &NativeTTSJobManifest) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(manifest)
        .map_err(|_| "native TTS job manifest is invalid".to_string())?;
    fs::write(&temporary, bytes)
        .map_err(|_| "native TTS job manifest could not be written".to_string())?;
    if path.exists() {
        fs::remove_file(path)
            .map_err(|_| "native TTS job manifest could not be replaced".to_string())?;
    }
    fs::rename(&temporary, path)
        .map_err(|_| "native TTS job manifest could not be committed".to_string())
}

pub(super) fn is_retryable_failure(error: &str) -> bool {
    let message = error.to_ascii_lowercase();
    ![
        "status 400",
        "status 401",
        "status 403",
        "status 404",
        "status 422",
        "credential",
        "api key",
        "api-key",
        "not configured",
        "unsupported",
        "invalid voice",
        "invalid request",
    ]
    .iter()
    .any(|token| message.contains(token))
}

fn recovery_delay_seconds(error: &str, attempt_count: u32) -> u64 {
    let provider_delay = error
        .split("retry-after-seconds=")
        .nth(1)
        .and_then(|tail| {
            tail.split(|character: char| !character.is_ascii_digit())
                .next()
        })
        .and_then(|value| value.parse::<u64>().ok());
    provider_delay
        .unwrap_or_else(|| 2_u64.saturating_pow(attempt_count.min(7)).max(2))
        .clamp(1, MAX_RECOVERY_DELAY_SECONDS)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| duration.as_millis().try_into().ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tts::cache_contract::{
        NativeTTSRecoveryChargingPolicy, NativeTTSRecoveryNetworkPolicy,
    };
    use serde_json::json;

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!(
            "noveldesk-native-tts-job-manifest-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ))
    }

    fn request(operation_id: &str) -> NativeTTSRenderRequest {
        serde_json::from_value(json!({
            "operationId": operation_id,
            "contentRevision": "revision-1",
            "renderSpec": {
                "novelId": "novel-1",
                "chapterId": "chapter-1",
                "speakerId": "speaker-1",
                "voiceProfileId": "voice-1",
                "providerId": "local-endpoint",
                "segmentAnchors": [],
                "inputTextHash": "sha256:text",
                "providerOptionsHash": "sha256:options",
                "format": "wav",
                "speed": 1.0
            },
            "renderSpecHash": "sha256:render",
            "cacheOnly": false,
            "recoveryPolicy": {
                "network": "unmetered",
                "charging": "required"
            },
            "synthesis": {
                "providerId": "local-endpoint",
                "text": "Text needed to resume the native render."
            }
        }))
        .expect("render request")
    }

    #[test]
    fn persists_replaces_lists_and_clears_pending_render() {
        let directory = temp_dir();
        let operation_id = "../../operation-1";
        let render = request(operation_id);

        persist_pending(&directory, &render).expect("persist pending render");
        persist_pending(&directory, &render).expect("replace pending render");

        let files = fs::read_dir(&directory)
            .expect("manifest directory")
            .collect::<Result<Vec<_>, _>>()
            .expect("manifest files");
        assert_eq!(files.len(), 1);
        assert!(!files[0].file_name().to_string_lossy().contains("operation"));

        let summaries = list_pending(&directory).expect("list pending renders");
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].operation_id, operation_id);
        assert_eq!(summaries[0].novel_id, "novel-1");
        assert_eq!(summaries[0].provider_id, "local-endpoint");
        assert_eq!(summaries[0].attempt_count, 2);
        assert_eq!(summaries[0].state, "running");

        mark_failed(
            &directory,
            operation_id,
            "provider unavailable (retry-after-seconds=12)",
        )
        .expect("mark retry wait");
        let retry = list_pending(&directory).expect("retry summary");
        assert_eq!(retry[0].state, "retry_wait");
        assert_eq!(retry[0].failure_kind.as_deref(), Some("transient"));
        assert!(retry[0].next_attempt_at_ms > Some(retry[0].updated_at_ms));

        let next_attempt = retry[0].next_attempt_at_ms.expect("next attempt");
        assert!(claim_due(&directory, operation_id, next_attempt - 1)
            .expect("early claim")
            .is_none());
        let due_request = claim_due(&directory, operation_id, next_attempt)
            .expect("due claim")
            .expect("claimed request");
        assert!(matches!(
            due_request.recovery_policy.network,
            NativeTTSRecoveryNetworkPolicy::Unmetered
        ));
        assert!(matches!(
            due_request.recovery_policy.charging,
            NativeTTSRecoveryChargingPolicy::Required
        ));
        let claimed = list_pending(&directory).expect("claimed summary");
        assert_eq!(claimed[0].state, "running");
        assert_eq!(claimed[0].attempt_count, 3);

        mark_failed(&directory, operation_id, "credential is not configured")
            .expect("mark configuration failure");
        let failed = list_pending(&directory).expect("failed summary");
        assert_eq!(failed[0].state, "failed");
        assert_eq!(failed[0].failure_kind.as_deref(), Some("configuration"));
        assert_eq!(failed[0].next_attempt_at_ms, None);

        clear_pending(&directory, operation_id).expect("clear pending render");
        assert!(list_pending(&directory)
            .expect("empty manifest list")
            .is_empty());
        fs::remove_dir_all(directory).expect("remove manifest directory");
    }
}
