use super::command_contract::{
    validate_execution_metadata, validate_identifier, NativeBookWorkflowJobView,
    NativeBookWorkflowSubmitRequest, NativeBookWorkflowView, NativeLabelMutationPendingView,
    NativeLabelMutationReceiptView, NativeStructuredJsonBatch, NativeWorkflowCheckpointView,
    NativeWorkflowJobStatus, NativeWorkflowJobType, NativeWorkflowReadinessOutcome,
    NativeWorkflowStage, NativeWorkflowStatus, COMPACT_WORKFLOW_SCHEMA_VERSION, MAX_WORKFLOW_JOBS,
    STRUCTURED_JSON_BATCH_RESULT_VERSION, STRUCTURED_JSON_BATCH_VERSION,
};
use crate::ai::command_contract::{DesktopStructuredJsonRequest, ProviderExecutionMetadata};
use crate::native_identity::{integrity_hash, persistent_id128};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) const LEGACY_WORKFLOW_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct PersistedWorkflowStage {
    pub(super) stage: NativeWorkflowStage,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct PersistedWorkflowJob {
    pub(super) id: String,
    pub(super) stage: NativeWorkflowStage,
    pub(super) sequence: usize,
    pub(super) status: NativeWorkflowJobStatus,
    pub(super) attempt: u32,
    pub(super) claim_fence: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) job_type: Option<NativeWorkflowJobType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) contract_fingerprint: Option<String>,
    #[serde(default)]
    pub(super) request_hash: Option<String>,
    #[serde(default)]
    pub(super) request: Option<DesktopStructuredJsonRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) batch: Option<PersistedWorkflowBatch>,
    #[serde(default)]
    pub(super) provider_id: Option<String>,
    #[serde(default)]
    pub(super) model_id: Option<String>,
    pub(super) error_code: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum PersistedWorkflowBatchUnitStatus {
    Queued,
    Running,
    Failed,
    Succeeded,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct PersistedWorkflowBatchUnit {
    pub(super) id: String,
    pub(super) packet_fingerprint: String,
    pub(super) request_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) request: Option<DesktopStructuredJsonRequest>,
    pub(super) status: PersistedWorkflowBatchUnitStatus,
    pub(super) attempt: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) claim_fence: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) output_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) output: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) provider_execution: Option<ProviderExecutionMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) completed_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct PersistedWorkflowBatch {
    pub(super) version: String,
    pub(super) contract_hash: String,
    pub(super) units: Vec<PersistedWorkflowBatchUnit>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedWorkflowBatchContractIdentity<'a> {
    version: &'a str,
    units: Vec<PersistedWorkflowBatchUnitIdentity<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedWorkflowBatchUnitIdentity<'a> {
    id: &'a str,
    packet_fingerprint: &'a str,
    request_hash: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeStructuredJsonBatchResult<'a> {
    version: &'static str,
    units: Vec<NativeStructuredJsonBatchUnitResult<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeStructuredJsonBatchUnitResult<'a> {
    id: &'a str,
    packet_fingerprint: &'a str,
    request_hash: &'a str,
    output_hash: &'a str,
    output: &'a Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_execution: Option<&'a ProviderExecutionMetadata>,
}

impl PersistedWorkflowBatch {
    pub(super) fn from_materialized(batch: NativeStructuredJsonBatch) -> Result<Self, String> {
        batch.validate()?;
        let units = batch
            .units
            .into_iter()
            .map(|unit| {
                Ok(PersistedWorkflowBatchUnit {
                    id: unit.id,
                    packet_fingerprint: unit.packet_fingerprint,
                    request_hash: integrity_hash(&unit.request)?,
                    request: Some(unit.request),
                    status: PersistedWorkflowBatchUnitStatus::Queued,
                    attempt: 0,
                    claim_fence: None,
                    output_hash: None,
                    output: None,
                    provider_execution: None,
                    completed_at_ms: None,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let mut persisted = Self {
            version: batch.version,
            contract_hash: String::new(),
            units,
        };
        persisted.contract_hash = persisted.canonical_contract_hash()?;
        Ok(persisted)
    }

    pub(super) fn aggregate_output(&self) -> Result<Value, String> {
        let units = self
            .units
            .iter()
            .map(|unit| {
                if unit.status != PersistedWorkflowBatchUnitStatus::Succeeded {
                    return Err("native workflow batch result is incomplete".to_string());
                }
                Ok(NativeStructuredJsonBatchUnitResult {
                    id: &unit.id,
                    packet_fingerprint: &unit.packet_fingerprint,
                    request_hash: &unit.request_hash,
                    output_hash: unit.output_hash.as_deref().ok_or_else(|| {
                        "native workflow batch unit output hash is missing".to_string()
                    })?,
                    output: unit.output.as_ref().ok_or_else(|| {
                        "native workflow batch unit output is missing".to_string()
                    })?,
                    provider_execution: unit.provider_execution.as_ref(),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        serde_json::to_value(NativeStructuredJsonBatchResult {
            version: STRUCTURED_JSON_BATCH_RESULT_VERSION,
            units,
        })
        .map_err(|_| "native workflow batch result could not be serialized".to_string())
    }

    pub(super) fn validate_integrity(
        &self,
        job_status: NativeWorkflowJobStatus,
        batch_request_hash: &str,
        resumable_review: bool,
    ) -> Result<(), String> {
        if self.version != STRUCTURED_JSON_BATCH_VERSION
            || self.units.len() > MAX_WORKFLOW_JOBS
            || self.canonical_contract_hash()? != self.contract_hash
        {
            return Err("native workflow batch contract hash is invalid".to_string());
        }
        let mut ids = HashSet::with_capacity(self.units.len());
        let mut packet_fingerprints = HashSet::with_capacity(self.units.len());
        let mut saw_incomplete = false;
        let mut running = 0;
        let mut failed = 0;
        let mut cancelled = 0;
        for unit in &self.units {
            validate_identifier(&unit.id, "workflow batch unit id")?;
            validate_identifier(
                &unit.packet_fingerprint,
                "workflow batch packet fingerprint",
            )?;
            if !ids.insert(unit.id.as_str()) {
                return Err("native workflow batch unit ids must be unique".to_string());
            }
            if !packet_fingerprints.insert(unit.packet_fingerprint.as_str()) {
                return Err("native workflow batch packet fingerprints must be unique".to_string());
            }
            if let Some(request) = &unit.request {
                if integrity_hash(request)? != unit.request_hash {
                    return Err("native workflow batch unit request hash is invalid".to_string());
                }
            }
            match unit.status {
                PersistedWorkflowBatchUnitStatus::Succeeded => {
                    if saw_incomplete
                        || unit.claim_fence.is_some()
                        || unit.output.is_none()
                        || unit.output_hash.as_deref()
                            != Some(integrity_hash(unit.output.as_ref().unwrap())?.as_str())
                        || unit.completed_at_ms.is_none()
                    {
                        return Err("native workflow batch unit checkpoint is invalid".to_string());
                    }
                }
                PersistedWorkflowBatchUnitStatus::Queued => {
                    saw_incomplete = true;
                    ensure_pending_batch_unit(unit)?;
                }
                PersistedWorkflowBatchUnitStatus::Running => {
                    saw_incomplete = true;
                    running += 1;
                    if unit.request.is_none()
                        || unit.claim_fence.is_none()
                        || unit.output.is_some()
                        || unit.output_hash.is_some()
                        || unit.provider_execution.is_some()
                        || unit.completed_at_ms.is_some()
                    {
                        return Err("native workflow running batch unit is invalid".to_string());
                    }
                }
                PersistedWorkflowBatchUnitStatus::Failed => {
                    saw_incomplete = true;
                    failed += 1;
                    ensure_pending_batch_unit(unit)?;
                }
                PersistedWorkflowBatchUnitStatus::Cancelled => {
                    saw_incomplete = true;
                    cancelled += 1;
                    if unit.request.is_some() != resumable_review
                        || unit.claim_fence.is_some()
                        || unit.output.is_some()
                        || unit.output_hash.is_some()
                        || unit.provider_execution.is_some()
                        || unit.completed_at_ms.is_some()
                    {
                        return Err("native workflow cancelled batch unit is invalid".to_string());
                    }
                }
            }
        }
        if self.units.iter().all(|unit| unit.request.is_some()) {
            let materialized = NativeStructuredJsonBatch {
                version: self.version.clone(),
                units: self
                    .units
                    .iter()
                    .map(
                        |unit| super::command_contract::NativeStructuredJsonBatchUnit {
                            id: unit.id.clone(),
                            packet_fingerprint: unit.packet_fingerprint.clone(),
                            request: unit
                                .request
                                .clone()
                                .expect("all batch requests are present"),
                        },
                    )
                    .collect(),
            };
            if integrity_hash(&materialized)? != batch_request_hash {
                return Err("native workflow batch request hash is invalid".to_string());
            }
        }
        let all_succeeded = self
            .units
            .iter()
            .all(|unit| unit.status == PersistedWorkflowBatchUnitStatus::Succeeded);
        let status_valid = match job_status {
            NativeWorkflowJobStatus::Queued => !all_succeeded && running == 0 && failed == 0,
            NativeWorkflowJobStatus::Running => running == 1 && failed == 0,
            NativeWorkflowJobStatus::Failed => running == 0 && failed == 1,
            NativeWorkflowJobStatus::Succeeded => all_succeeded,
            NativeWorkflowJobStatus::Cancelled => running == 0 && failed == 0 && cancelled > 0,
            NativeWorkflowJobStatus::WaitingForInput => false,
        };
        if !status_valid {
            return Err("native workflow batch job status is invalid".to_string());
        }
        Ok(())
    }

    fn canonical_contract_hash(&self) -> Result<String, String> {
        integrity_hash(&PersistedWorkflowBatchContractIdentity {
            version: &self.version,
            units: self
                .units
                .iter()
                .map(|unit| PersistedWorkflowBatchUnitIdentity {
                    id: &unit.id,
                    packet_fingerprint: &unit.packet_fingerprint,
                    request_hash: &unit.request_hash,
                })
                .collect(),
        })
    }
}

fn ensure_pending_batch_unit(unit: &PersistedWorkflowBatchUnit) -> Result<(), String> {
    if unit.request.is_none()
        || unit.claim_fence.is_some()
        || unit.output.is_some()
        || unit.output_hash.is_some()
        || unit.provider_execution.is_some()
        || unit.completed_at_ms.is_some()
    {
        return Err("native workflow pending batch unit is invalid".to_string());
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct PersistedWorkflowCheckpoint {
    pub(super) job_id: String,
    pub(super) stage: NativeWorkflowStage,
    pub(super) sequence: usize,
    pub(super) request_hash: String,
    pub(super) output_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) job_type: Option<NativeWorkflowJobType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) contract_fingerprint: Option<String>,
    pub(super) output: Value,
    #[serde(default)]
    pub(super) provider_execution: Option<ProviderExecutionMetadata>,
    pub(super) completed_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct PersistedWorkflow {
    pub(super) schema_version: u32,
    pub(super) id: String,
    pub(super) idempotency_key: String,
    pub(super) novel_id: String,
    pub(super) content_revision: String,
    pub(super) plan_hash: String,
    pub(super) payload_hash: String,
    pub(super) status: NativeWorkflowStatus,
    pub(super) stages: Vec<PersistedWorkflowStage>,
    pub(super) current_stage_index: Option<usize>,
    pub(super) fence: u64,
    pub(super) jobs: Vec<PersistedWorkflowJob>,
    pub(super) checkpoints: Vec<PersistedWorkflowCheckpoint>,
    #[serde(default)]
    pub(super) readiness_outcome: Option<NativeWorkflowReadinessOutcome>,
    #[serde(default)]
    pub(super) review_items: Vec<Value>,
    pub(super) error_code: Option<String>,
    #[serde(default)]
    pub(super) pending_label_mutation: Option<NativeLabelMutationPendingView>,
    #[serde(default)]
    pub(super) last_label_mutation_receipt: Option<NativeLabelMutationReceiptView>,
    pub(super) created_at_ms: u64,
    pub(super) updated_at_ms: u64,
}

impl PersistedWorkflow {
    pub(super) fn from_request(request: NativeBookWorkflowSubmitRequest) -> Result<Self, String> {
        let schema_version = request.effective_schema_version();
        let payload_hash = request.payload_hash()?;
        let id = persistent_id128(
            "native_book_workflow",
            &[request.novel_id.as_str(), request.idempotency_key.as_str()],
        )?;
        let now = now_ms();
        let stages = request
            .stages
            .iter()
            .map(|stage| PersistedWorkflowStage { stage: stage.stage })
            .collect::<Vec<_>>();
        let mut sequence = 0;
        let mut jobs = Vec::new();
        for stage in request.stages {
            for job in stage.jobs {
                let request_hash = job.request.as_ref().map(integrity_hash).transpose()?;
                let provider_id = job
                    .request
                    .as_ref()
                    .map(|request| request.provider_id.clone());
                let model_id = job.request.as_ref().map(|request| request.model_id.clone());
                let status = if job.request.is_some() {
                    NativeWorkflowJobStatus::Queued
                } else {
                    NativeWorkflowJobStatus::WaitingForInput
                };
                jobs.push(PersistedWorkflowJob {
                    id: job.id,
                    stage: stage.stage,
                    sequence,
                    status,
                    attempt: 0,
                    claim_fence: None,
                    job_type: job.job_type,
                    contract_fingerprint: job.contract_fingerprint,
                    request_hash,
                    request: job.request,
                    batch: None,
                    provider_id,
                    model_id,
                    error_code: None,
                });
                sequence += 1;
            }
        }
        let mut workflow = Self {
            schema_version,
            id,
            idempotency_key: request.idempotency_key,
            novel_id: request.novel_id,
            content_revision: request.content_revision,
            plan_hash: request.plan_hash,
            payload_hash,
            status: NativeWorkflowStatus::WaitingForInput,
            stages,
            current_stage_index: Some(0),
            fence: 1,
            jobs,
            checkpoints: Vec::new(),
            readiness_outcome: None,
            review_items: Vec::new(),
            error_code: None,
            pending_label_mutation: None,
            last_label_mutation_receipt: None,
            created_at_ms: now,
            updated_at_ms: now,
        };
        workflow.status = workflow.pending_status();
        Ok(workflow)
    }

    pub(super) fn current_stage(&self) -> Option<NativeWorkflowStage> {
        self.current_stage_index
            .and_then(|index| self.stages.get(index))
            .map(|stage| stage.stage)
    }

    pub(super) fn pending_status(&self) -> NativeWorkflowStatus {
        let Some(stage) = self.current_stage() else {
            return NativeWorkflowStatus::Succeeded;
        };
        if stage == NativeWorkflowStage::TtsReadyPreparation {
            return NativeWorkflowStatus::WaitingForInput;
        }
        if self
            .jobs
            .iter()
            .any(|job| job.stage == stage && job.status == NativeWorkflowJobStatus::Running)
        {
            return NativeWorkflowStatus::Running;
        }
        match self
            .jobs
            .iter()
            .filter(|job| job.stage == stage)
            .find(|job| job.status != NativeWorkflowJobStatus::Succeeded)
            .map(|job| job.status)
        {
            Some(NativeWorkflowJobStatus::WaitingForInput) => NativeWorkflowStatus::WaitingForInput,
            Some(NativeWorkflowJobStatus::Failed) => NativeWorkflowStatus::Failed,
            Some(NativeWorkflowJobStatus::Cancelled) => NativeWorkflowStatus::Cancelled,
            Some(_) | None => NativeWorkflowStatus::Queued,
        }
    }

    pub(super) fn is_active(&self) -> bool {
        !matches!(
            self.status,
            NativeWorkflowStatus::Succeeded | NativeWorkflowStatus::Cancelled
        )
    }

    pub(super) fn compact_completed_requests(&mut self) {
        let preserve_review_inputs = self.status == NativeWorkflowStatus::NeedsReview;
        for job in &mut self.jobs {
            if let Some(batch) = &mut job.batch {
                for unit in &mut batch.units {
                    if unit.status == PersistedWorkflowBatchUnitStatus::Succeeded
                        || (unit.status == PersistedWorkflowBatchUnitStatus::Cancelled
                            && !preserve_review_inputs)
                    {
                        unit.request = None;
                    }
                }
            }
            if matches!(
                job.status,
                NativeWorkflowJobStatus::Succeeded | NativeWorkflowJobStatus::Cancelled
            ) {
                job.request = None;
            }
        }
    }

    pub(super) fn validate_snapshot_integrity(&mut self) -> Result<(), String> {
        for job in &mut self.jobs {
            validate_execution_metadata(
                self.schema_version,
                job.stage,
                job.job_type,
                job.contract_fingerprint.as_deref(),
            )?;
            let compact_speaker_job = self.schema_version == COMPACT_WORKFLOW_SCHEMA_VERSION
                && job.job_type == Some(NativeWorkflowJobType::SpeakerAttributionV3)
                && job.stage == NativeWorkflowStage::ChapterLabeling;
            if compact_speaker_job
                && (job.request.is_some() || (job.request_hash.is_some() && job.batch.is_none()))
            {
                return Err(
                    "native compact speaker attribution snapshot requires a batch checkpoint"
                        .to_string(),
                );
            }
            if let Some(batch) = &job.batch {
                if self.schema_version != COMPACT_WORKFLOW_SCHEMA_VERSION
                    || job.stage != NativeWorkflowStage::ChapterLabeling
                    || job.job_type != Some(NativeWorkflowJobType::SpeakerAttributionV3)
                    || job.request.is_some()
                    || job.provider_id.is_some()
                    || job.model_id.is_some()
                {
                    return Err("native workflow batch execution metadata is invalid".to_string());
                }
                let request_hash = job
                    .request_hash
                    .as_deref()
                    .ok_or_else(|| "native workflow batch request hash is missing".to_string())?;
                batch.validate_integrity(
                    job.status,
                    request_hash,
                    self.status == NativeWorkflowStatus::NeedsReview,
                )?;
            } else if let Some(request) = &job.request {
                if job.request_hash.as_deref() != Some(integrity_hash(request)?.as_str()) {
                    return Err("native workflow snapshot request hash is invalid".to_string());
                }
                let provider_id = request.provider_id.clone();
                let model_id = request.model_id.clone();
                if job
                    .provider_id
                    .as_ref()
                    .is_some_and(|value| value != &provider_id)
                    || job
                        .model_id
                        .as_ref()
                        .is_some_and(|value| value != &model_id)
                {
                    return Err("native workflow snapshot provider identity is invalid".to_string());
                }
                job.provider_id = Some(provider_id);
                job.model_id = Some(model_id);
            } else if matches!(
                job.status,
                NativeWorkflowJobStatus::Queued
                    | NativeWorkflowJobStatus::Running
                    | NativeWorkflowJobStatus::Failed
            ) || (job.status == NativeWorkflowJobStatus::WaitingForInput
                && job.request_hash.is_some())
                || (job.status == NativeWorkflowJobStatus::Succeeded && job.request_hash.is_none())
            {
                return Err("native workflow snapshot request state is invalid".to_string());
            }
            if job.provider_id.is_some() != job.model_id.is_some() {
                return Err("native workflow snapshot provider identity is invalid".to_string());
            }
        }
        if self.schema_version == COMPACT_WORKFLOW_SCHEMA_VERSION
            && self.compact_plan_hash()? != self.plan_hash
        {
            return Err("native compact workflow execution manifest hash is invalid".to_string());
        }

        let mut checkpoint_jobs = HashSet::new();
        for checkpoint in &self.checkpoints {
            let job = self
                .jobs
                .iter()
                .find(|job| job.id == checkpoint.job_id)
                .ok_or_else(|| "native workflow snapshot checkpoint job is invalid".to_string())?;
            if !checkpoint_jobs.insert(checkpoint.job_id.as_str())
                || job.status != NativeWorkflowJobStatus::Succeeded
                || job.stage != checkpoint.stage
                || job.sequence != checkpoint.sequence
                || job.request_hash.as_deref() != Some(checkpoint.request_hash.as_str())
                || job.job_type != checkpoint.job_type
                || job.contract_fingerprint != checkpoint.contract_fingerprint
                || integrity_hash(&checkpoint.output)? != checkpoint.output_hash
            {
                return Err("native workflow snapshot checkpoint hash is invalid".to_string());
            }
            if let Some(batch) = &job.batch {
                if batch.aggregate_output()? != checkpoint.output
                    || checkpoint.provider_execution.is_some()
                {
                    return Err("native workflow batch checkpoint is invalid".to_string());
                }
            }
        }
        if self.jobs.iter().any(|job| {
            job.status == NativeWorkflowJobStatus::Succeeded
                && !checkpoint_jobs.contains(job.id.as_str())
        }) {
            return Err("native workflow snapshot checkpoint is missing".to_string());
        }
        Ok(())
    }

    fn compact_plan_hash(&self) -> Result<String, String> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct PlanIdentity<'a> {
            schema_version: u32,
            novel_id: &'a str,
            content_revision: &'a str,
            stages: Vec<StageIdentity<'a>>,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct StageIdentity<'a> {
            stage: NativeWorkflowStage,
            jobs: Vec<JobIdentity<'a>>,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct JobIdentity<'a> {
            id: &'a str,
            job_type: NativeWorkflowJobType,
            #[serde(skip_serializing_if = "Option::is_none")]
            contract_fingerprint: Option<&'a str>,
        }
        integrity_hash(&PlanIdentity {
            schema_version: COMPACT_WORKFLOW_SCHEMA_VERSION,
            novel_id: &self.novel_id,
            content_revision: &self.content_revision,
            stages: self
                .stages
                .iter()
                .map(|stage| StageIdentity {
                    stage: stage.stage,
                    jobs: self
                        .jobs
                        .iter()
                        .filter(|job| job.stage == stage.stage)
                        .map(|job| JobIdentity {
                            id: job.id.as_str(),
                            job_type: job.job_type.expect("validated compact job type"),
                            contract_fingerprint: job.contract_fingerprint.as_deref(),
                        })
                        .collect(),
                })
                .collect(),
        })
    }

    pub(super) fn supports_transition(
        &self,
        from: NativeWorkflowStage,
        to: NativeWorkflowStage,
    ) -> bool {
        from.can_transition_to(to)
            || (self.schema_version == LEGACY_WORKFLOW_SCHEMA_VERSION
                && from == NativeWorkflowStage::CharacterGraphBootstrap
                && to == NativeWorkflowStage::ChapterLabeling)
    }

    pub(super) fn view(&self) -> NativeBookWorkflowView {
        NativeBookWorkflowView {
            schema_version: self.schema_version,
            id: self.id.clone(),
            idempotency_key: self.idempotency_key.clone(),
            novel_id: self.novel_id.clone(),
            content_revision: self.content_revision.clone(),
            plan_hash: self.plan_hash.clone(),
            payload_hash: self.payload_hash.clone(),
            status: self.status,
            current_stage: self.current_stage(),
            fence: self.fence,
            jobs: self
                .jobs
                .iter()
                .map(|job| NativeBookWorkflowJobView {
                    id: job.id.clone(),
                    stage: job.stage,
                    sequence: job.sequence,
                    status: job.status,
                    attempt: job.attempt,
                    job_type: job.job_type,
                    contract_fingerprint: job.contract_fingerprint.clone(),
                    request_hash: job.request_hash.clone(),
                    provider_id: job.provider_id.clone(),
                    model_id: job.model_id.clone(),
                    error_code: job.error_code.clone(),
                })
                .collect(),
            checkpoints: self
                .checkpoints
                .iter()
                .map(|checkpoint| NativeWorkflowCheckpointView {
                    job_id: checkpoint.job_id.clone(),
                    stage: checkpoint.stage,
                    sequence: checkpoint.sequence,
                    request_hash: checkpoint.request_hash.clone(),
                    output_hash: checkpoint.output_hash.clone(),
                    job_type: checkpoint.job_type,
                    contract_fingerprint: checkpoint.contract_fingerprint.clone(),
                    provider_execution: checkpoint.provider_execution.clone(),
                    completed_at_ms: checkpoint.completed_at_ms,
                })
                .collect(),
            readiness_outcome: self.readiness_outcome,
            review_items: self.review_items.clone(),
            error_code: self.error_code.clone(),
            pending_label_mutation: self.pending_label_mutation.clone(),
            last_label_mutation_receipt: self.last_label_mutation_receipt.clone(),
            created_at_ms: self.created_at_ms,
            updated_at_ms: self.updated_at_ms,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum WorkflowJournalEvent {
    Submitted {
        workflow: PersistedWorkflow,
    },
    SnapshotCompleted {
        workflow_count: usize,
        state_hash: String,
    },
    JobMaterialized {
        workflow_id: String,
        job_id: String,
        fence: u64,
        request_hash: String,
        request: DesktopStructuredJsonRequest,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        job_type: Option<NativeWorkflowJobType>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        contract_fingerprint: Option<String>,
        updated_at_ms: u64,
    },
    JobBatchMaterialized {
        workflow_id: String,
        job_id: String,
        fence: u64,
        request_hash: String,
        batch: NativeStructuredJsonBatch,
        job_type: NativeWorkflowJobType,
        contract_fingerprint: String,
        updated_at_ms: u64,
    },
    JobClaimed {
        workflow_id: String,
        job_id: String,
        fence: u64,
        attempt: u32,
        updated_at_ms: u64,
    },
    JobSucceeded {
        workflow_id: String,
        job_id: String,
        fence: u64,
        checkpoint: PersistedWorkflowCheckpoint,
        updated_at_ms: u64,
    },
    JobFailed {
        workflow_id: String,
        job_id: String,
        fence: u64,
        error_code: String,
        updated_at_ms: u64,
    },
    BatchUnitClaimed {
        workflow_id: String,
        job_id: String,
        unit_id: String,
        fence: u64,
        attempt: u32,
        updated_at_ms: u64,
    },
    BatchUnitSucceeded {
        workflow_id: String,
        job_id: String,
        unit_id: String,
        fence: u64,
        output_hash: String,
        output: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_execution: Option<ProviderExecutionMetadata>,
        completed_at_ms: u64,
        updated_at_ms: u64,
    },
    BatchUnitFailed {
        workflow_id: String,
        job_id: String,
        unit_id: String,
        fence: u64,
        error_code: String,
        updated_at_ms: u64,
    },
    StageAdvanced {
        workflow_id: String,
        from: NativeWorkflowStage,
        to: Option<NativeWorkflowStage>,
        updated_at_ms: u64,
    },
    ReadinessFinalized {
        workflow_id: String,
        fence: u64,
        outcome: NativeWorkflowReadinessOutcome,
        review_items: Vec<Value>,
        updated_at_ms: u64,
    },
    ReviewRequired {
        workflow_id: String,
        fence: u64,
        error_code: String,
        review_items: Vec<Value>,
        updated_at_ms: u64,
    },
    LabelMutationPrepared {
        workflow_id: String,
        fence: u64,
        pending: NativeLabelMutationPendingView,
        updated_at_ms: u64,
    },
    LabelMutationFinalized {
        workflow_id: String,
        fence: u64,
        receipt: NativeLabelMutationReceiptView,
        #[serde(default)]
        resume_after_review: bool,
        updated_at_ms: u64,
    },
    Requeued {
        workflow_id: String,
        fence: u64,
        job_ids: Vec<String>,
        reason: WorkflowRequeueReason,
        updated_at_ms: u64,
    },
    Cancelled {
        workflow_id: String,
        fence: u64,
        updated_at_ms: u64,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum WorkflowRequeueReason {
    ProcessRestart,
    ExplicitResume,
}

pub(super) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::test_support::submit_request;

    #[test]
    fn planned_jobs_start_waiting_and_materialized_jobs_start_queued() {
        let mut request = submit_request();
        request.stages[0].jobs[0].request = Some(crate::workflow::test_support::provider_request(
            "bootstrap-1",
        ));
        request.plan_hash = request.canonical_plan_hash().unwrap();
        let workflow = PersistedWorkflow::from_request(request).expect("persist request");
        assert_eq!(workflow.status, NativeWorkflowStatus::Queued);
        assert_eq!(workflow.jobs[0].status, NativeWorkflowJobStatus::Queued);
        assert_eq!(
            workflow.jobs[1].status,
            NativeWorkflowJobStatus::WaitingForInput
        );
    }
}
