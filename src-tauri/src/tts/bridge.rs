use super::command_contract::{
    DesktopTTSSynthesisRequest, DesktopTTSSynthesisResult, DesktopTTSVoiceList,
};
use super::local_endpoint_provider::{fetch_local_endpoint_voices, synthesize_local_endpoint_tts};
use super::provider::{
    fetch_elevenlabs_voices, openai_tts_voices, synthesize_elevenlabs_tts, synthesize_openai_tts,
    TtsBodyRequest,
};
use crate::provider_http::{
    clean_provider_options, ensure_non_secret_provider_options, native_provider_http_client,
    NATIVE_TTS_REQUEST_TIMEOUT_SECS, NATIVE_TTS_VOICE_DISCOVERY_TIMEOUT_SECS,
};
use crate::provider_secrets::load_provider_secret;
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub(crate) async fn desktop_tts_synthesize(
    request: DesktopTTSSynthesisRequest,
) -> Result<DesktopTTSSynthesisResult, String> {
    desktop_tts_synthesize_impl(None, request).await
}

#[cfg(target_os = "android")]
#[tauri::command]
pub(crate) async fn desktop_tts_synthesize(
    app: tauri::AppHandle,
    request: DesktopTTSSynthesisRequest,
) -> Result<DesktopTTSSynthesisResult, String> {
    desktop_tts_synthesize_impl(Some(&app), request).await
}

pub(crate) async fn desktop_tts_synthesize_impl(
    app: Option<&tauri::AppHandle>,
    request: DesktopTTSSynthesisRequest,
) -> Result<DesktopTTSSynthesisResult, String> {
    request.validate()?;
    ensure_non_secret_provider_options(&request.provider_options)?;
    let provider_id = request.provider_id.trim();
    let (provider_id, secret_name) = match provider_id {
        "openai-tts" => ("openai-tts", "api_key"),
        "elevenlabs" => ("elevenlabs", "api_key"),
        "local-endpoint" => ("local-endpoint", "endpoint_url"),
        _ => return Err("데스크톱 로컬 TTS provider는 아직 지원하지 않습니다".to_string()),
    };
    let secret = load_provider_secret(app, "tts_synthesis", provider_id, secret_name).await?;
    desktop_tts_synthesize_with_secret(request, secret).await
}

pub(super) async fn desktop_tts_synthesize_with_secret(
    request: DesktopTTSSynthesisRequest,
    secret: String,
) -> Result<DesktopTTSSynthesisResult, String> {
    request.validate()?;
    ensure_non_secret_provider_options(&request.provider_options)?;
    if secret.trim().is_empty() {
        return Err("provider credential is not configured".to_string());
    }
    let provider_id = request.provider_id.trim();
    let text = request.text.as_str();
    let options = clean_provider_options(request.provider_options);
    let client = native_provider_http_client(NATIVE_TTS_REQUEST_TIMEOUT_SECS)?;
    let body_request = TtsBodyRequest {
        text,
        voice_id: request.voice_id.as_deref(),
        speed: request.speed,
        emotion: request.emotion.as_deref(),
        tone: request.tone.as_deref(),
        format: request.format.as_deref(),
        provider_options: &options,
    };

    if provider_id == "openai-tts" {
        if text.chars().count() > 4000 {
            return Err("OpenAI TTS text exceeds the desktop local limit".to_string());
        }
        let model_id = request
            .model_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("gpt-4o-mini-tts")
            .to_string();
        return synthesize_openai_tts(&client, secret, model_id, &body_request).await;
    }

    if provider_id == "elevenlabs" {
        if text.chars().count() > 5000 {
            return Err("ElevenLabs TTS text exceeds the desktop local limit".to_string());
        }
        let model_id = request
            .model_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("eleven_flash_v2_5")
            .to_string();
        return synthesize_elevenlabs_tts(&client, secret, model_id, &body_request).await;
    }

    if provider_id == "local-endpoint" {
        if text.chars().count() > 20000 {
            return Err("Local TTS endpoint text exceeds the desktop local limit".to_string());
        }
        let model_id = request
            .model_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty() && *value != "endpoint-default")
            .map(str::to_string);
        return synthesize_local_endpoint_tts(&client, &secret, model_id, &body_request).await;
    }

    Err("데스크톱 로컬 TTS provider는 아직 지원하지 않습니다".to_string())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub(crate) async fn desktop_tts_list_voices(
    provider_id: String,
) -> Result<DesktopTTSVoiceList, String> {
    desktop_tts_list_voices_impl(None, provider_id).await
}

#[cfg(target_os = "android")]
#[tauri::command]
pub(crate) async fn desktop_tts_list_voices(
    app: tauri::AppHandle,
    provider_id: String,
) -> Result<DesktopTTSVoiceList, String> {
    desktop_tts_list_voices_impl(Some(&app), provider_id).await
}

async fn desktop_tts_list_voices_impl(
    app: Option<&tauri::AppHandle>,
    provider_id: String,
) -> Result<DesktopTTSVoiceList, String> {
    let provider_id = provider_id.trim();
    if provider_id == "openai-tts" {
        return Ok(DesktopTTSVoiceList {
            voices: openai_tts_voices(),
        });
    }
    if provider_id == "elevenlabs" {
        let api_key = load_provider_secret(app, "tts_synthesis", "elevenlabs", "api_key").await?;
        let client = native_provider_http_client(NATIVE_TTS_VOICE_DISCOVERY_TIMEOUT_SECS)?;
        return Ok(DesktopTTSVoiceList {
            voices: fetch_elevenlabs_voices(&client, api_key).await?,
        });
    }
    if provider_id == "local-endpoint" {
        let endpoint_url =
            load_provider_secret(app, "tts_synthesis", "local-endpoint", "endpoint_url").await?;
        let client = native_provider_http_client(NATIVE_TTS_VOICE_DISCOVERY_TIMEOUT_SECS)?;
        return Ok(DesktopTTSVoiceList {
            voices: fetch_local_endpoint_voices(&client, &endpoint_url).await?,
        });
    }
    Ok(DesktopTTSVoiceList { voices: Vec::new() })
}
