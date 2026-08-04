use super::command_contract::{
    NativeBookWorkflowFinalizeRequest, NativeBookWorkflowMaterializeRequest,
    NativeBookWorkflowReviewRequest, NativeBookWorkflowSubmitRequest, NativeBookWorkflowView,
    NativeLabelMutationFinalizeRequest, NativeLabelMutationPrepareRequest,
    NativeWorkflowCheckpointResult, NativeWorkflowStatus,
};
use super::store::NativeWorkflowStore;
use crate::ai::bridge::desktop_ai_generate_json_impl;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::Manager;

#[derive(Clone)]
pub(crate) struct NativeWorkflowRuntime {
    inner: Arc<NativeWorkflowRuntimeInner>,
}

struct NativeWorkflowRuntimeInner {
    store: Mutex<NativeWorkflowStore>,
    active_workflows: Mutex<HashSet<String>>,
}

impl NativeWorkflowRuntime {
    pub(crate) fn open(app: &tauri::AppHandle) -> Result<Self, String> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|_| "native workflow app data path is unavailable".to_string())?;
        Ok(Self {
            inner: Arc::new(NativeWorkflowRuntimeInner {
                store: Mutex::new(NativeWorkflowStore::open(&data_dir)?),
                active_workflows: Mutex::new(HashSet::new()),
            }),
        })
    }

    pub(crate) fn recover_and_spawn(&self, app: tauri::AppHandle) -> Result<(), String> {
        let workflow_ids = self.store()?.recover_interrupted()?;
        for workflow_id in workflow_ids {
            self.spawn(app.clone(), workflow_id)?;
        }
        Ok(())
    }

    pub(crate) fn submit(
        &self,
        request: NativeBookWorkflowSubmitRequest,
    ) -> Result<NativeBookWorkflowView, String> {
        self.store()?.submit(request)
    }

    pub(crate) fn get(&self, workflow_id: &str) -> Result<NativeBookWorkflowView, String> {
        self.store()?.get(workflow_id)
    }

    pub(crate) fn get_active(
        &self,
        novel_id: &str,
        content_revision: &str,
    ) -> Result<Option<NativeBookWorkflowView>, String> {
        self.store()?.get_active(novel_id, content_revision)
    }

    pub(crate) fn materialize(
        &self,
        request: NativeBookWorkflowMaterializeRequest,
    ) -> Result<NativeBookWorkflowView, String> {
        self.store()?.materialize(request)
    }

    pub(crate) fn finalize_readiness(
        &self,
        request: NativeBookWorkflowFinalizeRequest,
    ) -> Result<NativeBookWorkflowView, String> {
        self.store()?.finalize_readiness(request)
    }

    pub(crate) fn checkpoint(
        &self,
        workflow_id: &str,
        job_id: &str,
    ) -> Result<NativeWorkflowCheckpointResult, String> {
        self.store()?.checkpoint(workflow_id, job_id)
    }

    pub(crate) fn require_review(
        &self,
        request: NativeBookWorkflowReviewRequest,
    ) -> Result<NativeBookWorkflowView, String> {
        self.store()?.require_review(request)
    }

    pub(crate) fn prepare_label_mutation(
        &self,
        request: NativeLabelMutationPrepareRequest,
    ) -> Result<NativeBookWorkflowView, String> {
        self.store()?.prepare_label_mutation(request)
    }

    pub(crate) fn finalize_label_mutation(
        &self,
        request: NativeLabelMutationFinalizeRequest,
    ) -> Result<NativeBookWorkflowView, String> {
        self.store()?.finalize_label_mutation(request)
    }

    pub(crate) fn resume(&self, workflow_id: &str) -> Result<NativeBookWorkflowView, String> {
        self.store()?.resume(workflow_id)
    }

    pub(crate) fn cancel(&self, workflow_id: &str) -> Result<NativeBookWorkflowView, String> {
        self.store()?.cancel(workflow_id)
    }

    pub(crate) fn spawn(&self, app: tauri::AppHandle, workflow_id: String) -> Result<(), String> {
        if !self.register_runner(&workflow_id)? {
            return Ok(());
        }
        let runtime = self.clone();
        tauri::async_runtime::spawn(async move {
            runtime.run(&app, &workflow_id).await;
            if runtime.finish_runner(&workflow_id).unwrap_or(false) {
                let _ = runtime.spawn(app, workflow_id);
            }
        });
        Ok(())
    }

    async fn run(&self, app: &tauri::AppHandle, workflow_id: &str) {
        loop {
            let claim = match self
                .store()
                .and_then(|mut store| store.claim_next(workflow_id))
            {
                Ok(Some(claim)) => claim,
                Ok(None) | Err(_) => return,
            };
            let provider_result =
                desktop_ai_generate_json_impl(Some(app), claim.request.clone()).await;
            match provider_result {
                Ok(output) => {
                    let parsed_output = match serde_json::from_str::<Value>(&output.text) {
                        Ok(output) => output,
                        Err(_) => {
                            if let Ok(mut store) = self.store() {
                                let _ = store.complete_failure(&claim);
                            }
                            return;
                        }
                    };
                    match self.store().and_then(|mut store| {
                        store.complete_success_with_metadata(
                            &claim,
                            parsed_output,
                            Some(output.execution_metadata),
                        )
                    }) {
                        Ok(true) => {}
                        Ok(false) | Err(_) => return,
                    }
                }
                Err(_) => {
                    if let Ok(mut store) = self.store() {
                        let _ = store.complete_failure(&claim);
                    }
                    return;
                }
            }
        }
    }

    pub(crate) fn should_spawn(view: &NativeBookWorkflowView) -> bool {
        matches!(view.status, NativeWorkflowStatus::Queued)
    }

    fn register_runner(&self, workflow_id: &str) -> Result<bool, String> {
        Ok(self.active_workflows()?.insert(workflow_id.to_string()))
    }

    fn finish_runner(&self, workflow_id: &str) -> Result<bool, String> {
        self.active_workflows()?.remove(workflow_id);
        self.get(workflow_id).map(|view| Self::should_spawn(&view))
    }

    fn store(&self) -> Result<MutexGuard<'_, NativeWorkflowStore>, String> {
        self.inner
            .store
            .lock()
            .map_err(|_| "native workflow state lock is unavailable".to_string())
    }

    fn active_workflows(&self) -> Result<MutexGuard<'_, HashSet<String>>, String> {
        self.inner
            .active_workflows
            .lock()
            .map_err(|_| "native workflow runner lock is unavailable".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::state::PersistedWorkflow;
    use crate::workflow::test_support::submit_request;
    use crate::workflow::{command_contract::NativeBookWorkflowMaterializeRequest, state::now_ms};
    use std::fs;

    #[test]
    fn runtime_only_spawns_workflows_with_executable_input() {
        let waiting = PersistedWorkflow::from_request(submit_request())
            .expect("planned workflow")
            .view();
        assert_eq!(waiting.status, NativeWorkflowStatus::WaitingForInput);
        assert!(!NativeWorkflowRuntime::should_spawn(&waiting));

        let mut queued_request = submit_request();
        queued_request.stages[0].jobs[0].request = Some(
            crate::workflow::test_support::provider_request("bootstrap-1"),
        );
        let queued = PersistedWorkflow::from_request(queued_request)
            .expect("materialized workflow")
            .view();
        assert_eq!(queued.status, NativeWorkflowStatus::Queued);
        assert!(NativeWorkflowRuntime::should_spawn(&queued));
    }

    #[test]
    fn runner_cleanup_rechecks_work_materialized_while_runner_was_active() {
        let directory = std::env::temp_dir().join(format!(
            "noveldesk-native-runner-wakeup-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let mut store = NativeWorkflowStore::open(&directory).expect("workflow store");
        let workflow = store.submit(submit_request()).expect("workflow");
        let runtime = NativeWorkflowRuntime {
            inner: Arc::new(NativeWorkflowRuntimeInner {
                store: Mutex::new(store),
                active_workflows: Mutex::new(HashSet::new()),
            }),
        };

        assert!(runtime.register_runner(&workflow.id).unwrap());
        let queued = runtime
            .materialize(NativeBookWorkflowMaterializeRequest {
                workflow_id: workflow.id.clone(),
                job_id: "bootstrap-1".to_string(),
                expected_fence: workflow.fence,
                request: Some(crate::workflow::test_support::provider_request(
                    "bootstrap-1",
                )),
                batch: None,
            })
            .expect("materialize during runner cleanup");
        assert!(NativeWorkflowRuntime::should_spawn(&queued));
        assert!(!runtime.register_runner(&workflow.id).unwrap());
        assert!(runtime.finish_runner(&workflow.id).unwrap());
        assert!(runtime.register_runner(&workflow.id).unwrap());
        fs::remove_dir_all(directory).ok();
    }
}
