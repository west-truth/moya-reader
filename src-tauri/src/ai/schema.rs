use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

const SINGLE_SCHEMA_KEYS: &[&str] = &[
    "items",
    "contains",
    "not",
    "if",
    "then",
    "else",
    "propertyNames",
];
const SCHEMA_ARRAY_KEYS: &[&str] = &["anyOf", "oneOf", "allOf", "prefixItems"];
const SCHEMA_MAP_KEYS: &[&str] = &[
    "$defs",
    "definitions",
    "patternProperties",
    "dependentSchemas",
];

pub(super) fn standard_json_schema(value: Value) -> Value {
    let Value::Object(source) = value else {
        return value;
    };
    let mut result = Map::new();
    for (key, value) in source {
        let normalized = if key == "type" {
            match value {
                Value::String(type_name) => Value::String(type_name.to_ascii_lowercase()),
                Value::Array(types) => Value::Array(
                    types
                        .into_iter()
                        .map(|item| match item {
                            Value::String(type_name) => {
                                Value::String(type_name.to_ascii_lowercase())
                            }
                            other => other,
                        })
                        .collect(),
                ),
                other => other,
            }
        } else if key == "properties" || SCHEMA_MAP_KEYS.contains(&key.as_str()) {
            match value {
                Value::Object(entries) => Value::Object(
                    entries
                        .into_iter()
                        .map(|(name, schema)| (name, standard_json_schema(schema)))
                        .collect(),
                ),
                other => other,
            }
        } else if SINGLE_SCHEMA_KEYS.contains(&key.as_str()) {
            standard_json_schema(value)
        } else if SCHEMA_ARRAY_KEYS.contains(&key.as_str()) {
            match value {
                Value::Array(items) => {
                    Value::Array(items.into_iter().map(standard_json_schema).collect())
                }
                other => other,
            }
        } else {
            value
        };
        result.insert(key, normalized);
    }

    let is_object = matches!(result.get("type"), Some(Value::String(value)) if value == "object")
        || result.contains_key("properties");
    if is_object {
        result.insert("additionalProperties".to_string(), Value::Bool(false));
    }
    Value::Object(result)
}

pub(super) fn supports_openai_strict_schema(value: &Value) -> bool {
    let Value::Object(schema) = value else {
        return true;
    };
    if let Some(Value::Object(properties)) = schema.get("properties") {
        let required = schema
            .get("required")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<HashSet<_>>()
            })
            .unwrap_or_default();
        if properties
            .keys()
            .any(|key| !required.contains(key.as_str()))
        {
            return false;
        }
        if properties
            .values()
            .any(|property| !supports_openai_strict_schema(property))
        {
            return false;
        }
    }
    for key in SINGLE_SCHEMA_KEYS {
        if schema
            .get(*key)
            .is_some_and(|child| !supports_openai_strict_schema(child))
        {
            return false;
        }
    }
    for key in SCHEMA_ARRAY_KEYS {
        if schema
            .get(*key)
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items
                    .iter()
                    .any(|child| !supports_openai_strict_schema(child))
            })
        {
            return false;
        }
    }
    for key in SCHEMA_MAP_KEYS {
        if schema
            .get(*key)
            .and_then(Value::as_object)
            .is_some_and(|entries| {
                entries
                    .values()
                    .any(|child| !supports_openai_strict_schema(child))
            })
        {
            return false;
        }
    }
    true
}

pub(super) fn schema_hash(value: &Value) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn closes_objects_without_synthesizing_required_fields() {
        let schema = standard_json_schema(json!({
            "type": "OBJECT",
            "properties": {
                "id": { "type": "STRING" },
                "optional": {
                    "type": "OBJECT",
                    "properties": { "note": { "type": "STRING" } }
                },
                "items": {
                    "type": "ARRAY",
                    "items": {
                        "type": "OBJECT",
                        "properties": { "value": { "type": "NUMBER" } },
                        "required": ["value"]
                    }
                }
            },
            "required": ["id"]
        }));

        assert_eq!(schema["required"], json!(["id"]));
        assert!(schema["properties"]["optional"].get("required").is_none());
        assert_eq!(schema["additionalProperties"], json!(false));
        assert_eq!(
            schema["properties"]["optional"]["additionalProperties"],
            json!(false)
        );
        assert_eq!(
            schema["properties"]["items"]["items"]["required"],
            json!(["value"])
        );
    }

    #[test]
    fn preserves_nullable_enum_and_literal_objects() {
        let schema = standard_json_schema(json!({
            "type": "OBJECT",
            "properties": {
                "state": { "type": ["STRING", "NULL"], "enum": ["ready", null] },
                "choice": { "anyOf": [{ "type": "STRING" }, { "type": "NUMBER" }] }
            },
            "default": { "type": "CUSTOM" }
        }));

        assert_eq!(
            schema["properties"]["state"]["type"],
            json!(["string", "null"])
        );
        assert_eq!(
            schema["properties"]["state"]["enum"],
            json!(["ready", null])
        );
        assert_eq!(schema["default"]["type"], json!("CUSTOM"));
    }

    #[test]
    fn detects_optional_properties_before_openai_strict_mode() {
        let optional = standard_json_schema(json!({
            "type": "OBJECT",
            "properties": {
                "id": { "type": "STRING" },
                "note": { "type": "STRING" }
            },
            "required": ["id"]
        }));
        let strict = standard_json_schema(json!({
            "type": "OBJECT",
            "properties": { "id": { "type": "STRING" } },
            "required": ["id"]
        }));

        assert!(!supports_openai_strict_schema(&optional));
        assert!(supports_openai_strict_schema(&strict));
    }
}
