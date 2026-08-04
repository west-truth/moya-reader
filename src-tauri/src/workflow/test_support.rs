use super::command_contract::{
    NativeBookWorkflowJobRequest, NativeBookWorkflowStageRequest, NativeBookWorkflowSubmitRequest,
    NativeWorkflowJobType, NativeWorkflowStage, COMPACT_WORKFLOW_SCHEMA_VERSION,
};
use crate::ai::command_contract::DesktopStructuredJsonRequest;
use serde_json::json;

pub(super) fn provider_request(id: &str) -> DesktopStructuredJsonRequest {
    DesktopStructuredJsonRequest {
        provider_id: "openai".to_string(),
        model_id: "gpt-5-mini".to_string(),
        prompt: format!("Return JSON for {id}."),
        response_schema: json!({ "type": "object" }),
        json_schema_name: "native_workflow_result".to_string(),
        schema_version: Some("native-workflow-v1".to_string()),
        provider_options: Some(json!({ "temperature": 0.1 })),
    }
}

fn planned_job(id: &str) -> NativeBookWorkflowJobRequest {
    NativeBookWorkflowJobRequest {
        id: id.to_string(),
        request: None,
        job_type: None,
        contract_fingerprint: None,
    }
}

pub(super) fn submit_request() -> NativeBookWorkflowSubmitRequest {
    let mut request = NativeBookWorkflowSubmitRequest {
        schema_version: None,
        idempotency_key: "revision-plan-1".to_string(),
        novel_id: "novel-1".to_string(),
        content_revision: "revision-1".to_string(),
        plan_hash: String::new(),
        stages: vec![
            NativeBookWorkflowStageRequest {
                stage: NativeWorkflowStage::CharacterGraphBootstrap,
                jobs: vec![planned_job("bootstrap-1"), planned_job("bootstrap-2")],
            },
            NativeBookWorkflowStageRequest {
                stage: NativeWorkflowStage::CharacterGraphMerge,
                jobs: vec![planned_job("merge-1")],
            },
            NativeBookWorkflowStageRequest {
                stage: NativeWorkflowStage::ChapterLabeling,
                jobs: vec![planned_job("label-1"), planned_job("label-2")],
            },
            NativeBookWorkflowStageRequest {
                stage: NativeWorkflowStage::TtsReadyPreparation,
                jobs: Vec::new(),
            },
        ],
    };
    request.plan_hash = request.canonical_plan_hash().expect("canonical plan hash");
    request
}

pub(super) fn compact_submit_request() -> NativeBookWorkflowSubmitRequest {
    let job =
        |id: &str, job_type, contract_fingerprint: Option<&str>| NativeBookWorkflowJobRequest {
            id: id.to_string(),
            request: None,
            job_type: Some(job_type),
            contract_fingerprint: contract_fingerprint.map(str::to_string),
        };
    let mut request = NativeBookWorkflowSubmitRequest {
        schema_version: Some(COMPACT_WORKFLOW_SCHEMA_VERSION),
        idempotency_key: "revision-compact-plan-1".to_string(),
        novel_id: "novel-1".to_string(),
        content_revision: "revision-1".to_string(),
        plan_hash: String::new(),
        stages: vec![
            NativeBookWorkflowStageRequest {
                stage: NativeWorkflowStage::CharacterGraphBootstrap,
                jobs: vec![job(
                    "bootstrap-1",
                    NativeWorkflowJobType::CharacterBundleAnalysis,
                    None,
                )],
            },
            NativeBookWorkflowStageRequest {
                stage: NativeWorkflowStage::CharacterGraphMerge,
                jobs: vec![job(
                    "merge-1",
                    NativeWorkflowJobType::CharacterGraphMerge,
                    None,
                )],
            },
            NativeBookWorkflowStageRequest {
                stage: NativeWorkflowStage::ChapterLabeling,
                jobs: vec![job(
                    "label-1:scene-1",
                    NativeWorkflowJobType::SpeakerAttributionV3,
                    Some("sha256:compact-contract"),
                )],
            },
            NativeBookWorkflowStageRequest {
                stage: NativeWorkflowStage::TtsReadyPreparation,
                jobs: Vec::new(),
            },
        ],
    };
    request.plan_hash = request.canonical_plan_hash().expect("compact plan hash");
    request
}
