use super::command_contract::{
    NativeBookWorkflowFinalizeRequest, NativeBookWorkflowMaterializeRequest,
    NativeBookWorkflowReviewRequest, NativeBookWorkflowSubmitRequest, NativeBookWorkflowView,
    NativeLabelMutationFinalizeRequest, NativeLabelMutationPrepareRequest,
    NativeWorkflowCheckpointResult, NativeWorkflowJobStatus, NativeWorkflowJobType,
    NativeWorkflowStage, NativeWorkflowStatus, COMPACT_WORKFLOW_SCHEMA_VERSION,
};
use super::compaction;
use super::journal;
use super::review_store;
use super::state::{
    now_ms, PersistedWorkflow, PersistedWorkflowBatchUnitStatus, PersistedWorkflowCheckpoint,
    WorkflowJournalEvent, WorkflowRequeueReason,
};
use crate::ai::command_contract::DesktopStructuredJsonRequest;
use crate::ai::command_contract::ProviderExecutionMetadata;
use crate::native_identity::integrity_hash;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const WORKFLOW_JOURNAL_FILE: &str = "native-book-workflows-v1.jsonl";

#[derive(Clone, Debug)]
pub(crate) struct NativeWorkflowJobClaim {
    pub(crate) workflow_id: String,
    pub(crate) job_id: String,
    pub(crate) fence: u64,
    pub(crate) request: DesktopStructuredJsonRequest,
    pub(crate) batch_unit_id: Option<String>,
}

pub(crate) struct NativeWorkflowStore {
    pub(super) journal_path: PathBuf,
    pub(super) workflows: BTreeMap<String, PersistedWorkflow>,
}

impl NativeWorkflowStore {
    pub(crate) fn open(data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(data_dir)
            .map_err(|_| "native workflow data directory is unavailable".to_string())?;
        let journal_path = data_dir.join(WORKFLOW_JOURNAL_FILE);
        compaction::recover(&journal_path)?;
        let workflows = journal::replay(&journal_path)?;
        Ok(Self {
            journal_path,
            workflows,
        })
    }

    #[cfg(test)]
    pub(crate) fn journal_path(&self) -> &Path {
        &self.journal_path
    }

    pub(crate) fn submit(
        &mut self,
        request: NativeBookWorkflowSubmitRequest,
    ) -> Result<NativeBookWorkflowView, String> {
        request.validate()?;
        let workflow = PersistedWorkflow::from_request(request)?;
        if let Some(existing) = self.workflows.get(&workflow.id) {
            if existing.payload_hash != workflow.payload_hash {
                return Err(
                    "native workflow idempotency key was already used for a different payload"
                        .to_string(),
                );
            }
            return Ok(existing.view());
        }
        let id = workflow.id.clone();
        self.commit(WorkflowJournalEvent::Submitted { workflow })?;
        self.get(&id)
    }

    pub(crate) fn get(&self, workflow_id: &str) -> Result<NativeBookWorkflowView, String> {
        self.workflows
            .get(workflow_id)
            .map(PersistedWorkflow::view)
            .ok_or_else(|| "native workflow was not found".to_string())
    }

    pub(crate) fn get_active(
        &self,
        novel_id: &str,
        content_revision: &str,
    ) -> Result<Option<NativeBookWorkflowView>, String> {
        super::command_contract::validate_identifier(novel_id, "workflow novel id")?;
        super::command_contract::validate_identifier(
            content_revision,
            "workflow content revision",
        )?;
        Ok(self
            .workflows
            .values()
            .filter(|workflow| {
                workflow.novel_id == novel_id
                    && workflow.content_revision == content_revision
                    && workflow.is_active()
            })
            .max_by_key(|workflow| (workflow.created_at_ms, workflow.updated_at_ms))
            .map(PersistedWorkflow::view))
    }

    pub(crate) fn checkpoint(
        &self,
        workflow_id: &str,
        job_id: &str,
    ) -> Result<NativeWorkflowCheckpointResult, String> {
        let workflow = self
            .workflows
            .get(workflow_id)
            .ok_or_else(|| "native workflow was not found".to_string())?;
        let checkpoint = workflow
            .checkpoints
            .iter()
            .find(|checkpoint| checkpoint.job_id == job_id)
            .ok_or_else(|| "native workflow checkpoint was not found".to_string())?;
        Ok(NativeWorkflowCheckpointResult {
            workflow_id: workflow.id.clone(),
            job_id: checkpoint.job_id.clone(),
            request_hash: checkpoint.request_hash.clone(),
            output_hash: checkpoint.output_hash.clone(),
            job_type: checkpoint.job_type,
            contract_fingerprint: checkpoint.contract_fingerprint.clone(),
            output: checkpoint.output.clone(),
            provider_execution: checkpoint.provider_execution.clone(),
        })
    }

    pub(crate) fn materialize(
        &mut self,
        input: NativeBookWorkflowMaterializeRequest,
    ) -> Result<NativeBookWorkflowView, String> {
        input.validate()?;
        let request_hash = match (&input.request, &input.batch) {
            (Some(request), None) => integrity_hash(request)?,
            (None, Some(batch)) => integrity_hash(batch)?,
            _ => unreachable!("validated materialization payload"),
        };
        let workflow = self
            .workflows
            .get(&input.workflow_id)
            .ok_or_else(|| "native workflow was not found".to_string())?;
        if workflow.fence != input.expected_fence {
            return Err("native workflow materialize fence is stale".to_string());
        }
        let job = workflow
            .jobs
            .iter()
            .find(|job| job.id == input.job_id)
            .ok_or_else(|| "native workflow job was not found".to_string())?;
        let compact_speaker_job = workflow.schema_version == COMPACT_WORKFLOW_SCHEMA_VERSION
            && job.stage == NativeWorkflowStage::ChapterLabeling
            && job.job_type == Some(NativeWorkflowJobType::SpeakerAttributionV3);
        if compact_speaker_job && input.batch.is_none() {
            return Err(
                "native compact speaker attribution jobs require batch materialization".to_string(),
            );
        }
        if input.batch.is_some()
            && (workflow.schema_version != COMPACT_WORKFLOW_SCHEMA_VERSION
                || job.stage != NativeWorkflowStage::ChapterLabeling
                || job.job_type != Some(NativeWorkflowJobType::SpeakerAttributionV3))
        {
            return Err(
                "native workflow batches require a schema-v3 speaker attribution job".to_string(),
            );
        }
        if let Some(existing_hash) = &job.request_hash {
            if existing_hash == &request_hash {
                return Ok(workflow.view());
            }
            return Err("native workflow materialized request drift was rejected".to_string());
        }
        if workflow.current_stage() != Some(job.stage) {
            return Err("native workflow stage dependencies are incomplete".to_string());
        }
        if matches!(
            job.stage,
            NativeWorkflowStage::CharacterGraphBootstrap | NativeWorkflowStage::ChapterLabeling
        ) && workflow.jobs.iter().any(|prior| {
            prior.stage == job.stage
                && prior.sequence < job.sequence
                && prior.status != NativeWorkflowJobStatus::Succeeded
        }) {
            return Err("native workflow jobs must materialize sequentially".to_string());
        }
        let job_type = job.job_type;
        let contract_fingerprint = job.contract_fingerprint.clone();
        let event = match (input.request, input.batch) {
            (Some(request), None) => WorkflowJournalEvent::JobMaterialized {
                workflow_id: input.workflow_id.clone(),
                job_id: input.job_id,
                fence: input.expected_fence,
                request_hash,
                request,
                job_type,
                contract_fingerprint,
                updated_at_ms: now_ms(),
            },
            (None, Some(batch)) => WorkflowJournalEvent::JobBatchMaterialized {
                workflow_id: input.workflow_id.clone(),
                job_id: input.job_id,
                fence: input.expected_fence,
                request_hash,
                batch,
                job_type: job_type.expect("validated batch job type"),
                contract_fingerprint: contract_fingerprint
                    .expect("validated batch contract fingerprint"),
                updated_at_ms: now_ms(),
            },
            _ => unreachable!("validated materialization payload"),
        };
        self.commit(event)?;
        self.get(&input.workflow_id)
    }

    pub(crate) fn finalize_readiness(
        &mut self,
        input: NativeBookWorkflowFinalizeRequest,
    ) -> Result<NativeBookWorkflowView, String> {
        review_store::finalize_readiness(self, input)
    }

    pub(crate) fn require_review(
        &mut self,
        input: NativeBookWorkflowReviewRequest,
    ) -> Result<NativeBookWorkflowView, String> {
        review_store::require_review(self, input)
    }

    pub(crate) fn prepare_label_mutation(
        &mut self,
        input: NativeLabelMutationPrepareRequest,
    ) -> Result<NativeBookWorkflowView, String> {
        review_store::prepare_label_mutation(self, input)
    }

    pub(crate) fn finalize_label_mutation(
        &mut self,
        input: NativeLabelMutationFinalizeRequest,
    ) -> Result<NativeBookWorkflowView, String> {
        review_store::finalize_label_mutation(self, input)
    }

    pub(crate) fn recover_interrupted(&mut self) -> Result<Vec<String>, String> {
        let interrupted = self
            .workflows
            .values()
            .filter(|workflow| workflow.status == NativeWorkflowStatus::Running)
            .map(|workflow| {
                let job_ids = workflow
                    .jobs
                    .iter()
                    .filter(|job| job.status == NativeWorkflowJobStatus::Running)
                    .map(|job| job.id.clone())
                    .collect::<Vec<_>>();
                (workflow.id.clone(), workflow.fence + 1, job_ids)
            })
            .collect::<Vec<_>>();
        for (workflow_id, fence, job_ids) in interrupted {
            self.commit(WorkflowJournalEvent::Requeued {
                workflow_id,
                fence,
                job_ids,
                reason: WorkflowRequeueReason::ProcessRestart,
                updated_at_ms: now_ms(),
            })?;
        }
        Ok(self
            .workflows
            .values()
            .filter(|workflow| workflow.status == NativeWorkflowStatus::Queued)
            .map(|workflow| workflow.id.clone())
            .collect())
    }

    pub(crate) fn resume(&mut self, workflow_id: &str) -> Result<NativeBookWorkflowView, String> {
        let workflow = self
            .workflows
            .get(workflow_id)
            .ok_or_else(|| "native workflow was not found".to_string())?;
        match workflow.status {
            NativeWorkflowStatus::Succeeded
            | NativeWorkflowStatus::Queued
            | NativeWorkflowStatus::WaitingForInput
            | NativeWorkflowStatus::Running
            | NativeWorkflowStatus::NeedsReview => return Ok(workflow.view()),
            NativeWorkflowStatus::Cancelled => {
                return Err("cancelled native workflows cannot be resumed".to_string())
            }
            NativeWorkflowStatus::Failed => {}
        }
        let fence = workflow.fence + 1;
        let job_ids = workflow
            .jobs
            .iter()
            .filter(|job| job.status == NativeWorkflowJobStatus::Failed)
            .map(|job| job.id.clone())
            .collect();
        self.commit(WorkflowJournalEvent::Requeued {
            workflow_id: workflow_id.to_string(),
            fence,
            job_ids,
            reason: WorkflowRequeueReason::ExplicitResume,
            updated_at_ms: now_ms(),
        })?;
        self.get(workflow_id)
    }

    pub(crate) fn cancel(&mut self, workflow_id: &str) -> Result<NativeBookWorkflowView, String> {
        let workflow = self
            .workflows
            .get(workflow_id)
            .ok_or_else(|| "native workflow was not found".to_string())?;
        if matches!(
            workflow.status,
            NativeWorkflowStatus::Succeeded | NativeWorkflowStatus::Cancelled
        ) {
            return Ok(workflow.view());
        }
        self.commit(WorkflowJournalEvent::Cancelled {
            workflow_id: workflow_id.to_string(),
            fence: workflow.fence + 1,
            updated_at_ms: now_ms(),
        })?;
        self.get(workflow_id)
    }

    pub(crate) fn claim_next(
        &mut self,
        workflow_id: &str,
    ) -> Result<Option<NativeWorkflowJobClaim>, String> {
        loop {
            let workflow = self
                .workflows
                .get(workflow_id)
                .ok_or_else(|| "native workflow was not found".to_string())?;
            if !matches!(
                workflow.status,
                NativeWorkflowStatus::Queued | NativeWorkflowStatus::Running
            ) {
                return Ok(None);
            }
            let Some(current_stage) = workflow.current_stage() else {
                return Ok(None);
            };
            if current_stage == NativeWorkflowStage::TtsReadyPreparation {
                return Ok(None);
            }
            if workflow.jobs.iter().any(|job| {
                job.stage == current_stage && job.status == NativeWorkflowJobStatus::Running
            }) {
                return Ok(None);
            }
            if let Some(job) = workflow.jobs.iter().find(|job| {
                job.stage == current_stage && job.status != NativeWorkflowJobStatus::Succeeded
            }) {
                if job.status != NativeWorkflowJobStatus::Queued {
                    return Ok(None);
                }
                let (claim, event) = if let Some(batch) = &job.batch {
                    let unit = batch
                        .units
                        .iter()
                        .find(|unit| unit.status != PersistedWorkflowBatchUnitStatus::Succeeded)
                        .ok_or_else(|| "native workflow queued batch is complete".to_string())?;
                    if unit.status != PersistedWorkflowBatchUnitStatus::Queued {
                        return Ok(None);
                    }
                    let claim = NativeWorkflowJobClaim {
                        workflow_id: workflow.id.clone(),
                        job_id: job.id.clone(),
                        fence: workflow.fence,
                        request: unit.request.clone().ok_or_else(|| {
                            "native workflow queued batch unit has no request".to_string()
                        })?,
                        batch_unit_id: Some(unit.id.clone()),
                    };
                    let event = WorkflowJournalEvent::BatchUnitClaimed {
                        workflow_id: claim.workflow_id.clone(),
                        job_id: claim.job_id.clone(),
                        unit_id: unit.id.clone(),
                        fence: claim.fence,
                        attempt: unit.attempt + 1,
                        updated_at_ms: now_ms(),
                    };
                    (claim, event)
                } else {
                    let claim = NativeWorkflowJobClaim {
                        workflow_id: workflow.id.clone(),
                        job_id: job.id.clone(),
                        fence: workflow.fence,
                        request: job.request.clone().ok_or_else(|| {
                            "native workflow queued job has no request".to_string()
                        })?,
                        batch_unit_id: None,
                    };
                    let event = WorkflowJournalEvent::JobClaimed {
                        workflow_id: claim.workflow_id.clone(),
                        job_id: claim.job_id.clone(),
                        fence: claim.fence,
                        attempt: job.attempt + 1,
                        updated_at_ms: now_ms(),
                    };
                    (claim, event)
                };
                self.commit(event)?;
                return Ok(Some(claim));
            }

            let current_index = workflow
                .current_stage_index
                .ok_or_else(|| "native workflow stage checkpoint is invalid".to_string())?;
            let next = workflow
                .stages
                .get(current_index + 1)
                .map(|stage| stage.stage);
            if next.is_none() {
                return Ok(None);
            }
            self.commit(WorkflowJournalEvent::StageAdvanced {
                workflow_id: workflow_id.to_string(),
                from: current_stage,
                to: next,
                updated_at_ms: now_ms(),
            })?;
        }
    }

    #[cfg(test)]
    pub(crate) fn complete_success(
        &mut self,
        claim: &NativeWorkflowJobClaim,
        output: Value,
    ) -> Result<bool, String> {
        self.complete_success_with_metadata(claim, output, None)
    }

    pub(crate) fn complete_success_with_metadata(
        &mut self,
        claim: &NativeWorkflowJobClaim,
        output: Value,
        provider_execution: Option<ProviderExecutionMetadata>,
    ) -> Result<bool, String> {
        let Some(workflow) = self.workflows.get(&claim.workflow_id) else {
            return Ok(false);
        };
        let Some(job) = workflow.jobs.iter().find(|job| job.id == claim.job_id) else {
            return Ok(false);
        };
        if workflow.fence != claim.fence
            || workflow.status != NativeWorkflowStatus::Running
            || job.status != NativeWorkflowJobStatus::Running
            || job.claim_fence != Some(claim.fence)
        {
            return Ok(false);
        }
        if let Some(unit_id) = &claim.batch_unit_id {
            let Some(batch) = &job.batch else {
                return Ok(false);
            };
            let Some(unit) = batch.units.iter().find(|unit| unit.id == *unit_id) else {
                return Ok(false);
            };
            if unit.status != PersistedWorkflowBatchUnitStatus::Running
                || unit.claim_fence != Some(claim.fence)
            {
                return Ok(false);
            }
            let output_hash = integrity_hash(&output)?;
            let completed_at_ms = now_ms();
            self.commit(WorkflowJournalEvent::BatchUnitSucceeded {
                workflow_id: claim.workflow_id.clone(),
                job_id: claim.job_id.clone(),
                unit_id: unit_id.clone(),
                fence: claim.fence,
                output_hash,
                output,
                provider_execution,
                completed_at_ms,
                updated_at_ms: completed_at_ms,
            })?;
            return Ok(true);
        }
        if job.batch.is_some() {
            return Ok(false);
        }
        let request_hash = job
            .request_hash
            .clone()
            .ok_or_else(|| "native workflow running job has no request hash".to_string())?;
        let checkpoint = PersistedWorkflowCheckpoint {
            job_id: job.id.clone(),
            stage: job.stage,
            sequence: job.sequence,
            request_hash,
            output_hash: integrity_hash(&output)?,
            job_type: job.job_type,
            contract_fingerprint: job.contract_fingerprint.clone(),
            output,
            provider_execution,
            completed_at_ms: now_ms(),
        };
        self.commit(WorkflowJournalEvent::JobSucceeded {
            workflow_id: claim.workflow_id.clone(),
            job_id: claim.job_id.clone(),
            fence: claim.fence,
            checkpoint,
            updated_at_ms: now_ms(),
        })?;
        Ok(true)
    }

    pub(crate) fn complete_failure(
        &mut self,
        claim: &NativeWorkflowJobClaim,
    ) -> Result<bool, String> {
        let Some(workflow) = self.workflows.get(&claim.workflow_id) else {
            return Ok(false);
        };
        let Some(job) = workflow.jobs.iter().find(|job| job.id == claim.job_id) else {
            return Ok(false);
        };
        if workflow.fence != claim.fence
            || workflow.status != NativeWorkflowStatus::Running
            || job.status != NativeWorkflowJobStatus::Running
            || job.claim_fence != Some(claim.fence)
        {
            return Ok(false);
        }
        let event = if let Some(unit_id) = &claim.batch_unit_id {
            let Some(batch) = &job.batch else {
                return Ok(false);
            };
            let Some(unit) = batch.units.iter().find(|unit| unit.id == *unit_id) else {
                return Ok(false);
            };
            if unit.status != PersistedWorkflowBatchUnitStatus::Running
                || unit.claim_fence != Some(claim.fence)
            {
                return Ok(false);
            }
            WorkflowJournalEvent::BatchUnitFailed {
                workflow_id: claim.workflow_id.clone(),
                job_id: claim.job_id.clone(),
                unit_id: unit_id.clone(),
                fence: claim.fence,
                error_code: "provider_request_failed".to_string(),
                updated_at_ms: now_ms(),
            }
        } else {
            if job.batch.is_some() {
                return Ok(false);
            }
            WorkflowJournalEvent::JobFailed {
                workflow_id: claim.workflow_id.clone(),
                job_id: claim.job_id.clone(),
                fence: claim.fence,
                error_code: "provider_request_failed".to_string(),
                updated_at_ms: now_ms(),
            }
        };
        self.commit(event)?;
        Ok(true)
    }

    pub(super) fn commit(&mut self, event: WorkflowJournalEvent) -> Result<(), String> {
        if matches!(
            &event,
            WorkflowJournalEvent::JobSucceeded { .. }
                | WorkflowJournalEvent::JobBatchMaterialized { .. }
                | WorkflowJournalEvent::BatchUnitSucceeded { .. }
                | WorkflowJournalEvent::ReadinessFinalized { .. }
                | WorkflowJournalEvent::ReviewRequired { .. }
                | WorkflowJournalEvent::Cancelled { .. }
        ) {
            let mut next = self.workflows.clone();
            journal::apply_event(&mut next, event)?;
            if let Err(error) = compaction::compact(&self.journal_path, &mut next) {
                compaction::recover(&self.journal_path)?;
                self.workflows = journal::replay(&self.journal_path)?;
                return Err(error);
            }
            self.workflows = next;
            Ok(())
        } else {
            journal::commit(&self.journal_path, &mut self.workflows, event)
        }
    }
}

#[cfg(test)]
#[path = "store.test.rs"]
mod tests;

#[cfg(test)]
#[path = "persistence.test.rs"]
mod persistence_tests;

#[cfg(test)]
#[path = "review.test.rs"]
mod review_tests;

#[cfg(test)]
#[path = "batch.test.rs"]
mod batch_tests;
