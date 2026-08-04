use super::command_contract::{
    NativeBookWorkflowFinalizeRequest, NativeBookWorkflowMaterializeRequest,
    NativeBookWorkflowReviewRequest, NativeBookWorkflowSubmitRequest, NativeBookWorkflowView,
    NativeLabelMutationFinalizeRequest, NativeLabelMutationPrepareRequest,
    NativeWorkflowCheckpointResult,
};
use super::NativeWorkflowRuntime;

#[tauri::command]
pub(crate) fn native_book_workflow_submit(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, NativeWorkflowRuntime>,
    request: NativeBookWorkflowSubmitRequest,
) -> Result<NativeBookWorkflowView, String> {
    let workflow = runtime.submit(request)?;
    if NativeWorkflowRuntime::should_spawn(&workflow) {
        runtime.spawn(app, workflow.id.clone())?;
    }
    Ok(workflow)
}

#[tauri::command]
pub(crate) fn native_book_workflow_get(
    runtime: tauri::State<'_, NativeWorkflowRuntime>,
    workflow_id: String,
) -> Result<NativeBookWorkflowView, String> {
    runtime.get(workflow_id.trim())
}

#[tauri::command]
pub(crate) fn native_book_workflow_active_get(
    runtime: tauri::State<'_, NativeWorkflowRuntime>,
    novel_id: String,
    content_revision: String,
) -> Result<Option<NativeBookWorkflowView>, String> {
    runtime.get_active(novel_id.trim(), content_revision.trim())
}

#[tauri::command]
pub(crate) fn native_book_workflow_materialize(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, NativeWorkflowRuntime>,
    request: NativeBookWorkflowMaterializeRequest,
) -> Result<NativeBookWorkflowView, String> {
    let workflow = runtime.materialize(request)?;
    if NativeWorkflowRuntime::should_spawn(&workflow) {
        runtime.spawn(app, workflow.id.clone())?;
    }
    Ok(workflow)
}

#[tauri::command]
pub(crate) fn native_book_workflow_finalize_readiness(
    runtime: tauri::State<'_, NativeWorkflowRuntime>,
    request: NativeBookWorkflowFinalizeRequest,
) -> Result<NativeBookWorkflowView, String> {
    runtime.finalize_readiness(request)
}

#[tauri::command]
pub(crate) fn native_book_workflow_require_review(
    runtime: tauri::State<'_, NativeWorkflowRuntime>,
    request: NativeBookWorkflowReviewRequest,
) -> Result<NativeBookWorkflowView, String> {
    runtime.require_review(request)
}

#[tauri::command]
pub(crate) fn native_book_workflow_label_mutation_prepare(
    runtime: tauri::State<'_, NativeWorkflowRuntime>,
    request: NativeLabelMutationPrepareRequest,
) -> Result<NativeBookWorkflowView, String> {
    runtime.prepare_label_mutation(request)
}

#[tauri::command]
pub(crate) fn native_book_workflow_label_mutation_finalize(
    runtime: tauri::State<'_, NativeWorkflowRuntime>,
    request: NativeLabelMutationFinalizeRequest,
) -> Result<NativeBookWorkflowView, String> {
    runtime.finalize_label_mutation(request)
}

#[tauri::command]
pub(crate) fn native_book_workflow_resume(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, NativeWorkflowRuntime>,
    workflow_id: String,
) -> Result<NativeBookWorkflowView, String> {
    let workflow = runtime.resume(workflow_id.trim())?;
    if NativeWorkflowRuntime::should_spawn(&workflow) {
        runtime.spawn(app, workflow.id.clone())?;
    }
    Ok(workflow)
}

#[tauri::command]
pub(crate) fn native_book_workflow_cancel(
    runtime: tauri::State<'_, NativeWorkflowRuntime>,
    workflow_id: String,
) -> Result<NativeBookWorkflowView, String> {
    runtime.cancel(workflow_id.trim())
}

#[tauri::command]
pub(crate) fn native_book_workflow_checkpoint_get(
    runtime: tauri::State<'_, NativeWorkflowRuntime>,
    workflow_id: String,
    job_id: String,
) -> Result<NativeWorkflowCheckpointResult, String> {
    runtime.checkpoint(workflow_id.trim(), job_id.trim())
}

#[cfg(test)]
mod tests {
    use super::super::command_contract::{
        NativeBookWorkflowFinalizeRequest, NativeBookWorkflowMaterializeRequest,
        NativeBookWorkflowReviewRequest, NativeWorkflowReadinessOutcome,
    };
    use crate::workflow::{state::PersistedWorkflow, test_support::submit_request};
    use serde_json::json;

    #[test]
    fn bridge_command_payloads_use_shared_camel_case_fields() {
        let materialize: NativeBookWorkflowMaterializeRequest = serde_json::from_value(json!({
            "workflowId": "workflow-1",
            "jobId": "bootstrap-1",
            "expectedFence": 4,
            "request": {
                "providerId": "openai",
                "modelId": "gpt-5-mini",
                "prompt": "Return JSON.",
                "responseSchema": { "type": "object" },
                "jsonSchemaName": "workflow_result"
            }
        }))
        .expect("materialize payload");
        assert_eq!(materialize.expected_fence, 4);

        let finalize: NativeBookWorkflowFinalizeRequest = serde_json::from_value(json!({
            "workflowId": "workflow-1",
            "expectedFence": 4,
            "outcome": "ready_for_tts",
            "reviewItems": []
        }))
        .expect("finalize payload");
        assert_eq!(
            finalize.outcome,
            NativeWorkflowReadinessOutcome::ReadyForTts
        );

        let review: NativeBookWorkflowReviewRequest = serde_json::from_value(json!({
            "workflowId": "workflow-1",
            "expectedFence": 4,
            "errorCode": "invalid_checkpoint",
            "reviewItems": [{ "id": "invalid-checkpoint" }]
        }))
        .expect("review payload");
        assert_eq!(review.error_code, "invalid_checkpoint");

        let view = PersistedWorkflow::from_request(submit_request())
            .expect("workflow view")
            .view();
        let serialized = serde_json::to_value(view).expect("serialize workflow view");
        assert_eq!(serialized["schemaVersion"], 2);
        assert!(serialized.get("schema_version").is_none());
    }
}
