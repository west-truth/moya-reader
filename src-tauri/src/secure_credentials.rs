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
const CLOUD_VAULT_PASSPHRASE: &str = "cloud_vault_passphrase";
#[cfg(not(target_os = "android"))]
const APP_CREDENTIAL_SERVICE: &str = "Moya App Credentials";
#[cfg(not(target_os = "android"))]
const APP_CREDENTIAL_UTF8_PREFIX: &[u8] = b"moya-utf8-v1\0";

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
    if key != SERVER_API_TOKEN && key != DROPBOX_OAUTH && key != CLOUD_VAULT_PASSPHRASE {
        return Err("app credential target is invalid".to_string());
    }
    Ok(format!("noveldesk:{}", key))
}

fn credential_status(key: &str, configured: bool) -> AppCredentialStatus {
    #[cfg(target_os = "android")]
    const SOURCE: &str = "android_keystore";
    #[cfg(not(target_os = "android"))]
    const SOURCE: &str = "desktop_secure_store";

    AppCredentialStatus {
        key: key.trim().to_string(),
        configured,
        source: configured.then_some(SOURCE),
    }
}

#[cfg(not(target_os = "android"))]
fn desktop_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(APP_CREDENTIAL_SERVICE, account)
        .map_err(|_| "native app credential store is unavailable".to_string())
}

#[cfg(not(target_os = "android"))]
fn desktop_get(account: &str) -> Result<String, String> {
    let entry = desktop_entry(account)?;
    let secret = entry
        .get_secret()
        .map_err(|_| "app credential is not configured".to_string())?;
    let value = if let Some(encoded) = secret.strip_prefix(APP_CREDENTIAL_UTF8_PREFIX) {
        std::str::from_utf8(encoded)
            .map(str::to_string)
            .map_err(|_| "app credential is invalid".to_string())?
    } else {
        entry
            .get_password()
            .map_err(|_| "app credential is not configured".to_string())?
    };
    if value.trim().is_empty() {
        return Err("app credential is not configured".to_string());
    }
    Ok(value)
}

#[cfg(not(target_os = "android"))]
fn desktop_set(account: &str, value: &str) -> Result<(), String> {
    let mut encoded = Vec::with_capacity(APP_CREDENTIAL_UTF8_PREFIX.len() + value.len());
    encoded.extend_from_slice(APP_CREDENTIAL_UTF8_PREFIX);
    encoded.extend_from_slice(value.as_bytes());
    let result = desktop_entry(account)?
        .set_secret(&encoded)
        .map_err(|error| {
            if matches!(error, keyring::Error::TooLong(_, _)) {
                "app credential is too large for the desktop secure store".to_string()
            } else {
                "app credential could not be saved".to_string()
            }
        });
    encoded.fill(0);
    result
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
    secret_value: String,
) -> Result<AppCredentialStatus, String> {
    let account = credential_account(&key)?;
    let normalized_key = key.trim().to_string();
    let value = secret_value.trim().to_string();
    if value.is_empty() {
        return Err("app credential value is required".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        desktop_set(&account, &value)?;
        Ok(credential_status(&normalized_key, true))
    })
    .await
    .map_err(|_| "native app credential save task failed".to_string())?
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
    let account = credential_account(&key)?;
    tauri::async_runtime::spawn_blocking(move || desktop_get(&account))
        .await
        .map_err(|_| "native app credential read task failed".to_string())?
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
    let account = credential_account(&key)?;
    let normalized_key = key.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(credential_status(
            &normalized_key,
            desktop_get(&account).is_ok(),
        ))
    })
    .await
    .map_err(|_| "native app credential status task failed".to_string())?
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
    let account = credential_account(&key)?;
    let normalized_key = key.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(entry) = desktop_entry(&account) {
            let _ = entry.delete_credential();
        }
        Ok(credential_status(&normalized_key, false))
    })
    .await
    .map_err(|_| "native app credential delete task failed".to_string())?
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
        assert_eq!(
            credential_account(CLOUD_VAULT_PASSPHRASE).expect("vault passphrase account"),
            "noveldesk:cloud_vault_passphrase"
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

    #[cfg(not(target_os = "android"))]
    #[test]
    fn utf8_secret_encoding_avoids_windows_password_expansion() {
        let value = "a".repeat(1_800);
        let mut encoded = APP_CREDENTIAL_UTF8_PREFIX.to_vec();
        encoded.extend_from_slice(value.as_bytes());

        assert!(encoded.len() < 2_560);
        assert!(value.encode_utf16().count() * 2 > 2_560);
        assert_eq!(
            std::str::from_utf8(encoded.strip_prefix(APP_CREDENTIAL_UTF8_PREFIX).unwrap()).unwrap(),
            value
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "requires Windows Credential Manager"]
    fn desktop_secure_store_round_trips_large_utf8_credentials() {
        let account = format!("noveldesk:test-large-credential:{}", std::process::id());
        let entry = desktop_entry(&account).unwrap();
        let _ = entry.delete_credential();
        let value = format!("{{\"accessToken\":\"{}\"}}", "a".repeat(1_800));

        desktop_set(&account, &value).unwrap();
        assert_eq!(desktop_get(&account).unwrap(), value);
        entry.delete_credential().unwrap();
    }
}
