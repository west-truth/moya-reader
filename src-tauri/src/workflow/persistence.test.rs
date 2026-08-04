use super::*;
use crate::workflow::command_contract::{
    NativeBookWorkflowMaterializeRequest, NativeStructuredJsonBatch, NativeStructuredJsonBatchUnit,
    NativeWorkflowJobStatus, NativeWorkflowStatus, STRUCTURED_JSON_BATCH_VERSION,
};
use crate::workflow::state::now_ms;
use crate::workflow::test_support::{compact_submit_request, provider_request, submit_request};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn temp_dir(test_name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "noveldesk-native-workflow-persistence-{test_name}-{}-{}",
        std::process::id(),
        now_ms()
    ));
    fs::create_dir_all(&path).expect("create persistence test directory");
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

fn complete_compact_job(store: &mut NativeWorkflowStore, workflow_id: &str, job_id: &str) {
    if job_id.starts_with("label-") {
        let fence = store.get(workflow_id).expect("workflow").fence;
        store
            .materialize(NativeBookWorkflowMaterializeRequest {
                workflow_id: workflow_id.to_string(),
                job_id: job_id.to_string(),
                expected_fence: fence,
                request: None,
                batch: Some(NativeStructuredJsonBatch {
                    version: STRUCTURED_JSON_BATCH_VERSION.to_string(),
                    units: vec![NativeStructuredJsonBatchUnit {
                        id: format!("{job_id}:unit-1"),
                        packet_fingerprint: format!("sha256:{job_id}:packet-1"),
                        request: provider_request(job_id),
                    }],
                }),
            })
            .expect("materialize compact label batch");
    } else {
        materialize(store, workflow_id, job_id);
    }
    let claim = store.claim_next(workflow_id).unwrap().unwrap();
    assert_eq!(claim.job_id, job_id);
    store
        .complete_success(&claim, json!({ "jobId": job_id }))
        .unwrap();
    assert!(store.claim_next(workflow_id).unwrap().is_none());
}

#[test]
fn compact_manifest_metadata_survives_completion_compaction_and_rejects_tampering() {
    let directory = temp_dir("compact-manifest");
    let journal_path = directory.join(WORKFLOW_JOURNAL_FILE);
    let workflow_id = {
        let mut store = NativeWorkflowStore::open(&directory).unwrap();
        let workflow = store.submit(compact_submit_request()).unwrap();
        assert_eq!(workflow.schema_version, 3);
        complete_compact_job(&mut store, &workflow.id, "bootstrap-1");
        complete_compact_job(&mut store, &workflow.id, "merge-1");
        complete_compact_job(&mut store, &workflow.id, "label-1:scene-1");
        workflow.id
    };

    let reopened = NativeWorkflowStore::open(&directory).expect("replay compact workflow");
    let view = reopened.get(&workflow_id).unwrap();
    let label = view
        .jobs
        .iter()
        .find(|job| job.id == "label-1:scene-1")
        .unwrap();
    assert_eq!(
        label.contract_fingerprint.as_deref(),
        Some("sha256:compact-contract")
    );
    let checkpoint = view
        .checkpoints
        .iter()
        .find(|checkpoint| checkpoint.job_id == "label-1:scene-1")
        .unwrap();
    assert_eq!(
        checkpoint.contract_fingerprint.as_deref(),
        Some("sha256:compact-contract")
    );
    drop(reopened);

    rewrite_event(&journal_path, 0, |event| {
        event["workflow"]["jobs"][2]["contract_fingerprint"] = json!("sha256:tampered-contract");
    });
    assert!(NativeWorkflowStore::open(&directory)
        .err()
        .expect("tampered compact contract must fail")
        .contains("manifest hash"));
    fs::remove_dir_all(directory).ok();
}

#[test]
fn replay_rejects_tampered_materialized_request_and_checkpoint_output_hashes() {
    let request_directory = temp_dir("request-hash");
    let request_path = request_directory.join(WORKFLOW_JOURNAL_FILE);
    {
        let mut store = NativeWorkflowStore::open(&request_directory).unwrap();
        let workflow = store.submit(submit_request()).unwrap();
        materialize(&mut store, &workflow.id, "bootstrap-1");
    }
    rewrite_event(&request_path, 1, |event| {
        event["request_hash"] = json!("sha256:tampered");
    });
    assert!(NativeWorkflowStore::open(&request_directory)
        .err()
        .expect("tampered request must fail")
        .contains("request hash"));

    let output_directory = temp_dir("output-hash");
    let output_path = output_directory.join(WORKFLOW_JOURNAL_FILE);
    {
        let mut store = NativeWorkflowStore::open(&output_directory).unwrap();
        let workflow = store.submit(submit_request()).unwrap();
        materialize(&mut store, &workflow.id, "bootstrap-1");
        let claim = store.claim_next(&workflow.id).unwrap().unwrap();
        store
            .complete_success(&claim, json!({ "valid": true }))
            .unwrap();
    }
    rewrite_event(&output_path, 0, |event| {
        event["workflow"]["checkpoints"][0]["output_hash"] = json!("sha256:tampered");
    });
    assert!(NativeWorkflowStore::open(&output_directory)
        .err()
        .expect("tampered output must fail")
        .contains("checkpoint hash"));
    fs::remove_dir_all(request_directory).ok();
    fs::remove_dir_all(output_directory).ok();
}

#[test]
fn compaction_removes_completed_prompts_but_preserves_failed_retry_input() {
    let directory = temp_dir("prompt-retention");
    let journal_path = directory.join(WORKFLOW_JOURNAL_FILE);
    let workflow_id = {
        let mut store = NativeWorkflowStore::open(&directory).unwrap();
        let workflow = store.submit(submit_request()).unwrap();
        materialize(&mut store, &workflow.id, "bootstrap-1");
        let claim = store.claim_next(&workflow.id).unwrap().unwrap();
        store
            .complete_success(&claim, json!({ "done": 1 }))
            .unwrap();
        workflow.id
    };
    let compacted = fs::read_to_string(&journal_path).unwrap();
    assert!(!compacted.contains("Return JSON for bootstrap-1."));

    {
        let mut store = NativeWorkflowStore::open(&directory).unwrap();
        materialize(&mut store, &workflow_id, "bootstrap-2");
        let claim = store.claim_next(&workflow_id).unwrap().unwrap();
        store.complete_failure(&claim).unwrap();
    }
    assert!(fs::read_to_string(&journal_path)
        .unwrap()
        .contains("Return JSON for bootstrap-2."));
    let mut recovered = NativeWorkflowStore::open(&directory).expect("replay failed request");
    recovered
        .resume(&workflow_id)
        .expect("resume failed request");
    let retry = recovered.claim_next(&workflow_id).unwrap().unwrap();
    assert_eq!(retry.request.prompt, "Return JSON for bootstrap-2.");
    fs::remove_dir_all(directory).ok();
}

#[test]
fn cancellation_compaction_is_prompt_free_and_restart_safe() {
    let directory = temp_dir("cancel-compaction");
    let journal_path = directory.join(WORKFLOW_JOURNAL_FILE);
    let workflow_id = {
        let mut store = NativeWorkflowStore::open(&directory).unwrap();
        let workflow = store.submit(submit_request()).unwrap();
        materialize(&mut store, &workflow.id, "bootstrap-1");
        store.cancel(&workflow.id).expect("cancel workflow");
        workflow.id
    };
    let journal = fs::read_to_string(&journal_path).unwrap();
    assert!(!journal.contains("Return JSON for bootstrap-1."));
    let reopened = NativeWorkflowStore::open(&directory).expect("replay compacted cancellation");
    let view = reopened.get(&workflow_id).unwrap();
    assert_eq!(view.status, NativeWorkflowStatus::Cancelled);
    assert_eq!(view.jobs[0].status, NativeWorkflowJobStatus::Cancelled);
    assert_eq!(view.jobs[0].provider_id.as_deref(), Some("openai"));
    fs::remove_dir_all(directory).ok();
}

#[test]
fn interrupted_compaction_restores_backup_instead_of_partial_snapshot() {
    let directory = temp_dir("interrupted-compaction");
    let journal_path = directory.join(WORKFLOW_JOURNAL_FILE);
    let workflow_id = {
        let mut store = NativeWorkflowStore::open(&directory).unwrap();
        let workflow = store.submit(submit_request()).unwrap();
        materialize(&mut store, &workflow.id, "bootstrap-1");
        workflow.id
    };
    let complete_journal = fs::read_to_string(&journal_path).unwrap();
    let submitted_only = complete_journal.lines().next().unwrap().to_string() + "\n";
    let backup_path = sidecar_path(&journal_path, ".backup");
    let temporary_path = sidecar_path(&journal_path, ".compacting");
    fs::rename(&journal_path, &backup_path).expect("simulate old journal backup");
    fs::write(&temporary_path, submitted_only).expect("simulate partial compacted snapshot");

    let recovered = NativeWorkflowStore::open(&directory).expect("restore complete backup");
    let view = recovered.get(&workflow_id).unwrap();
    assert_eq!(view.jobs[0].status, NativeWorkflowJobStatus::Queued);
    assert!(fs::read_to_string(&journal_path)
        .unwrap()
        .contains("Return JSON for bootstrap-1."));
    assert!(!backup_path.exists());
    assert!(!temporary_path.exists());
    fs::remove_dir_all(directory).ok();
}

#[test]
fn installed_but_incomplete_snapshot_restores_the_valid_backup() {
    let directory = temp_dir("installed-incomplete-compaction");
    let journal_path = directory.join(WORKFLOW_JOURNAL_FILE);
    let workflow_id = {
        let mut store = NativeWorkflowStore::open(&directory).unwrap();
        let workflow = store.submit(submit_request()).unwrap();
        materialize(&mut store, &workflow.id, "bootstrap-1");
        workflow.id
    };
    let complete_journal = fs::read_to_string(&journal_path).unwrap();
    let submitted_only = complete_journal.lines().next().unwrap().to_string() + "\n";
    let backup_path = sidecar_path(&journal_path, ".backup");
    fs::copy(&journal_path, &backup_path).expect("simulate retained old journal backup");
    fs::write(&journal_path, submitted_only).expect("simulate installed partial snapshot");

    let recovered = NativeWorkflowStore::open(&directory).expect("restore valid backup");
    let view = recovered.get(&workflow_id).unwrap();
    assert_eq!(view.jobs[0].status, NativeWorkflowJobStatus::Queued);
    assert!(fs::read_to_string(&journal_path)
        .unwrap()
        .contains("Return JSON for bootstrap-1."));
    assert!(!backup_path.exists());
    fs::remove_dir_all(directory).ok();
}

fn rewrite_event(path: &Path, index: usize, edit: impl FnOnce(&mut Value)) {
    let source = fs::read_to_string(path).expect("read journal");
    let mut events = source
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("journal event"))
        .collect::<Vec<_>>();
    edit(&mut events[index]);
    let rewritten = events
        .into_iter()
        .map(|event| serde_json::to_string(&event).unwrap())
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    fs::write(path, rewritten).expect("rewrite journal");
}

fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut file_name = path.file_name().unwrap().to_os_string();
    file_name.push(suffix);
    path.with_file_name(file_name)
}
