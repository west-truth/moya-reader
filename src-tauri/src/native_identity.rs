use serde::Serialize;
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};

const PERSISTENT_ID_TAG: &[u8] = b"noveldesk:persistent-id:v2";

pub(crate) fn canonical_json<T: Serialize>(value: &T) -> Result<String, String> {
    let value = serde_json::to_value(value)
        .map_err(|_| "native identity input could not be serialized".to_string())?;
    serde_json::to_string(&normalize_json_numbers(value))
        .map_err(|_| "native identity input could not be serialized".to_string())
}

pub(crate) fn integrity_hash<T: Serialize>(value: &T) -> Result<String, String> {
    let canonical = canonical_json(value)?;
    Ok(format!("sha256:{}", hex_digest(canonical.as_bytes())))
}

pub(crate) fn text_integrity_hash(value: &str) -> String {
    format!("sha256:{}", hex_digest(value.as_bytes()))
}

pub(crate) fn bytes_integrity_hash(value: &[u8]) -> String {
    format!("sha256:{}", hex_digest(value))
}

pub(crate) fn persistent_id128(namespace: &str, parts: &[&str]) -> Result<String, String> {
    if !valid_namespace(namespace) || parts.is_empty() {
        return Err("native persistent identity input is invalid".to_string());
    }
    let mut fields = Vec::with_capacity(parts.len() + 2);
    fields.push(PERSISTENT_ID_TAG);
    fields.push(namespace.as_bytes());
    fields.extend(parts.iter().map(|part| part.as_bytes()));

    let mut input = Vec::new();
    push_u32(&mut input, fields.len())?;
    for field in fields {
        push_u32(&mut input, field.len())?;
        input.extend_from_slice(field);
    }
    let digest = Sha256::digest(input);
    Ok(format!("{namespace}_{}", bytes_to_hex(&digest[..16])))
}

fn valid_namespace(namespace: &str) -> bool {
    let mut characters = namespace.chars();
    namespace.len() <= 48
        && characters
            .next()
            .is_some_and(|character| character.is_ascii_lowercase())
        && characters.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
        })
}

fn normalize_json_numbers(value: Value) -> Value {
    match value {
        Value::Array(items) => {
            Value::Array(items.into_iter().map(normalize_json_numbers).collect())
        }
        Value::Object(items) => Value::Object(
            items
                .into_iter()
                .map(|(key, value)| (key, normalize_json_numbers(value)))
                .collect::<Map<_, _>>(),
        ),
        Value::Number(number) => normalize_json_number(number),
        value => value,
    }
}

fn normalize_json_number(number: Number) -> Value {
    let Some(value) = number.as_f64() else {
        return Value::Number(number);
    };
    if value == 0.0 {
        return Value::Number(Number::from(0));
    }
    if value.fract() == 0.0 {
        if value > 0.0 && value <= u64::MAX as f64 {
            return Value::Number(Number::from(value as u64));
        }
        if value < 0.0 && value >= i64::MIN as f64 {
            return Value::Number(Number::from(value as i64));
        }
    }
    Value::Number(number)
}

fn push_u32(target: &mut Vec<u8>, value: usize) -> Result<(), String> {
    let value = u32::try_from(value)
        .map_err(|_| "native persistent identity field is too large".to_string())?;
    target.extend_from_slice(&value.to_be_bytes());
    Ok(())
}

fn hex_digest(value: &[u8]) -> String {
    bytes_to_hex(&Sha256::digest(value))
}

fn bytes_to_hex(value: &[u8]) -> String {
    let mut output = String::with_capacity(value.len() * 2);
    for byte in value {
        use std::fmt::Write;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matches_web_integrity_and_persistent_id_contract_fixtures() {
        assert_eq!(
            integrity_hash(&json!({ "b": 2, "a": 1 })).expect("structured hash"),
            "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
        );
        assert_eq!(
            canonical_json(&json!({ "speed": 1.0, "negativeZero": -0.0 }))
                .expect("canonical numeric JSON"),
            "{\"negativeZero\":0,\"speed\":1}"
        );
        assert_eq!(
            text_integrity_hash("NovelDesk"),
            "sha256:38bfd1a491b16447347734b0516a4585a1c570e421b0081f82cf57dec5548ea0"
        );
        assert_eq!(
            persistent_id128("tts", &["sha256:fixture"]).expect("persistent id"),
            "tts_7ee8e02d912bffec508d5b2e9a6158fa"
        );
    }
}
