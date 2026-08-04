use super::command_contract::{DesktopTTSSynthesisResult, DesktopTTSVoice};
use crate::provider_http::{
    boolean_provider_option, numeric_provider_option, provider_send_error, string_provider_option,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde_json::{json, Map, Value};

pub(super) struct TtsBodyRequest<'a> {
    pub(super) text: &'a str,
    pub(super) voice_id: Option<&'a str>,
    pub(super) speed: Option<f64>,
    pub(super) emotion: Option<&'a str>,
    pub(super) tone: Option<&'a str>,
    pub(super) format: Option<&'a str>,
    pub(super) provider_options: &'a Map<String, Value>,
}
pub(super) async fn synthesize_openai_tts(
    client: &reqwest::Client,
    api_key: String,
    model_id: String,
    request: &TtsBodyRequest<'_>,
) -> Result<DesktopTTSSynthesisResult, String> {
    let body = openai_tts_body(&model_id, request);
    let response_format = body
        .get("response_format")
        .and_then(Value::as_str)
        .unwrap_or("mp3")
        .to_string();
    let (bytes, content_type, request_id) = post_audio(
        client,
        "OpenAI",
        "https://api.openai.com/v1/audio/speech".to_string(),
        vec![("Authorization", format!("Bearer {}", api_key))],
        body,
    )
    .await?;
    Ok(desktop_tts_result(
        "openai-tts",
        Some(model_id),
        bytes,
        content_type,
        content_type_for_openai_format(&response_format),
        request_id,
    ))
}

pub(super) async fn synthesize_elevenlabs_tts(
    client: &reqwest::Client,
    api_key: String,
    model_id: String,
    request: &TtsBodyRequest<'_>,
) -> Result<DesktopTTSSynthesisResult, String> {
    let options = request.provider_options;
    let voice_id = validate_elevenlabs_voice_id(
        &string_provider_option(options, "voice")
            .or_else(|| request.voice_id.map(str::to_string))
            .unwrap_or_default(),
    )?;
    let output_format = elevenlabs_output_format(
        request.format,
        string_provider_option(options, "outputFormat"),
    );
    let mut url = reqwest::Url::parse(&format!(
        "https://api.elevenlabs.io/v1/text-to-speech/{}",
        voice_id
    ))
    .map_err(|_| "ElevenLabs TTS endpoint is invalid".to_string())?;
    url.query_pairs_mut()
        .append_pair("output_format", &output_format);
    if let Some(value) = boolean_provider_option(options, "enableLogging") {
        url.query_pairs_mut()
            .append_pair("enable_logging", if value { "true" } else { "false" });
    }
    let body = elevenlabs_tts_body(&model_id, request.text, request.speed, options);
    let (bytes, content_type, request_id) = post_audio(
        client,
        "ElevenLabs",
        url.to_string(),
        vec![
            ("xi-api-key", api_key),
            (
                "Accept",
                content_type_for_elevenlabs_output_format(&output_format).to_string(),
            ),
        ],
        body,
    )
    .await?;
    Ok(desktop_tts_result(
        "elevenlabs",
        Some(model_id),
        bytes,
        content_type,
        content_type_for_elevenlabs_output_format(&output_format),
        request_id,
    ))
}
pub(super) fn openai_tts_voices() -> Vec<DesktopTTSVoice> {
    [
        "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer",
    ]
    .into_iter()
    .map(|voice| DesktopTTSVoice {
        id: voice.to_string(),
        label: format!("OpenAI {}", voice),
        lang: "multi".to_string(),
    })
    .collect()
}

pub(super) async fn fetch_elevenlabs_voices(
    client: &reqwest::Client,
    api_key: String,
) -> Result<Vec<DesktopTTSVoice>, String> {
    let response = client
        .get("https://api.elevenlabs.io/v1/voices")
        .header("xi-api-key", api_key)
        .send()
        .await
        .map_err(|error| provider_send_error("ElevenLabs voices", "request", error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "ElevenLabs voices request failed with status {}",
            status.as_u16()
        ));
    }
    let value = response
        .json::<Value>()
        .await
        .map_err(|_| "ElevenLabs voices response was invalid".to_string())?;
    Ok(value
        .get("voices")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|voice| {
            let voice_id = voice.get("voice_id").and_then(Value::as_str)?.trim();
            if voice_id.is_empty() {
                return None;
            }
            let name = voice
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(voice_id)
                .trim();
            Some(DesktopTTSVoice {
                id: voice_id.to_string(),
                label: format!("ElevenLabs {}", name),
                lang: "multi".to_string(),
            })
        })
        .collect())
}
pub(super) fn clamp_f64(value: f64, min: f64, max: f64) -> f64 {
    value.min(max).max(min)
}
async fn post_audio(
    client: &reqwest::Client,
    provider_name: &str,
    url: String,
    headers: Vec<(&str, String)>,
    body: Value,
) -> Result<(Vec<u8>, String, Option<String>), String> {
    let mut request = client.post(url).json(&body);
    for (key, value) in headers {
        request = request.header(key, value);
    }
    let response = request
        .send()
        .await
        .map_err(|error| provider_send_error(provider_name, "TTS request", error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "{} TTS request failed with status {}{}",
            provider_name,
            status.as_u16(),
            retry_after_error_suffix(response.headers())
        ));
    }
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
    let bytes = response
        .bytes()
        .await
        .map_err(|_| format!("{} TTS returned unreadable audio", provider_name))?
        .to_vec();
    Ok((bytes, content_type, request_id))
}

pub(super) fn retry_after_error_suffix(headers: &reqwest::header::HeaderMap) -> String {
    retry_after_seconds_at(headers, std::time::SystemTime::now())
        .map(|seconds| format!(" (retry-after-seconds={})", seconds))
        .unwrap_or_default()
}

fn retry_after_seconds_at(
    headers: &reqwest::header::HeaderMap,
    now: std::time::SystemTime,
) -> Option<u64> {
    let value = headers
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)?;
    let seconds = value.parse::<u64>().ok().or_else(|| {
        httpdate::parse_http_date(value)
            .ok()?
            .duration_since(now)
            .ok()
            .map(|duration| duration.as_secs().max(1))
    })?;
    Some(seconds)
        .filter(|seconds| *seconds > 0)
        .map(|seconds| seconds.min(300))
}
pub(super) fn normalize_tts_format(value: Option<&str>) -> &str {
    match value.unwrap_or("mp3").trim() {
        "wav" => "wav",
        "pcm" => "pcm",
        "ogg" | "opus" => "opus",
        "aac" => "aac",
        "flac" => "flac",
        _ => "mp3",
    }
}

pub(super) fn content_type_for_openai_format(format: &str) -> &'static str {
    match format {
        "wav" => "audio/wav",
        "pcm" => "audio/pcm",
        "opus" => "audio/opus",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        _ => "audio/mpeg",
    }
}

fn elevenlabs_output_format(input_format: Option<&str>, option_format: Option<String>) -> String {
    if let Some(format) = option_format.filter(|value| !value.trim().is_empty()) {
        return format;
    }
    match normalize_tts_format(input_format) {
        "pcm" | "wav" => "pcm_24000".to_string(),
        "opus" => "opus_48000_64".to_string(),
        _ => "mp3_44100_128".to_string(),
    }
}

fn content_type_for_elevenlabs_output_format(format: &str) -> &'static str {
    if format.starts_with("pcm_") {
        "audio/pcm"
    } else if format.starts_with("opus_") {
        "audio/ogg"
    } else {
        "audio/mpeg"
    }
}

fn speech_instructions(tone: Option<&str>, emotion: Option<&str>) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(value) = tone.map(str::trim).filter(|value| !value.is_empty()) {
        parts.push(value.to_string());
    }
    if let Some(value) = emotion
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "neutral")
    {
        parts.push(format!("emotion: {}", value));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("; "))
    }
}

fn legacy_openai_tts_model(model_id: &str) -> bool {
    model_id == "tts-1" || model_id == "tts-1-hd"
}

fn openai_tts_body(model_id: &str, request: &TtsBodyRequest<'_>) -> Value {
    let options = request.provider_options;
    let response_format = string_provider_option(options, "responseFormat")
        .or_else(|| string_provider_option(options, "format"))
        .unwrap_or_else(|| normalize_tts_format(request.format).to_string());
    let voice = string_provider_option(options, "voice")
        .or_else(|| {
            request
                .voice_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "alloy".to_string());
    let voice_value = if voice.starts_with("voice_") {
        json!({ "id": voice })
    } else {
        json!(voice)
    };
    let mut body = json!({
        "model": model_id,
        "input": request.text,
        "voice": voice_value,
        "response_format": normalize_tts_format(Some(&response_format)),
    });
    if let Value::Object(ref mut map) = body {
        if let Some(value) = numeric_provider_option(options, "speed").or(request.speed) {
            map.insert("speed".to_string(), json!(clamp_f64(value, 0.25, 4.0)));
        }
        let instructions = string_provider_option(options, "instructions")
            .or_else(|| speech_instructions(request.tone, request.emotion));
        if let Some(value) = instructions.filter(|_| !legacy_openai_tts_model(model_id)) {
            map.insert("instructions".to_string(), json!(value));
        }
    }
    body
}

fn elevenlabs_voice_settings(
    speed: Option<f64>,
    options: &Map<String, Value>,
) -> Map<String, Value> {
    let mut settings = Map::new();
    if let Some(value) = numeric_provider_option(options, "stability") {
        settings.insert("stability".to_string(), json!(clamp_f64(value, 0.0, 1.0)));
    }
    if let Some(value) = numeric_provider_option(options, "similarityBoost")
        .or_else(|| numeric_provider_option(options, "similarity_boost"))
    {
        settings.insert(
            "similarity_boost".to_string(),
            json!(clamp_f64(value, 0.0, 1.0)),
        );
    }
    if let Some(value) = numeric_provider_option(options, "style") {
        settings.insert("style".to_string(), json!(clamp_f64(value, 0.0, 1.0)));
    }
    if let Some(value) = numeric_provider_option(options, "speed").or(speed) {
        settings.insert("speed".to_string(), json!(clamp_f64(value, 0.7, 1.2)));
    }
    if let Some(value) = boolean_provider_option(options, "useSpeakerBoost")
        .or_else(|| boolean_provider_option(options, "use_speaker_boost"))
    {
        settings.insert("use_speaker_boost".to_string(), json!(value));
    }
    settings
}

fn elevenlabs_tts_body(
    model_id: &str,
    text: &str,
    speed: Option<f64>,
    options: &Map<String, Value>,
) -> Value {
    let mut body = json!({
        "text": text,
        "model_id": model_id,
    });
    if let Value::Object(ref mut map) = body {
        let voice_settings = elevenlabs_voice_settings(speed, options);
        if !voice_settings.is_empty() {
            map.insert("voice_settings".to_string(), Value::Object(voice_settings));
        }
        if let Some(value) = string_provider_option(options, "previousText") {
            map.insert("previous_text".to_string(), json!(value));
        }
        if let Some(value) = string_provider_option(options, "nextText") {
            map.insert("next_text".to_string(), json!(value));
        }
    }
    body
}

fn validate_elevenlabs_voice_id(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("ElevenLabs voice id is required".to_string());
    }
    if trimmed.len() > 128 {
        return Err("ElevenLabs voice id is too long".to_string());
    }
    if !trimmed
        .chars()
        .all(|item| item.is_ascii_alphanumeric() || item == '_' || item == '-')
    {
        return Err("ElevenLabs voice id contains unsupported characters".to_string());
    }
    Ok(trimmed.to_string())
}

pub(super) fn desktop_tts_result(
    provider_id: &str,
    model_id: Option<String>,
    bytes: Vec<u8>,
    content_type: String,
    fallback_content_type: &str,
    provider_request_id: Option<String>,
) -> DesktopTTSSynthesisResult {
    DesktopTTSSynthesisResult {
        provider_id: provider_id.to_string(),
        model_id,
        content_type: if content_type.trim().is_empty() {
            fallback_content_type.to_string()
        } else {
            content_type
        },
        byte_size: bytes.len(),
        audio_base64: BASE64_STANDARD.encode(bytes),
        provider_request_id,
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_openai_tts_body_without_secrets() {
        let mut options = Map::new();
        options.insert(
            "responseFormat".to_string(),
            Value::String("mp3".to_string()),
        );
        options.insert(
            "instructions".to_string(),
            Value::String("Read softly.".to_string()),
        );
        let request = TtsBodyRequest {
            text: "Hello.",
            voice_id: Some("voice_custom"),
            speed: Some(1.2),
            emotion: Some("happy"),
            tone: Some("calm"),
            format: Some("mp3"),
            provider_options: &options,
        };
        let body = openai_tts_body("gpt-4o-mini-tts", &request);

        assert_eq!(
            body.get("model").and_then(Value::as_str),
            Some("gpt-4o-mini-tts")
        );
        assert_eq!(body.get("input").and_then(Value::as_str), Some("Hello."));
        assert_eq!(
            body.get("response_format").and_then(Value::as_str),
            Some("mp3")
        );
        assert_eq!(body.get("speed").and_then(Value::as_f64), Some(1.2));
        assert_eq!(
            body.get("instructions").and_then(Value::as_str),
            Some("Read softly.")
        );
        assert_eq!(
            body.get("voice")
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str),
            Some("voice_custom"),
        );
        assert!(!body.to_string().contains("sk-"));
    }

    #[test]
    fn builds_elevenlabs_tts_body_with_clamped_voice_settings() {
        let mut options = Map::new();
        options.insert("stability".to_string(), json!(2.0));
        options.insert("similarityBoost".to_string(), json!("0.8"));
        options.insert("style".to_string(), json!(-1.0));
        options.insert("useSpeakerBoost".to_string(), json!(true));
        let body = elevenlabs_tts_body("eleven_flash_v2_5", "Hello.", Some(1.4), &options);
        let settings = body
            .get("voice_settings")
            .and_then(Value::as_object)
            .expect("voice settings");

        assert_eq!(
            body.get("model_id").and_then(Value::as_str),
            Some("eleven_flash_v2_5")
        );
        assert_eq!(body.get("text").and_then(Value::as_str), Some("Hello."));
        assert_eq!(settings.get("stability").and_then(Value::as_f64), Some(1.0));
        assert_eq!(
            settings.get("similarity_boost").and_then(Value::as_f64),
            Some(0.8)
        );
        assert_eq!(settings.get("style").and_then(Value::as_f64), Some(0.0));
        assert_eq!(settings.get("speed").and_then(Value::as_f64), Some(1.2));
        assert_eq!(
            settings.get("use_speaker_boost").and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn emits_a_bounded_numeric_retry_after_marker() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            "retry-after",
            reqwest::header::HeaderValue::from_static("37"),
        );
        assert_eq!(
            retry_after_error_suffix(&headers),
            " (retry-after-seconds=37)"
        );
        headers.insert(
            "retry-after",
            reqwest::header::HeaderValue::from_static("3600"),
        );
        assert_eq!(
            retry_after_error_suffix(&headers),
            " (retry-after-seconds=300)"
        );
    }

    #[test]
    fn converts_http_date_retry_after_to_a_bounded_delay() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            "retry-after",
            reqwest::header::HeaderValue::from_static("Wed, 21 Oct 2015 07:28:00 GMT"),
        );
        let now = httpdate::parse_http_date("Wed, 21 Oct 2015 07:27:23 GMT").expect("test date");
        assert_eq!(retry_after_seconds_at(&headers, now), Some(37));

        let later = httpdate::parse_http_date("Wed, 21 Oct 2015 08:00:00 GMT").expect("test date");
        assert_eq!(retry_after_seconds_at(&headers, later), None);
    }
}
