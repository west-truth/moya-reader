use super::command_contract::{DesktopTTSSynthesisResult, DesktopTTSVoice};
use super::provider::{
    clamp_f64, content_type_for_openai_format, desktop_tts_result, normalize_tts_format,
    retry_after_error_suffix, TtsBodyRequest,
};
use crate::provider_http::{
    numeric_provider_option, provider_send_error, string_provider_option,
    validate_local_endpoint_url,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde_json::{json, Map, Value};

pub(super) async fn synthesize_local_endpoint_tts(
    client: &reqwest::Client,
    endpoint_url: &str,
    model_id: Option<String>,
    request: &TtsBodyRequest<'_>,
) -> Result<DesktopTTSSynthesisResult, String> {
    let body = local_endpoint_tts_body(model_id.as_deref(), request);
    let fallback_format = body
        .get("format")
        .and_then(Value::as_str)
        .unwrap_or("mp3")
        .to_string();
    let fallback_content_type =
        content_type_for_openai_format(normalize_tts_format(Some(&fallback_format)));
    let (bytes, content_type, request_id) =
        post_local_endpoint_audio(client, endpoint_url, body, fallback_content_type).await?;
    Ok(desktop_tts_result(
        "local-endpoint",
        model_id,
        bytes,
        content_type,
        fallback_content_type,
        request_id,
    ))
}
pub(super) async fn fetch_local_endpoint_voices(
    client: &reqwest::Client,
    endpoint_url: &str,
) -> Result<Vec<DesktopTTSVoice>, String> {
    let voices_url = local_endpoint_voices_url(endpoint_url)?;
    let response = client
        .get(voices_url)
        .send()
        .await
        .map_err(|error| provider_send_error("Local TTS endpoint voices", "request", error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Local TTS endpoint voices request failed with status {}",
            status.as_u16()
        ));
    }
    let value = response
        .json::<Value>()
        .await
        .map_err(|_| "Local TTS endpoint voices response was invalid".to_string())?;
    Ok(parse_local_endpoint_voices(&value))
}
fn local_endpoint_voices_url(endpoint_url: &str) -> Result<String, String> {
    let mut url = validate_local_endpoint_url(endpoint_url)?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "Local TTS endpoint URL path is invalid".to_string())?;
        segments.pop_if_empty();
        segments.pop();
        segments.push("voices");
    }
    url.set_query(None);
    Ok(url.to_string())
}
fn local_endpoint_tts_body(model_id: Option<&str>, request: &TtsBodyRequest<'_>) -> Value {
    let options = request.provider_options;
    let mut body = Map::new();
    if let Some(value) = model_id
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "endpoint-default")
    {
        body.insert("modelId".to_string(), json!(value));
    }
    body.insert("text".to_string(), json!(request.text));
    let resolved_voice = string_provider_option(options, "voice").or_else(|| {
        request
            .voice_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    });
    if let Some(value) = resolved_voice.as_deref() {
        body.insert("voiceId".to_string(), json!(value));
    }
    if let Some(value) = request
        .tone
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body.insert("tone".to_string(), json!(value));
    }
    if let Some(value) = request
        .emotion
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body.insert("emotion".to_string(), json!(value));
    }
    if let Some(value) = numeric_provider_option(options, "speed").or(request.speed) {
        body.insert("speed".to_string(), json!(clamp_f64(value, 0.25, 4.0)));
    }
    let response_format = string_provider_option(options, "format")
        .unwrap_or_else(|| normalize_tts_format(request.format).to_string());
    body.insert("format".to_string(), json!(response_format));
    if !options.is_empty() {
        body.insert(
            "providerOptions".to_string(),
            Value::Object(options.clone()),
        );
    }
    if let Some(value) = resolved_voice {
        let mut voice_profile = Map::new();
        voice_profile.insert("providerId".to_string(), json!("local-endpoint"));
        voice_profile.insert("providerVoiceId".to_string(), json!(value));
        if let Some(value) = numeric_provider_option(options, "speed").or(request.speed) {
            voice_profile.insert("speed".to_string(), json!(clamp_f64(value, 0.25, 4.0)));
        }
        if !options.is_empty() {
            voice_profile.insert(
                "providerOptions".to_string(),
                Value::Object(options.clone()),
            );
        }
        body.insert("voiceProfile".to_string(), Value::Object(voice_profile));
    }
    Value::Object(body)
}

fn local_endpoint_voice_field(voice: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        voice
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn parse_local_endpoint_voices(value: &Value) -> Vec<DesktopTTSVoice> {
    let voices = value
        .as_array()
        .cloned()
        .or_else(|| value.get("voices").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    voices
        .into_iter()
        .filter_map(|voice| {
            let id = local_endpoint_voice_field(&voice, &["id", "voiceId", "voice_id"])?;
            let label =
                local_endpoint_voice_field(&voice, &["label", "name"]).unwrap_or(id.clone());
            let lang = local_endpoint_voice_field(&voice, &["lang", "language"])
                .unwrap_or_else(|| "und".to_string());
            Some(DesktopTTSVoice { id, label, lang })
        })
        .collect()
}

fn local_endpoint_json_audio(
    value: Value,
    fallback_content_type: &str,
    header_request_id: Option<String>,
) -> Result<(Vec<u8>, String, Option<String>), String> {
    let body = value
        .as_object()
        .ok_or_else(|| "Local TTS endpoint returned invalid JSON".to_string())?;
    let audio_base64 = body
        .get("audioBase64")
        .or_else(|| body.get("audio"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Local TTS endpoint returned no audioBase64 payload".to_string())?;
    let bytes = BASE64_STANDARD
        .decode(audio_base64)
        .map_err(|_| "Local TTS endpoint returned invalid base64 audio".to_string())?;
    let content_type = body
        .get("contentType")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_content_type)
        .to_string();
    let request_id = body
        .get("providerRequestId")
        .or_else(|| body.get("requestId"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or(header_request_id);
    Ok((bytes, content_type, request_id))
}

fn content_type_is_audio(content_type: &str) -> bool {
    let media_type = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    media_type.starts_with("audio/") || media_type == "application/octet-stream"
}

async fn post_local_endpoint_audio(
    client: &reqwest::Client,
    endpoint_url: &str,
    body: Value,
    fallback_content_type: &str,
) -> Result<(Vec<u8>, String, Option<String>), String> {
    let response = client
        .post(validate_local_endpoint_url(endpoint_url)?.to_string())
        .json(&body)
        .send()
        .await
        .map_err(|error| provider_send_error("Local TTS endpoint", "request", error))?;
    let status = response.status();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("audio/mpeg")
        .to_string();
    let request_id = response
        .headers()
        .get("x-request-id")
        .or_else(|| response.headers().get("request-id"))
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    if !status.is_success() {
        return Err(format!(
            "Local TTS endpoint request failed with status {}{}",
            status.as_u16(),
            retry_after_error_suffix(response.headers())
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "Local TTS endpoint returned unreadable audio".to_string())?
        .to_vec();
    if content_type_is_audio(&content_type) {
        return Ok((bytes, content_type, request_id));
    }
    let value = serde_json::from_slice::<Value>(&bytes)
        .map_err(|_| "Local TTS endpoint returned invalid JSON".to_string())?;
    local_endpoint_json_audio(value, fallback_content_type, request_id)
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_local_endpoint_tts_body_without_secrets() {
        let mut options = Map::new();
        options.insert("sampleRate".to_string(), json!(24000));
        options.insert("voice".to_string(), json!("alice"));
        let request = TtsBodyRequest {
            text: "  안녕하세요.  ",
            voice_id: Some("fallback"),
            speed: Some(0.9),
            emotion: Some("warm"),
            tone: Some("calm"),
            format: Some("wav"),
            provider_options: &options,
        };
        let body = local_endpoint_tts_body(Some("kokoro"), &request);

        assert_eq!(body.get("modelId").and_then(Value::as_str), Some("kokoro"));
        assert_eq!(
            body.get("text").and_then(Value::as_str),
            Some("  안녕하세요.  ")
        );
        assert_eq!(body.get("voiceId").and_then(Value::as_str), Some("alice"));
        assert_eq!(body.get("tone").and_then(Value::as_str), Some("calm"));
        assert_eq!(body.get("emotion").and_then(Value::as_str), Some("warm"));
        assert_eq!(body.get("speed").and_then(Value::as_f64), Some(0.9));
        assert_eq!(body.get("format").and_then(Value::as_str), Some("wav"));
        assert_eq!(
            body.get("voiceProfile")
                .and_then(|value| value.get("providerVoiceId"))
                .and_then(Value::as_str),
            Some("alice")
        );
        assert!(!body.to_string().contains("sk-"));
    }

    #[test]
    fn parses_local_endpoint_voice_contract_variants() {
        let array_voices = parse_local_endpoint_voices(&json!([
            { "id": "alice", "label": "Alice", "lang": "ko-KR" },
            { "voiceId": "bob", "name": "Bob", "language": "en-US" },
            { "name": "missing id" }
        ]));
        assert_eq!(array_voices.len(), 2);
        assert_eq!(array_voices[0].id, "alice");
        assert_eq!(array_voices[0].label, "Alice");
        assert_eq!(array_voices[1].id, "bob");
        assert_eq!(array_voices[1].lang, "en-US");

        let object_voices = parse_local_endpoint_voices(&json!({
            "voices": [{ "voice_id": "narrator", "name": "Narrator" }]
        }));
        assert_eq!(object_voices[0].id, "narrator");
        assert_eq!(object_voices[0].lang, "und");
    }

    #[test]
    fn validates_local_endpoint_url_and_derives_voices_url() {
        assert_eq!(
            local_endpoint_voices_url("http://127.0.0.1:5000/api/synthesize?token=secret")
                .expect("voices url"),
            "http://127.0.0.1:5000/api/voices"
        );
        assert_eq!(
            local_endpoint_voices_url("https://tts.local/synthesize/").expect("voices url"),
            "https://tts.local/voices"
        );
        assert!(validate_local_endpoint_url("ftp://127.0.0.1/synthesize").is_err());
        assert!(validate_local_endpoint_url("http://user:pass@127.0.0.1/synthesize").is_err());
        assert!(validate_local_endpoint_url("http://127.0.0.1/synthesize#secret").is_err());
    }

    #[test]
    fn parses_local_endpoint_json_audio() {
        let (bytes, content_type, request_id) = local_endpoint_json_audio(
            json!({
                "audioBase64": BASE64_STANDARD.encode([1_u8, 2, 3]),
                "contentType": "audio/wav",
                "requestId": "local-1"
            }),
            "audio/mpeg",
            None,
        )
        .expect("json audio");

        assert_eq!(bytes, vec![1, 2, 3]);
        assert_eq!(content_type, "audio/wav");
        assert_eq!(request_id.as_deref(), Some("local-1"));
        assert!(
            local_endpoint_json_audio(json!({ "audioBase64": "$" }), "audio/mpeg", None)
                .expect_err("bad base64")
                .contains("invalid base64")
        );
    }
}
