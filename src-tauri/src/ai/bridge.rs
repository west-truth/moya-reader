use super::command_contract::{
    DesktopStructuredJsonCommandError, DesktopStructuredJsonRequest, DesktopStructuredJsonResponse,
    ProviderExecutionMetadata,
};
use super::provider::{
    generate_anthropic_json, generate_gemini_ai_studio_json, generate_gemini_vertex_json,
    generate_openai_json, NativeStructuredJsonCall,
};
use super::schema::schema_hash;
use crate::provider_http::{
    clean_provider_options, ensure_non_secret_provider_options, native_provider_http_client,
    NATIVE_AI_REQUEST_TIMEOUT_SECS,
};
use crate::provider_secrets::load_provider_secret;
#[cfg(test)]
use serde_json::{json, Value};
use std::time::Instant;
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub(crate) async fn desktop_ai_generate_json(
    request: DesktopStructuredJsonRequest,
) -> Result<DesktopStructuredJsonResponse, Box<DesktopStructuredJsonCommandError>> {
    desktop_ai_generate_json_command(None, request).await
}

#[cfg(target_os = "android")]
#[tauri::command]
pub(crate) async fn desktop_ai_generate_json(
    app: tauri::AppHandle,
    request: DesktopStructuredJsonRequest,
) -> Result<DesktopStructuredJsonResponse, Box<DesktopStructuredJsonCommandError>> {
    desktop_ai_generate_json_command(Some(&app), request).await
}

async fn desktop_ai_generate_json_command(
    app: Option<&tauri::AppHandle>,
    request: DesktopStructuredJsonRequest,
) -> Result<DesktopStructuredJsonResponse, Box<DesktopStructuredJsonCommandError>> {
    let started_at = Instant::now();
    let request_context = request.clone();
    desktop_ai_generate_json_impl(app, request)
        .await
        .map_err(|message| {
            Box::new(desktop_ai_command_error(
                &request_context,
                message,
                started_at.elapsed().as_millis(),
            ))
        })
}

fn desktop_ai_command_error(
    request: &DesktopStructuredJsonRequest,
    message: String,
    latency_ms: u128,
) -> DesktopStructuredJsonCommandError {
    let incomplete_reason = message
        .strip_prefix("provider_output_incomplete:")
        .and_then(|detail| detail.split_whitespace().last())
        .filter(|reason| {
            !reason.is_empty()
                && reason.len() <= 128
                && reason.chars().all(|character| {
                    character.is_ascii_alphanumeric() || "_-./".contains(character)
                })
        })
        .map(str::to_string);
    if let Some(reason) = incomplete_reason {
        let safety_or_refusal_code = matches!(
            reason.to_ascii_lowercase().as_str(),
            "refusal" | "safety" | "content_filter" | "recitation"
        )
        .then(|| reason.clone());
        return DesktopStructuredJsonCommandError {
            code: "provider_output_incomplete".to_string(),
            message: format!("Provider output was incomplete: {}", reason),
            execution_metadata: Some(ProviderExecutionMetadata {
                provider_id: request.provider_id.trim().to_string(),
                provider_request_id: None,
                requested_model_id: request.model_id.trim().to_string(),
                resolved_model_version: None,
                structured_output_mode: "json_schema".to_string(),
                schema_version: request.schema_version.clone(),
                schema_hash: schema_hash(&request.response_schema),
                finish_reason: (reason != "empty_output").then(|| reason.clone()),
                incomplete_reason: Some(reason),
                input_tokens: None,
                output_tokens: None,
                reasoning_tokens: None,
                input_bytes: request.prompt.len(),
                output_bytes: 0,
                latency_ms: latency_ms.min(u64::MAX as u128) as u64,
                retry_count: 0,
                safety_or_refusal_code,
            }),
        };
    }
    DesktopStructuredJsonCommandError {
        code: "desktop_provider_error".to_string(),
        message,
        execution_metadata: None,
    }
}

pub(crate) async fn desktop_ai_generate_json_impl(
    app: Option<&tauri::AppHandle>,
    request: DesktopStructuredJsonRequest,
) -> Result<DesktopStructuredJsonResponse, String> {
    request.validate()?;
    let provider_id = request.provider_id.trim();
    let model_id = request.model_id.trim();
    ensure_non_secret_provider_options(&request.provider_options)?;
    let options = clean_provider_options(request.provider_options);
    let client = native_provider_http_client(NATIVE_AI_REQUEST_TIMEOUT_SECS)?;

    if provider_id == "openai" {
        let api_key = load_provider_secret(app, "llm_labeling", "openai", "api_key").await?;
        return generate_openai_json(
            &client,
            NativeStructuredJsonCall {
                model_id,
                prompt: &request.prompt,
                response_schema: request.response_schema,
                json_schema_name: &request.json_schema_name,
                schema_version: request.schema_version.as_deref(),
                options: &options,
            },
            api_key,
        )
        .await;
    }

    if provider_id == "anthropic" {
        let api_key = load_provider_secret(app, "llm_labeling", "anthropic", "api_key").await?;
        return generate_anthropic_json(
            &client,
            model_id,
            &request.prompt,
            request.response_schema,
            request.schema_version.as_deref(),
            &options,
            api_key,
        )
        .await;
    }

    if provider_id == "gemini-ai-studio" {
        let api_key =
            load_provider_secret(app, "llm_labeling", "gemini-ai-studio", "api_key").await?;
        return generate_gemini_ai_studio_json(
            &client,
            model_id,
            &request.prompt,
            request.response_schema,
            request.schema_version.as_deref(),
            &options,
            api_key,
        )
        .await;
    }

    if provider_id == "gemini-vertex" {
        #[cfg(target_os = "android")]
        {
            return Err("Android local mode does not support gemini-vertex credential_path execution yet; use connected server mode for Vertex providers".to_string());
        }
        #[cfg(not(target_os = "android"))]
        {
            let credential_path =
                load_provider_secret(app, "llm_labeling", "gemini-vertex", "credential_path")
                    .await?;
            return generate_gemini_vertex_json(
                &client,
                model_id,
                &request.prompt,
                request.response_schema,
                request.schema_version.as_deref(),
                &options,
                &credential_path,
            )
            .await;
        }
    }

    Err("desktop local provider is not implemented for this provider yet".to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(not(target_os = "android"))]
    use crate::provider_secrets::{
        provider_secret_delete, provider_secret_set, stored_secret_for_test,
    };
    #[cfg(not(target_os = "android"))]
    use serde_json::Map;
    #[cfg(not(target_os = "android"))]
    use std::path::Path;

    #[test]
    fn desktop_ai_rejects_secret_like_provider_options_before_store_lookup() {
        let error = tauri::async_runtime::block_on(desktop_ai_generate_json(
            DesktopStructuredJsonRequest {
                provider_id: "openai".to_string(),
                model_id: "gpt-4.1-mini".to_string(),
                prompt: "Return JSON.".to_string(),
                response_schema: json!({ "type": "object" }),
                json_schema_name: "Smoke".to_string(),
                schema_version: None,
                provider_options: Some(json!({ "apiKey": "sk-proj-secretvalue" })),
            },
        ))
        .expect_err("secret-like provider options should fail before keyring lookup");
        assert!(error.message.contains("secret-like"));
    }

    #[test]
    fn desktop_ai_incomplete_error_returns_only_sanitized_execution_metadata() {
        let request = DesktopStructuredJsonRequest {
            provider_id: "openai".to_string(),
            model_id: "gpt-labeler".to_string(),
            prompt: "private novel text".to_string(),
            response_schema: json!({ "type": "object" }),
            json_schema_name: "LabelResult".to_string(),
            schema_version: Some("label-v1".to_string()),
            provider_options: None,
        };
        let error = desktop_ai_command_error(
            &request,
            "provider_output_incomplete: OpenAI length".to_string(),
            17,
        );
        let serialized = serde_json::to_string(&error).expect("serialize command error");
        assert_eq!(error.code, "provider_output_incomplete");
        assert_eq!(
            error
                .execution_metadata
                .as_ref()
                .and_then(|metadata| metadata.incomplete_reason.as_deref()),
            Some("length")
        );
        assert!(!serialized.contains("private novel text"));
    }
    #[test]
    #[ignore = "requires local Vertex credentials, writes the desktop secure store, and makes one live provider request"]
    #[cfg(not(target_os = "android"))]
    fn live_desktop_vertex_secure_store_labeling_smoke() {
        if std::env::var("NOVELDESK_DESKTOP_VERTEX_LIVE")
            .ok()
            .as_deref()
            != Some("1")
        {
            return;
        }
        let credential_path = std::env::var("NOVELDESK_DESKTOP_VERTEX_CREDENTIAL_PATH")
            .unwrap_or_else(|_| {
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .expect("workspace root")
                    .join("vertex env")
                    .to_string_lossy()
                    .into_owned()
            });
        let model_id = std::env::var("NOVELDESK_DESKTOP_VERTEX_MODEL")
            .unwrap_or_else(|_| "gemini-3.1-flash-lite".to_string());
        let previous_secret =
            stored_secret_for_test("llm_labeling", "gemini-vertex", "credential_path").ok();

        let result = (|| {
            let saved = provider_secret_set(
                "llm_labeling".to_string(),
                "gemini-vertex".to_string(),
                "credential_path".to_string(),
                credential_path,
            )?;
            let saved = serde_json::to_value(saved)
                .map_err(|_| "provider secret status could not be serialized".to_string())?;
            assert_eq!(saved.get("configured").and_then(Value::as_bool), Some(true));
            assert_eq!(
                saved.get("source").and_then(Value::as_str),
                Some("desktop_secure_store")
            );
            assert_eq!(saved.get("last4"), Some(&Value::Null));
            assert_eq!(saved.get("fingerprint"), Some(&Value::Null));

            let mut provider_options = Map::new();
            provider_options.insert(
                "location".to_string(),
                Value::String(
                    std::env::var("NOVELDESK_DESKTOP_VERTEX_LOCATION")
                        .unwrap_or_else(|_| "global".to_string()),
                ),
            );
            if let Ok(project) = std::env::var("NOVELDESK_DESKTOP_VERTEX_PROJECT") {
                provider_options.insert("project".to_string(), Value::String(project));
            }
            let text = tauri::async_runtime::block_on(desktop_ai_generate_json(
                DesktopStructuredJsonRequest {
                    provider_id: "gemini-vertex".to_string(),
                    model_id,
                    prompt: [
                        "Return only JSON that matches the schema.",
                        "Label each paragraph as dialogue or narration for a novel text viewer.",
                        "Paragraph 0: \"Where am I?\"",
                        "Paragraph 1: [System] The door opened.",
                    ]
                    .join("\n"),
                    response_schema: json!({
                        "type": "object",
                        "properties": {
                            "segments": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "paragraph_index": { "type": "integer" },
                                        "label": { "type": "string" },
                                        "confidence": { "type": "number" }
                                    },
                                    "required": ["paragraph_index", "label", "confidence"]
                                }
                            }
                        },
                        "required": ["segments"]
                    }),
                    json_schema_name: "DesktopVertexSecureStoreSmoke".to_string(),
                    schema_version: Some("desktop-vertex-smoke-v1".to_string()),
                    provider_options: Some(Value::Object(provider_options)),
                },
            ))
            .map_err(|error| error.message)?;
            let value: Value = serde_json::from_str(&text.text)
                .map_err(|_| "Vertex response was not JSON".to_string())?;
            let segments = value
                .get("segments")
                .and_then(Value::as_array)
                .ok_or_else(|| "Vertex response did not include segments".to_string())?;
            if segments.is_empty() {
                return Err("Vertex response segments array was empty".to_string());
            }
            Ok(())
        })();

        if let Some(previous_secret) = previous_secret {
            provider_secret_set(
                "llm_labeling".to_string(),
                "gemini-vertex".to_string(),
                "credential_path".to_string(),
                previous_secret,
            )
            .expect("restore previous desktop Vertex credential path");
        } else {
            provider_secret_delete(
                "llm_labeling".to_string(),
                "gemini-vertex".to_string(),
                "credential_path".to_string(),
            )
            .expect("clear desktop Vertex credential path after live smoke");
        }

        result.expect("desktop secure-store Vertex live smoke should label segments");
    }
}
