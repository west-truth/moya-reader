use super::command_contract::{
    NativeWorkflowJobStatus, NativeWorkflowJobType, NativeWorkflowStage, NativeWorkflowStatus,
    COMPACT_WORKFLOW_SCHEMA_VERSION, WORKFLOW_SCHEMA_VERSION,
};
use super::review_transition;
use super::state::{
    PersistedWorkflow, PersistedWorkflowBatch, PersistedWorkflowBatchUnitStatus,
    PersistedWorkflowCheckpoint, WorkflowJournalEvent, WorkflowRequeueReason,
    LEGACY_WORKFLOW_SCHEMA_VERSION,
};
use crate::native_identity::integrity_hash;
use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

pub(super) fn replay(journal_path: &Path) -> Result<BTreeMap<String, PersistedWorkflow>, String> {
    let file = match OpenOptions::new().read(true).write(true).open(journal_path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(_) => return Err("native workflow journal is unavailable".to_string()),
    };
    let mut workflows = BTreeMap::new();
    let mut reader = BufReader::new(&file);
    let mut line = Vec::new();
    let mut valid_len = 0_u64;
    loop {
        line.clear();
        let bytes = reader
            .read_until(b'\n', &mut line)
            .map_err(|_| "native workflow journal could not be read".to_string())?;
        if bytes == 0 {
            break;
        }
        if !line.ends_with(b"\n") {
            drop(reader);
            file.set_len(valid_len)
                .and_then(|_| file.sync_all())
                .map_err(|_| {
                    "native workflow torn journal tail could not be repaired".to_string()
                })?;
            break;
        }
        let event = serde_json::from_slice::<WorkflowJournalEvent>(&line)
            .map_err(|_| "native workflow journal contains invalid state".to_string())?;
        apply_event(&mut workflows, event)?;
        valid_len += bytes as u64;
    }
    Ok(workflows)
}

pub(super) fn commit(
    journal_path: &Path,
    workflows: &mut BTreeMap<String, PersistedWorkflow>,
    event: WorkflowJournalEvent,
) -> Result<(), String> {
    let mut next = workflows.clone();
    apply_event(&mut next, event.clone())?;
    let encoded = serde_json::to_vec(&event)
        .map_err(|_| "native workflow event could not be serialized".to_string())?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(journal_path)
        .map_err(|_| "native workflow journal is unavailable".to_string())?;
    file.write_all(&encoded)
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
        .map_err(|_| "native workflow event could not be persisted".to_string())?;
    *workflows = next;
    Ok(())
}

pub(super) fn apply_event(
    workflows: &mut BTreeMap<String, PersistedWorkflow>,
    event: WorkflowJournalEvent,
) -> Result<(), String> {
    match event {
        WorkflowJournalEvent::Submitted { workflow } => apply_submitted(workflows, workflow),
        WorkflowJournalEvent::SnapshotCompleted {
            workflow_count,
            state_hash,
        } => {
            if workflow_count != workflows.len() || integrity_hash(workflows)? != state_hash {
                return Err("native workflow snapshot completion marker is invalid".to_string());
            }
            Ok(())
        }
        WorkflowJournalEvent::JobMaterialized {
            workflow_id,
            job_id,
            fence,
            request_hash,
            request,
            job_type,
            contract_fingerprint,
            updated_at_ms,
        } => {
            if integrity_hash(&request)? != request_hash {
                return Err("native workflow materialized request hash is invalid".to_string());
            }
            let workflow = workflow_mut(workflows, &workflow_id)?;
            if workflow.fence != fence || !workflow.is_active() {
                return Err("native workflow materialize fence is invalid".to_string());
            }
            let current_stage = workflow
                .current_stage()
                .ok_or_else(|| "native workflow materialize stage is invalid".to_string())?;
            let job_index = workflow
                .jobs
                .iter()
                .position(|job| job.id == job_id)
                .ok_or_else(|| "native workflow materialize job is invalid".to_string())?;
            let job = &workflow.jobs[job_index];
            if job.stage != current_stage
                || job.status != NativeWorkflowJobStatus::WaitingForInput
                || (workflow.schema_version == COMPACT_WORKFLOW_SCHEMA_VERSION
                    && job.job_type == Some(NativeWorkflowJobType::SpeakerAttributionV3))
                || job.request.is_some()
                || job.batch.is_some()
                || job.request_hash.is_some()
                || job.job_type != job_type
                || job.contract_fingerprint != contract_fingerprint
            {
                return Err("native workflow materialize transition is invalid".to_string());
            }
            ensure_prior_jobs_succeeded(workflow, job_index)?;
            let job = &mut workflow.jobs[job_index];
            job.provider_id = Some(request.provider_id.clone());
            job.model_id = Some(request.model_id.clone());
            job.request = Some(request);
            job.request_hash = Some(request_hash);
            job.status = NativeWorkflowJobStatus::Queued;
            job.error_code = None;
            workflow.status = workflow.pending_status();
            workflow.error_code = None;
            workflow.updated_at_ms = updated_at_ms;
            Ok(())
        }
        WorkflowJournalEvent::JobBatchMaterialized {
            workflow_id,
            job_id,
            fence,
            request_hash,
            batch,
            job_type,
            contract_fingerprint,
            updated_at_ms,
        } => {
            batch.validate()?;
            if integrity_hash(&batch)? != request_hash {
                return Err("native workflow materialized batch hash is invalid".to_string());
            }
            let workflow = workflow_mut(workflows, &workflow_id)?;
            if workflow.schema_version != COMPACT_WORKFLOW_SCHEMA_VERSION
                || workflow.fence != fence
                || !workflow.is_active()
            {
                return Err("native workflow batch materialize fence is invalid".to_string());
            }
            let current_stage = workflow
                .current_stage()
                .ok_or_else(|| "native workflow batch materialize stage is invalid".to_string())?;
            let job_index = workflow
                .jobs
                .iter()
                .position(|job| job.id == job_id)
                .ok_or_else(|| "native workflow batch materialize job is invalid".to_string())?;
            let job = &workflow.jobs[job_index];
            if current_stage != NativeWorkflowStage::ChapterLabeling
                || job.stage != NativeWorkflowStage::ChapterLabeling
                || job.status != NativeWorkflowJobStatus::WaitingForInput
                || job.request.is_some()
                || job.batch.is_some()
                || job.request_hash.is_some()
                || job_type != NativeWorkflowJobType::SpeakerAttributionV3
                || job.job_type != Some(job_type)
                || job.contract_fingerprint.as_deref() != Some(contract_fingerprint.as_str())
            {
                return Err("native workflow batch materialize transition is invalid".to_string());
            }
            ensure_prior_jobs_succeeded(workflow, job_index)?;
            let persisted_batch = PersistedWorkflowBatch::from_materialized(batch)?;
            let completes_immediately = persisted_batch.units.is_empty();
            let checkpoint = if completes_immediately {
                let output = persisted_batch.aggregate_output()?;
                Some(PersistedWorkflowCheckpoint {
                    job_id: job_id.clone(),
                    stage: job.stage,
                    sequence: job.sequence,
                    request_hash: request_hash.clone(),
                    output_hash: integrity_hash(&output)?,
                    job_type: job.job_type,
                    contract_fingerprint: job.contract_fingerprint.clone(),
                    output,
                    provider_execution: None,
                    completed_at_ms: updated_at_ms,
                })
            } else {
                None
            };
            let job = &mut workflow.jobs[job_index];
            job.request_hash = Some(request_hash);
            job.batch = Some(persisted_batch);
            job.status = if completes_immediately {
                NativeWorkflowJobStatus::Succeeded
            } else {
                NativeWorkflowJobStatus::Queued
            };
            job.error_code = None;
            if let Some(checkpoint) = checkpoint {
                workflow.checkpoints.push(checkpoint);
            }
            workflow.status = workflow.pending_status();
            workflow.error_code = None;
            workflow.updated_at_ms = updated_at_ms;
            Ok(())
        }
        WorkflowJournalEvent::JobClaimed {
            workflow_id,
            job_id,
            fence,
            attempt,
            updated_at_ms,
        } => {
            let workflow = workflow_mut(workflows, &workflow_id)?;
            let current_stage = workflow
                .current_stage()
                .ok_or_else(|| "native workflow claim stage is invalid".to_string())?;
            if workflow.fence != fence
                || !matches!(
                    workflow.status,
                    NativeWorkflowStatus::Queued | NativeWorkflowStatus::Running
                )
            {
                return Err("native workflow claim fence is invalid".to_string());
            }
            let job = workflow
                .jobs
                .iter_mut()
                .find(|job| job.id == job_id)
                .ok_or_else(|| "native workflow claim job is invalid".to_string())?;
            if job.stage != current_stage
                || job.status != NativeWorkflowJobStatus::Queued
                || job.request.is_none()
                || job.batch.is_some()
                || job.request_hash.is_none()
                || attempt != job.attempt + 1
            {
                return Err("native workflow job claim transition is invalid".to_string());
            }
            job.status = NativeWorkflowJobStatus::Running;
            job.attempt = attempt;
            job.claim_fence = Some(fence);
            job.error_code = None;
            workflow.status = NativeWorkflowStatus::Running;
            workflow.error_code = None;
            workflow.updated_at_ms = updated_at_ms;
            Ok(())
        }
        WorkflowJournalEvent::JobSucceeded {
            workflow_id,
            job_id,
            fence,
            checkpoint,
            updated_at_ms,
        } => {
            let workflow = workflow_mut(workflows, &workflow_id)?;
            let job = workflow
                .jobs
                .iter_mut()
                .find(|job| job.id == job_id)
                .ok_or_else(|| "native workflow result job is invalid".to_string())?;
            if workflow.fence != fence
                || workflow.status != NativeWorkflowStatus::Running
                || job.status != NativeWorkflowJobStatus::Running
                || job.claim_fence != Some(fence)
                || job.batch.is_some()
                || checkpoint.job_id != job.id
                || checkpoint.stage != job.stage
                || checkpoint.sequence != job.sequence
                || job.request_hash.as_deref() != Some(checkpoint.request_hash.as_str())
                || integrity_hash(&checkpoint.output)? != checkpoint.output_hash
            {
                return Err("native workflow result fence is invalid".to_string());
            }
            job.status = NativeWorkflowJobStatus::Succeeded;
            job.claim_fence = None;
            job.error_code = None;
            workflow.checkpoints.push(checkpoint);
            workflow.status = workflow.pending_status();
            workflow.updated_at_ms = updated_at_ms;
            Ok(())
        }
        WorkflowJournalEvent::JobFailed {
            workflow_id,
            job_id,
            fence,
            error_code,
            updated_at_ms,
        } => {
            let workflow = workflow_mut(workflows, &workflow_id)?;
            let job = workflow
                .jobs
                .iter_mut()
                .find(|job| job.id == job_id)
                .ok_or_else(|| "native workflow failure job is invalid".to_string())?;
            if workflow.fence != fence
                || workflow.status != NativeWorkflowStatus::Running
                || job.status != NativeWorkflowJobStatus::Running
                || job.claim_fence != Some(fence)
                || job.batch.is_some()
            {
                return Err("native workflow failure fence is invalid".to_string());
            }
            job.status = NativeWorkflowJobStatus::Failed;
            job.claim_fence = None;
            job.error_code = Some(error_code.clone());
            workflow.status = NativeWorkflowStatus::Failed;
            workflow.error_code = Some(error_code);
            workflow.updated_at_ms = updated_at_ms;
            Ok(())
        }
        WorkflowJournalEvent::BatchUnitClaimed {
            workflow_id,
            job_id,
            unit_id,
            fence,
            attempt,
            updated_at_ms,
        } => {
            let workflow = workflow_mut(workflows, &workflow_id)?;
            let current_stage = workflow
                .current_stage()
                .ok_or_else(|| "native workflow batch claim stage is invalid".to_string())?;
            if workflow.fence != fence
                || current_stage != NativeWorkflowStage::ChapterLabeling
                || !matches!(
                    workflow.status,
                    NativeWorkflowStatus::Queued | NativeWorkflowStatus::Running
                )
            {
                return Err("native workflow batch claim fence is invalid".to_string());
            }
            let job = workflow
                .jobs
                .iter_mut()
                .find(|job| job.id == job_id)
                .ok_or_else(|| "native workflow batch claim job is invalid".to_string())?;
            let batch = job
                .batch
                .as_mut()
                .ok_or_else(|| "native workflow batch claim state is missing".to_string())?;
            let unit = batch
                .units
                .iter_mut()
                .find(|unit| unit.status != PersistedWorkflowBatchUnitStatus::Succeeded)
                .ok_or_else(|| "native workflow batch claim is complete".to_string())?;
            if job.stage != current_stage
                || job.status != NativeWorkflowJobStatus::Queued
                || unit.id != unit_id
                || unit.status != PersistedWorkflowBatchUnitStatus::Queued
                || unit.request.is_none()
                || attempt != unit.attempt + 1
            {
                return Err("native workflow batch unit claim transition is invalid".to_string());
            }
            unit.status = PersistedWorkflowBatchUnitStatus::Running;
            unit.attempt = attempt;
            unit.claim_fence = Some(fence);
            job.status = NativeWorkflowJobStatus::Running;
            job.attempt = job
                .attempt
                .checked_add(1)
                .ok_or_else(|| "native workflow batch attempt overflowed".to_string())?;
            job.claim_fence = Some(fence);
            job.error_code = None;
            workflow.status = NativeWorkflowStatus::Running;
            workflow.error_code = None;
            workflow.updated_at_ms = updated_at_ms;
            Ok(())
        }
        WorkflowJournalEvent::BatchUnitSucceeded {
            workflow_id,
            job_id,
            unit_id,
            fence,
            output_hash,
            output,
            provider_execution,
            completed_at_ms,
            updated_at_ms,
        } => {
            if integrity_hash(&output)? != output_hash {
                return Err("native workflow batch unit output hash is invalid".to_string());
            }
            let workflow = workflow_mut(workflows, &workflow_id)?;
            if workflow.fence != fence || workflow.status != NativeWorkflowStatus::Running {
                return Err("native workflow batch result fence is invalid".to_string());
            }
            let job_index = workflow
                .jobs
                .iter()
                .position(|job| job.id == job_id)
                .ok_or_else(|| "native workflow batch result job is invalid".to_string())?;
            let checkpoint = {
                let job = &mut workflow.jobs[job_index];
                let batch = job
                    .batch
                    .as_mut()
                    .ok_or_else(|| "native workflow batch result state is missing".to_string())?;
                let unit = batch
                    .units
                    .iter_mut()
                    .find(|unit| unit.id == unit_id)
                    .ok_or_else(|| "native workflow batch result unit is invalid".to_string())?;
                if job.status != NativeWorkflowJobStatus::Running
                    || job.claim_fence != Some(fence)
                    || unit.status != PersistedWorkflowBatchUnitStatus::Running
                    || unit.claim_fence != Some(fence)
                {
                    return Err("native workflow batch result fence is invalid".to_string());
                }
                unit.status = PersistedWorkflowBatchUnitStatus::Succeeded;
                unit.claim_fence = None;
                unit.output_hash = Some(output_hash);
                unit.output = Some(output);
                unit.provider_execution = provider_execution;
                unit.completed_at_ms = Some(completed_at_ms);
                job.claim_fence = None;
                job.error_code = None;
                if batch
                    .units
                    .iter()
                    .all(|unit| unit.status == PersistedWorkflowBatchUnitStatus::Succeeded)
                {
                    let aggregate = batch.aggregate_output()?;
                    job.status = NativeWorkflowJobStatus::Succeeded;
                    Some(PersistedWorkflowCheckpoint {
                        job_id: job.id.clone(),
                        stage: job.stage,
                        sequence: job.sequence,
                        request_hash: job.request_hash.clone().ok_or_else(|| {
                            "native workflow batch request hash is missing".to_string()
                        })?,
                        output_hash: integrity_hash(&aggregate)?,
                        job_type: job.job_type,
                        contract_fingerprint: job.contract_fingerprint.clone(),
                        output: aggregate,
                        provider_execution: None,
                        completed_at_ms,
                    })
                } else {
                    job.status = NativeWorkflowJobStatus::Queued;
                    None
                }
            };
            if let Some(checkpoint) = checkpoint {
                workflow.checkpoints.push(checkpoint);
            }
            workflow.status = workflow.pending_status();
            workflow.updated_at_ms = updated_at_ms;
            Ok(())
        }
        WorkflowJournalEvent::BatchUnitFailed {
            workflow_id,
            job_id,
            unit_id,
            fence,
            error_code,
            updated_at_ms,
        } => {
            let workflow = workflow_mut(workflows, &workflow_id)?;
            if workflow.fence != fence || workflow.status != NativeWorkflowStatus::Running {
                return Err("native workflow batch failure fence is invalid".to_string());
            }
            let job = workflow
                .jobs
                .iter_mut()
                .find(|job| job.id == job_id)
                .ok_or_else(|| "native workflow batch failure job is invalid".to_string())?;
            let batch = job
                .batch
                .as_mut()
                .ok_or_else(|| "native workflow batch failure state is missing".to_string())?;
            let unit = batch
                .units
                .iter_mut()
                .find(|unit| unit.id == unit_id)
                .ok_or_else(|| "native workflow batch failure unit is invalid".to_string())?;
            if job.status != NativeWorkflowJobStatus::Running
                || job.claim_fence != Some(fence)
                || unit.status != PersistedWorkflowBatchUnitStatus::Running
                || unit.claim_fence != Some(fence)
            {
                return Err("native workflow batch failure fence is invalid".to_string());
            }
            unit.status = PersistedWorkflowBatchUnitStatus::Failed;
            unit.claim_fence = None;
            job.status = NativeWorkflowJobStatus::Failed;
            job.claim_fence = None;
            job.error_code = Some(error_code.clone());
            workflow.status = NativeWorkflowStatus::Failed;
            workflow.error_code = Some(error_code);
            workflow.updated_at_ms = updated_at_ms;
            Ok(())
        }
        WorkflowJournalEvent::StageAdvanced {
            workflow_id,
            from,
            to,
            updated_at_ms,
        } => apply_stage_advanced(workflows, &workflow_id, from, to, updated_at_ms),
        WorkflowJournalEvent::ReadinessFinalized {
            workflow_id,
            fence,
            outcome,
            review_items,
            updated_at_ms,
        } => review_transition::apply_readiness_finalized(
            workflows,
            &workflow_id,
            fence,
            outcome,
            review_items,
            updated_at_ms,
        ),
        WorkflowJournalEvent::ReviewRequired {
            workflow_id,
            fence,
            error_code,
            review_items,
            updated_at_ms,
        } => review_transition::apply_review_required(
            workflows,
            &workflow_id,
            fence,
            error_code,
            review_items,
            updated_at_ms,
        ),
        WorkflowJournalEvent::LabelMutationPrepared {
            workflow_id,
            fence,
            pending,
            updated_at_ms,
        } => review_transition::apply_label_mutation_prepared(
            workflows,
            &workflow_id,
            fence,
            pending,
            updated_at_ms,
        ),
        WorkflowJournalEvent::LabelMutationFinalized {
            workflow_id,
            fence,
            receipt,
            resume_after_review,
            updated_at_ms,
        } => review_transition::apply_label_mutation_finalized(
            workflows,
            &workflow_id,
            fence,
            receipt,
            resume_after_review,
            updated_at_ms,
        ),
        WorkflowJournalEvent::Requeued {
            workflow_id,
            fence,
            job_ids,
            reason,
            updated_at_ms,
        } => apply_requeued(
            workflows,
            &workflow_id,
            fence,
            job_ids,
            reason,
            updated_at_ms,
        ),
        WorkflowJournalEvent::Cancelled {
            workflow_id,
            fence,
            updated_at_ms,
        } => apply_cancelled(workflows, &workflow_id, fence, updated_at_ms),
    }
}

fn apply_submitted(
    workflows: &mut BTreeMap<String, PersistedWorkflow>,
    mut workflow: PersistedWorkflow,
) -> Result<(), String> {
    if !matches!(
        workflow.schema_version,
        LEGACY_WORKFLOW_SCHEMA_VERSION | WORKFLOW_SCHEMA_VERSION | COMPACT_WORKFLOW_SCHEMA_VERSION
    ) || workflows.contains_key(&workflow.id)
    {
        return Err("native workflow submit event is invalid".to_string());
    }
    workflow.validate_snapshot_integrity()?;
    workflows.insert(workflow.id.clone(), workflow);
    Ok(())
}

fn ensure_prior_jobs_succeeded(
    workflow: &PersistedWorkflow,
    job_index: usize,
) -> Result<(), String> {
    let job = &workflow.jobs[job_index];
    if matches!(
        job.stage,
        NativeWorkflowStage::CharacterGraphBootstrap | NativeWorkflowStage::ChapterLabeling
    ) && workflow.jobs[..job_index]
        .iter()
        .any(|prior| prior.stage == job.stage && prior.status != NativeWorkflowJobStatus::Succeeded)
    {
        return Err("native workflow jobs must materialize sequentially".to_string());
    }
    Ok(())
}

fn apply_stage_advanced(
    workflows: &mut BTreeMap<String, PersistedWorkflow>,
    workflow_id: &str,
    from: NativeWorkflowStage,
    to: Option<NativeWorkflowStage>,
    updated_at_ms: u64,
) -> Result<(), String> {
    let workflow = workflow_mut(workflows, workflow_id)?;
    let index = workflow
        .current_stage_index
        .ok_or_else(|| "native workflow stage transition is invalid".to_string())?;
    if workflow.current_stage() != Some(from)
        || workflow
            .jobs
            .iter()
            .any(|job| job.stage == from && job.status != NativeWorkflowJobStatus::Succeeded)
    {
        return Err("native workflow stage checkpoint is incomplete".to_string());
    }
    let expected = workflow.stages.get(index + 1).map(|stage| stage.stage);
    let valid_terminal_legacy = to.is_none()
        && workflow.schema_version == LEGACY_WORKFLOW_SCHEMA_VERSION
        && index + 1 == workflow.stages.len();
    if expected != to
        || to.is_some_and(|next| !workflow.supports_transition(from, next))
        || (to.is_none() && !valid_terminal_legacy)
    {
        return Err("native workflow stage transition is invalid".to_string());
    }
    workflow.current_stage_index = to.map(|_| index + 1);
    workflow.status = if to.is_some() {
        workflow.pending_status()
    } else {
        NativeWorkflowStatus::Succeeded
    };
    workflow.updated_at_ms = updated_at_ms;
    Ok(())
}

fn apply_requeued(
    workflows: &mut BTreeMap<String, PersistedWorkflow>,
    workflow_id: &str,
    fence: u64,
    job_ids: Vec<String>,
    reason: WorkflowRequeueReason,
    updated_at_ms: u64,
) -> Result<(), String> {
    let workflow = workflow_mut(workflows, workflow_id)?;
    let expected_status = match reason {
        WorkflowRequeueReason::ProcessRestart => NativeWorkflowStatus::Running,
        WorkflowRequeueReason::ExplicitResume => NativeWorkflowStatus::Failed,
    };
    if workflow.status != expected_status || fence != workflow.fence + 1 || job_ids.is_empty() {
        return Err("native workflow requeue transition is invalid".to_string());
    }
    for job_id in job_ids {
        let job = workflow
            .jobs
            .iter_mut()
            .find(|job| job.id == job_id)
            .ok_or_else(|| "native workflow requeue job is invalid".to_string())?;
        let expected_job_status = match reason {
            WorkflowRequeueReason::ProcessRestart => NativeWorkflowJobStatus::Running,
            WorkflowRequeueReason::ExplicitResume => NativeWorkflowJobStatus::Failed,
        };
        if job.status != expected_job_status {
            return Err("native workflow requeue job transition is invalid".to_string());
        }
        if let Some(batch) = &mut job.batch {
            let expected_unit_status = match reason {
                WorkflowRequeueReason::ProcessRestart => PersistedWorkflowBatchUnitStatus::Running,
                WorkflowRequeueReason::ExplicitResume => PersistedWorkflowBatchUnitStatus::Failed,
            };
            let unit = batch
                .units
                .iter_mut()
                .find(|unit| unit.status == expected_unit_status)
                .ok_or_else(|| "native workflow requeue batch unit is invalid".to_string())?;
            if unit.request.is_none() {
                return Err("native workflow requeue batch input is missing".to_string());
            }
            unit.status = PersistedWorkflowBatchUnitStatus::Queued;
            unit.claim_fence = None;
        } else if job.request.is_none() {
            return Err("native workflow requeue job transition is invalid".to_string());
        }
        job.status = NativeWorkflowJobStatus::Queued;
        job.claim_fence = None;
        job.error_code = None;
    }
    workflow.fence = fence;
    workflow.status = workflow.pending_status();
    workflow.error_code = None;
    workflow.updated_at_ms = updated_at_ms;
    Ok(())
}

fn apply_cancelled(
    workflows: &mut BTreeMap<String, PersistedWorkflow>,
    workflow_id: &str,
    fence: u64,
    updated_at_ms: u64,
) -> Result<(), String> {
    let workflow = workflow_mut(workflows, workflow_id)?;
    if matches!(
        workflow.status,
        NativeWorkflowStatus::Succeeded | NativeWorkflowStatus::Cancelled
    ) || fence != workflow.fence + 1
    {
        return Err("native workflow cancel transition is invalid".to_string());
    }
    workflow.fence = fence;
    workflow.status = NativeWorkflowStatus::Cancelled;
    workflow.error_code = None;
    for job in &mut workflow.jobs {
        if !matches!(
            job.status,
            NativeWorkflowJobStatus::Succeeded | NativeWorkflowJobStatus::Cancelled
        ) {
            if let Some(batch) = &mut job.batch {
                for unit in &mut batch.units {
                    if unit.status != PersistedWorkflowBatchUnitStatus::Succeeded {
                        unit.status = PersistedWorkflowBatchUnitStatus::Cancelled;
                        unit.claim_fence = None;
                        unit.output_hash = None;
                        unit.output = None;
                        unit.provider_execution = None;
                        unit.completed_at_ms = None;
                    }
                }
            }
            job.status = NativeWorkflowJobStatus::Cancelled;
            job.claim_fence = None;
            job.error_code = None;
        }
    }
    workflow.updated_at_ms = updated_at_ms;
    Ok(())
}

fn workflow_mut<'a>(
    workflows: &'a mut BTreeMap<String, PersistedWorkflow>,
    workflow_id: &str,
) -> Result<&'a mut PersistedWorkflow, String> {
    workflows
        .get_mut(workflow_id)
        .ok_or_else(|| "native workflow event references missing state".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn journal_event_names_cover_v2_state_changes() {
        let materialized = json!({
            "type": "job_materialized",
            "workflow_id": "workflow-1",
            "job_id": "job-1",
            "fence": 1,
            "request_hash": "sha256:request",
            "request": {
                "providerId": "openai",
                "modelId": "gpt-5-mini",
                "prompt": "Return JSON.",
                "responseSchema": { "type": "object" },
                "jsonSchemaName": "workflow_result",
                "providerOptions": null
            },
            "updated_at_ms": 1
        });
        assert!(serde_json::from_value::<WorkflowJournalEvent>(materialized).is_ok());

        let finalized = json!({
            "type": "readiness_finalized",
            "workflow_id": "workflow-1",
            "fence": 1,
            "outcome": "needs_review",
            "review_items": [{ "id": "review-1" }],
            "updated_at_ms": 2
        });
        assert!(serde_json::from_value::<WorkflowJournalEvent>(finalized).is_ok());

        let review_required = json!({
            "type": "review_required",
            "workflow_id": "workflow-1",
            "fence": 2,
            "error_code": "invalid_checkpoint",
            "review_items": [{ "id": "review-1" }],
            "updated_at_ms": 3
        });
        assert!(serde_json::from_value::<WorkflowJournalEvent>(review_required).is_ok());
    }
}
