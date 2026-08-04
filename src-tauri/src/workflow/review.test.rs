use super::*;
use crate::native_identity::integrity_hash;
use crate::workflow::command_contract::{
    NativeBookWorkflowMaterializeRequest, NativeBookWorkflowReviewRequest,
    NativeLabelMutationFinalizeRequest, NativeLabelMutationPrepareRequest,
    NativeStructuredJsonBatch, NativeStructuredJsonBatchUnit, NativeWorkflowJobStatus,
    NativeWorkflowReadinessOutcome, NativeWorkflowStatus, STRUCTURED_JSON_BATCH_VERSION,
};
use crate::workflow::state::now_ms;
use crate::workflow::test_support::{compact_submit_request, provider_request, submit_request};
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_NONCE: AtomicU64 = AtomicU64::new(0);

fn temp_dir() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "noveldesk-native-workflow-early-review-{}-{}-{}",
        std::process::id(),
        now_ms(),
        TEMP_NONCE.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&path).expect("create test workflow directory");
    path
}

#[test]
fn label_mutation_pending_command_and_receipt_survive_restart() {
    let directory = temp_dir();
    let (workflow_id, prepared_fence, command_hash) = {
        let mut store = NativeWorkflowStore::open(&directory).expect("open workflow store");
        let workflow = store.submit(submit_request()).expect("submit workflow");
        let reviewed = store
            .require_review(NativeBookWorkflowReviewRequest {
                workflow_id: workflow.id.clone(),
                expected_fence: workflow.fence,
                error_code: "label_review_required".to_string(),
                review_items: vec![json!({ "id": "label-review" })],
            })
            .expect("require review");
        let command = json!({
            "operationId": "operation-1",
            "bookId": "book-1",
            "edits": [{ "segmentId": "segment-1" }]
        });
        let command_hash = integrity_hash(&command).expect("command hash");
        let prepared = store
            .prepare_label_mutation(NativeLabelMutationPrepareRequest {
                workflow_id: workflow.id.clone(),
                expected_fence: reviewed.fence,
                operation_id: "operation-1".to_string(),
                command_hash: command_hash.clone(),
                command,
            })
            .expect("prepare label mutation");
        assert!(prepared.pending_label_mutation.is_some());
        (workflow.id, prepared.fence, command_hash)
    };

    let mut reopened = NativeWorkflowStore::open(&directory).expect("reopen pending mutation");
    let pending = reopened.get(&workflow_id).expect("pending workflow");
    assert_eq!(pending.fence, prepared_fence);
    assert_eq!(
        pending
            .pending_label_mutation
            .as_ref()
            .unwrap()
            .operation_id,
        "operation-1"
    );
    let finalized = reopened
        .finalize_label_mutation(NativeLabelMutationFinalizeRequest {
            workflow_id: workflow_id.clone(),
            expected_fence: prepared_fence,
            operation_id: "operation-1".to_string(),
            command_hash,
            receipt_hash: "sha256:receipt-1".to_string(),
            resume_after_review: false,
        })
        .expect("finalize label mutation");
    assert!(finalized.pending_label_mutation.is_none());
    assert_eq!(
        finalized
            .last_label_mutation_receipt
            .as_ref()
            .unwrap()
            .receipt_hash,
        "sha256:receipt-1"
    );
    drop(reopened);
    let reopened = NativeWorkflowStore::open(&directory).expect("reopen finalized mutation");
    assert!(reopened
        .get(&workflow_id)
        .unwrap()
        .last_label_mutation_receipt
        .is_some());
    fs::remove_dir_all(directory).ok();
}

#[test]
fn reviewed_label_promotion_resumes_only_the_cancelled_remainder() {
    let directory = temp_dir();
    let mut store = NativeWorkflowStore::open(&directory).expect("open workflow store");
    let workflow = store.submit(submit_request()).expect("submit workflow");
    let materialized = store
        .materialize(NativeBookWorkflowMaterializeRequest {
            workflow_id: workflow.id.clone(),
            job_id: "bootstrap-1".to_string(),
            expected_fence: workflow.fence,
            request: Some(provider_request("bootstrap-1")),
            batch: None,
        })
        .expect("materialize first job");
    let reviewed = store
        .require_review(NativeBookWorkflowReviewRequest {
            workflow_id: workflow.id.clone(),
            expected_fence: materialized.fence,
            error_code: "label_review_required".to_string(),
            review_items: vec![json!({ "id": "label-review" })],
        })
        .expect("require review");
    let command = json!({
        "kind": "native_review_promotion_v1",
        "operationId": "review-operation-1",
        "artifactId": "artifact-1"
    });
    let command_hash = integrity_hash(&command).expect("command hash");
    let prepared = store
        .prepare_label_mutation(NativeLabelMutationPrepareRequest {
            workflow_id: workflow.id.clone(),
            expected_fence: reviewed.fence,
            operation_id: "review-operation-1".to_string(),
            command_hash: command_hash.clone(),
            command,
        })
        .expect("prepare review promotion");
    let resumed = store
        .finalize_label_mutation(NativeLabelMutationFinalizeRequest {
            workflow_id: workflow.id.clone(),
            expected_fence: prepared.fence,
            operation_id: "review-operation-1".to_string(),
            command_hash,
            receipt_hash: "sha256:review-receipt-1".to_string(),
            resume_after_review: true,
        })
        .expect("finalize and resume review promotion");

    assert!(resumed
        .jobs
        .iter()
        .all(|job| job.status == NativeWorkflowJobStatus::WaitingForInput));
    assert_eq!(resumed.status, NativeWorkflowStatus::WaitingForInput);
    assert!(resumed.review_items.is_empty());
    assert!(resumed.readiness_outcome.is_none());
    assert!(resumed.error_code.is_none());
    drop(store);

    let reopened = NativeWorkflowStore::open(&directory).expect("reopen resumed workflow");
    assert_eq!(
        reopened.get(&workflow.id).expect("resumed workflow").status,
        NativeWorkflowStatus::WaitingForInput
    );
    fs::remove_dir_all(directory).ok();
}

#[test]
fn early_review_fences_late_results_redacts_evidence_and_survives_restart() {
    let directory = temp_dir();
    let (workflow_id, original_fence, request) = {
        let mut store = NativeWorkflowStore::open(&directory).expect("open workflow store");
        let workflow = store.submit(submit_request()).expect("submit workflow");
        store
            .materialize(NativeBookWorkflowMaterializeRequest {
                workflow_id: workflow.id.clone(),
                job_id: "bootstrap-1".to_string(),
                expected_fence: workflow.fence,
                request: Some(provider_request("bootstrap-1")),
                batch: None,
            })
            .expect("materialize bootstrap");
        let claim = store
            .claim_next(&workflow.id)
            .expect("claim bootstrap")
            .expect("bootstrap claim");
        let request = NativeBookWorkflowReviewRequest {
            workflow_id: workflow.id.clone(),
            expected_fence: claim.fence,
            error_code: "native_checkpoint_requires_review".to_string(),
            review_items: vec![json!({
                "id": "invalid-bootstrap",
                "apiKey": "sk-must-not-persist",
                "detail": "invalid provider output"
            })],
        };
        let reviewed = store
            .require_review(request.clone())
            .expect("require early review");
        assert_eq!(reviewed.status, NativeWorkflowStatus::NeedsReview);
        assert_eq!(reviewed.fence, claim.fence + 1);
        assert_eq!(
            reviewed.readiness_outcome,
            Some(NativeWorkflowReadinessOutcome::NeedsReview)
        );
        assert_eq!(reviewed.jobs[0].status, NativeWorkflowJobStatus::Cancelled);
        assert!(!store
            .complete_success(&claim, json!({ "late": true }))
            .expect("late result fence"));
        let repeated = store
            .require_review(request.clone())
            .expect("idempotent review retry");
        assert_eq!(repeated.fence, reviewed.fence);
        let journal = fs::read_to_string(store.journal_path()).expect("read compacted journal");
        assert!(!journal.contains("Return JSON for bootstrap-1."));
        assert!(!journal.contains("sk-must-not-persist"));
        (workflow.id, claim.fence, request)
    };
    let mut reopened = NativeWorkflowStore::open(&directory).expect("reopen reviewed workflow");
    let view = reopened.get(&workflow_id).expect("reviewed workflow");
    assert_eq!(view.status, NativeWorkflowStatus::NeedsReview);
    assert_eq!(view.fence, original_fence + 1);
    assert!(reopened.require_review(request).is_ok());
    fs::remove_dir_all(directory).ok();
}

#[test]
fn compact_checkpoint_review_resumes_only_the_next_logical_window() {
    let directory = temp_dir();
    let mut store = NativeWorkflowStore::open(&directory).expect("open compact workflow store");
    let mut request = compact_submit_request();
    let mut second_label = request.stages[2].jobs[0].clone();
    second_label.id = "label-2:scene-1".to_string();
    request.stages[2].jobs.push(second_label);
    request.plan_hash = request.canonical_plan_hash().expect("compact plan hash");
    let workflow = store.submit(request).expect("submit compact workflow");

    for job_id in ["bootstrap-1", "merge-1"] {
        let fence = store.get(&workflow.id).unwrap().fence;
        store
            .materialize(NativeBookWorkflowMaterializeRequest {
                workflow_id: workflow.id.clone(),
                job_id: job_id.to_string(),
                expected_fence: fence,
                request: Some(provider_request(job_id)),
                batch: None,
            })
            .expect("materialize compact non-label job");
        let claim = store.claim_next(&workflow.id).unwrap().unwrap();
        store
            .complete_success(&claim, json!({ "jobId": job_id }))
            .unwrap();
        assert!(store.claim_next(&workflow.id).unwrap().is_none());
    }
    let before_label = store.get(&workflow.id).unwrap();
    let first_label = store
        .materialize(NativeBookWorkflowMaterializeRequest {
            workflow_id: workflow.id.clone(),
            job_id: "label-1:scene-1".to_string(),
            expected_fence: before_label.fence,
            request: None,
            batch: Some(NativeStructuredJsonBatch {
                version: STRUCTURED_JSON_BATCH_VERSION.to_string(),
                units: vec![],
            }),
        })
        .expect("complete deterministic compact label window");
    assert_eq!(
        first_label.jobs[2].status,
        NativeWorkflowJobStatus::Succeeded
    );
    assert_eq!(
        first_label.jobs[3].status,
        NativeWorkflowJobStatus::WaitingForInput
    );

    let reviewed = store
        .require_review(NativeBookWorkflowReviewRequest {
            workflow_id: workflow.id.clone(),
            expected_fence: first_label.fence,
            error_code: "native_speaker_risk_requires_review".to_string(),
            review_items: vec![json!({ "id": "speaker-risk-review" })],
        })
        .expect("require compact checkpoint review");
    assert_eq!(reviewed.status, NativeWorkflowStatus::NeedsReview);
    assert_eq!(reviewed.jobs[2].status, NativeWorkflowJobStatus::Succeeded);
    assert_eq!(reviewed.jobs[3].status, NativeWorkflowJobStatus::Cancelled);

    let command = json!({
        "kind": "native_review_promotion_v1",
        "operationId": "compact-review-operation",
        "artifactId": "compact-label-artifact"
    });
    let command_hash = integrity_hash(&command).unwrap();
    let prepared = store
        .prepare_label_mutation(NativeLabelMutationPrepareRequest {
            workflow_id: workflow.id.clone(),
            expected_fence: reviewed.fence,
            operation_id: "compact-review-operation".to_string(),
            command_hash: command_hash.clone(),
            command,
        })
        .expect("prepare compact review promotion");
    let resumed = store
        .finalize_label_mutation(NativeLabelMutationFinalizeRequest {
            workflow_id: workflow.id.clone(),
            expected_fence: prepared.fence,
            operation_id: "compact-review-operation".to_string(),
            command_hash,
            receipt_hash: "sha256:compact-review-receipt".to_string(),
            resume_after_review: true,
        })
        .expect("resume compact workflow after review");
    assert_eq!(resumed.status, NativeWorkflowStatus::WaitingForInput);
    assert_eq!(resumed.jobs[2].status, NativeWorkflowJobStatus::Succeeded);
    assert_eq!(
        resumed.jobs[3].status,
        NativeWorkflowJobStatus::WaitingForInput
    );
    drop(store);

    let reopened = NativeWorkflowStore::open(&directory).expect("reopen resumed compact workflow");
    let reopened_view = reopened.get(&workflow.id).unwrap();
    assert_eq!(reopened_view.status, NativeWorkflowStatus::WaitingForInput);
    assert_eq!(
        reopened_view.jobs[3].status,
        NativeWorkflowJobStatus::WaitingForInput
    );
    fs::remove_dir_all(directory).ok();
}

#[test]
fn active_compact_batch_review_requeues_the_interrupted_unit_after_approval() {
    let directory = temp_dir();
    let mut store = NativeWorkflowStore::open(&directory).expect("open compact workflow store");
    let workflow = store
        .submit(compact_submit_request())
        .expect("submit compact workflow");

    for job_id in ["bootstrap-1", "merge-1"] {
        let fence = store.get(&workflow.id).unwrap().fence;
        store
            .materialize(NativeBookWorkflowMaterializeRequest {
                workflow_id: workflow.id.clone(),
                job_id: job_id.to_string(),
                expected_fence: fence,
                request: Some(provider_request(job_id)),
                batch: None,
            })
            .unwrap();
        let claim = store.claim_next(&workflow.id).unwrap().unwrap();
        store
            .complete_success(&claim, json!({ "jobId": job_id }))
            .unwrap();
        assert!(store.claim_next(&workflow.id).unwrap().is_none());
    }

    let fence = store.get(&workflow.id).unwrap().fence;
    store
        .materialize(NativeBookWorkflowMaterializeRequest {
            workflow_id: workflow.id.clone(),
            job_id: "label-1:scene-1".to_string(),
            expected_fence: fence,
            request: None,
            batch: Some(NativeStructuredJsonBatch {
                version: STRUCTURED_JSON_BATCH_VERSION.to_string(),
                units: ["unit-1", "unit-2"]
                    .into_iter()
                    .map(|id| NativeStructuredJsonBatchUnit {
                        id: id.to_string(),
                        packet_fingerprint: format!("sha256:packet-{id}"),
                        request: provider_request(id),
                    })
                    .collect(),
            }),
        })
        .unwrap();
    let interrupted = store.claim_next(&workflow.id).unwrap().unwrap();
    assert_eq!(interrupted.batch_unit_id.as_deref(), Some("unit-1"));

    let reviewed = store
        .require_review(NativeBookWorkflowReviewRequest {
            workflow_id: workflow.id.clone(),
            expected_fence: interrupted.fence,
            error_code: "native_speaker_risk_requires_review".to_string(),
            review_items: vec![json!({ "id": "active-batch-review" })],
        })
        .expect("interrupt active batch for review");
    assert_eq!(reviewed.status, NativeWorkflowStatus::NeedsReview);
    assert!(!store
        .complete_success(&interrupted, json!({ "late": true }))
        .unwrap());
    drop(store);

    let mut store = NativeWorkflowStore::open(&directory).expect("reopen reviewed active batch");
    let command = json!({
        "kind": "native_review_promotion_v1",
        "operationId": "active-batch-review-operation",
        "artifactId": "active-batch-artifact"
    });
    let command_hash = integrity_hash(&command).unwrap();
    let prepared = store
        .prepare_label_mutation(NativeLabelMutationPrepareRequest {
            workflow_id: workflow.id.clone(),
            expected_fence: reviewed.fence,
            operation_id: "active-batch-review-operation".to_string(),
            command_hash: command_hash.clone(),
            command,
        })
        .unwrap();
    let resumed = store
        .finalize_label_mutation(NativeLabelMutationFinalizeRequest {
            workflow_id: workflow.id.clone(),
            expected_fence: prepared.fence,
            operation_id: "active-batch-review-operation".to_string(),
            command_hash,
            receipt_hash: "sha256:active-batch-review-receipt".to_string(),
            resume_after_review: true,
        })
        .expect("resume reviewed active batch");
    assert_eq!(resumed.status, NativeWorkflowStatus::Queued);
    drop(store);

    let mut store = NativeWorkflowStore::open(&directory).expect("reopen resumed active batch");
    let first = store.claim_next(&workflow.id).unwrap().unwrap();
    assert_eq!(first.batch_unit_id.as_deref(), Some("unit-1"));
    store
        .complete_success(&first, json!({ "speaker": "first" }))
        .unwrap();
    let second = store.claim_next(&workflow.id).unwrap().unwrap();
    assert_eq!(second.batch_unit_id.as_deref(), Some("unit-2"));
    store
        .complete_success(&second, json!({ "speaker": "second" }))
        .unwrap();
    assert!(store.claim_next(&workflow.id).unwrap().is_none());
    fs::remove_dir_all(directory).ok();
}
