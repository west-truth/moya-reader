use serde_json::{Map, Value};

const MAX_REVIEW_ITEMS: usize = 100;
const MAX_ARRAY_ITEMS: usize = 100;
const MAX_OBJECT_FIELDS: usize = 64;
const MAX_DEPTH: usize = 6;
const MAX_KEY_CHARS: usize = 128;
const MAX_STRING_CHARS: usize = 2_048;
const MAX_REVIEW_BYTES: usize = 64 * 1_024;

pub(super) fn sanitize_review_items(items: Vec<Value>) -> Result<Vec<Value>, String> {
    if items.len() > MAX_REVIEW_ITEMS {
        return Err("native workflow review item count exceeds the limit".to_string());
    }
    let mut sanitized = Vec::with_capacity(items.len());
    for item in items {
        sanitized.push(sanitize_value(item, 0));
    }
    let bytes = serde_json::to_vec(&sanitized)
        .map_err(|_| "native workflow review items could not be serialized".to_string())?;
    if bytes.len() > MAX_REVIEW_BYTES {
        return Err("native workflow review evidence exceeds the size limit".to_string());
    }
    Ok(sanitized)
}

fn sanitize_value(value: Value, depth: usize) -> Value {
    if depth >= MAX_DEPTH {
        return Value::String("[truncated]".to_string());
    }
    match value {
        Value::String(value) => sanitize_string(value),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .take(MAX_ARRAY_ITEMS)
                .map(|item| sanitize_value(item, depth + 1))
                .collect(),
        ),
        Value::Object(items) => sanitize_object(items, depth),
        value => value,
    }
}

fn sanitize_object(items: Map<String, Value>, depth: usize) -> Value {
    Value::Object(
        items
            .into_iter()
            .filter(|(key, _)| !secret_like_key(key))
            .take(MAX_OBJECT_FIELDS)
            .map(|(key, value)| {
                (
                    truncate_chars(key, MAX_KEY_CHARS),
                    sanitize_value(value, depth + 1),
                )
            })
            .collect(),
    )
}

fn sanitize_string(value: String) -> Value {
    if secret_like_value(&value) {
        Value::String("[redacted]".to_string())
    } else {
        Value::String(truncate_chars(value, MAX_STRING_CHARS))
    }
}

fn truncate_chars(value: String, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value;
    }
    value.chars().take(limit).collect()
}

fn secret_like_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "apikey",
        "api_key",
        "api-key",
        "secret",
        "token",
        "credential",
        "password",
        "authorization",
        "bearer",
        "privatekey",
        "private_key",
        "endpointurl",
        "endpoint_url",
        "endpoint-url",
    ]
    .iter()
    .any(|candidate| key.contains(candidate))
}

fn secret_like_value(value: &str) -> bool {
    let trimmed = value.trim();
    let lowered = trimmed.to_ascii_lowercase();
    trimmed.starts_with("sk-")
        || trimmed.starts_with("AIza")
        || trimmed.starts_with("ya29.")
        || lowered.starts_with("bearer ")
        || trimmed.contains("-----BEGIN ")
        || lowered.contains("\"private_key\"")
        || lowered.contains("\"client_email\"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bounds_and_redacts_review_evidence() {
        let items = sanitize_review_items(vec![json!({
            "id": "review-1",
            "apiKey": "sk-hidden",
            "evidence": {
                "authorization": "Bearer hidden",
                "summary": "x".repeat(MAX_STRING_CHARS + 20),
                "providerBody": "sk-also-hidden"
            }
        })])
        .expect("sanitize evidence");
        let encoded = serde_json::to_string(&items).unwrap();
        assert!(!encoded.contains("apiKey"));
        assert!(!encoded.contains("Bearer hidden"));
        assert!(!encoded.contains("sk-also-hidden"));
        assert!(encoded.contains("[redacted]"));
    }
}
