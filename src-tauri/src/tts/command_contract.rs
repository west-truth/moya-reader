use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesktopTTSSynthesisRequest {
    pub(crate) provider_id: String,
    pub(crate) model_id: Option<String>,
    pub(crate) text: String,
    pub(crate) voice_id: Option<String>,
    pub(crate) speed: Option<f64>,
    pub(crate) emotion: Option<String>,
    pub(crate) tone: Option<String>,
    pub(crate) format: Option<String>,
    pub(crate) provider_options: Option<Value>,
}

impl DesktopTTSSynthesisRequest {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.provider_id.trim().is_empty() {
            return Err("TTS provider id is required".to_string());
        }
        if self.text.trim().is_empty() {
            return Err("TTS text is required".to_string());
        }
        if self
            .speed
            .is_some_and(|speed| !speed.is_finite() || speed <= 0.0 || speed > 4.0)
        {
            return Err("TTS speed must be greater than 0 and at most 4".to_string());
        }
        if self.format.as_deref().is_some_and(|format| {
            !matches!(
                format,
                "mp3" | "wav" | "pcm" | "ogg" | "opus" | "aac" | "flac"
            )
        }) {
            return Err("TTS format is unsupported".to_string());
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopTTSSynthesisResult {
    pub(crate) provider_id: String,
    pub(crate) model_id: Option<String>,
    pub(crate) content_type: String,
    pub(crate) audio_base64: String,
    pub(crate) byte_size: usize,
    pub(crate) provider_request_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopTTSVoiceList {
    pub(super) voices: Vec<DesktopTTSVoice>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopTTSVoice {
    pub(super) id: String,
    pub(super) label: String,
    pub(super) lang: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_desktop_tts_request_contract() {
        let request: DesktopTTSSynthesisRequest = serde_json::from_value(json!({
            "providerId": "local-endpoint",
            "modelId": "endpoint-default",
            "text": "  원문 공백을 보존합니다.  ",
            "voiceId": "narrator",
            "speed": 1.1,
            "emotion": "neutral",
            "tone": "calm",
            "format": "wav",
            "providerOptions": { "sampleRate": 24000 }
        }))
        .expect("desktop TTS request should deserialize");

        request
            .validate()
            .expect("canonical request should validate");
        assert_eq!(request.text, "  원문 공백을 보존합니다.  ");
    }

    #[test]
    fn rejects_tts_contract_drift_and_invalid_values() {
        let unknown = serde_json::from_value::<DesktopTTSSynthesisRequest>(json!({
            "providerId": "openai-tts",
            "text": "hello",
            "providerOptions": {},
            "apiKey": "sk-must-not-cross-the-command-contract"
        }))
        .expect_err("unknown top-level secret field should be rejected");
        assert!(unknown.to_string().contains("unknown field"));

        let invalid: DesktopTTSSynthesisRequest = serde_json::from_value(json!({
            "providerId": "openai-tts",
            "text": "hello",
            "speed": 0,
            "format": "zip",
            "providerOptions": []
        }))
        .expect("request shape should deserialize before semantic validation");
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn serializes_tts_result_without_provider_secrets() {
        let value = serde_json::to_value(DesktopTTSSynthesisResult {
            provider_id: "openai-tts".to_string(),
            model_id: Some("gpt-4o-mini-tts".to_string()),
            content_type: "audio/mpeg".to_string(),
            audio_base64: "AQID".to_string(),
            byte_size: 3,
            provider_request_id: Some("request-1".to_string()),
        })
        .expect("TTS result should serialize");

        assert_eq!(
            value.get("providerId").and_then(Value::as_str),
            Some("openai-tts")
        );
        assert!(value.get("secretValue").is_none());
        assert!(value.get("apiKey").is_none());
    }
}
