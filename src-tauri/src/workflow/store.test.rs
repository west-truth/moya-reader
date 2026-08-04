use super::*;
use crate::workflow::command_contract::{
    NativeBookWorkflowFinalizeRequest, NativeBookWorkflowMaterializeRequest,
    NativeWorkflowReadinessOutcome,
};
use crate::workflow::state::now_ms;
use crate::workflow::test_support::{provider_request, submit_request};
use serde_json::json;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

fn temp_dir(test_name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "noveldesk-native-workflow-{test_name}-{}-{}",
        std::process::id(),
        now_ms()
    ));
    fs::create_dir_all(&path).expect("create test workflow directory");
    path
}

fn materialize(
    store: &mut NativeWorkflowStore,
    workflow_id: &str,
    job_id: &str,
) -> NativeBookWorkflowView {
    let fence = store.get(workflow_id).expect("workflow").fence;
    store
        .materialize(NativeBookWorkflowMaterializeRequest {
            workflow_id: workflow_id.to_string(),
            job_id: job_id.to_string(),
            expected_fence: fence,
            request: Some(provider_request(job_id)),
            batch: None,
        })
        .expect("materialize job")
}

fn complete_job(store: &mut NativeWorkflowStore, workflow_id: &str, job_id: &str) {
    materialize(store, workflow_id, job_id);
    let claim = store
        .claim_next(workflow_id)
        .expect("claim job")
        .expect("materialized claim");
    assert_eq!(claim.job_id, job_id);
    store
        .complete_success(&claim, json!({ "jobId": job_id }))
        .expect("complete job");
    assert!(store
        .claim_next(workflow_id)
        .expect("advance stage")
        .is_none());
}

fn advance_to_readiness(store: &mut NativeWorkflowStore, workflow_id: &str) {
    for job_id in [
        "bootstrap-1",
        "bootstrap-2",
        "merge-1",
        "label-1",
        "label-2",
    ] {
        complete_job(store, workflow_id, job_id);
    }
    let view = store.get(workflow_id).expect("readiness view");
    assert_eq!(view.status, NativeWorkflowStatus::WaitingForInput);
    assert_eq!(
        view.current_stage,
        Some(NativeWorkflowStage::TtsReadyPreparation)
    );
}

#[test]
fn submit_is_idempotent_and_conflicting_materialization_is_rejected() {
    let directory = temp_dir("idempotent");
    let first = {
        let mut store = NativeWorkflowStore::open(&directory).expect("open workflow store");
        store.submit(submit_request()).expect("submit workflow")
    };
    let mut store = NativeWorkflowStore::open(&directory).expect("reopen workflow store");
    let second = store
        .submit(submit_request())
        .expect("repeat workflow submit");
    assert_eq!(first.id, second.id);
    assert_eq!(first.payload_hash, second.payload_hash);

    let mut conflict = submit_request();
    conflict.stages[0].jobs[0].request = Some(provider_request("different-request"));
    let error = store
        .submit(conflict)
        .expect_err("payload conflict must fail");
    assert!(error.contains("different payload"));
    fs::remove_dir_all(directory).ok();
}

#[test]
fn restart_preserves_waiting_workflow_without_spawning_it() {
    let directory = temp_dir("restart-waiting");
    let workflow_id = {
        let mut store = NativeWorkflowStore::open(&directory).expect("open workflow store");
        store.submit(submit_request()).expect("submit workflow").id
    };
    let mut recovered = NativeWorkflowStore::open(&directory).expect("replay workflow journal");
    assert!(recovered
        .recover_interrupted()
        .expect("recover waiting")
        .is_empty());
    assert_eq!(
        recovered
            .get(&workflow_id)
            .expect("waiting workflow")
            .status,
        NativeWorkflowStatus::WaitingForInput
    );
    fs::remove_dir_all(directory).ok();
}

#[test]
fn restart_requeues_claimed_materialized_job() {
    let directory = temp_dir("restart-running");
    let workflow_id = {
        let mut store = NativeWorkflowStore::open(&directory).expect("open workflow store");
        let workflow = store.submit(submit_request()).expect("submit workflow");
        materialize(&mut store, &workflow.id, "bootstrap-1");
        let claim = store.claim_next(&workflow.id).unwrap().unwrap();
        assert_eq!(claim.job_id, "bootstrap-1");
        workflow.id
    };
    let mut recovered = NativeWorkflowStore::open(&directory).expect("replay workflow journal");
    assert_eq!(
        recovered.recover_interrupted().expect("recover running"),
        vec![workflow_id.clone()]
    );
    let view = recovered.get(&workflow_id).expect("requeued workflow");
    assert_eq!(view.status, NativeWorkflowStatus::Queued);
    assert_eq!(view.jobs[0].attempt, 1);
    assert_eq!(view.jobs[0].status, NativeWorkflowJobStatus::Queued);
    fs::remove_dir_all(directory).ok();
}

#[test]
fn materialize_is_idempotent_and_rejects_drift_stale_fences_and_dependencies() {
    let directory = temp_dir("materialize");
    let mut store = NativeWorkflowStore::open(&directory).expect("open workflow store");
    let workflow = store.submit(submit_request()).expect("submit workflow");
    let first = materialize(&mut store, &workflow.id, "bootstrap-1");
    let repeated = materialize(&mut store, &workflow.id, "bootstrap-1");
    assert_eq!(first.jobs[0].request_hash, repeated.jobs[0].request_hash);

    let mut drifted = provider_request("bootstrap-1");
    drifted.prompt.push_str(" Changed.");
    let drift_error = store
        .materialize(NativeBookWorkflowMaterializeRequest {
            workflow_id: workflow.id.clone(),
            job_id: "bootstrap-1".to_string(),
            expected_fence: workflow.fence,
            request: Some(drifted),
            batch: None,
        })
        .expect_err("request drift must fail");
    assert!(drift_error.contains("drift"));

    let stale_error = store
        .materialize(NativeBookWorkflowMaterializeRequest {
            workflow_id: workflow.id.clone(),
            job_id: "bootstrap-1".to_string(),
            expected_fence: workflow.fence + 1,
            request: Some(provider_request("bootstrap-1")),
            batch: None,
        })
        .expect_err("stale fence must fail");
    assert!(stale_error.contains("stale"));

    let sequential_error = store
        .materialize(NativeBookWorkflowMaterializeRequest {
            workflow_id: workflow.id.clone(),
            job_id: "bootstrap-2".to_string(),
            expected_fence: workflow.fence,
            request: Some(provider_request("bootstrap-2")),
            batch: None,
        })
        .expect_err("second bootstrap request must wait");
    assert!(sequential_error.contains("sequentially"));

    let dependency_error = store
        .materialize(NativeBookWorkflowMaterializeRequest {
            workflow_id: workflow.id.clone(),
            job_id: "merge-1".to_string(),
            expected_fence: workflow.fence,
            request: Some(provider_request("merge-1")),
            batch: None,
        })
        .expect_err("merge request must wait for bootstrap");
    assert!(dependency_error.contains("dependencies"));
    fs::remove_dir_all(directory).ok();
}

#[test]
fn empty_readiness_waits_for_explicit_bounded_finalization() {
    let directory = temp_dir("finalization");
    let mut store = NativeWorkflowStore::open(&directory).expect("open workflow store");
    let workflow = store.submit(submit_request()).expect("submit workflow");
    advance_to_readiness(&mut store, &workflow.id);
    assert!(store.claim_next(&workflow.id).unwrap().is_none());

    let stale_error = store
        .finalize_readiness(NativeBookWorkflowFinalizeRequest {
            workflow_id: workflow.id.clone(),
            expected_fence: workflow.fence + 1,
            outcome: NativeWorkflowReadinessOutcome::ReadyForTts,
            review_items: Vec::new(),
        })
        .expect_err("stale readiness fence must fail");
    assert!(stale_error.contains("stale"));

    let review_input = NativeBookWorkflowFinalizeRequest {
        workflow_id: workflow.id.clone(),
        expected_fence: workflow.fence,
        outcome: NativeWorkflowReadinessOutcome::NeedsReview,
        review_items: vec![json!({
            "id": "missing-labels",
            "apiKey": "sk-must-not-persist",
            "evidence": "x".repeat(3_000)
        })],
    };
    let needs_review = store
        .finalize_readiness(review_input)
        .expect("finalize needs review");
    assert_eq!(needs_review.status, NativeWorkflowStatus::NeedsReview);
    assert_eq!(
        needs_review.current_stage,
        Some(NativeWorkflowStage::TtsReadyPreparation)
    );
    let serialized = serde_json::to_string(&needs_review).unwrap();
    assert!(!serialized.contains("apiKey"));
    assert!(!serialized.contains("sk-must-not-persist"));
    assert!(
        needs_review.review_items[0]["evidence"]
            .as_str()
            .expect("sanitized evidence")
            .chars()
            .count()
            <= 2_048
    );

    let ready = store
        .finalize_readiness(NativeBookWorkflowFinalizeRequest {
            workflow_id: workflow.id.clone(),
            expected_fence: workflow.fence,
            outcome: NativeWorkflowReadinessOutcome::ReadyForTts,
            review_items: Vec::new(),
        })
        .expect("finalize ready");
    assert_eq!(ready.status, NativeWorkflowStatus::Succeeded);
    assert_eq!(ready.current_stage, None);
    fs::remove_dir_all(directory).ok();
}

#[test]
fn premature_finalization_is_rejected_without_poisoning_replay() {
    let directory = temp_dir("premature-finalization");
    let workflow_id = {
        let mut store = NativeWorkflowStore::open(&directory).expect("open workflow store");
        let workflow = store.submit(submit_request()).expect("submit workflow");
        let error = store
            .finalize_readiness(NativeBookWorkflowFinalizeRequest {
                workflow_id: workflow.id.clone(),
                expected_fence: workflow.fence,
                outcome: NativeWorkflowReadinessOutcome::ReadyForTts,
                review_items: Vec::new(),
            })
            .expect_err("premature finalization must fail");
        assert!(error.contains("not waiting"));
        workflow.id
    };
    let recovered = NativeWorkflowStore::open(&directory).expect("replay unpoisoned journal");
    assert_eq!(
        recovered
            .get(&workflow_id)
            .expect("planned workflow")
            .status,
        NativeWorkflowStatus::WaitingForInput
    );
    fs::remove_dir_all(directory).ok();
}

#[test]
fn active_lookup_is_scoped_to_novel_and_content_revision() {
    let directory = temp_dir("active-lookup");
    let mut store = NativeWorkflowStore::open(&directory).expect("open workflow store");
    let workflow = store.submit(submit_request()).expect("submit workflow");
    assert_eq!(
        store
            .get_active("novel-1", "revision-1")
            .expect("active lookup")
            .expect("active workflow")
            .id,
        workflow.id
    );
    assert!(store
        .get_active("novel-1", "other-revision")
        .expect("missing lookup")
        .is_none());
    store.cancel(&workflow.id).expect("cancel workflow");
    assert!(store
        .get_active("novel-1", "revision-1")
        .expect("terminal lookup")
        .is_none());
    fs::remove_dir_all(directory).ok();
}

#[test]
fn cancellation_fence_rejects_a_late_provider_result() {
    let directory = temp_dir("cancel-fence");
    let mut store = NativeWorkflowStore::open(&directory).expect("open workflow store");
    let workflow = store.submit(submit_request()).expect("submit workflow");
    materialize(&mut store, &workflow.id, "bootstrap-1");
    let claim = store.claim_next(&workflow.id).unwrap().unwrap();
    let cancelled = store.cancel(&workflow.id).expect("cancel workflow");
    assert_eq!(cancelled.status, NativeWorkflowStatus::Cancelled);
    assert!(cancelled.fence > claim.fence);
    assert!(!store
        .complete_success(&claim, json!({ "late": true }))
        .expect("late result should be ignored"));
    assert!(store
        .get(&workflow.id)
        .expect("cancelled workflow")
        .checkpoints
        .is_empty());
    fs::remove_dir_all(directory).ok();
}

#[test]
fn schema_v1_submitted_fixture_replays_and_runs_materialized_jobs() {
    let directory = temp_dir("v1-replay");
    let journal_path = directory.join(WORKFLOW_JOURNAL_FILE);
    let request = provider_request("legacy");
    let request_hash = integrity_hash(&request).expect("legacy request hash");
    let workflow_id = "native_book_workflow_legacy";
    let event = json!({
        "type": "submitted",
        "workflow": {
            "schema_version": 1,
            "id": workflow_id,
            "idempotency_key": "legacy-plan",
            "novel_id": "legacy-novel",
            "content_revision": "legacy-revision",
            "plan_hash": "sha256:legacy-plan",
            "payload_hash": "sha256:legacy-payload",
            "status": "queued",
            "stages": [
                { "stage": "character_graph_bootstrap" },
                { "stage": "chapter_labeling" },
                { "stage": "tts_ready_preparation" }
            ],
            "current_stage_index": 0,
            "fence": 1,
            "jobs": [
                {
                    "id": "legacy-bootstrap",
                    "stage": "character_graph_bootstrap",
                    "sequence": 0,
                    "status": "queued",
                    "attempt": 0,
                    "claim_fence": null,
                    "request_hash": request_hash,
                    "request": request,
                    "error_code": null
                },
                {
                    "id": "legacy-label",
                    "stage": "chapter_labeling",
                    "sequence": 1,
                    "status": "queued",
                    "attempt": 0,
                    "claim_fence": null,
                    "request_hash": request_hash,
                    "request": request,
                    "error_code": null
                }
            ],
            "checkpoints": [],
            "error_code": null,
            "created_at_ms": 1,
            "updated_at_ms": 1
        }
    });
    fs::write(&journal_path, format!("{}\n", event)).expect("write v1 fixture");

    let mut store = NativeWorkflowStore::open(&directory).expect("replay v1 fixture");
    let bootstrap = store.claim_next(workflow_id).unwrap().unwrap();
    assert_eq!(bootstrap.job_id, "legacy-bootstrap");
    store
        .complete_success(&bootstrap, json!({ "legacy": "bootstrap" }))
        .unwrap();
    drop(store);
    let mut store = NativeWorkflowStore::open(&directory).expect("replay compacted v1 workflow");
    let label = store.claim_next(workflow_id).unwrap().unwrap();
    assert_eq!(label.job_id, "legacy-label");
    store
        .complete_success(&label, json!({ "legacy": "label" }))
        .unwrap();
    assert!(store.claim_next(workflow_id).unwrap().is_none());
    let waiting = store.get(workflow_id).expect("legacy waiting readiness");
    assert_eq!(waiting.schema_version, 1);
    assert_eq!(waiting.status, NativeWorkflowStatus::WaitingForInput);
    assert_eq!(waiting.readiness_outcome, None);
    let finalized = store
        .finalize_readiness(NativeBookWorkflowFinalizeRequest {
            workflow_id: workflow_id.to_string(),
            expected_fence: waiting.fence,
            outcome: NativeWorkflowReadinessOutcome::NeedsReview,
            review_items: vec![json!({ "id": "legacy-readiness-review" })],
        })
        .expect("explicitly finalize legacy readiness");
    assert_eq!(finalized.schema_version, 1);
    assert_eq!(finalized.status, NativeWorkflowStatus::NeedsReview);
    drop(store);
    let reopened = NativeWorkflowStore::open(&directory).expect("reopen finalized v1 workflow");
    assert_eq!(
        reopened.get(workflow_id).expect("legacy workflow").status,
        NativeWorkflowStatus::NeedsReview
    );
    fs::remove_dir_all(directory).ok();
}

#[test]
fn truncated_final_journal_event_is_repaired_before_append_and_reopen() {
    let directory = temp_dir("truncated-tail");
    let journal_path = {
        let mut store = NativeWorkflowStore::open(&directory).expect("open workflow store");
        store.submit(submit_request()).expect("submit workflow");
        store.journal_path().to_path_buf()
    };
    let mut file = OpenOptions::new()
        .append(true)
        .open(journal_path)
        .expect("open workflow journal");
    file.write_all(b"{\"type\":\"job_claimed\"")
        .expect("write truncated tail");
    file.sync_all().expect("sync truncated tail");
    let mut recovered =
        NativeWorkflowStore::open(&directory).expect("repair truncated final event");
    assert_eq!(recovered.workflows.len(), 1);
    let workflow_id = recovered.workflows.keys().next().unwrap().clone();
    materialize(&mut recovered, &workflow_id, "bootstrap-1");
    drop(recovered);
    let reopened = NativeWorkflowStore::open(&directory).expect("replay append after repair");
    assert_eq!(
        reopened.get(&workflow_id).unwrap().jobs[0].status,
        NativeWorkflowJobStatus::Queued
    );
    let journal = fs::read_to_string(directory.join(WORKFLOW_JOURNAL_FILE)).unwrap();
    assert!(!journal.contains("{\"type\":\"job_claimed\"{\""));
    fs::remove_dir_all(directory).ok();
}
