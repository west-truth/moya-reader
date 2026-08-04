use super::command_contract::{
    NativeLabelMutationPendingView, NativeLabelMutationReceiptView, NativeWorkflowJobStatus,
    NativeWorkflowReadinessOutcome, NativeWorkflowStage, NativeWorkflowStatus,
    COMPACT_WORKFLOW_SCHEMA_VERSION, WORKFLOW_SCHEMA_VERSION,
};
use super::state::{PersistedWorkflow, PersistedWorkflowBatchUnitStatus};
use std::collections::BTreeMap;

fn workflow_mut<'a>(
    workflows: &'a mut BTreeMap<String, PersistedWorkflow>,
    workflow_id: &str,
) -> Result<&'a mut PersistedWorkflow, String> {
    workflows
        .get_mut(workflow_id)
        .ok_or_else(|| "native workflow event references missing state".to_string())
}

pub(super) fn apply_label_mutation_prepared(
    workflows: &mut BTreeMap<String, PersistedWorkflow>,
    workflow_id: &str,
    fence: u64,
    pending: NativeLabelMutationPendingView,
    updated_at_ms: u64,
) -> Result<(), String> {
    let workflow = workflow_mut(workflows, workflow_id)?;
    if workflow.status != NativeWorkflowStatus::NeedsReview
        || workflow.pending_label_mutation.is_some()
        || fence != workflow.fence + 1
    {
        return Err("native label mutation prepare transition is invalid".to_string());
    }
    workflow.fence = fence;
    workflow.pending_label_mutation = Some(pending);
    workflow.updated_at_ms = updated_at_ms;
    Ok(())
}

pub(super) fn apply_label_mutation_finalized(
    workflows: &mut BTreeMap<String, PersistedWorkflow>,
    workflow_id: &str,
    fence: u64,
    receipt: NativeLabelMutationReceiptView,
    resume_after_review: bool,
    updated_at_ms: u64,
) -> Result<(), String> {
    let workflow = workflow_mut(workflows, workflow_id)?;
    let pending = workflow
        .pending_label_mutation
        .as_ref()
        .ok_or_else(|| "native label mutation is not pending".to_string())?;
    if workflow.fence != fence
        || pending.operation_id != receipt.operation_id
        || pending.command_hash != receipt.command_hash
    {
        return Err("native label mutation finalize transition is invalid".to_string());
    }
    if resume_after_review
        && workflow.jobs.iter().any(|job| {
            job.status == NativeWorkflowJobStatus::Cancelled
                && job.batch.as_ref().is_some_and(|batch| {
                    batch.units.iter().any(|unit| {
                        unit.status == PersistedWorkflowBatchUnitStatus::Cancelled
                            && unit.request.is_none()
                    })
                })
        })
    {
        return Err("native review batch input is unavailable for resume".to_string());
    }
    workflow.pending_label_mutation = None;
    workflow.last_label_mutation_receipt = Some(receipt);
    if resume_after_review {
        workflow.review_items.clear();
        workflow.readiness_outcome = None;
        workflow.error_code = None;
        for job in &mut workflow.jobs {
            if job.status == NativeWorkflowJobStatus::Cancelled {
                if let Some(batch) = &mut job.batch {
                    for unit in &mut batch.units {
                        if unit.status == PersistedWorkflowBatchUnitStatus::Cancelled {
                            unit.status = PersistedWorkflowBatchUnitStatus::Queued;
                            unit.claim_fence = None;
                        }
                    }
                }
                job.status = if job.request.is_some() || job.batch.is_some() {
                    NativeWorkflowJobStatus::Queued
                } else {
                    NativeWorkflowJobStatus::WaitingForInput
                };
                job.claim_fence = None;
                job.error_code = None;
            }
        }
        workflow.status = workflow.pending_status();
    }
    workflow.updated_at_ms = updated_at_ms;
    Ok(())
}

pub(super) fn apply_readiness_finalized(
    workflows: &mut BTreeMap<String, PersistedWorkflow>,
    workflow_id: &str,
    fence: u64,
    outcome: NativeWorkflowReadinessOutcome,
    review_items: Vec<serde_json::Value>,
    updated_at_ms: u64,
) -> Result<(), String> {
    let workflow = workflow_mut(workflows, workflow_id)?;
    if workflow.fence != fence
        || workflow.current_stage() != Some(NativeWorkflowStage::TtsReadyPreparation)
        || !matches!(
            workflow.status,
            NativeWorkflowStatus::WaitingForInput | NativeWorkflowStatus::NeedsReview
        )
        || workflow.jobs.iter().any(|job| {
            job.stage == NativeWorkflowStage::TtsReadyPreparation
                && job.status != NativeWorkflowJobStatus::Succeeded
        })
        || (outcome == NativeWorkflowReadinessOutcome::ReadyForTts && !review_items.is_empty())
        || (outcome == NativeWorkflowReadinessOutcome::NeedsReview && review_items.is_empty())
    {
        return Err("native workflow readiness finalization is invalid".to_string());
    }
    workflow.readiness_outcome = Some(outcome);
    workflow.review_items = review_items;
    workflow.error_code = None;
    workflow.status = match outcome {
        NativeWorkflowReadinessOutcome::ReadyForTts => {
            workflow.current_stage_index = None;
            NativeWorkflowStatus::Succeeded
        }
        NativeWorkflowReadinessOutcome::NeedsReview => NativeWorkflowStatus::NeedsReview,
    };
    workflow.updated_at_ms = updated_at_ms;
    Ok(())
}

pub(super) fn apply_review_required(
    workflows: &mut BTreeMap<String, PersistedWorkflow>,
    workflow_id: &str,
    fence: u64,
    error_code: String,
    review_items: Vec<serde_json::Value>,
    updated_at_ms: u64,
) -> Result<(), String> {
    let workflow = workflow_mut(workflows, workflow_id)?;
    if !matches!(
        workflow.schema_version,
        WORKFLOW_SCHEMA_VERSION | COMPACT_WORKFLOW_SCHEMA_VERSION
    ) || matches!(
        workflow.status,
        NativeWorkflowStatus::Succeeded
            | NativeWorkflowStatus::Cancelled
            | NativeWorkflowStatus::NeedsReview
    ) || fence != workflow.fence + 1
        || review_items.is_empty()
    {
        return Err("native workflow review transition is invalid".to_string());
    }
    workflow.fence = fence;
    workflow.status = NativeWorkflowStatus::NeedsReview;
    workflow.readiness_outcome = Some(NativeWorkflowReadinessOutcome::NeedsReview);
    workflow.review_items = review_items;
    workflow.error_code = Some(error_code);
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
