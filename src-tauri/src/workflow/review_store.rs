use super::command_contract::{
    NativeBookWorkflowFinalizeRequest, NativeBookWorkflowReviewRequest, NativeBookWorkflowView,
    NativeLabelMutationFinalizeRequest, NativeLabelMutationPendingView,
    NativeLabelMutationPrepareRequest, NativeLabelMutationReceiptView,
    NativeWorkflowReadinessOutcome, NativeWorkflowStage, NativeWorkflowStatus,
};
use super::review_evidence::sanitize_review_items;
use super::state::{now_ms, WorkflowJournalEvent};
use super::store::NativeWorkflowStore;

pub(super) fn finalize_readiness(
    store: &mut NativeWorkflowStore,
    input: NativeBookWorkflowFinalizeRequest,
) -> Result<NativeBookWorkflowView, String> {
    input.validate()?;
    let workflow = store
        .workflows
        .get(&input.workflow_id)
        .ok_or_else(|| "native workflow was not found".to_string())?;
    if workflow.fence != input.expected_fence {
        return Err("native workflow readiness fence is stale".to_string());
    }
    let terminal_ready_retry = workflow.status == NativeWorkflowStatus::Succeeded
        && workflow.readiness_outcome == Some(NativeWorkflowReadinessOutcome::ReadyForTts)
        && input.outcome == NativeWorkflowReadinessOutcome::ReadyForTts;
    if !terminal_ready_retry
        && (workflow.current_stage() != Some(NativeWorkflowStage::TtsReadyPreparation)
            || !matches!(
                workflow.status,
                NativeWorkflowStatus::WaitingForInput | NativeWorkflowStatus::NeedsReview
            ))
    {
        return Err("native workflow is not waiting for readiness finalization".to_string());
    }
    let review_items = sanitize_review_items(input.review_items)?;
    if workflow.readiness_outcome == Some(input.outcome)
        && workflow.review_items == review_items
        && matches!(
            (input.outcome, workflow.status),
            (
                NativeWorkflowReadinessOutcome::ReadyForTts,
                NativeWorkflowStatus::Succeeded
            ) | (
                NativeWorkflowReadinessOutcome::NeedsReview,
                NativeWorkflowStatus::NeedsReview
            )
        )
    {
        return Ok(workflow.view());
    }
    store.commit(WorkflowJournalEvent::ReadinessFinalized {
        workflow_id: input.workflow_id.clone(),
        fence: input.expected_fence,
        outcome: input.outcome,
        review_items,
        updated_at_ms: now_ms(),
    })?;
    store.get(&input.workflow_id)
}

pub(super) fn prepare_label_mutation(
    store: &mut NativeWorkflowStore,
    input: NativeLabelMutationPrepareRequest,
) -> Result<NativeBookWorkflowView, String> {
    input.validate()?;
    let workflow = store
        .workflows
        .get(&input.workflow_id)
        .ok_or_else(|| "native workflow was not found".to_string())?;
    if let Some(pending) = &workflow.pending_label_mutation {
        if pending.operation_id == input.operation_id && pending.command_hash == input.command_hash
        {
            return Ok(workflow.view());
        }
        return Err("another native label mutation is pending".to_string());
    }
    if workflow.fence != input.expected_fence
        || workflow.status != NativeWorkflowStatus::NeedsReview
    {
        return Err("native label mutation prepare fence is stale".to_string());
    }
    store.commit(WorkflowJournalEvent::LabelMutationPrepared {
        workflow_id: input.workflow_id.clone(),
        fence: input.expected_fence + 1,
        pending: NativeLabelMutationPendingView {
            operation_id: input.operation_id,
            command_hash: input.command_hash,
            command: input.command,
        },
        updated_at_ms: now_ms(),
    })?;
    store.get(&input.workflow_id)
}

pub(super) fn finalize_label_mutation(
    store: &mut NativeWorkflowStore,
    input: NativeLabelMutationFinalizeRequest,
) -> Result<NativeBookWorkflowView, String> {
    input.validate()?;
    let workflow = store
        .workflows
        .get(&input.workflow_id)
        .ok_or_else(|| "native workflow was not found".to_string())?;
    if let Some(receipt) = &workflow.last_label_mutation_receipt {
        if receipt.operation_id == input.operation_id
            && receipt.command_hash == input.command_hash
            && receipt.receipt_hash == input.receipt_hash
        {
            return Ok(workflow.view());
        }
    }
    store.commit(WorkflowJournalEvent::LabelMutationFinalized {
        workflow_id: input.workflow_id.clone(),
        fence: input.expected_fence,
        receipt: NativeLabelMutationReceiptView {
            operation_id: input.operation_id,
            command_hash: input.command_hash,
            receipt_hash: input.receipt_hash,
        },
        resume_after_review: input.resume_after_review,
        updated_at_ms: now_ms(),
    })?;
    store.get(&input.workflow_id)
}

pub(super) fn require_review(
    store: &mut NativeWorkflowStore,
    input: NativeBookWorkflowReviewRequest,
) -> Result<NativeBookWorkflowView, String> {
    input.validate()?;
    let review_items = sanitize_review_items(input.review_items)?;
    let workflow = store
        .workflows
        .get(&input.workflow_id)
        .ok_or_else(|| "native workflow was not found".to_string())?;
    if workflow.status == NativeWorkflowStatus::NeedsReview
        && workflow.fence == input.expected_fence + 1
        && workflow.error_code.as_deref() == Some(input.error_code.as_str())
        && workflow.review_items == review_items
    {
        return Ok(workflow.view());
    }
    if workflow.fence != input.expected_fence {
        return Err("native workflow review fence is stale".to_string());
    }
    if matches!(
        workflow.status,
        NativeWorkflowStatus::Succeeded
            | NativeWorkflowStatus::Cancelled
            | NativeWorkflowStatus::NeedsReview
    ) {
        return Err("native workflow cannot enter review from its current state".to_string());
    }
    store.commit(WorkflowJournalEvent::ReviewRequired {
        workflow_id: input.workflow_id.clone(),
        fence: input.expected_fence + 1,
        error_code: input.error_code,
        review_items,
        updated_at_ms: now_ms(),
    })?;
    store.get(&input.workflow_id)
}
