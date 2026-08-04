use serde::{Deserialize, Serialize};

#[cfg(target_os = "android")]
use tauri::{
    plugin::{Builder as PluginBuilder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

#[cfg(target_os = "android")]
const ANDROID_DOCUMENT_IO_PLUGIN: &str = "documentIo";

#[cfg(target_os = "android")]
struct AndroidDocumentIo<R: Runtime>(PluginHandle<R>);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PickDocumentsRequest {
    multiple: bool,
    mime_types: Vec<String>,
    extensions: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AndroidDocumentDescriptor {
    token: String,
    file_name: String,
    mime_type: String,
    byte_length: u64,
    last_modified: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PickDocumentsResponse {
    cancelled: bool,
    documents: Vec<AndroidDocumentDescriptor>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadDocumentChunkRequest {
    token: String,
    offset: u64,
    max_bytes: u32,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadDocumentChunkResponse {
    data_base64: String,
    next_offset: u64,
    eof: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentTokenRequest {
    token: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BeginSaveDocumentRequest {
    suggested_name: String,
    mime_type: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BeginSaveDocumentResponse {
    cancelled: bool,
    token: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WriteDocumentChunkRequest {
    token: String,
    data_base64: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WriteDocumentChunkResponse {
    bytes_written: u32,
    total_bytes_written: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PickFolderResponse {
    cancelled: bool,
    folder_id: Option<String>,
    display_name: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanFolderRequest {
    folder_id: String,
    recursive: bool,
    max_entries: u32,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AndroidFolderEntry {
    document_id: String,
    relative_path: String,
    file_name: String,
    mime_type: Option<String>,
    byte_length: u64,
    last_modified: u64,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct ScanFolderResponse {
    entries: Vec<AndroidFolderEntry>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenFolderFileRequest {
    folder_id: String,
    document_id: String,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct OpenFolderFileResponse {
    document: AndroidDocumentDescriptor,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderIdRequest {
    folder_id: String,
}

#[cfg(target_os = "android")]
fn android_document_io(
    app: &tauri::AppHandle,
) -> Result<tauri::State<'_, AndroidDocumentIo<tauri::Wry>>, String> {
    app.try_state::<AndroidDocumentIo<tauri::Wry>>()
        .ok_or_else(|| "Android document I/O is unavailable".to_string())
}

#[tauri::command]
pub(crate) async fn android_document_io_pick(
    app: tauri::AppHandle,
    request: PickDocumentsRequest,
) -> Result<PickDocumentsResponse, String> {
    #[cfg(target_os = "android")]
    {
        return android_document_io(&app)?
            .0
            .run_mobile_plugin_async("pickDocuments", request)
            .await
            .map_err(|error| format!("Android document picker failed: {error}"));
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        let _ = request;
        Err("Android document picker is unavailable on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) async fn android_document_io_pick_folder(
    app: tauri::AppHandle,
) -> Result<PickFolderResponse, String> {
    #[cfg(target_os = "android")]
    {
        return android_document_io(&app)?
            .0
            .run_mobile_plugin_async("pickFolder", ())
            .await
            .map_err(|error| format!("Android folder picker failed: {error}"));
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("Android folder picker is unavailable on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) async fn android_document_io_scan_folder(
    app: tauri::AppHandle,
    request: ScanFolderRequest,
) -> Result<ScanFolderResponse, String> {
    #[cfg(target_os = "android")]
    {
        return android_document_io(&app)?
            .0
            .run_mobile_plugin_async("scanFolder", request)
            .await
            .map_err(|error| format!("Android folder scan failed: {error}"));
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        let _ = request;
        Err("Android folder scan is unavailable on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) async fn android_document_io_open_folder_file(
    app: tauri::AppHandle,
    request: OpenFolderFileRequest,
) -> Result<OpenFolderFileResponse, String> {
    #[cfg(target_os = "android")]
    {
        return android_document_io(&app)?
            .0
            .run_mobile_plugin_async("openFolderFile", request)
            .await
            .map_err(|error| format!("Android folder file open failed: {error}"));
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        let _ = request;
        Err("Android folder file open is unavailable on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) async fn android_document_io_forget_folder(
    app: tauri::AppHandle,
    request: FolderIdRequest,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        return android_document_io(&app)?
            .0
            .run_mobile_plugin_async("forgetFolder", request)
            .await
            .map_err(|error| format!("Android folder permission removal failed: {error}"));
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        let _ = request;
        Err("Android folder permission is unavailable on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) async fn android_document_io_read_chunk(
    app: tauri::AppHandle,
    request: ReadDocumentChunkRequest,
) -> Result<ReadDocumentChunkResponse, String> {
    #[cfg(target_os = "android")]
    {
        return android_document_io(&app)?
            .0
            .run_mobile_plugin_async("readChunk", request)
            .await
            .map_err(|error| format!("Android document read failed: {error}"));
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        let _ = request;
        Err("Android document reader is unavailable on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) async fn android_document_io_release(
    app: tauri::AppHandle,
    request: DocumentTokenRequest,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        return android_document_io(&app)?
            .0
            .run_mobile_plugin_async("releaseDocument", request)
            .await
            .map_err(|error| format!("Android document cache release failed: {error}"));
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        let _ = request;
        Err("Android document cache is unavailable on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) async fn android_document_io_begin_save(
    app: tauri::AppHandle,
    request: BeginSaveDocumentRequest,
) -> Result<BeginSaveDocumentResponse, String> {
    #[cfg(target_os = "android")]
    {
        return android_document_io(&app)?
            .0
            .run_mobile_plugin_async("beginSave", request)
            .await
            .map_err(|error| format!("Android save picker failed: {error}"));
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        let _ = request;
        Err("Android save picker is unavailable on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) async fn android_document_io_write_chunk(
    app: tauri::AppHandle,
    request: WriteDocumentChunkRequest,
) -> Result<WriteDocumentChunkResponse, String> {
    #[cfg(target_os = "android")]
    {
        return android_document_io(&app)?
            .0
            .run_mobile_plugin_async("writeChunk", request)
            .await
            .map_err(|error| format!("Android document write failed: {error}"));
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        let _ = request;
        Err("Android document writer is unavailable on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) async fn android_document_io_finish_save(
    app: tauri::AppHandle,
    request: DocumentTokenRequest,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        return android_document_io(&app)?
            .0
            .run_mobile_plugin_async("finishSave", request)
            .await
            .map_err(|error| format!("Android document finalize failed: {error}"));
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        let _ = request;
        Err("Android document writer is unavailable on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) async fn android_document_io_abort_save(
    app: tauri::AppHandle,
    request: DocumentTokenRequest,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        return android_document_io(&app)?
            .0
            .run_mobile_plugin_async("abortSave", request)
            .await
            .map_err(|error| format!("Android document abort failed: {error}"));
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        let _ = request;
        Err("Android document writer is unavailable on this platform".to_string())
    }
}

#[cfg(target_os = "android")]
pub(crate) fn init_android_document_io<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new(ANDROID_DOCUMENT_IO_PLUGIN)
        .setup(|app, api| {
            let handle = api
                .register_android_plugin("com.local.noveldeskreader.plugins", "DocumentIoPlugin")?;
            app.manage(AndroidDocumentIo(handle));
            Ok(())
        })
        .build()
}
