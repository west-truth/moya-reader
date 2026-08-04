#[cfg(target_os = "android")]
use serde::Deserialize;
use serde::Serialize;
#[cfg(target_os = "android")]
use tauri::{
    plugin::{Builder as PluginBuilder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

#[cfg(target_os = "android")]
const ANDROID_APP_CREDENTIAL_STORE_PLUGIN: &str = "appCredentialStore";
const SERVER_API_TOKEN: &str = "server_api_token";
const DROPBOX_OAUTH: &str = "cloud_vault_dropbox_oauth";

#[cfg(target_os = "android")]
struct AndroidAppCredentialStore<R: Runtime>(PluginHandle<R>);

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidCredentialAccountRequest {
    account: String,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidCredentialSetRequest {
    account: String,
    secret_value: String,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AndroidCredentialGetResponse {
    secret_value: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppCredentialStatus {
    key: String,
    configured: bool,
    source: Option<&'static str>,
}

fn credential_account(key: &str) -> Result<String, String> {
    let key = key.trim();
    if key != SERVER_API_TOKEN && key != DROPBOX_OAUTH {
        return Err("app credential target is invalid".to_string());
    }
    Ok(format!("noveldesk:{}", key))
}

#[cfg(any(target_os = "android", test))]
fn credential_status(key: &str, configured: bool) -> AppCredentialStatus {
    AppCredentialStatus {
        key: key.trim().to_string(),
        configured,
        source: configured.then_some("android_keystore"),
    }
}

#[cfg(target_os = "android")]
fn android_store(
    app: &tauri::AppHandle,
) -> Result<tauri::State<'_, AndroidAppCredentialStore<tauri::Wry>>, String> {
    app.try_state::<AndroidAppCredentialStore<tauri::Wry>>()
        .ok_or_else(|| "Android app credential store is unavailable".to_string())
}

#[cfg(target_os = "android")]
async fn android_get(app: &tauri::AppHandle, account: String) -> Result<String, String> {
    let response = android_store(app)?
        .0
        .run_mobile_plugin_async::<AndroidCredentialGetResponse>(
            "getCredential",
            AndroidCredentialAccountRequest { account },
        )
        .await
        .map_err(|error| {
            let message = error.to_string();
            if message.contains("app credential is not configured") {
                "app credential is not configured".to_string()
            } else {
                format!("Android app credential read failed: {}", message)
            }
        })?;
    let value = response.secret_value.trim().to_string();
    if value.is_empty() {
        return Err("app credential is not configured".to_string());
    }
    Ok(value)
}

#[cfg(target_os = "android")]
#[tauri::command]
pub(crate) async fn app_credential_set(
    app: tauri::AppHandle,
    key: String,
    secret_value: String,
) -> Result<AppCredentialStatus, String> {
    let account = credential_account(&key)?;
    let value = secret_value.trim().to_string();
    if value.is_empty() {
        return Err("app credential value is required".to_string());
    }
    android_store(&app)?
        .0
        .run_mobile_plugin_async::<()>(
            "setCredential",
            AndroidCredentialSetRequest {
                account,
                secret_value: value,
            },
        )
        .await
        .map_err(|error| format!("Android app credential save failed: {}", error))?;
    Ok(credential_status(&key, true))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub(crate) async fn app_credential_set(
    key: String,
    _secret_value: String,
) -> Result<AppCredentialStatus, String> {
    let _ = credential_account(&key)?;
    Err("app credential commands are available only on Android".to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub(crate) async fn app_credential_get(
    app: tauri::AppHandle,
    key: String,
) -> Result<String, String> {
    let account = credential_account(&key)?;
    android_get(&app, account).await
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub(crate) async fn app_credential_get(key: String) -> Result<String, String> {
    let _ = credential_account(&key)?;
    Err("app credential commands are available only on Android".to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub(crate) async fn app_credential_status(
    app: tauri::AppHandle,
    key: String,
) -> Result<AppCredentialStatus, String> {
    let account = credential_account(&key)?;
    let configured = match android_get(&app, account).await {
        Ok(_) => true,
        Err(error) if error.contains("app credential is not configured") => false,
        Err(error) => return Err(error),
    };
    Ok(credential_status(&key, configured))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub(crate) async fn app_credential_status(key: String) -> Result<AppCredentialStatus, String> {
    let _ = credential_account(&key)?;
    Err("app credential commands are available only on Android".to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub(crate) async fn app_credential_delete(
    app: tauri::AppHandle,
    key: String,
) -> Result<AppCredentialStatus, String> {
    let account = credential_account(&key)?;
    android_store(&app)?
        .0
        .run_mobile_plugin_async::<()>(
            "deleteCredential",
            AndroidCredentialAccountRequest { account },
        )
        .await
        .map_err(|error| format!("Android app credential delete failed: {}", error))?;
    Ok(credential_status(&key, false))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub(crate) async fn app_credential_delete(key: String) -> Result<AppCredentialStatus, String> {
    let _ = credential_account(&key)?;
    Err("app credential commands are available only on Android".to_string())
}

#[cfg(target_os = "android")]
pub(crate) fn init_android_app_credential_store<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new(ANDROID_APP_CREDENTIAL_STORE_PLUGIN)
        .setup(|app, api| {
            let handle = api.register_android_plugin(
                "com.local.noveldeskreader.plugins",
                "AppCredentialStorePlugin",
            )?;
            app.manage(AndroidAppCredentialStore(handle));
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_declared_app_credentials() {
        assert_eq!(
            credential_account(SERVER_API_TOKEN).expect("server token account"),
            "noveldesk:server_api_token"
        );
        assert_eq!(
            credential_account(DROPBOX_OAUTH).expect("dropbox account"),
            "noveldesk:cloud_vault_dropbox_oauth"
        );
        assert!(credential_account("provider_api_key").is_err());
    }

    #[test]
    fn status_never_serializes_a_secret_value() {
        let serialized = serde_json::to_value(credential_status(SERVER_API_TOKEN, true))
            .expect("status serialization");
        assert_eq!(serialized.get("configured"), Some(&serde_json::json!(true)));
        assert!(serialized.get("secretValue").is_none());
        assert!(serialized.get("secret_value").is_none());
    }
}
