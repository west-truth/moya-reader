use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "windows")]
    let builder = builder.on_page_load(|webview, payload| {
        if payload.event() != tauri::webview::PageLoadEvent::Finished {
            return;
        }
        let _ = webview.eval(
            r#"
            (() => {
              const migrationKey = 'moya.nativeShellCacheVersion';
              const migrationVersion = '1';
              if (
                window.location.hostname !== 'tauri.localhost' ||
                window.localStorage.getItem(migrationKey) === migrationVersion
              ) return;
              window.localStorage.setItem(migrationKey, migrationVersion);
              const unregister = 'serviceWorker' in navigator
                ? navigator.serviceWorker.getRegistrations().then((registrations) =>
                    Promise.all(registrations.map((registration) => registration.unregister())))
                : Promise.resolve([]);
              const clearCaches = 'caches' in window
                ? window.caches.keys().then((keys) =>
                    Promise.all(keys.map((key) => window.caches.delete(key))))
                : Promise.resolve([]);
              Promise.all([unregister, clearCaches]).finally(() => window.location.reload());
            })();
            "#,
        );
    });
    #[cfg(target_os = "android")]
    let builder = builder.plugin(crate::provider_secrets::init_android_provider_secret_store());
    #[cfg(target_os = "android")]
    let builder = builder.plugin(crate::secure_credentials::init_android_app_credential_store());
    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(crate::tts::android_recovery::init())
        .plugin(crate::android_document_io::init_android_document_io())
        .plugin(crate::android_plugins::init_android_shell())
        .plugin(crate::android_plugins::init_android_system_tts());
    let app = builder
        .setup(|app| {
            app.manage(crate::metadata_collector::MetadataCollectorManager::default());
            let runtime = crate::workflow::NativeWorkflowRuntime::open(app.handle())
                .map_err(std::io::Error::other)?;
            app.manage(runtime.clone());
            runtime
                .recover_and_spawn(app.handle().clone())
                .map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            crate::provider_secrets::provider_secret_set,
            crate::provider_secrets::provider_secret_status,
            crate::provider_secrets::provider_secret_delete,
            crate::provider_secrets::provider_secret_test,
            crate::secure_credentials::app_credential_set,
            crate::secure_credentials::app_credential_get,
            crate::secure_credentials::app_credential_status,
            crate::secure_credentials::app_credential_delete,
            crate::desktop_oauth::desktop_dropbox_oauth_authorize,
            crate::metadata_collector::desktop_metadata_collector_start,
            crate::metadata_collector::desktop_metadata_collector_stop,
            crate::android_document_io::android_document_io_pick,
            crate::android_document_io::android_document_io_pick_folder,
            crate::android_document_io::android_document_io_scan_folder,
            crate::android_document_io::android_document_io_open_folder_file,
            crate::android_document_io::android_document_io_forget_folder,
            crate::android_document_io::android_document_io_read_chunk,
            crate::android_document_io::android_document_io_release,
            crate::android_document_io::android_document_io_begin_save,
            crate::android_document_io::android_document_io_write_chunk,
            crate::android_document_io::android_document_io_finish_save,
            crate::android_document_io::android_document_io_abort_save,
            crate::ai::bridge::desktop_ai_generate_json,
            crate::workflow::bridge::native_book_workflow_submit,
            crate::workflow::bridge::native_book_workflow_get,
            crate::workflow::bridge::native_book_workflow_active_get,
            crate::workflow::bridge::native_book_workflow_materialize,
            crate::workflow::bridge::native_book_workflow_finalize_readiness,
            crate::workflow::bridge::native_book_workflow_require_review,
            crate::workflow::bridge::native_book_workflow_label_mutation_prepare,
            crate::workflow::bridge::native_book_workflow_label_mutation_finalize,
            crate::workflow::bridge::native_book_workflow_resume,
            crate::workflow::bridge::native_book_workflow_cancel,
            crate::workflow::bridge::native_book_workflow_checkpoint_get,
            crate::tts::bridge::desktop_tts_synthesize,
            crate::tts::render_cache::native_tts_render_cached,
            crate::tts::render_cache::native_tts_cache_readiness,
            crate::tts::render_cache::native_tts_cache_prune,
            crate::tts::render_cache::native_tts_cache_evidence,
            crate::tts::render_cache::native_tts_operation_cancel,
            crate::tts::render_cache::native_tts_pending_jobs,
            crate::tts::bridge::desktop_tts_list_voices
        ])
        .build(tauri::generate_context!())
        .expect("error while building Moya");
    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            app_handle
                .state::<crate::metadata_collector::MetadataCollectorManager>()
                .stop_before_exit();
        }
    });
}
