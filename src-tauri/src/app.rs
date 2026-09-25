use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(moya_portable)]
    if let Err(error) = crate::portable::prepare() {
        if error == "moya_existing_focused" {
            return;
        }
        eprintln!("{error}");
        #[cfg(target_os = "windows")]
        crate::portable::show_error(&error);
        return;
    }
    #[cfg(all(moya_portable, target_os = "windows"))]
    if let Err(error) = crate::portable::ensure_webview2() {
        eprintln!("{error}");
        crate::portable::show_error(&error);
        return;
    }
    let builder = tauri::Builder::default();
    #[cfg(target_os = "windows")]
    let builder = builder.on_page_load(|webview, payload| {
        if payload.event() != tauri::webview::PageLoadEvent::Finished {
            return;
        }
        #[cfg(moya_portable)]
        if let Ok(token) = std::env::var("MOYA_PORTABLE_SMOKE_TOKEN") {
            if token.len() == 32 && token.bytes().all(|value| value.is_ascii_hexdigit()) {
                let script = r#"
                  (() => {
                    const key = 'moya.portable-smoke';
                    const timer = setInterval(() => {
                      if (!document.querySelector('#root button')) return;
                      clearInterval(timer);
                      const persisted = localStorage.getItem(key) === '__TOKEN__';
                      localStorage.setItem(key, '__TOKEN__');
                      window.__TAURI_INTERNALS__.invoke('desktop_portable_smoke_ready', { persisted });
                    }, 100);
                    setTimeout(() => clearInterval(timer), 60000);
                  })();
                "#.replace("__TOKEN__", &token);
                let _ = webview.eval(&script);
            }
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
    let context = tauri::generate_context!();
    #[cfg(all(debug_assertions, target_os = "windows", moya_embedded_server))]
    let context = {
        let mut context = context;
        if let Ok(port) = std::env::var("MOYA_EMBEDDED_CDP_PORT")
            .unwrap_or_default()
            .parse::<u16>()
        {
            if port != 0 {
                if let Some(window) = context.config_mut().app.windows.first_mut() {
                    window.additional_browser_args =
                        Some(format!("--remote-debugging-port={port}"));
                }
            }
        }
        context
    };
    let app = builder
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if window
                        .state::<crate::embedded_server::EmbeddedServerManager>()
                        .running()
                    {
                        api.prevent_close();
                        let _ = window.emit("embedded-server-close-requested", ());
                    } else if let Some(remote) =
                        window.app_handle().get_webview_window("remote-server")
                    {
                        // The local selector belongs to the app, not the external server.
                        // Closing it also closes the external view; the server keeps running.
                        let _ = remote.close();
                    }
                }
            }
        })
        .setup(|app| {
            app.manage(crate::embedded_server::EmbeddedServerManager::default());
            #[cfg(all(desktop, moya_embedded_server))]
            crate::embedded_server::setup_tray(app.handle())?;
            #[cfg(moya_portable)]
            {
                let window = app.config().app.windows.first().ok_or_else(|| {
                    std::io::Error::other("portable main window configuration is missing")
                })?;
                if window.create {
                    return Err(
                        std::io::Error::other("portable window must have create=false").into(),
                    );
                }
                let profile = crate::portable::prepare().map_err(std::io::Error::other)?;
                std::fs::create_dir_all(profile.root.join("webview"))?;
                let bounds_path = crate::portable_window::path(&profile.root);
                let saved = crate::portable_window::restore(app.handle(), &bounds_path);
                let mut builder = tauri::WebviewWindowBuilder::from_config(app.handle(), window)?
                    .data_directory(profile.root.join("webview"));
                if let Some(bounds) = &saved {
                    builder = builder
                        .inner_size(bounds.width, bounds.height)
                        .position(bounds.x, bounds.y)
                        .maximized(bounds.maximized);
                }
                let webview = builder.build()?;
                crate::portable_window::track(&webview, bounds_path, saved);
                crate::portable_activation::listen(webview, &profile.root)
                    .map_err(std::io::Error::other)?;
            }
            app.manage(crate::metadata_collector::MetadataCollectorManager::default());
            app.manage(crate::extension_runtime::ExtensionRuntimeManager::default());
            let runtime = crate::workflow::NativeWorkflowRuntime::open(app.handle())
                .map_err(std::io::Error::other)?;
            app.manage(runtime.clone());
            #[cfg(not(moya_embedded_server))]
            runtime
                .recover_and_spawn(app.handle().clone())
                .map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler(|invoke: tauri::ipc::Invoke<tauri::Wry>| {
            // App commands are callable outside the plugin capability ACL. The external
            // self-host WebView receives a bridge, so reject every app command here.
            if invoke.message.webview_ref().label() != "main" {
                invoke
                    .resolver
                    .reject("이 창에서는 로컬 앱 명령을 사용할 수 없습니다.");
                return true;
            }
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                crate::embedded_server::desktop_embedded_server_start,
                crate::embedded_server::desktop_embedded_server_status,
                crate::embedded_server::desktop_embedded_server_close,
                crate::embedded_server::desktop_embedded_server_share,
                crate::desktop_remote_window::desktop_remote_server_open,
                crate::provider_secrets::provider_secret_set,
                crate::provider_secrets::provider_secret_status,
                crate::provider_secrets::provider_secret_delete,
                crate::provider_secrets::provider_secret_test,
                crate::secure_credentials::app_credential_set,
                crate::secure_credentials::app_credential_get,
                crate::secure_credentials::app_credential_status,
                crate::secure_credentials::app_credential_delete,
                crate::desktop_oauth::desktop_dropbox_oauth_authorize,
                crate::google_oauth::desktop_google_oauth,
                crate::metadata_collector::desktop_metadata_collector_start,
                crate::extension_runtime::desktop_extension_runtime_start,
                crate::portable_vault::desktop_portable_vault_status,
                crate::portable::desktop_portable_smoke_ready,
                crate::portable_vault::desktop_portable_vault_unlock,
                crate::portable_vault::desktop_portable_vault_lock,
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
            ];
            handler(invoke)
        })
        .build(context)
        .expect("error while building Moya");
    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let server = app_handle.state::<crate::embedded_server::EmbeddedServerManager>();
            if server.running() {
                api.prevent_exit();
                if let Err(error) = server.stop(app_handle) {
                    eprintln!("{error}");
                }
                return;
            }
            app_handle
                .state::<crate::extension_runtime::ExtensionRuntimeManager>()
                .stop_before_exit();
            app_handle
                .state::<crate::metadata_collector::MetadataCollectorManager>()
                .stop_before_exit();
        }
    });
}
