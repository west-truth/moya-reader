use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesktopStructuredJsonRequest {
    pub(crate) provider_id: String,
    pub(crate) model_id: String,
    pub(crate) prompt: String,
    pub(crate) response_schema: Value,
    pub(crate) json_schema_name: String,
    pub(crate) schema_version: Option<String>,
    pub(crate) provider_options: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderExecutionMetadata {
    pub(crate) provider_id: String,
    pub(crate) provider_request_id: Option<String>,
    pub(crate) requested_model_id: String,
    pub(crate) resolved_model_version: Option<String>,
    pub(crate) structured_output_mode: String,
    pub(crate) schema_version: Option<String>,
    pub(crate) schema_hash: String,
    pub(crate) finish_reason: Option<String>,
    pub(crate) incomplete_reason: Option<String>,
    pub(crate) input_tokens: Option<u64>,
    pub(crate) output_tokens: Option<u64>,
    pub(crate) reasoning_tokens: Option<u64>,
    pub(crate) input_bytes: usize,
    pub(crate) output_bytes: usize,
    pub(crate) latency_ms: u64,
    pub(crate) retry_count: u32,
    pub(crate) safety_or_refusal_code: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopStructuredJsonResponse {
    pub(crate) text: String,
    pub(crate) execution_metadata: ProviderExecutionMetadata,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopStructuredJsonCommandError {
    pub(crate) code: String,
    pub(crate) message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) execution_metadata: Option<ProviderExecutionMetadata>,
}

impl DesktopStructuredJsonRequest {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.provider_id.trim().is_empty() {
            return Err("provider id is required".to_string());
        }
        if self.model_id.trim().is_empty() {
            return Err("provider model id is required".to_string());
        }
        if self.prompt.trim().is_empty() {
            return Err("provider prompt is required".to_string());
        }
        if !self.response_schema.is_object() {
            return Err("provider response schema must be an object".to_string());
        }
        if self
            .schema_version
            .as_ref()
            .is_some_and(|value| value.trim().is_empty() || value.len() > 128)
        {
            return Err("provider schema version is invalid".to_string());
        }
        let schema_name = self.json_schema_name.trim();
        if schema_name.is_empty()
            || schema_name.len() > 64
            || !schema_name.chars().all(|character| {
                character.is_ascii_alphanumeric() || character == '_' || character == '-'
            })
        {
            return Err("provider JSON schema name is invalid".to_string());
        }
        if self
            .provider_options
            .as_ref()
            .is_some_and(|options| !options.is_object())
        {
            return Err("provider options must be an object".to_string());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_provider_neutral_structured_json_request_contract() {
        let request: DesktopStructuredJsonRequest = serde_json::from_value(json!({
            "providerId": "gemini-ai-studio",
            "modelId": "gemini-3.1-flash-lite",
            "prompt": "Return the canonical chapter labeling response.",
            "responseSchema": { "type": "OBJECT", "properties": {} },
            "jsonSchemaName": "chapter_labeling_result",
            "schemaVersion": "chapter-labeling-result-v1",
            "providerOptions": { "thinkingConfig": { "thinkingLevel": "minimal" } }
        }))
        .expect("desktop structured JSON request should deserialize");

        request
            .validate()
            .expect("canonical request should validate");
        assert_eq!(request.provider_id, "gemini-ai-studio");
        assert_eq!(request.json_schema_name, "chapter_labeling_result");
        assert_eq!(
            request.schema_version.as_deref(),
            Some("chapter-labeling-result-v1")
        );
    }

    #[test]
    fn rejects_unknown_top_level_secret_fields() {
        let error = serde_json::from_value::<DesktopStructuredJsonRequest>(json!({
            "providerId": "openai",
            "modelId": "gpt-4.1-mini",
            "prompt": "Return JSON.",
            "responseSchema": { "type": "OBJECT" },
            "jsonSchemaName": "chapter_labeling_result",
            "schemaVersion": "chapter-labeling-result-v1",
            "providerOptions": {},
            "apiKey": "sk-must-not-cross-the-command-contract"
        }))
        .expect_err("unknown top-level secret field should be rejected");

        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn rejects_invalid_structured_json_request_metadata() {
        let request: DesktopStructuredJsonRequest = serde_json::from_value(json!({
            "providerId": "openai",
            "modelId": "gpt-4.1-mini",
            "prompt": " ",
            "responseSchema": [],
            "jsonSchemaName": "bad schema name",
            "schemaVersion": " ",
            "providerOptions": []
        }))
        .expect("request shape should deserialize before semantic validation");

        assert!(request.validate().is_err());
    }
}
