use super::command_contract::{DesktopStructuredJsonResponse, ProviderExecutionMetadata};
use super::schema::{schema_hash, standard_json_schema, supports_openai_strict_schema};
use crate::google_service_account::{
    read_google_service_account_credential, GoogleServiceAccountCredential,
};
#[cfg(test)]
use crate::provider_http::{native_provider_http_client, NATIVE_AI_REQUEST_TIMEOUT_SECS};
use crate::provider_http::{numeric_provider_option, provider_send_error, string_provider_option};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
struct ServiceAccountJwtClaims<'a> {
    iss: &'a str,
    scope: &'a str,
    aud: &'a str,
    iat: usize,
    exp: usize,
}
fn normalize_vertex_model_id(model_id: &str) -> &str {
    let trimmed = model_id.trim();
    if let Some(stripped) = trimmed.strip_prefix("models/") {
        return stripped;
    }
    if let Some((_, stripped)) = trimmed.rsplit_once("/models/") {
        return stripped;
    }
    trimmed
}

fn validate_vertex_path_segment(label: &str, value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{} is required", label));
    }
    if trimmed.len() > 128 {
        return Err(format!("{} is too long", label));
    }
    if !trimmed
        .chars()
        .all(|item| item.is_ascii_alphanumeric() || item == '-' || item == '_' || item == '.')
    {
        return Err(format!("{} contains unsupported characters", label));
    }
    Ok(trimmed.to_string())
}
async fn post_json(
    client: &reqwest::Client,
    provider_name: &str,
    url: String,
    headers: Vec<(&str, String)>,
    body: Value,
) -> Result<Value, String> {
    let mut request = client.post(url).json(&body);
    for (key, value) in headers {
        request = request.header(key, value);
    }
    let response = request
        .send()
        .await
        .map_err(|error| provider_send_error(provider_name, "request", error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "{} request failed with status {}",
            provider_name,
            status.as_u16()
        ));
    }
    response
        .json::<Value>()
        .await
        .map_err(|_| format!("{} returned invalid JSON", provider_name))
}

pub(super) struct NativeStructuredJsonCall<'a> {
    pub(super) model_id: &'a str,
    pub(super) prompt: &'a str,
    pub(super) response_schema: Value,
    pub(super) json_schema_name: &'a str,
    pub(super) schema_version: Option<&'a str>,
    pub(super) options: &'a Map<String, Value>,
}

pub(super) async fn generate_openai_json(
    client: &reqwest::Client,
    call: NativeStructuredJsonCall<'_>,
    api_key: String,
) -> Result<DesktopStructuredJsonResponse, String> {
    let NativeStructuredJsonCall {
        model_id,
        prompt,
        response_schema,
        json_schema_name,
        schema_version,
        options,
    } = call;
    let response_schema = standard_json_schema(response_schema);
    let response_schema_hash = schema_hash(&response_schema);
    let strict = supports_openai_strict_schema(&response_schema);
    let mut body = json!({
        "model": model_id,
        "messages": [
            { "role": "system", "content": "Return only JSON that matches the supplied schema." },
            { "role": "user", "content": prompt }
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": json_schema_name,
                "strict": strict,
                "schema": response_schema
            }
        }
    });
    if let Value::Object(ref mut map) = body {
        if let Some(temperature) = numeric_provider_option(options, "temperature") {
            map.insert("temperature".to_string(), json!(temperature));
        }
        if let Some(top_p) = numeric_provider_option(options, "topP") {
            map.insert("top_p".to_string(), json!(top_p));
        }
        if let Some(max_tokens) = numeric_provider_option(options, "maxOutputTokens") {
            map.insert(
                "max_completion_tokens".to_string(),
                json!(max_tokens as u64),
            );
        }
    }
    let started_at = Instant::now();
    let response = post_json(
        client,
        "OpenAI",
        "https://api.openai.com/v1/chat/completions".to_string(),
        vec![("Authorization", format!("Bearer {}", api_key))],
        body,
    )
    .await?;
    let finish_reason = optional_string(response.pointer("/choices/0/finish_reason"));
    let text = extract_openai_message_text(&response).unwrap_or_default();
    let incomplete_reason = finish_reason
        .clone()
        .filter(|reason| reason != "stop")
        .or_else(|| text.trim().is_empty().then(|| "empty_output".to_string()));
    if let Some(reason) = incomplete_reason {
        return Err(format!("provider_output_incomplete: OpenAI {}", reason));
    }
    Ok(DesktopStructuredJsonResponse {
        execution_metadata: ProviderExecutionMetadata {
            provider_id: "openai".to_string(),
            provider_request_id: optional_string(response.get("id")),
            requested_model_id: model_id.to_string(),
            resolved_model_version: optional_string(response.get("model")),
            structured_output_mode: if strict {
                "json_schema_strict".to_string()
            } else {
                "json_schema".to_string()
            },
            schema_version: schema_version.map(str::to_string),
            schema_hash: response_schema_hash,
            finish_reason: finish_reason.clone(),
            incomplete_reason: None,
            input_tokens: optional_u64(response.pointer("/usage/prompt_tokens")),
            output_tokens: optional_u64(response.pointer("/usage/completion_tokens")),
            reasoning_tokens: optional_u64(
                response.pointer("/usage/completion_tokens_details/reasoning_tokens"),
            ),
            input_bytes: prompt.len(),
            output_bytes: text.len(),
            latency_ms: started_at.elapsed().as_millis() as u64,
            retry_count: 0,
            safety_or_refusal_code: finish_reason.filter(|reason| reason == "content_filter"),
        },
        text,
    })
}

pub(super) async fn generate_anthropic_json(
    client: &reqwest::Client,
    model_id: &str,
    prompt: &str,
    response_schema: Value,
    schema_version: Option<&str>,
    options: &Map<String, Value>,
    api_key: String,
) -> Result<DesktopStructuredJsonResponse, String> {
    let max_tokens = numeric_provider_option(options, "maxOutputTokens").unwrap_or(8192.0);
    let response_schema = standard_json_schema(response_schema);
    let response_schema_hash = schema_hash(&response_schema);
    let mut body = json!({
        "model": model_id,
        "max_tokens": max_tokens as u64,
        "messages": [{ "role": "user", "content": prompt }],
        "output_config": {
            "format": {
                "type": "json_schema",
                "schema": response_schema
            }
        }
    });
    if let Value::Object(ref mut map) = body {
        if let Some(temperature) = numeric_provider_option(options, "temperature") {
            map.insert("temperature".to_string(), json!(temperature));
        }
        if let Some(top_p) = numeric_provider_option(options, "topP") {
            map.insert("top_p".to_string(), json!(top_p));
        }
    }
    let started_at = Instant::now();
    let response = post_json(
        client,
        "Anthropic",
        "https://api.anthropic.com/v1/messages".to_string(),
        vec![
            ("x-api-key", api_key),
            ("anthropic-version", "2023-06-01".to_string()),
        ],
        body,
    )
    .await?;
    let finish_reason = optional_string(response.get("stop_reason"));
    let text = extract_anthropic_message_text(&response).unwrap_or_default();
    let incomplete_reason = finish_reason
        .clone()
        .filter(|reason| reason != "end_turn" && reason != "stop_sequence")
        .or_else(|| text.trim().is_empty().then(|| "empty_output".to_string()));
    if let Some(reason) = incomplete_reason {
        return Err(format!("provider_output_incomplete: Anthropic {}", reason));
    }
    Ok(DesktopStructuredJsonResponse {
        execution_metadata: ProviderExecutionMetadata {
            provider_id: "anthropic".to_string(),
            provider_request_id: optional_string(response.get("id")),
            requested_model_id: model_id.to_string(),
            resolved_model_version: optional_string(response.get("model")),
            structured_output_mode: "json_schema".to_string(),
            schema_version: schema_version.map(str::to_string),
            schema_hash: response_schema_hash,
            finish_reason,
            incomplete_reason: None,
            input_tokens: optional_u64(response.pointer("/usage/input_tokens")),
            output_tokens: optional_u64(response.pointer("/usage/output_tokens")),
            reasoning_tokens: None,
            input_bytes: prompt.len(),
            output_bytes: text.len(),
            latency_ms: started_at.elapsed().as_millis() as u64,
            retry_count: 0,
            safety_or_refusal_code: None,
        },
        text,
    })
}

pub(super) async fn generate_gemini_ai_studio_json(
    client: &reqwest::Client,
    model_id: &str,
    prompt: &str,
    response_schema: Value,
    schema_version: Option<&str>,
    options: &Map<String, Value>,
    api_key: String,
) -> Result<DesktopStructuredJsonResponse, String> {
    let response_schema_hash = schema_hash(&response_schema);
    let body = gemini_generate_content_body(prompt, response_schema, options);
    let started_at = Instant::now();
    let response = post_json(
        client,
        "Gemini AI Studio",
        gemini_ai_studio_generate_content_url(model_id),
        gemini_ai_studio_headers(&api_key),
        body,
    )
    .await?;
    gemini_response(
        "gemini-ai-studio",
        model_id,
        prompt,
        schema_version,
        response_schema_hash,
        response,
        started_at.elapsed().as_millis() as u64,
    )
}

async fn fetch_google_oauth_access_token(
    client: &reqwest::Client,
    credential: &GoogleServiceAccountCredential,
) -> Result<String, String> {
    let token_uri = credential
        .token_uri
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("https://oauth2.googleapis.com/token");
    if !token_uri.starts_with("https://") {
        return Err("Vertex credential token endpoint is invalid".to_string());
    }
    let issued_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is invalid for Vertex authentication".to_string())?
        .as_secs() as usize;
    let claims = ServiceAccountJwtClaims {
        iss: credential.client_email.trim(),
        scope: "https://www.googleapis.com/auth/cloud-platform",
        aud: token_uri,
        iat: issued_at,
        exp: issued_at + 3600,
    };
    let key = EncodingKey::from_rsa_pem(credential.private_key.as_bytes())
        .map_err(|_| "Vertex credential private key could not be used".to_string())?;
    let assertion = jsonwebtoken::encode(&Header::new(Algorithm::RS256), &claims, &key)
        .map_err(|_| "Vertex credential signing failed".to_string())?;
    let response = client
        .post(token_uri)
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", assertion.as_str()),
        ])
        .send()
        .await
        .map_err(|error| provider_send_error("Vertex authentication", "request", error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Vertex authentication failed with status {}",
            status.as_u16()
        ));
    }
    let value = response
        .json::<Value>()
        .await
        .map_err(|_| "Vertex authentication returned invalid JSON".to_string())?;
    value
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|token| !token.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| "Vertex authentication returned no access token".to_string())
}

pub(super) async fn generate_gemini_vertex_json(
    client: &reqwest::Client,
    model_id: &str,
    prompt: &str,
    response_schema: Value,
    schema_version: Option<&str>,
    options: &Map<String, Value>,
    credential_path: &str,
) -> Result<DesktopStructuredJsonResponse, String> {
    let credential = read_google_service_account_credential(credential_path)?;
    let project = string_provider_option(options, "project")
        .or_else(|| {
            credential
                .project_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .ok_or_else(|| "Vertex project is required".to_string())?;
    let location =
        string_provider_option(options, "location").unwrap_or_else(|| "global".to_string());
    let project_segment = validate_vertex_path_segment("Vertex project", &project)?;
    let location_segment = validate_vertex_path_segment("Vertex location", &location)?;
    let model_segment =
        validate_vertex_path_segment("Vertex model", normalize_vertex_model_id(model_id))?;
    let access_token = fetch_google_oauth_access_token(client, &credential).await?;
    let response_schema_hash = schema_hash(&response_schema);
    let body = gemini_generate_content_body(prompt, response_schema, options);
    let started_at = Instant::now();
    let response = post_json(
        client,
        "Gemini Vertex",
        format!(
            "https://aiplatform.googleapis.com/v1/projects/{}/locations/{}/publishers/google/models/{}:generateContent",
            project_segment,
            location_segment,
            model_segment
        ),
        vec![("Authorization", format!("Bearer {}", access_token))],
        body,
    )
    .await?;
    gemini_response(
        "gemini-vertex",
        model_id,
        prompt,
        schema_version,
        response_schema_hash,
        response,
        started_at.elapsed().as_millis() as u64,
    )
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn optional_u64(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64)
}

fn extract_openai_message_text(value: &Value) -> Result<String, String> {
    let choices = value
        .get("choices")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let message = choices
        .first()
        .and_then(|choice| choice.get("message"))
        .ok_or_else(|| "OpenAI returned no message".to_string())?;
    if let Some(refusal) = message.get("refusal").and_then(Value::as_str) {
        if !refusal.trim().is_empty() {
            return Err("OpenAI refused the request".to_string());
        }
    }
    if let Some(content) = message.get("content").and_then(Value::as_str) {
        if !content.trim().is_empty() {
            return Ok(content.to_string());
        }
    }
    if let Some(parts) = message.get("content").and_then(Value::as_array) {
        let text = parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<String>();
        if !text.trim().is_empty() {
            return Ok(text);
        }
    }
    Err("OpenAI returned no message content".to_string())
}

fn extract_anthropic_message_text(value: &Value) -> Result<String, String> {
    let text = value
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<String>();
    if text.trim().is_empty() {
        Err("Anthropic returned no text content".to_string())
    } else {
        Ok(text)
    }
}

fn extract_gemini_message_text(value: &Value) -> Result<String, String> {
    let text = value
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|candidates| candidates.first())
        .and_then(|candidate| candidate.get("content"))
        .and_then(|content| content.get("parts"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<String>();
    if text.trim().is_empty() {
        Err("Gemini returned no text content".to_string())
    } else {
        Ok(text)
    }
}

fn gemini_response(
    provider_id: &str,
    model_id: &str,
    prompt: &str,
    schema_version: Option<&str>,
    response_schema_hash: String,
    response: Value,
    latency_ms: u64,
) -> Result<DesktopStructuredJsonResponse, String> {
    let finish_reason = optional_string(response.pointer("/candidates/0/finishReason"));
    let block_reason = optional_string(response.pointer("/promptFeedback/blockReason"));
    let incomplete_reason = block_reason
        .clone()
        .or_else(|| finish_reason.clone().filter(|reason| reason != "STOP"));
    if let Some(reason) = incomplete_reason {
        return Err(format!("provider_output_incomplete: Gemini {}", reason));
    }
    let text = extract_gemini_message_text(&response).unwrap_or_default();
    if text.trim().is_empty() {
        return Err("provider_output_incomplete: Gemini empty_output".to_string());
    }
    Ok(DesktopStructuredJsonResponse {
        execution_metadata: ProviderExecutionMetadata {
            provider_id: provider_id.to_string(),
            provider_request_id: optional_string(response.get("responseId")),
            requested_model_id: model_id.to_string(),
            resolved_model_version: optional_string(response.get("modelVersion")),
            structured_output_mode: "json_schema".to_string(),
            schema_version: schema_version.map(str::to_string),
            schema_hash: response_schema_hash,
            finish_reason,
            incomplete_reason: None,
            input_tokens: optional_u64(response.pointer("/usageMetadata/promptTokenCount")),
            output_tokens: optional_u64(response.pointer("/usageMetadata/candidatesTokenCount")),
            reasoning_tokens: optional_u64(response.pointer("/usageMetadata/thoughtsTokenCount")),
            input_bytes: prompt.len(),
            output_bytes: text.len(),
            latency_ms,
            retry_count: 0,
            safety_or_refusal_code: block_reason,
        },
        text,
    })
}

fn gemini_generate_content_body(
    prompt: &str,
    response_schema: Value,
    options: &Map<String, Value>,
) -> Value {
    let mut body = json!({
        "contents": [{
            "role": "user",
            "parts": [{ "text": prompt }]
        }],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": response_schema
        }
    });
    if let Some(config) = body
        .get_mut("generationConfig")
        .and_then(Value::as_object_mut)
    {
        if let Some(temperature) = numeric_provider_option(options, "temperature") {
            config.insert("temperature".to_string(), json!(temperature));
        }
        if let Some(top_p) = numeric_provider_option(options, "topP") {
            config.insert("topP".to_string(), json!(top_p));
        }
        if let Some(max_tokens) = numeric_provider_option(options, "maxOutputTokens") {
            config.insert("maxOutputTokens".to_string(), json!(max_tokens as u64));
        }
        if let Some(source) = options.get("thinkingConfig").and_then(Value::as_object) {
            let mut thinking_config = Map::new();
            if let Some(level) = source.get("thinkingLevel").and_then(Value::as_str) {
                if ["minimal", "low", "medium", "high"].contains(&level) {
                    thinking_config.insert("thinkingLevel".to_string(), json!(level));
                }
            }
            if let Some(budget) = source.get("thinkingBudget").and_then(Value::as_u64) {
                thinking_config.insert("thinkingBudget".to_string(), json!(budget));
            }
            if !thinking_config.is_empty() {
                config.insert("thinkingConfig".to_string(), Value::Object(thinking_config));
            }
        }
    }
    body
}
fn gemini_ai_studio_generate_content_url(model_id: &str) -> String {
    let normalized_model_id = model_id.strip_prefix("models/").unwrap_or(model_id);
    format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
        normalized_model_id
    )
}

fn gemini_ai_studio_headers(api_key: &str) -> Vec<(&'static str, String)> {
    vec![("x-goog-api-key", api_key.to_string())]
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn validates_vertex_url_segments() {
        assert_eq!(
            validate_vertex_path_segment("Vertex project", "demo-project.1")
                .expect("valid project"),
            "demo-project.1",
        );
        assert!(validate_vertex_path_segment("Vertex project", "projects/demo-project").is_err());
        assert!(validate_vertex_path_segment("Vertex location", "us central1").is_err());
    }

    #[test]
    fn normalizes_vertex_model_resource_names() {
        assert_eq!(
            normalize_vertex_model_id("models/gemini-3.1-flash-lite"),
            "gemini-3.1-flash-lite"
        );
        assert_eq!(
            normalize_vertex_model_id(
                "projects/demo/locations/global/publishers/google/models/gemini-3.1-flash-lite"
            ),
            "gemini-3.1-flash-lite",
        );
    }

    #[test]
    fn builds_gemini_ai_studio_request_without_key_in_url() {
        let url = gemini_ai_studio_generate_content_url("models/gemini-3.1-flash-lite");
        let headers = gemini_ai_studio_headers("gemini-secret");

        assert_eq!(
            url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent"
        );
        assert!(!url.contains("key="));
        assert_eq!(
            headers,
            vec![("x-goog-api-key", "gemini-secret".to_string())]
        );
    }

    #[test]
    fn forwards_only_supported_gemini_thinking_policy_fields() {
        let mut options = Map::new();
        options.insert(
            "thinkingConfig".to_string(),
            json!({ "thinkingLevel": "minimal", "ignored": "value" }),
        );
        let body = gemini_generate_content_body("label", json!({ "type": "OBJECT" }), &options);

        assert_eq!(
            body.pointer("/generationConfig/thinkingConfig"),
            Some(&json!({ "thinkingLevel": "minimal" })),
        );
        assert!(body.pointer("/generationConfig/temperature").is_none());
    }

    #[test]
    fn rejects_incomplete_gemini_output_before_json_parsing() {
        let error = gemini_response(
            "gemini-ai-studio",
            "gemini-flash",
            "label",
            Some("chapter-labeling-result-v1"),
            "sha256:test".to_string(),
            json!({
                "candidates": [{
                    "finishReason": "MAX_TOKENS",
                    "content": { "parts": [{ "text": "{\"partial\":true" }] }
                }]
            }),
            3,
        )
        .expect_err("truncated Gemini output must fail before parsing");

        assert!(error.contains("provider_output_incomplete"));
        assert!(error.contains("MAX_TOKENS"));
    }

    #[test]
    fn returns_native_provider_execution_metadata_for_complete_gemini_output() {
        let response = gemini_response(
            "gemini-vertex",
            "gemini-flash",
            "label",
            Some("chapter-labeling-result-v1"),
            "sha256:test".to_string(),
            json!({
                "responseId": "request-1",
                "modelVersion": "gemini-flash-2026-07-11",
                "candidates": [{
                    "finishReason": "STOP",
                    "content": { "parts": [{ "text": "{\"ok\":true}" }] }
                }],
                "usageMetadata": {
                    "promptTokenCount": 7,
                    "candidatesTokenCount": 5,
                    "thoughtsTokenCount": 2
                }
            }),
            4,
        )
        .expect("complete Gemini output should return metadata");

        assert_eq!(response.text, "{\"ok\":true}");
        assert_eq!(
            response.execution_metadata.finish_reason.as_deref(),
            Some("STOP")
        );
        assert_eq!(response.execution_metadata.input_tokens, Some(7));
        assert_eq!(response.execution_metadata.output_tokens, Some(5));
        assert_eq!(response.execution_metadata.reasoning_tokens, Some(2));
    }
    #[test]
    #[ignore = "requires local Vertex credentials and makes one live provider request"]
    fn live_desktop_vertex_labeling_smoke() {
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
        let mut options = Map::new();
        options.insert(
            "location".to_string(),
            Value::String(
                std::env::var("NOVELDESK_DESKTOP_VERTEX_LOCATION")
                    .unwrap_or_else(|_| "global".to_string()),
            ),
        );
        if let Ok(project) = std::env::var("NOVELDESK_DESKTOP_VERTEX_PROJECT") {
            options.insert("project".to_string(), Value::String(project));
        }
        let prompt = [
            "Return only JSON that matches the schema.",
            "Label each paragraph as dialogue or narration for a novel text viewer.",
            "Paragraph 0: \"여긴 어디지?\"",
            "Paragraph 1: [시스템] 낯선 방에서 눈을 떴다.",
        ]
        .join("\n");
        let schema = json!({
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
        });

        let text = tauri::async_runtime::block_on(async {
            let client = native_provider_http_client(NATIVE_AI_REQUEST_TIMEOUT_SECS)
                .expect("native provider HTTP client");
            generate_gemini_vertex_json(
                &client,
                &model_id,
                &prompt,
                schema,
                None,
                &options,
                &credential_path,
            )
            .await
        })
        .expect("desktop Vertex live smoke should return JSON text");
        let value: Value =
            serde_json::from_str(&text.text).expect("desktop Vertex live smoke should return JSON");
        let segments = value
            .get("segments")
            .and_then(Value::as_array)
            .expect("segments array");
        assert!(!segments.is_empty(), "segments array should not be empty");
    }
}
