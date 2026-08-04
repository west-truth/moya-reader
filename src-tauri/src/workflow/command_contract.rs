use crate::ai::command_contract::DesktopStructuredJsonRequest;
use crate::ai::command_contract::ProviderExecutionMetadata;
use crate::native_identity::integrity_hash;
use crate::provider_http::ensure_non_secret_provider_options;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::HashSet;

pub(super) const WORKFLOW_SCHEMA_VERSION: u32 = 2;
pub(super) const COMPACT_WORKFLOW_SCHEMA_VERSION: u32 = 3;
pub(super) const STRUCTURED_JSON_BATCH_VERSION: &str = "native-structured-json-batch-v1";
pub(super) const STRUCTURED_JSON_BATCH_RESULT_VERSION: &str =
    "native-structured-json-batch-result-v1";
pub(super) const MAX_WORKFLOW_JOBS: usize = 10_000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NativeWorkflowStage {
    CharacterGraphBootstrap,
    CharacterGraphMerge,
    ChapterLabeling,
    TtsReadyPreparation,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NativeWorkflowJobType {
    CharacterBundleAnalysis,
    CharacterGraphMerge,
    ChapterSegmentLabeling,
    SpeakerAttributionV3,
}

impl NativeWorkflowStage {
    pub(crate) fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::CharacterGraphBootstrap, Self::CharacterGraphMerge)
                | (Self::CharacterGraphMerge, Self::ChapterLabeling)
                | (Self::ChapterLabeling, Self::TtsReadyPreparation)
        )
    }
}

const CANONICAL_STAGES: [NativeWorkflowStage; 4] = [
    NativeWorkflowStage::CharacterGraphBootstrap,
    NativeWorkflowStage::CharacterGraphMerge,
    NativeWorkflowStage::ChapterLabeling,
    NativeWorkflowStage::TtsReadyPreparation,
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeBookWorkflowJobRequest {
    pub(crate) id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) request: Option<DesktopStructuredJsonRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) job_type: Option<NativeWorkflowJobType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) contract_fingerprint: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeBookWorkflowStageRequest {
    pub(crate) stage: NativeWorkflowStage,
    pub(crate) jobs: Vec<NativeBookWorkflowJobRequest>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeBookWorkflowSubmitRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) schema_version: Option<u32>,
    pub(crate) idempotency_key: String,
    pub(crate) novel_id: String,
    pub(crate) content_revision: String,
    pub(crate) plan_hash: String,
    pub(crate) stages: Vec<NativeBookWorkflowStageRequest>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeWorkflowPlanIdentity<'a> {
    schema_version: u32,
    novel_id: &'a str,
    content_revision: &'a str,
    stages: Vec<NativeWorkflowPlanStageIdentity<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeWorkflowPlanStageIdentity<'a> {
    stage: NativeWorkflowStage,
    item_ids: Vec<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCompactWorkflowPlanIdentity<'a> {
    schema_version: u32,
    novel_id: &'a str,
    content_revision: &'a str,
    stages: Vec<NativeCompactWorkflowPlanStageIdentity<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCompactWorkflowPlanStageIdentity<'a> {
    stage: NativeWorkflowStage,
    jobs: Vec<NativeCompactWorkflowPlanJobIdentity<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCompactWorkflowPlanJobIdentity<'a> {
    id: &'a str,
    job_type: NativeWorkflowJobType,
    #[serde(skip_serializing_if = "Option::is_none")]
    contract_fingerprint: Option<&'a str>,
}

impl NativeBookWorkflowSubmitRequest {
    pub(crate) fn effective_schema_version(&self) -> u32 {
        self.schema_version.unwrap_or(WORKFLOW_SCHEMA_VERSION)
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_identifier(&self.idempotency_key, "workflow idempotency key")?;
        validate_identifier(&self.novel_id, "workflow novel id")?;
        validate_identifier(&self.content_revision, "workflow content revision")?;
        validate_identifier(&self.plan_hash, "workflow plan hash")?;
        let schema_version = self.effective_schema_version();
        if !matches!(
            schema_version,
            WORKFLOW_SCHEMA_VERSION | COMPACT_WORKFLOW_SCHEMA_VERSION
        ) {
            return Err("native workflow schema version is unsupported".to_string());
        }
        if self.stages.len() != CANONICAL_STAGES.len()
            || self
                .stages
                .iter()
                .zip(CANONICAL_STAGES)
                .any(|(stage, expected)| stage.stage != expected)
        {
            return Err("native workflow must contain the four canonical stages".to_string());
        }

        let job_count = self
            .stages
            .iter()
            .map(|stage| stage.jobs.len())
            .sum::<usize>();
        if job_count == 0 || job_count > MAX_WORKFLOW_JOBS {
            return Err("native workflow job count is invalid".to_string());
        }
        let mut job_ids = HashSet::with_capacity(job_count);
        for stage in &self.stages {
            validate_stage_jobs(stage)?;
            for job in &stage.jobs {
                validate_identifier(&job.id, "workflow job id")?;
                if !job_ids.insert(job.id.as_str()) {
                    return Err("native workflow job ids must be unique".to_string());
                }
                validate_execution_job(schema_version, stage.stage, job)?;
                if schema_version == COMPACT_WORKFLOW_SCHEMA_VERSION && job.request.is_some() {
                    return Err(
                        "native compact workflow jobs must materialize provider input after submit"
                            .to_string(),
                    );
                }
                if let Some(request) = &job.request {
                    validate_provider_request(request)?;
                }
            }
        }
        if self.plan_hash != self.canonical_plan_hash()? {
            return Err("native workflow plan hash does not match the canonical plan".to_string());
        }
        Ok(())
    }

    pub(crate) fn canonical_plan_hash(&self) -> Result<String, String> {
        if self.effective_schema_version() == COMPACT_WORKFLOW_SCHEMA_VERSION {
            let stages = self
                .stages
                .iter()
                .map(|stage| {
                    Ok(NativeCompactWorkflowPlanStageIdentity {
                        stage: stage.stage,
                        jobs: stage
                            .jobs
                            .iter()
                            .map(|job| {
                                Ok(NativeCompactWorkflowPlanJobIdentity {
                                    id: job.id.as_str(),
                                    job_type: job.job_type.ok_or_else(|| {
                                        "native compact workflow job type is missing".to_string()
                                    })?,
                                    contract_fingerprint: job.contract_fingerprint.as_deref(),
                                })
                            })
                            .collect::<Result<Vec<_>, String>>()?,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            return integrity_hash(&NativeCompactWorkflowPlanIdentity {
                schema_version: COMPACT_WORKFLOW_SCHEMA_VERSION,
                novel_id: &self.novel_id,
                content_revision: &self.content_revision,
                stages,
            });
        }
        integrity_hash(&NativeWorkflowPlanIdentity {
            schema_version: WORKFLOW_SCHEMA_VERSION,
            novel_id: &self.novel_id,
            content_revision: &self.content_revision,
            stages: self
                .stages
                .iter()
                .map(|stage| NativeWorkflowPlanStageIdentity {
                    stage: stage.stage,
                    item_ids: stage.jobs.iter().map(|job| job.id.as_str()).collect(),
                })
                .collect(),
        })
    }

    pub(crate) fn payload_hash(&self) -> Result<String, String> {
        integrity_hash(self)
    }
}

pub(super) fn validate_execution_job(
    schema_version: u32,
    stage: NativeWorkflowStage,
    job: &NativeBookWorkflowJobRequest,
) -> Result<(), String> {
    validate_execution_metadata(
        schema_version,
        stage,
        job.job_type,
        job.contract_fingerprint.as_deref(),
    )
}

pub(super) fn validate_execution_metadata(
    schema_version: u32,
    stage: NativeWorkflowStage,
    job_type: Option<NativeWorkflowJobType>,
    contract_fingerprint: Option<&str>,
) -> Result<(), String> {
    if schema_version != COMPACT_WORKFLOW_SCHEMA_VERSION {
        if job_type.is_some() || contract_fingerprint.is_some() {
            return Err("native workflow v2 jobs must not contain execution metadata".to_string());
        }
        return Ok(());
    }
    let expected = match stage {
        NativeWorkflowStage::CharacterGraphBootstrap => {
            NativeWorkflowJobType::CharacterBundleAnalysis
        }
        NativeWorkflowStage::CharacterGraphMerge => NativeWorkflowJobType::CharacterGraphMerge,
        NativeWorkflowStage::ChapterLabeling => NativeWorkflowJobType::SpeakerAttributionV3,
        NativeWorkflowStage::TtsReadyPreparation => {
            return Err("native workflow readiness stage must not contain jobs".to_string())
        }
    };
    if job_type != Some(expected) {
        return Err("native compact workflow job type does not match its stage".to_string());
    }
    if expected == NativeWorkflowJobType::SpeakerAttributionV3 {
        validate_identifier(
            contract_fingerprint.unwrap_or_default(),
            "native compact speaker contract fingerprint",
        )?;
    } else if contract_fingerprint.is_some() {
        return Err(
            "native non-speaker workflow job must not contain a contract fingerprint".to_string(),
        );
    }
    Ok(())
}

fn validate_stage_jobs(stage: &NativeBookWorkflowStageRequest) -> Result<(), String> {
    match stage.stage {
        NativeWorkflowStage::CharacterGraphBootstrap | NativeWorkflowStage::ChapterLabeling
            if stage.jobs.is_empty() =>
        {
            Err("native workflow analysis stages must contain jobs".to_string())
        }
        NativeWorkflowStage::CharacterGraphMerge if stage.jobs.len() != 1 => {
            Err("native workflow graph merge stage must contain one job".to_string())
        }
        NativeWorkflowStage::TtsReadyPreparation if !stage.jobs.is_empty() => {
            Err("native workflow TTS readiness stage must not contain provider jobs".to_string())
        }
        _ => Ok(()),
    }
}

fn validate_provider_request(request: &DesktopStructuredJsonRequest) -> Result<(), String> {
    request.validate()?;
    ensure_non_secret_provider_options(&request.provider_options)
}

pub(super) fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed != value
        || trimmed.len() > 256
        || trimmed.chars().any(|character| character.is_control())
    {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct NativeStructuredJsonBatchUnit {
    pub(super) id: String,
    pub(super) packet_fingerprint: String,
    pub(super) request: DesktopStructuredJsonRequest,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct NativeStructuredJsonBatch {
    pub(super) version: String,
    pub(super) units: Vec<NativeStructuredJsonBatchUnit>,
}

impl NativeStructuredJsonBatch {
    pub(super) fn validate(&self) -> Result<(), String> {
        if self.version != STRUCTURED_JSON_BATCH_VERSION {
            return Err("native workflow batch version is unsupported".to_string());
        }
        if self.units.len() > MAX_WORKFLOW_JOBS {
            return Err("native workflow batch unit count is invalid".to_string());
        }
        let mut unit_ids = HashSet::with_capacity(self.units.len());
        let mut packet_fingerprints = HashSet::with_capacity(self.units.len());
        for unit in &self.units {
            validate_identifier(&unit.id, "workflow batch unit id")?;
            validate_identifier(
                &unit.packet_fingerprint,
                "workflow batch packet fingerprint",
            )?;
            if !unit_ids.insert(unit.id.as_str()) {
                return Err("native workflow batch unit ids must be unique".to_string());
            }
            if !packet_fingerprints.insert(unit.packet_fingerprint.as_str()) {
                return Err("native workflow batch packet fingerprints must be unique".to_string());
            }
            validate_provider_request(&unit.request)?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub(crate) struct NativeBookWorkflowMaterializeRequest {
    pub(crate) workflow_id: String,
    pub(crate) job_id: String,
    pub(crate) expected_fence: u64,
    pub(crate) request: Option<DesktopStructuredJsonRequest>,
    pub(super) batch: Option<NativeStructuredJsonBatch>,
}

#[derive(Default)]
enum MaterializationField<T> {
    #[default]
    Missing,
    Present(T),
}

impl<'de, T> Deserialize<'de> for MaterializationField<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        T::deserialize(deserializer).map(Self::Present)
    }
}

impl<'de> Deserialize<'de> for NativeBookWorkflowMaterializeRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct RawMaterializeRequest {
            workflow_id: String,
            job_id: String,
            expected_fence: u64,
            #[serde(default)]
            request: MaterializationField<DesktopStructuredJsonRequest>,
            #[serde(default)]
            batch: MaterializationField<NativeStructuredJsonBatch>,
        }

        let raw = RawMaterializeRequest::deserialize(deserializer)?;
        Ok(Self {
            workflow_id: raw.workflow_id,
            job_id: raw.job_id,
            expected_fence: raw.expected_fence,
            request: match raw.request {
                MaterializationField::Missing => None,
                MaterializationField::Present(request) => Some(request),
            },
            batch: match raw.batch {
                MaterializationField::Missing => None,
                MaterializationField::Present(batch) => Some(batch),
            },
        })
    }
}

impl NativeBookWorkflowMaterializeRequest {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_identifier(&self.workflow_id, "workflow id")?;
        validate_identifier(&self.job_id, "workflow job id")?;
        if self.expected_fence == 0 || self.expected_fence == u64::MAX {
            return Err("native workflow expected fence is invalid".to_string());
        }
        match (&self.request, &self.batch) {
            (Some(request), None) => validate_provider_request(request),
            (None, Some(batch)) => batch.validate(),
            _ => Err(
                "native workflow materialization must contain exactly one request or batch"
                    .to_string(),
            ),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NativeWorkflowReadinessOutcome {
    ReadyForTts,
    NeedsReview,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeBookWorkflowFinalizeRequest {
    pub(crate) workflow_id: String,
    pub(crate) expected_fence: u64,
    pub(crate) outcome: NativeWorkflowReadinessOutcome,
    #[serde(default)]
    pub(crate) review_items: Vec<Value>,
}

impl NativeBookWorkflowFinalizeRequest {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_identifier(&self.workflow_id, "workflow id")?;
        if self.expected_fence == 0 {
            return Err("native workflow expected fence is invalid".to_string());
        }
        match self.outcome {
            NativeWorkflowReadinessOutcome::ReadyForTts if !self.review_items.is_empty() => {
                Err("ready native workflows must not contain review items".to_string())
            }
            NativeWorkflowReadinessOutcome::NeedsReview if self.review_items.is_empty() => {
                Err("native workflows needing review must contain review items".to_string())
            }
            _ => Ok(()),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeBookWorkflowReviewRequest {
    pub(crate) workflow_id: String,
    pub(crate) expected_fence: u64,
    pub(crate) error_code: String,
    #[serde(default)]
    pub(crate) review_items: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeLabelMutationPrepareRequest {
    pub(crate) workflow_id: String,
    pub(crate) expected_fence: u64,
    pub(crate) operation_id: String,
    pub(crate) command_hash: String,
    pub(crate) command: Value,
}

impl NativeLabelMutationPrepareRequest {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_identifier(&self.workflow_id, "workflow id")?;
        validate_identifier(&self.operation_id, "label mutation operation id")?;
        validate_identifier(&self.command_hash, "label mutation command hash")?;
        if self.expected_fence == 0 || integrity_hash(&self.command)? != self.command_hash {
            return Err("native label mutation command is invalid".to_string());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeLabelMutationFinalizeRequest {
    pub(crate) workflow_id: String,
    pub(crate) expected_fence: u64,
    pub(crate) operation_id: String,
    pub(crate) command_hash: String,
    pub(crate) receipt_hash: String,
    #[serde(default)]
    pub(crate) resume_after_review: bool,
}

impl NativeLabelMutationFinalizeRequest {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_identifier(&self.workflow_id, "workflow id")?;
        validate_identifier(&self.operation_id, "label mutation operation id")?;
        validate_identifier(&self.command_hash, "label mutation command hash")?;
        validate_identifier(&self.receipt_hash, "label mutation receipt hash")?;
        if self.expected_fence == 0 {
            return Err("native workflow expected fence is invalid".to_string());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeLabelMutationPendingView {
    pub(crate) operation_id: String,
    pub(crate) command_hash: String,
    pub(crate) command: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeLabelMutationReceiptView {
    pub(crate) operation_id: String,
    pub(crate) command_hash: String,
    pub(crate) receipt_hash: String,
}

impl NativeBookWorkflowReviewRequest {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_identifier(&self.workflow_id, "workflow id")?;
        validate_identifier(&self.error_code, "workflow review error code")?;
        if self.expected_fence == 0 || self.expected_fence == u64::MAX {
            return Err("native workflow expected fence is invalid".to_string());
        }
        if self.review_items.is_empty() {
            return Err("native workflows needing review must contain review items".to_string());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NativeWorkflowStatus {
    Queued,
    WaitingForInput,
    Running,
    Failed,
    NeedsReview,
    Succeeded,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NativeWorkflowJobStatus {
    Queued,
    WaitingForInput,
    Running,
    Failed,
    Succeeded,
    Cancelled,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeBookWorkflowJobView {
    pub(crate) id: String,
    pub(crate) stage: NativeWorkflowStage,
    pub(crate) sequence: usize,
    pub(crate) status: NativeWorkflowJobStatus,
    pub(crate) attempt: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) job_type: Option<NativeWorkflowJobType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) contract_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) request_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_id: Option<String>,
    pub(crate) error_code: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeWorkflowCheckpointView {
    pub(crate) job_id: String,
    pub(crate) stage: NativeWorkflowStage,
    pub(crate) sequence: usize,
    pub(crate) request_hash: String,
    pub(crate) output_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) job_type: Option<NativeWorkflowJobType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) contract_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) provider_execution: Option<ProviderExecutionMetadata>,
    pub(crate) completed_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeWorkflowCheckpointResult {
    pub(crate) workflow_id: String,
    pub(crate) job_id: String,
    pub(crate) request_hash: String,
    pub(crate) output_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) job_type: Option<NativeWorkflowJobType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) contract_fingerprint: Option<String>,
    pub(crate) output: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) provider_execution: Option<ProviderExecutionMetadata>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeBookWorkflowView {
    pub(crate) schema_version: u32,
    pub(crate) id: String,
    pub(crate) idempotency_key: String,
    pub(crate) novel_id: String,
    pub(crate) content_revision: String,
    pub(crate) plan_hash: String,
    pub(crate) payload_hash: String,
    pub(crate) status: NativeWorkflowStatus,
    pub(crate) current_stage: Option<NativeWorkflowStage>,
    pub(crate) fence: u64,
    pub(crate) jobs: Vec<NativeBookWorkflowJobView>,
    pub(crate) checkpoints: Vec<NativeWorkflowCheckpointView>,
    pub(crate) readiness_outcome: Option<NativeWorkflowReadinessOutcome>,
    pub(crate) review_items: Vec<Value>,
    pub(crate) error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) pending_label_mutation: Option<NativeLabelMutationPendingView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_label_mutation_receipt: Option<NativeLabelMutationReceiptView>,
    pub(crate) created_at_ms: u64,
    pub(crate) updated_at_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn job(id: &str) -> NativeBookWorkflowJobRequest {
        NativeBookWorkflowJobRequest {
            id: id.to_string(),
            request: None,
            job_type: None,
            contract_fingerprint: None,
        }
    }

    fn request() -> NativeBookWorkflowSubmitRequest {
        let mut request = NativeBookWorkflowSubmitRequest {
            schema_version: None,
            idempotency_key: "book-revision-plan".to_string(),
            novel_id: "novel-1".to_string(),
            content_revision: "revision-1".to_string(),
            plan_hash: String::new(),
            stages: vec![
                NativeBookWorkflowStageRequest {
                    stage: NativeWorkflowStage::CharacterGraphBootstrap,
                    jobs: vec![job("bootstrap-1")],
                },
                NativeBookWorkflowStageRequest {
                    stage: NativeWorkflowStage::CharacterGraphMerge,
                    jobs: vec![job("merge-1")],
                },
                NativeBookWorkflowStageRequest {
                    stage: NativeWorkflowStage::ChapterLabeling,
                    jobs: vec![job("label-1")],
                },
                NativeBookWorkflowStageRequest {
                    stage: NativeWorkflowStage::TtsReadyPreparation,
                    jobs: Vec::new(),
                },
            ],
        };
        request.plan_hash = request.canonical_plan_hash().expect("canonical plan hash");
        request
    }

    fn compact_request() -> NativeBookWorkflowSubmitRequest {
        let compact_job =
            |id: &str, job_type, contract_fingerprint: Option<&str>| NativeBookWorkflowJobRequest {
                id: id.to_string(),
                request: None,
                job_type: Some(job_type),
                contract_fingerprint: contract_fingerprint.map(str::to_string),
            };
        let mut request = NativeBookWorkflowSubmitRequest {
            schema_version: Some(COMPACT_WORKFLOW_SCHEMA_VERSION),
            idempotency_key: "book-revision-compact-plan".to_string(),
            novel_id: "novel-1".to_string(),
            content_revision: "revision-1".to_string(),
            plan_hash: String::new(),
            stages: vec![
                NativeBookWorkflowStageRequest {
                    stage: NativeWorkflowStage::CharacterGraphBootstrap,
                    jobs: vec![compact_job(
                        "bootstrap-1",
                        NativeWorkflowJobType::CharacterBundleAnalysis,
                        None,
                    )],
                },
                NativeBookWorkflowStageRequest {
                    stage: NativeWorkflowStage::CharacterGraphMerge,
                    jobs: vec![compact_job(
                        "merge-1",
                        NativeWorkflowJobType::CharacterGraphMerge,
                        None,
                    )],
                },
                NativeBookWorkflowStageRequest {
                    stage: NativeWorkflowStage::ChapterLabeling,
                    jobs: vec![compact_job(
                        "label-1:scene-1",
                        NativeWorkflowJobType::SpeakerAttributionV3,
                        Some("sha256:compact-contract"),
                    )],
                },
                NativeBookWorkflowStageRequest {
                    stage: NativeWorkflowStage::TtsReadyPreparation,
                    jobs: Vec::new(),
                },
            ],
        };
        request.plan_hash = request.canonical_plan_hash().expect("compact plan hash");
        request
    }

    #[test]
    fn accepts_canonical_v2_plan_and_rejects_hash_or_stage_drift() {
        let canonical = request();
        assert_eq!(
            canonical.plan_hash,
            "sha256:983e38bf60a689e6567e36fc627d4bc46e30ba41e34c287bb227e843d5ac7d8e"
        );
        canonical.validate().expect("canonical workflow");
        let serialized = serde_json::to_value(&canonical).expect("serialize v2 request");
        assert!(serialized.get("schemaVersion").is_none());
        assert!(serialized["stages"][0]["jobs"][0].get("jobType").is_none());
        let mut invalid_hash = request();
        invalid_hash.plan_hash = "sha256:different".to_string();
        assert!(invalid_hash.validate().unwrap_err().contains("plan hash"));

        let mut invalid_order = request();
        invalid_order.stages.swap(1, 2);
        invalid_order.plan_hash = invalid_order.canonical_plan_hash().unwrap();
        assert!(invalid_order
            .validate()
            .unwrap_err()
            .contains("four canonical"));
    }

    #[test]
    fn validates_compact_execution_identity_and_rejects_contract_tampering() {
        let compact = compact_request();
        compact.validate().expect("valid compact workflow");
        let serialized = serde_json::to_value(&compact).expect("serialize compact request");
        assert_eq!(serialized["schemaVersion"], COMPACT_WORKFLOW_SCHEMA_VERSION);
        assert_eq!(
            serialized["stages"][2]["jobs"][0]["jobType"],
            "speaker_attribution_v3"
        );

        let mut tampered = compact_request();
        tampered.stages[2].jobs[0].contract_fingerprint =
            Some("sha256:tampered-contract".to_string());
        assert!(tampered.validate().unwrap_err().contains("plan hash"));

        let mut missing = compact_request();
        missing.stages[2].jobs[0].contract_fingerprint = None;
        missing.plan_hash = missing
            .canonical_plan_hash()
            .expect("missing contract plan hash");
        assert!(missing
            .validate()
            .unwrap_err()
            .contains("contract fingerprint"));
    }

    #[test]
    fn optional_job_request_keeps_camel_case_and_rejects_secrets() {
        let value = serde_json::to_value(request()).expect("serialize request");
        assert!(value.get("idempotencyKey").is_some());
        assert!(value["stages"][0]["jobs"][0].get("request").is_none());

        let mut secret = request();
        secret.stages[0].jobs[0].request = Some(DesktopStructuredJsonRequest {
            provider_id: "openai".to_string(),
            model_id: "gpt-5-mini".to_string(),
            prompt: "Return JSON.".to_string(),
            response_schema: json!({ "type": "object" }),
            json_schema_name: "workflow_result".to_string(),
            schema_version: Some("workflow-v1".to_string()),
            provider_options: Some(json!({ "apiKey": "sk-secret" })),
        });
        assert!(secret.validate().unwrap_err().contains("secret-like"));
    }
}
