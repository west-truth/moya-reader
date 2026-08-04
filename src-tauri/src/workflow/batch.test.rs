use super::*;
use crate::workflow::command_contract::{
    NativeBookWorkflowMaterializeRequest, NativeStructuredJsonBatch, NativeStructuredJsonBatchUnit,
    NativeWorkflowJobStatus, NativeWorkflowStatus, STRUCTURED_JSON_BATCH_RESULT_VERSION,
    STRUCTURED_JSON_BATCH_VERSION,
};
use crate::workflow::state::now_ms;
use crate::workflow::test_support::{compact_submit_request, provider_request, submit_request};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn temp_dir(test_name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "noveldesk-native-workflow-batch-{test_name}-{}-{}",
        std::process::id(),
        now_ms()
    ));
    fs::create_dir_all(&path).expect("create batch test directory");
    path
}

fn batch(ids: &[&str]) -> NativeStructuredJsonBatch {
    NativeStructuredJsonBatch {
        version: STRUCTURED_JSON_BATCH_VERSION.to_string(),
        units: ids
            .iter()
            .map(|id| NativeStructuredJsonBatchUnit {
                id: (*id).to_string(),
                packet_fingerprint: format!("sha256:packet-{id}"),
                request: provider_request(id),
            })
            .collect(),
    }
}

fn materialize_single(store: &mut NativeWorkflowStore, workflow_id: &str, job_id: &str) {
    let fence = store.get(workflow_id).unwrap().fence;
    store
        .materialize(NativeBookWorkflowMaterializeRequest {
            workflow_id: workflow_id.to_string(),
            job_id: job_id.to_string(),
            expected_fence: fence,
            request: Some(provider_request(job_id)),
            batch: None,
        })
        .expect("materialize single job");
}

fn complete_single(store: &mut NativeWorkflowStore, workflow_id: &str, job_id: &str) {
    materialize_single(store, workflow_id, job_id);
    let claim = store.claim_next(workflow_id).unwrap().unwrap();
    assert_eq!(claim.job_id, job_id);
    assert!(claim.batch_unit_id.is_none());
    store
        .complete_success(&claim, json!({ "jobId": job_id }))
        .unwrap();
    assert!(store.claim_next(workflow_id).unwrap().is_none());
}

fn advance_compact_workflow_to_labeling(store: &mut NativeWorkflowStore, workflow_id: &str) {
    complete_single(store, workflow_id, "bootstrap-1");
    complete_single(store, workflow_id, "merge-1");
}

fn materialize_batch(
    store: &mut NativeWorkflowStore,
    workflow_id: &str,
    value: NativeStructuredJsonBatch,
) -> NativeBookWorkflowView {
    let fence = store.get(workflow_id).unwrap().fence;
    store
        .materialize(NativeBookWorkflowMaterializeRequest {
            workflow_id: workflow_id.to_string(),
            job_id: "label-1:scene-1".to_string(),
            expected_fence: fence,
            request: None,
            batch: Some(value),
        })
        .expect("materialize batch")
}

#[test]
fn batch_restart_resume_preserves_completed_units_and_fences_late_results() {
    let directory = temp_dir("restart-resume");
    let journal_path = directory.join(WORKFLOW_JOURNAL_FILE);
    let requested_batch = batch(&["unit-1", "unit-2", "unit-3"]);
    let expected_batch_hash = integrity_hash(&requested_batch).unwrap();
    let (workflow_id, interrupted_claim) = {
        let mut store = NativeWorkflowStore::open(&directory).unwrap();
        let workflow = store.submit(compact_submit_request()).unwrap();
        advance_compact_workflow_to_labeling(&mut store, &workflow.id);
        let materialized = materialize_batch(&mut store, &workflow.id, requested_batch.clone());
        let label = materialized
            .jobs
            .iter()
            .find(|job| job.id == "label-1:scene-1")
            .unwrap();
        assert_eq!(
            label.request_hash.as_deref(),
            Some(expected_batch_hash.as_str())
        );

        let first = store.claim_next(&workflow.id).unwrap().unwrap();
        assert_eq!(first.batch_unit_id.as_deref(), Some("unit-1"));
        store
            .complete_success(&first, json!({ "speaker": "first" }))
            .unwrap();
        let compacted = fs::read_to_string(&journal_path).unwrap();
        assert!(!compacted.contains("Return JSON for unit-1."));
        assert!(compacted.contains("Return JSON for unit-2."));
        assert!(compacted.contains("sha256:packet-unit-1"));

        let second = store.claim_next(&workflow.id).unwrap().unwrap();
        assert_eq!(second.batch_unit_id.as_deref(), Some("unit-2"));
        (workflow.id, second)
    };

    let mut store = NativeWorkflowStore::open(&directory).expect("replay interrupted batch");
    assert_eq!(
        store.recover_interrupted().expect("recover batch unit"),
        vec![workflow_id.clone()]
    );
    assert!(!store
        .complete_success(&interrupted_claim, json!({ "late": "restart" }))
        .unwrap());
    let failed_claim = store.claim_next(&workflow_id).unwrap().unwrap();
    assert_eq!(failed_claim.batch_unit_id.as_deref(), Some("unit-2"));
    store.complete_failure(&failed_claim).unwrap();
    let resumed = store
        .resume(&workflow_id)
        .expect("resume failed batch unit");
    assert_eq!(resumed.status, NativeWorkflowStatus::Queued);
    assert!(!store
        .complete_success(&failed_claim, json!({ "late": "resume" }))
        .unwrap());

    let retry = store.claim_next(&workflow_id).unwrap().unwrap();
    assert_eq!(retry.batch_unit_id.as_deref(), Some("unit-2"));
    store
        .complete_success(&retry, json!({ "speaker": "second" }))
        .unwrap();
    let third = store.claim_next(&workflow_id).unwrap().unwrap();
    assert_eq!(third.batch_unit_id.as_deref(), Some("unit-3"));
    store
        .complete_success(&third, json!({ "speaker": "third" }))
        .unwrap();
    assert!(store.claim_next(&workflow_id).unwrap().is_none());

    let checkpoint = store
        .checkpoint(&workflow_id, "label-1:scene-1")
        .expect("logical batch checkpoint");
    assert_eq!(checkpoint.request_hash, expected_batch_hash);
    assert_eq!(
        checkpoint.output["version"],
        STRUCTURED_JSON_BATCH_RESULT_VERSION
    );
    let units = checkpoint.output["units"].as_array().unwrap();
    assert_eq!(
        units
            .iter()
            .map(|unit| unit["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["unit-1", "unit-2", "unit-3"]
    );
    assert_eq!(units[0]["packetFingerprint"], "sha256:packet-unit-1");
    assert_eq!(units[1]["output"]["speaker"], "second");
    assert!(units.iter().all(|unit| {
        unit["requestHash"].as_str().is_some() && unit["outputHash"].as_str().is_some()
    }));
    let final_journal = fs::read_to_string(&journal_path).unwrap();
    assert!(!final_journal.contains("Return JSON for unit-1."));
    assert!(!final_journal.contains("Return JSON for unit-2."));
    assert!(!final_journal.contains("Return JSON for unit-3."));
    drop(store);
    NativeWorkflowStore::open(&directory).expect("replay completed batch");
    fs::remove_dir_all(directory).ok();
}

#[test]
fn zero_unit_batch_completes_with_one_logical_checkpoint_and_no_claim() {
    let directory = temp_dir("zero-units");
    let mut store = NativeWorkflowStore::open(&directory).unwrap();
    let workflow = store.submit(compact_submit_request()).unwrap();
    advance_compact_workflow_to_labeling(&mut store, &workflow.id);
    let view = materialize_batch(&mut store, &workflow.id, batch(&[]));
    let label = view
        .jobs
        .iter()
        .find(|job| job.id == "label-1:scene-1")
        .unwrap();
    assert_eq!(label.status, NativeWorkflowJobStatus::Succeeded);
    assert_eq!(view.checkpoints.len(), 3);
    assert!(store.claim_next(&workflow.id).unwrap().is_none());
    let checkpoint = store.checkpoint(&workflow.id, "label-1:scene-1").unwrap();
    assert_eq!(checkpoint.output["units"], json!([]));
    assert_eq!(
        checkpoint.output["version"],
        STRUCTURED_JSON_BATCH_RESULT_VERSION
    );
    drop(store);
    NativeWorkflowStore::open(&directory).expect("replay zero-unit batch");
    fs::remove_dir_all(directory).ok();
}

#[test]
fn batch_contract_rejects_invalid_shapes_scope_and_materialization_drift() {
    let neither: NativeBookWorkflowMaterializeRequest = serde_json::from_value(json!({
        "workflowId": "workflow-1",
        "jobId": "job-1",
        "expectedFence": 1
    }))
    .unwrap();
    assert!(neither.validate().unwrap_err().contains("exactly one"));
    let both: NativeBookWorkflowMaterializeRequest = serde_json::from_value(json!({
        "workflowId": "workflow-1",
        "jobId": "job-1",
        "expectedFence": 1,
        "request": provider_request("single"),
        "batch": batch(&["unit-1"])
    }))
    .unwrap();
    assert!(both.validate().unwrap_err().contains("exactly one"));
    assert!(
        serde_json::from_value::<NativeBookWorkflowMaterializeRequest>(json!({
            "workflowId": "workflow-1",
            "jobId": "job-1",
            "expectedFence": 1,
            "request": null,
            "batch": batch(&["unit-1"])
        }))
        .is_err()
    );

    let mut duplicate = batch(&["unit-1", "unit-1"]);
    assert!(duplicate.validate().unwrap_err().contains("unique"));
    duplicate.version = "native-structured-json-batch-v0".to_string();
    assert!(duplicate.validate().unwrap_err().contains("unsupported"));

    let v2_directory = temp_dir("v2-scope");
    let mut v2_store = NativeWorkflowStore::open(&v2_directory).unwrap();
    let v2 = v2_store.submit(submit_request()).unwrap();
    let error = v2_store
        .materialize(NativeBookWorkflowMaterializeRequest {
            workflow_id: v2.id,
            job_id: "bootstrap-1".to_string(),
            expected_fence: 1,
            request: None,
            batch: Some(batch(&["unit-1"])),
        })
        .unwrap_err();
    assert!(error.contains("schema-v3"));

    let directory = temp_dir("drift");
    let mut store = NativeWorkflowStore::open(&directory).unwrap();
    let workflow = store.submit(compact_submit_request()).unwrap();
    advance_compact_workflow_to_labeling(&mut store, &workflow.id);
    let single_error = store
        .materialize(NativeBookWorkflowMaterializeRequest {
            workflow_id: workflow.id.clone(),
            job_id: "label-1:scene-1".to_string(),
            expected_fence: workflow.fence,
            request: Some(provider_request("invalid-single-speaker-request")),
            batch: None,
        })
        .unwrap_err();
    assert!(single_error.contains("require batch materialization"));
    let original = batch(&["unit-1", "unit-2"]);
    materialize_batch(&mut store, &workflow.id, original.clone());
    materialize_batch(&mut store, &workflow.id, original);
    let mut drifted = batch(&["unit-1", "unit-2"]);
    drifted.units[1].packet_fingerprint = "sha256:drifted-packet".to_string();
    let fence = store.get(&workflow.id).unwrap().fence;
    let error = store
        .materialize(NativeBookWorkflowMaterializeRequest {
            workflow_id: workflow.id.clone(),
            job_id: "label-1:scene-1".to_string(),
            expected_fence: fence,
            request: None,
            batch: Some(drifted),
        })
        .unwrap_err();
    assert!(error.contains("drift"));
    fs::remove_dir_all(v2_directory).ok();
    fs::remove_dir_all(directory).ok();
}

#[test]
fn compact_submit_rejects_embedded_provider_requests() {
    let mut request = compact_submit_request();
    request.stages[2].jobs[0].request = Some(provider_request("embedded-speaker-request"));
    assert!(request
        .validate()
        .unwrap_err()
        .contains("materialize provider input after submit"));
}

#[test]
fn replay_rejects_compacted_batch_packet_or_result_tampering() {
    for (name, mutate) in [
        ("packet", mutate_packet_fingerprint as fn(&mut Value)),
        ("result", mutate_unit_output as fn(&mut Value)),
    ] {
        let directory = temp_dir(name);
        let journal_path = directory.join(WORKFLOW_JOURNAL_FILE);
        {
            let mut store = NativeWorkflowStore::open(&directory).unwrap();
            let workflow = store.submit(compact_submit_request()).unwrap();
            advance_compact_workflow_to_labeling(&mut store, &workflow.id);
            materialize_batch(&mut store, &workflow.id, batch(&["unit-1"]));
            let claim = store.claim_next(&workflow.id).unwrap().unwrap();
            store
                .complete_success(&claim, json!({ "speaker": "original" }))
                .unwrap();
        }
        rewrite_snapshot(&journal_path, mutate);
        let error = NativeWorkflowStore::open(&directory)
            .err()
            .expect("tampered batch snapshot must fail");
        assert!(error.contains("batch"), "unexpected replay error: {error}");
        fs::remove_dir_all(directory).ok();
    }
}

#[test]
fn replay_rejects_compacted_speaker_checkpoint_without_its_batch() {
    let directory = temp_dir("missing-batch");
    let journal_path = directory.join(WORKFLOW_JOURNAL_FILE);
    {
        let mut store = NativeWorkflowStore::open(&directory).unwrap();
        let workflow = store.submit(compact_submit_request()).unwrap();
        advance_compact_workflow_to_labeling(&mut store, &workflow.id);
        materialize_batch(&mut store, &workflow.id, batch(&["unit-1"]));
        let claim = store.claim_next(&workflow.id).unwrap().unwrap();
        store
            .complete_success(&claim, json!({ "speaker": "original" }))
            .unwrap();
    }
    rewrite_snapshot(&journal_path, |event| {
        event["workflow"]["jobs"][2]
            .as_object_mut()
            .unwrap()
            .remove("batch");
    });
    let error = NativeWorkflowStore::open(&directory)
        .err()
        .expect("speaker checkpoint without batch must fail");
    assert!(
        error.contains("requires a batch checkpoint"),
        "unexpected replay error: {error}"
    );
    fs::remove_dir_all(directory).ok();
}

fn mutate_packet_fingerprint(event: &mut Value) {
    event["workflow"]["jobs"][2]["batch"]["units"][0]["packet_fingerprint"] =
        json!("sha256:tampered-packet");
}

fn mutate_unit_output(event: &mut Value) {
    event["workflow"]["jobs"][2]["batch"]["units"][0]["output"] = json!({ "speaker": "tampered" });
}

fn rewrite_snapshot(path: &Path, mutate: fn(&mut Value)) {
    let contents = fs::read_to_string(path).unwrap();
    let mut lines = contents.lines().collect::<Vec<_>>();
    let mut event: Value = serde_json::from_str(lines[0]).unwrap();
    mutate(&mut event);
    let encoded = serde_json::to_string(&event).unwrap();
    lines[0] = &encoded;
    fs::write(path, format!("{}\n", lines.join("\n"))).unwrap();
}
