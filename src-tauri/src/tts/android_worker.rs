use super::bridge::desktop_tts_synthesize_with_secret;
use super::cache_runtime::{render_cached_with, shared_runtime};
use super::job_manifest::{
    claim_due, clear_pending, is_retryable_failure, mark_failed, JOB_DIRECTORY,
};
use jni::objects::{JObject, JString};
use jni::sys::jint;
use jni::JNIEnv;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const OUTCOME_SUCCESS: jint = 0;
const OUTCOME_RETRY: jint = 1;
const OUTCOME_FAILED: jint = 2;
const OUTCOME_NOT_DUE: jint = 3;
const OUTCOME_INTERNAL: jint = 4;
const CACHE_DIRECTORY: &str = "native-tts-render-cache-v2";

#[no_mangle]
pub extern "system" fn Java_com_local_noveldeskreader_NativeTtsRecoveryWorker_runNativeTtsJob(
    mut env: JNIEnv,
    _worker: JObject,
    app_data_path: JString,
    operation_id: JString,
    secret: JString,
) -> jint {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let app_data_path = match env.get_string(&app_data_path) {
            Ok(value) => String::from(value),
            Err(_) => return OUTCOME_INTERNAL,
        };
        let operation_id = match env.get_string(&operation_id) {
            Ok(value) => String::from(value),
            Err(_) => return OUTCOME_INTERNAL,
        };
        let secret = match env.get_string(&secret) {
            Ok(value) => String::from(value),
            Err(_) => return OUTCOME_INTERNAL,
        };
        run_job(PathBuf::from(app_data_path), operation_id, secret)
    }))
    .unwrap_or(OUTCOME_INTERNAL)
}

fn run_job(app_data: PathBuf, operation_id: String, secret: String) -> jint {
    if !app_data.is_absolute() || operation_id.trim().is_empty() || operation_id.len() > 256 {
        return OUTCOME_INTERNAL;
    }
    let job_directory = app_data.join(JOB_DIRECTORY);
    let cache_directory = app_data.join(CACHE_DIRECTORY);
    let request = match claim_due(&job_directory, operation_id.trim(), now_ms()) {
        Ok(Some(request)) => request,
        Ok(None) => return OUTCOME_NOT_DUE,
        Err(_) => return OUTCOME_INTERNAL,
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => return OUTCOME_INTERNAL,
    };
    let result = runtime.block_on(render_cached_with(
        shared_runtime(),
        &cache_directory,
        request,
        |synthesis| desktop_tts_synthesize_with_secret(synthesis, secret),
    ));
    match result {
        Ok(_) => match clear_pending(&job_directory, operation_id.trim()) {
            Ok(()) => OUTCOME_SUCCESS,
            Err(_) => OUTCOME_INTERNAL,
        },
        Err(error) => {
            let retryable = is_retryable_failure(&error);
            let _ = mark_failed(&job_directory, operation_id.trim(), &error);
            if retryable {
                OUTCOME_RETRY
            } else {
                OUTCOME_FAILED
            }
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| duration.as_millis().try_into().ok())
        .unwrap_or_default()
}
