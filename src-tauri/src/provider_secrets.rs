#[cfg(not(target_os = "android"))]
use crate::google_service_account::read_google_service_account_credential;
use crate::provider_http::validate_local_endpoint_url;
#[cfg(target_os = "android")]
use serde::Deserialize;
use serde::Serialize;
use sha2::{Digest, Sha256};
#[cfg(target_os = "android")]
use tauri::{
    plugin::{Builder as PluginBuilder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

#[cfg(not(target_os = "android"))]
const SECRET_SERVICE: &str = "NovelDesk Reader Provider Secrets";
#[cfg(target_os = "android")]
const ANDROID_PROVIDER_SECRET_STORE_PLUGIN: &str = "providerSecretStore";

#[cfg(target_os = "android")]
struct AndroidProviderSecretStore<R: Runtime>(PluginHandle<R>);

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidSecretAccountRequest {
    account: String,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidSecretSetRequest {
    account: String,
    secret_value: String,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AndroidSecretGetResponse {
    secret_value: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderSecretStatus {
    scope: String,
    provider_id: String,
    secret_name: String,
    configured: bool,
    source: Option<String>,
    last4: Option<String>,
    fingerprint: Option<String>,
}
fn secret_account(scope: &str, provider_id: &str, secret_name: &str) -> Result<String, String> {
    let scope = scope.trim();
    let provider_id = provider_id.trim();
    let secret_name = secret_name.trim();
    if scope != "llm_labeling" && scope != "tts_synthesis" {
        return Err("provider secret scope is invalid".to_string());
    }
    if provider_id.is_empty() || secret_name.is_empty() {
        return Err("provider secret target is invalid".to_string());
    }
    Ok(format!("{}:{}:{}", scope, provider_id, secret_name))
}

fn secret_status(
    scope: &str,
    provider_id: &str,
    secret_name: &str,
    value: Option<String>,
) -> ProviderSecretStatus {
    #[cfg(target_os = "android")]
    const SOURCE: &str = "android_secure_store";
    #[cfg(not(target_os = "android"))]
    const SOURCE: &str = "desktop_secure_store";

    let secret_name = secret_name.trim();
    let expose_value_hint = secret_name != "credential_path" && secret_name != "endpoint_url";
    let fingerprint = if expose_value_hint {
        value.as_ref().map(|secret| {
            let mut hasher = Sha256::new();
            hasher.update(secret.as_bytes());
            format!("sha256:{:.16}", format!("{:x}", hasher.finalize()))
        })
    } else {
        None
    };
    ProviderSecretStatus {
        scope: scope.trim().to_string(),
        provider_id: provider_id.trim().to_string(),
        secret_name: secret_name.trim().to_string(),
        configured: value.is_some(),
        source: value.as_ref().map(|_| SOURCE.to_string()),
        last4: value.as_ref().and_then(|secret| {
            if expose_value_hint && secret.chars().count() >= 4 {
                Some(
                    secret
                        .chars()
                        .rev()
                        .take(4)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect(),
                )
            } else {
                None
            }
        }),
        fingerprint,
    }
}

#[cfg(target_os = "android")]
fn android_provider_secret_store(
    app: &tauri::AppHandle,
) -> Result<tauri::State<'_, AndroidProviderSecretStore<tauri::Wry>>, String> {
    app.try_state::<AndroidProviderSecretStore<tauri::Wry>>()
        .ok_or_else(|| "Android provider secure store is unavailable".to_string())
}

#[cfg(target_os = "android")]
async fn android_set_secret(
    app: &tauri::AppHandle,
    account: String,
    value: String,
) -> Result<(), String> {
    android_provider_secret_store(app)?
        .0
        .run_mobile_plugin_async::<()>(
            "setSecret",
            AndroidSecretSetRequest {
                account,
                secret_value: value,
            },
        )
        .await
        .map_err(|error| format!("Android provider secure store save failed: {}", error))
}

#[cfg(target_os = "android")]
async fn android_get_secret(app: &tauri::AppHandle, account: String) -> Result<String, String> {
    let response = android_provider_secret_store(app)?
        .0
        .run_mobile_plugin_async::<AndroidSecretGetResponse>(
            "getSecret",
            AndroidSecretAccountRequest { account },
        )
        .await
        .map_err(|error| {
            let message = error.to_string();
            if message.contains("provider secret is not configured") {
                "provider secret is not configured".to_string()
            } else {
                format!("Android provider secure store read failed: {}", message)
            }
        })?;
    if response.secret_value.trim().is_empty() {
        return Err("provider secret is not configured".to_string());
    }
    Ok(response.secret_value)
}

#[cfg(target_os = "android")]
async fn stored_secret_for_app(
    app: &tauri::AppHandle,
    scope: &str,
    provider_id: &str,
    secret_name: &str,
) -> Result<String, String> {
    let account = secret_account(scope, provider_id, secret_name)?;
    android_get_secret(app, account).await
}

#[cfg(target_os = "android")]
async fn android_delete_secret(app: &tauri::AppHandle, account: String) -> Result<(), String> {
    android_provider_secret_store(app)?
        .0
        .run_mobile_plugin_async::<()>("deleteSecret", AndroidSecretAccountRequest { account })
        .await
        .map_err(|error| format!("Android provider secure store delete failed: {}", error))
}

fn stored_secret(scope: &str, provider_id: &str, secret_name: &str) -> Result<String, String> {
    let account = secret_account(scope, provider_id, secret_name)?;
    #[cfg(target_os = "android")]
    {
        let _ = account;
        return Err("Android provider secure store adapter is not implemented yet".to_string());
    }
    #[cfg(not(target_os = "android"))]
    {
        let entry = keyring::Entry::new(SECRET_SERVICE, &account)
            .map_err(|_| "provider secret store is unavailable".to_string())?;
        entry
            .get_password()
            .map_err(|_| "provider secret is not configured".to_string())
    }
}
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub(crate) fn provider_secret_set(
    scope: String,
    provider_id: String,
    secret_name: String,
    secret_value: String,
) -> Result<ProviderSecretStatus, String> {
    let account = secret_account(&scope, &provider_id, &secret_name)?;
    let value = secret_value.trim().to_string();
    if value.is_empty() {
        return Err("provider secret value is required".to_string());
    }
    #[cfg(target_os = "android")]
    {
        let _ = account;
        let _ = value;
        return Err("Android provider secure store adapter is not implemented yet".to_string());
    }
    #[cfg(not(target_os = "android"))]
    {
        if secret_name == "credential_path" {
            let _ = read_google_service_account_credential(&value)?;
        }
        if secret_name == "endpoint_url" {
            let _ = validate_local_endpoint_url(&value)?;
        }
        let entry = keyring::Entry::new(SECRET_SERVICE, &account)
            .map_err(|_| "provider secret store is unavailable".to_string())?;
        entry
            .set_password(&value)
            .map_err(|_| "provider secret could not be saved".to_string())?;
        Ok(secret_status(
            &scope,
            &provider_id,
            &secret_name,
            Some(value),
        ))
    }
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub(crate) fn provider_secret_status(
    scope: String,
    provider_id: String,
    secret_name: String,
) -> Result<ProviderSecretStatus, String> {
    let account = secret_account(&scope, &provider_id, &secret_name)?;
    #[cfg(target_os = "android")]
    {
        let _ = account;
        return Ok(secret_status(&scope, &provider_id, &secret_name, None));
    }
    #[cfg(not(target_os = "android"))]
    {
        let entry = keyring::Entry::new(SECRET_SERVICE, &account)
            .map_err(|_| "provider secret store is unavailable".to_string())?;
        let value = entry.get_password().ok();
        Ok(secret_status(&scope, &provider_id, &secret_name, value))
    }
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub(crate) fn provider_secret_delete(
    scope: String,
    provider_id: String,
    secret_name: String,
) -> Result<ProviderSecretStatus, String> {
    let account = secret_account(&scope, &provider_id, &secret_name)?;
    #[cfg(target_os = "android")]
    {
        let _ = account;
        return Ok(secret_status(&scope, &provider_id, &secret_name, None));
    }
    #[cfg(not(target_os = "android"))]
    {
        let entry = keyring::Entry::new(SECRET_SERVICE, &account)
            .map_err(|_| "provider secret store is unavailable".to_string())?;
        let _ = entry.delete_credential();
        Ok(secret_status(&scope, &provider_id, &secret_name, None))
    }
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub(crate) fn provider_secret_test(
    scope: String,
    provider_id: String,
    secret_name: String,
) -> Result<ProviderSecretStatus, String> {
    let secret_value = stored_secret(&scope, &provider_id, &secret_name)?;
    if secret_name == "credential_path" {
        let _ = read_google_service_account_credential(&secret_value)?;
    }
    if secret_name == "endpoint_url" {
        let _ = validate_local_endpoint_url(&secret_value)?;
    }
    let status = secret_status(&scope, &provider_id, &secret_name, Some(secret_value));
    if !status.configured {
        return Err("provider secret is not configured".to_string());
    }
    Ok(status)
}

#[cfg(target_os = "android")]
#[tauri::command]
pub(crate) async fn provider_secret_set(
    app: tauri::AppHandle,
    scope: String,
    provider_id: String,
    secret_name: String,
    secret_value: String,
) -> Result<ProviderSecretStatus, String> {
    let account = secret_account(&scope, &provider_id, &secret_name)?;
    let value = secret_value.trim().to_string();
    if value.is_empty() {
        return Err("provider secret value is required".to_string());
    }
    if secret_name == "credential_path" {
        return Err(
            "Android local mode does not support credential_path secrets yet; use connected server mode for Vertex providers"
                .to_string(),
        );
    }
    if secret_name == "endpoint_url" {
        let _ = validate_local_endpoint_url(&value)?;
    }
    android_set_secret(&app, account, value.clone()).await?;
    Ok(secret_status(
        &scope,
        &provider_id,
        &secret_name,
        Some(value),
    ))
}

#[cfg(target_os = "android")]
#[tauri::command]
pub(crate) async fn provider_secret_status(
    app: tauri::AppHandle,
    scope: String,
    provider_id: String,
    secret_name: String,
) -> Result<ProviderSecretStatus, String> {
    let account = secret_account(&scope, &provider_id, &secret_name)?;
    if secret_name == "credential_path" {
        return Ok(secret_status(&scope, &provider_id, &secret_name, None));
    }
    let value = match android_get_secret(&app, account).await {
        Ok(value) => Some(value),
        Err(error) if error.contains("provider secret is not configured") => None,
        Err(error) => return Err(error),
    };
    Ok(secret_status(&scope, &provider_id, &secret_name, value))
}

#[cfg(target_os = "android")]
#[tauri::command]
pub(crate) async fn provider_secret_delete(
    app: tauri::AppHandle,
    scope: String,
    provider_id: String,
    secret_name: String,
) -> Result<ProviderSecretStatus, String> {
    let account = secret_account(&scope, &provider_id, &secret_name)?;
    android_delete_secret(&app, account).await?;
    Ok(secret_status(&scope, &provider_id, &secret_name, None))
}

#[cfg(target_os = "android")]
#[tauri::command]
pub(crate) async fn provider_secret_test(
    app: tauri::AppHandle,
    scope: String,
    provider_id: String,
    secret_name: String,
) -> Result<ProviderSecretStatus, String> {
    let _ = secret_account(&scope, &provider_id, &secret_name)?;
    if secret_name == "credential_path" {
        return Err(
            "Android local mode does not support credential_path secrets yet; use connected server mode for Vertex providers"
                .to_string(),
        );
    }
    let secret_value = stored_secret_for_app(&app, &scope, &provider_id, &secret_name).await?;
    if secret_name == "endpoint_url" {
        let _ = validate_local_endpoint_url(&secret_value)?;
    }
    let status = secret_status(&scope, &provider_id, &secret_name, Some(secret_value));
    if !status.configured {
        return Err("provider secret is not configured".to_string());
    }
    Ok(status)
}

#[cfg(not(target_os = "android"))]
pub(crate) async fn load_provider_secret(
    _app: Option<&tauri::AppHandle>,
    scope: &str,
    provider_id: &str,
    secret_name: &str,
) -> Result<String, String> {
    stored_secret(scope, provider_id, secret_name)
}

#[cfg(target_os = "android")]
pub(crate) async fn load_provider_secret(
    app: Option<&tauri::AppHandle>,
    scope: &str,
    provider_id: &str,
    secret_name: &str,
) -> Result<String, String> {
    let app = app.ok_or_else(|| "Android provider secure store is unavailable".to_string())?;
    stored_secret_for_app(app, scope, provider_id, secret_name).await
}
#[cfg(target_os = "android")]
pub(crate) fn init_android_provider_secret_store<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new(ANDROID_PROVIDER_SECRET_STORE_PLUGIN)
        .setup(|app, api| {
            let handle = api.register_android_plugin(
                "com.local.noveldeskreader.plugins",
                "ProviderSecretStorePlugin",
            )?;
            app.manage(AndroidProviderSecretStore(handle));
            Ok(())
        })
        .build()
}
#[cfg(all(test, not(target_os = "android")))]
pub(crate) fn stored_secret_for_test(
    scope: &str,
    provider_id: &str,
    secret_name: &str,
) -> Result<String, String> {
    stored_secret(scope, provider_id, secret_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_path_status_does_not_expose_path_hints() {
        let status = secret_status(
            "llm_labeling",
            "gemini-vertex",
            "credential_path",
            Some("C:\\sensitive\\credential.json".to_string()),
        );

        assert!(status.configured);
        assert_eq!(status.source.as_deref(), Some("desktop_secure_store"));
        assert_eq!(status.last4, None);
        assert_eq!(status.fingerprint, None);
    }

    #[test]
    fn endpoint_url_status_does_not_expose_url_hints() {
        let status = secret_status(
            "tts_synthesis",
            "local-endpoint",
            "endpoint_url",
            Some("http://127.0.0.1:5000/synthesize?token=secret".to_string()),
        );

        assert!(status.configured);
        assert_eq!(status.source.as_deref(), Some("desktop_secure_store"));
        assert_eq!(status.last4, None);
        assert_eq!(status.fingerprint, None);
    }

    #[test]
    fn api_key_status_keeps_redacted_hints() {
        let raw_secret = "sk-test-123456";
        let status = secret_status(
            "llm_labeling",
            "openai",
            "api_key",
            Some(raw_secret.to_string()),
        );

        assert!(status.configured);
        assert_eq!(status.last4.as_deref(), Some("3456"));
        assert!(status
            .fingerprint
            .as_deref()
            .is_some_and(|value| value.starts_with("sha256:")));

        let serialized = serde_json::to_value(status).expect("secret status should serialize");
        let serialized_text = serialized.to_string();
        assert!(!serialized_text.contains(raw_secret));
        assert!(serialized.get("secretValue").is_none());
        assert!(serialized.get("secret_value").is_none());
    }

    #[test]
    fn canonicalizes_secret_account_components() {
        assert_eq!(
            secret_account(" llm_labeling ", " openai ", " api_key ").expect("secret account"),
            "llm_labeling:openai:api_key"
        );
    }
}
