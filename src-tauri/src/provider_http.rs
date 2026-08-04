use serde_json::{Map, Value};
use std::time::Duration;

pub(crate) const NATIVE_AI_REQUEST_TIMEOUT_SECS: u64 = 120;
pub(crate) const NATIVE_TTS_REQUEST_TIMEOUT_SECS: u64 = 45;
pub(crate) const NATIVE_TTS_VOICE_DISCOVERY_TIMEOUT_SECS: u64 = 20;

pub(crate) fn validate_local_endpoint_url(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value.trim())
        .map_err(|_| "Local TTS endpoint URL is invalid".to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Local TTS endpoint URL must use http or https".to_string());
    }
    if url.host_str().unwrap_or("").trim().is_empty() {
        return Err("Local TTS endpoint URL is missing a host".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Local TTS endpoint URL must not embed credentials".to_string());
    }
    if url.fragment().is_some() {
        return Err("Local TTS endpoint URL must not include a fragment".to_string());
    }
    Ok(url)
}
pub(crate) fn clean_provider_options(value: Option<Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map
            .into_iter()
            .filter(|(_, item)| {
                !matches!(item, Value::Null)
                    && !matches!(item, Value::String(text) if text.is_empty())
            })
            .collect(),
        _ => Map::new(),
    }
}

fn provider_options_contain_secret_like_value(value: &Value) -> bool {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            let lowered = trimmed.to_ascii_lowercase();
            trimmed.starts_with("sk-")
                || trimmed.starts_with("AIza")
                || trimmed.starts_with("ya29.")
                || lowered.starts_with("bearer ")
                || trimmed.contains("-----BEGIN ")
                || lowered.contains("\"private_key\"")
                || lowered.contains("\"client_email\"")
        }
        Value::Array(items) => items.iter().any(provider_options_contain_secret_like_value),
        Value::Object(map) => map.iter().any(|(key, item)| {
            let lowered_key = key.to_ascii_lowercase();
            lowered_key.contains("apikey")
                || lowered_key.contains("api_key")
                || lowered_key.contains("api-key")
                || lowered_key.contains("secret")
                || lowered_key.contains("token")
                || lowered_key.contains("credential")
                || lowered_key.contains("password")
                || lowered_key.contains("authorization")
                || lowered_key.contains("bearer")
                || lowered_key.contains("privatekey")
                || lowered_key.contains("private_key")
                || lowered_key.contains("endpointurl")
                || lowered_key.contains("endpoint_url")
                || lowered_key.contains("endpoint-url")
                || provider_options_contain_secret_like_value(item)
        }),
        _ => false,
    }
}

pub(crate) fn ensure_non_secret_provider_options(value: &Option<Value>) -> Result<(), String> {
    if value
        .as_ref()
        .is_some_and(provider_options_contain_secret_like_value)
    {
        return Err("provider options must not contain secret-like keys or values".to_string());
    }
    Ok(())
}

pub(crate) fn numeric_provider_option(options: &Map<String, Value>, key: &str) -> Option<f64> {
    options.get(key).and_then(|value| match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    })
}

pub(crate) fn string_provider_option(options: &Map<String, Value>, key: &str) -> Option<String> {
    options.get(key).and_then(|value| match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        _ => None,
    })
}

pub(crate) fn boolean_provider_option(options: &Map<String, Value>, key: &str) -> Option<bool> {
    options.get(key).and_then(|value| match value {
        Value::Bool(flag) => Some(*flag),
        Value::String(text) if text == "true" => Some(true),
        Value::String(text) if text == "false" => Some(false),
        _ => None,
    })
}
pub(crate) fn native_provider_http_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|_| "native provider HTTP client is unavailable".to_string())
}

pub(crate) fn provider_send_error(
    provider_name: &str,
    operation: &str,
    error: reqwest::Error,
) -> String {
    if error.is_timeout() {
        format!("{} {} timed out", provider_name, operation)
    } else {
        format!(
            "{} {} failed before receiving a response",
            provider_name, operation
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_native_provider_http_clients_with_timeouts() {
        native_provider_http_client(NATIVE_AI_REQUEST_TIMEOUT_SECS)
            .expect("AI provider timeout client");
        native_provider_http_client(NATIVE_TTS_REQUEST_TIMEOUT_SECS)
            .expect("TTS provider timeout client");
        native_provider_http_client(NATIVE_TTS_VOICE_DISCOVERY_TIMEOUT_SECS)
            .expect("voice discovery timeout client");
    }

    #[test]
    fn rejects_secret_like_tts_provider_options() {
        let options = Some(json!({
            "voice": "alloy",
            "apiKey": "sk-proj-secretvalue"
        }));

        let error = ensure_non_secret_provider_options(&options)
            .expect_err("secret-like provider options should fail");
        assert!(error.contains("secret-like"));
    }
}
