use super::command_contract::{DesktopTTSSynthesisRequest, DesktopTTSSynthesisResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(crate) const MAX_READINESS_HASHES: usize = 128;
pub(crate) const MAX_READINESS_RENDERS: usize = 1_024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeTTSRenderSegmentAnchor {
    pub(crate) segment_id: String,
    pub(crate) paragraph_id: Option<String>,
    pub(crate) start_offset: Option<u64>,
    pub(crate) end_offset: Option<u64>,
    pub(crate) segment_text_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeTTSRenderSpec {
    pub(crate) novel_id: String,
    pub(crate) chapter_id: String,
    pub(crate) content_revision: Option<String>,
    pub(crate) chapter_text_hash: Option<String>,
    pub(crate) speaker_id: String,
    pub(crate) voice_profile_id: String,
    pub(crate) provider_id: String,
    pub(crate) provider_model: Option<String>,
    pub(crate) provider_version: Option<String>,
    pub(crate) provider_voice_id: Option<String>,
    pub(crate) voice_profile_revision: Option<String>,
    pub(crate) segment_anchors: Vec<NativeTTSRenderSegmentAnchor>,
    pub(crate) input_text_hash: String,
    pub(crate) provider_options_hash: String,
    pub(crate) format: String,
    pub(crate) speed: f64,
    pub(crate) pitch: Option<f64>,
    pub(crate) tone: Option<String>,
    pub(crate) emotion: Option<String>,
    pub(crate) emotion_policy: Option<String>,
    #[serde(default)]
    pub(crate) pronunciation_revision_id: Option<String>,
    #[serde(default)]
    pub(crate) pronunciation_fingerprint: Option<String>,
    #[serde(default)]
    pub(crate) voice_entry_fingerprint: Option<String>,
    #[serde(default)]
    pub(crate) applied_controls: Option<Value>,
    #[serde(default)]
    pub(crate) alignment_mode: Option<String>,
    #[serde(default)]
    pub(crate) chunker_version: Option<String>,
    #[serde(default)]
    pub(crate) synthesis_projection_version: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NativeTTSRecoveryNetworkPolicy {
    #[default]
    Any,
    Unmetered,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NativeTTSRecoveryChargingPolicy {
    #[default]
    Any,
    Required,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeTTSRecoveryPolicy {
    pub(crate) network: NativeTTSRecoveryNetworkPolicy,
    pub(crate) charging: NativeTTSRecoveryChargingPolicy,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeTTSRenderRequest {
    pub(crate) operation_id: String,
    pub(crate) content_revision: String,
    pub(crate) render_spec: NativeTTSRenderSpec,
    pub(crate) render_spec_hash: String,
    #[serde(default)]
    pub(crate) cache_only: bool,
    #[serde(default)]
    pub(crate) recovery_policy: NativeTTSRecoveryPolicy,
    pub(crate) synthesis: DesktopTTSSynthesisRequest,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeTTSRenderResult {
    pub(crate) cache_key: String,
    pub(crate) render_spec_hash: String,
    pub(crate) content_revision: String,
    pub(crate) cache_hit: bool,
    pub(crate) synthesis: DesktopTTSSynthesisResult,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeTTSExpectedRender {
    pub(crate) render_spec: NativeTTSRenderSpec,
    pub(crate) render_spec_hash: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeTTSCacheReadinessRequest {
    pub(crate) novel_id: String,
    pub(crate) content_revision: String,
    pub(crate) expected: Vec<NativeTTSExpectedRender>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeTTSCacheReadinessResult {
    pub(crate) ok: bool,
    pub(crate) planned: usize,
    pub(crate) ready: usize,
    pub(crate) missing: usize,
    pub(crate) byte_size: u64,
    pub(crate) ready_render_spec_hashes: Vec<String>,
    pub(crate) missing_render_spec_hashes: Vec<String>,
    pub(crate) evidence_hash: String,
    pub(crate) checked_at_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeTTSOperationCancelResult {
    pub(crate) operation_id: String,
    pub(crate) cancelled: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeTTSCachePruneRequest {
    pub(crate) max_bytes: u64,
    #[serde(default)]
    pub(crate) protected_cache_keys: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeTTSCachePruneResult {
    pub(crate) before_bytes: u64,
    pub(crate) after_bytes: u64,
    pub(crate) removed_bytes: u64,
    pub(crate) removed_items: usize,
    pub(crate) retained_items: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeTTSCacheEvidenceRequest {
    pub(crate) render_spec_hashes: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeTTSCacheEvidence {
    pub(crate) render_spec_hash: String,
    pub(crate) cache_key: String,
    pub(crate) byte_size: usize,
}
