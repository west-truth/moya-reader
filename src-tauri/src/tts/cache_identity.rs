use super::cache_contract::{
    NativeTTSCacheReadinessRequest, NativeTTSExpectedRender, NativeTTSRenderRequest,
    NativeTTSRenderSegmentAnchor, NativeTTSRenderSpec, MAX_READINESS_RENDERS,
};
use super::command_contract::DesktopTTSSynthesisRequest;
use crate::native_identity::{integrity_hash, persistent_id128, text_integrity_hash};
use crate::provider_http::{clean_provider_options, ensure_non_secret_provider_options};
use serde::Serialize;
use serde_json::{Map, Number, Value};
use std::collections::HashSet;

const MAX_APPLIED_CONTROLS_DEPTH: usize = 6;
const MAX_APPLIED_CONTROLS_NODES: usize = 256;
const MAX_APPLIED_CONTROLS_OBJECT_FIELDS: usize = 32;
const MAX_APPLIED_CONTROLS_ARRAY_ITEMS: usize = 64;
const MAX_APPLIED_CONTROLS_KEY_CHARS: usize = 128;
const MAX_APPLIED_CONTROLS_STRING_CHARS: usize = 2_048;

#[derive(Clone, Debug)]
pub(super) struct ValidatedRenderIdentity {
    pub(super) content_revision: String,
    pub(super) render_spec: NativeTTSRenderSpec,
    pub(super) render_spec_hash: String,
    pub(super) cache_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderSpecIdentity<'a> {
    novel_id: &'a str,
    chapter_id: &'a str,
    content_revision: &'a str,
    chapter_text_hash: &'a str,
    speaker_id: &'a str,
    voice_profile_id: &'a str,
    provider_id: &'a str,
    provider_model: &'a str,
    provider_version: &'a str,
    provider_voice_id: &'a str,
    voice_profile_revision: &'a str,
    segment_anchors: Vec<RenderAnchorIdentity<'a>>,
    input_text_hash: &'a str,
    provider_options_hash: &'a str,
    format: &'a str,
    speed: f64,
    pitch: Option<f64>,
    tone: &'a str,
    emotion: &'a str,
    emotion_policy: &'a str,
    pronunciation_revision_id: &'a str,
    pronunciation_fingerprint: &'a str,
    voice_entry_fingerprint: &'a str,
    applied_controls: Option<&'a Value>,
    alignment_mode: &'a str,
    chunker_version: &'a str,
    synthesis_projection_version: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderAnchorIdentity<'a> {
    segment_id: &'a str,
    paragraph_id: &'a str,
    start_offset: Option<u64>,
    end_offset: Option<u64>,
    segment_text_hash: &'a str,
}

pub(super) fn validate_render_request(
    request: &NativeTTSRenderRequest,
) -> Result<ValidatedRenderIdentity, String> {
    validate_token(&request.operation_id, "native TTS operation id")?;
    request.synthesis.validate()?;
    // This check intentionally precedes all cache identity construction.
    ensure_non_secret_provider_options(&request.synthesis.provider_options)?;
    let identity = validate_expected(
        &request.content_revision,
        &request.render_spec,
        &request.render_spec_hash,
    )?;
    cross_check_synthesis(&identity.render_spec, &request.synthesis)?;
    Ok(identity)
}

pub(super) fn validate_readiness_request(
    request: &NativeTTSCacheReadinessRequest,
) -> Result<Vec<ValidatedRenderIdentity>, String> {
    if request.expected.len() > MAX_READINESS_RENDERS {
        return Err(format!(
            "native TTS readiness is limited to {MAX_READINESS_RENDERS} renders per request"
        ));
    }
    let novel_id = normalized_token(&request.novel_id, "native TTS novel id")?;
    validate_token(&request.content_revision, "native TTS content revision")?;
    let mut hashes = HashSet::with_capacity(request.expected.len());
    request
        .expected
        .iter()
        .map(|expected| {
            let identity = validate_expected_render(&request.content_revision, expected)?;
            if identity.render_spec.novel_id != novel_id {
                return Err("native TTS readiness novel identity drift was rejected".to_string());
            }
            if !hashes.insert(identity.render_spec_hash.clone()) {
                return Err("native TTS readiness contains duplicate render specs".to_string());
            }
            Ok(identity)
        })
        .collect()
}

fn validate_expected_render(
    content_revision: &str,
    expected: &NativeTTSExpectedRender,
) -> Result<ValidatedRenderIdentity, String> {
    validate_expected(
        content_revision,
        &expected.render_spec,
        &expected.render_spec_hash,
    )
}

pub(super) fn validate_cached_identity(
    content_revision: &str,
    render_spec: &NativeTTSRenderSpec,
    render_spec_hash: &str,
) -> Result<ValidatedRenderIdentity, String> {
    validate_expected(content_revision, render_spec, render_spec_hash)
}

fn validate_expected(
    content_revision: &str,
    render_spec: &NativeTTSRenderSpec,
    expected_hash: &str,
) -> Result<ValidatedRenderIdentity, String> {
    let content_revision = normalized_token(content_revision, "native TTS content revision")?;
    let render_spec = normalize_and_validate_spec(render_spec)?;
    if render_spec.content_revision.as_deref() != Some(content_revision.as_str()) {
        return Err("native TTS content revision identity drift was rejected".to_string());
    }
    let render_spec_hash = render_spec_hash(&render_spec)?;
    if !valid_integrity_hash(expected_hash) || expected_hash != render_spec_hash {
        return Err("native TTS render spec hash drift was rejected".to_string());
    }
    let cache_key = persistent_id128("tts", &[&content_revision, &render_spec_hash])?;
    Ok(ValidatedRenderIdentity {
        content_revision,
        render_spec,
        render_spec_hash,
        cache_key,
    })
}

pub(super) fn render_spec_hash(spec: &NativeTTSRenderSpec) -> Result<String, String> {
    let anchors = spec
        .segment_anchors
        .iter()
        .map(|anchor| RenderAnchorIdentity {
            segment_id: &anchor.segment_id,
            paragraph_id: anchor.paragraph_id.as_deref().unwrap_or(""),
            start_offset: anchor.start_offset,
            end_offset: anchor.end_offset,
            segment_text_hash: anchor.segment_text_hash.as_deref().unwrap_or(""),
        })
        .collect();
    integrity_hash(&RenderSpecIdentity {
        novel_id: &spec.novel_id,
        chapter_id: &spec.chapter_id,
        content_revision: spec.content_revision.as_deref().unwrap_or(""),
        chapter_text_hash: spec.chapter_text_hash.as_deref().unwrap_or(""),
        speaker_id: &spec.speaker_id,
        voice_profile_id: &spec.voice_profile_id,
        provider_id: &spec.provider_id,
        provider_model: spec.provider_model.as_deref().unwrap_or(""),
        provider_version: spec.provider_version.as_deref().unwrap_or(""),
        provider_voice_id: spec.provider_voice_id.as_deref().unwrap_or(""),
        voice_profile_revision: spec.voice_profile_revision.as_deref().unwrap_or(""),
        segment_anchors: anchors,
        input_text_hash: &spec.input_text_hash,
        provider_options_hash: &spec.provider_options_hash,
        format: &spec.format,
        speed: spec.speed,
        pitch: spec.pitch,
        tone: spec.tone.as_deref().unwrap_or(""),
        emotion: spec.emotion.as_deref().unwrap_or(""),
        emotion_policy: spec.emotion_policy.as_deref().unwrap_or(""),
        pronunciation_revision_id: spec.pronunciation_revision_id.as_deref().unwrap_or(""),
        pronunciation_fingerprint: spec.pronunciation_fingerprint.as_deref().unwrap_or(""),
        voice_entry_fingerprint: spec.voice_entry_fingerprint.as_deref().unwrap_or(""),
        applied_controls: spec.applied_controls.as_ref(),
        alignment_mode: spec.alignment_mode.as_deref().unwrap_or("exact_segment"),
        chunker_version: spec.chunker_version.as_deref().unwrap_or(""),
        synthesis_projection_version: spec.synthesis_projection_version.as_deref().unwrap_or(""),
    })
}

fn normalize_and_validate_spec(spec: &NativeTTSRenderSpec) -> Result<NativeTTSRenderSpec, String> {
    let mut normalized = spec.clone();
    normalized.novel_id = normalized_token(&spec.novel_id, "native TTS novel id")?;
    normalized.chapter_id = normalized_token(&spec.chapter_id, "native TTS chapter id")?;
    normalized.content_revision = Some(normalized_token(
        spec.content_revision.as_deref().unwrap_or(""),
        "native TTS render spec content revision",
    )?);
    normalized.chapter_text_hash = normalized_option(spec.chapter_text_hash.as_deref())?;
    if let Some(hash) = &normalized.chapter_text_hash {
        normalized_hash(hash, "native TTS chapter text hash")?;
    }
    normalized.speaker_id = normalized_token(&spec.speaker_id, "native TTS speaker id")?;
    normalized.voice_profile_id =
        normalized_token(&spec.voice_profile_id, "native TTS voice profile id")?;
    normalized.provider_id = normalized_token(&spec.provider_id, "native TTS provider id")?;
    let configured_model = normalized_option(spec.provider_model.as_deref())?;
    normalized.provider_model =
        effective_provider_model(&normalized.provider_id, configured_model.as_deref());
    normalized.provider_version = normalized_option(spec.provider_version.as_deref())?;
    normalized.provider_voice_id = normalized_option(spec.provider_voice_id.as_deref())?;
    normalized.voice_profile_revision = Some(normalized_token(
        spec.voice_profile_revision.as_deref().unwrap_or(""),
        "native TTS voice profile revision",
    )?);
    normalized.input_text_hash =
        normalized_hash(&spec.input_text_hash, "native TTS input text hash")?;
    normalized.provider_options_hash = normalized_hash(
        &spec.provider_options_hash,
        "native TTS provider options hash",
    )?;
    normalized.format = normalized_token(&spec.format, "native TTS format")?;
    normalized.tone = normalized_option(spec.tone.as_deref())?;
    normalized.emotion = normalized_option(spec.emotion.as_deref())?;
    normalized.emotion_policy = normalized_option(spec.emotion_policy.as_deref())?;
    normalized.pronunciation_revision_id =
        normalized_option(spec.pronunciation_revision_id.as_deref())?;
    normalized.pronunciation_fingerprint =
        normalized_option(spec.pronunciation_fingerprint.as_deref())?;
    normalized.voice_entry_fingerprint =
        normalized_option(spec.voice_entry_fingerprint.as_deref())?;
    normalized.applied_controls = normalize_applied_controls(spec.applied_controls.as_ref())?;
    normalized.alignment_mode = normalized_option(spec.alignment_mode.as_deref())?;
    if normalized
        .alignment_mode
        .as_deref()
        .is_some_and(|mode| !matches!(mode, "exact_segment" | "provider_marks" | "estimated_chunk"))
    {
        return Err("native TTS alignment mode is invalid".to_string());
    }
    normalized.chunker_version = normalized_option(spec.chunker_version.as_deref())?;
    normalized.synthesis_projection_version =
        normalized_option(spec.synthesis_projection_version.as_deref())?;
    if !spec.speed.is_finite() || spec.speed <= 0.0 || spec.speed > 4.0 {
        return Err("native TTS render speed is invalid".to_string());
    }
    if spec
        .pitch
        .is_some_and(|pitch| !pitch.is_finite() || pitch != 1.0)
    {
        return Err("native TTS does not support non-default pitch".to_string());
    }
    if spec.segment_anchors.is_empty() {
        return Err("native TTS render spec requires segment anchors".to_string());
    }
    normalized.segment_anchors = spec
        .segment_anchors
        .iter()
        .map(normalize_anchor)
        .collect::<Result<_, _>>()?;
    Ok(normalized)
}

fn normalize_applied_controls(value: Option<&Value>) -> Result<Option<Value>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let mut nodes = 0;
    validate_applied_controls_bounds(value, 0, &mut nodes)?;
    ensure_non_secret_provider_options(&Some(value.clone())).map_err(|_| {
        "native TTS applied controls contain secret-like keys or values".to_string()
    })?;
    let body = value
        .as_object()
        .ok_or_else(|| "native TTS applied controls must be an object".to_string())?;
    let speed = applied_control_number(
        body.get("speed"),
        false,
        "native TTS applied controls speed",
    )?
    .ok_or_else(|| "native TTS applied controls speed is required".to_string())?;
    let pitch =
        applied_control_number(body.get("pitch"), true, "native TTS applied controls pitch")?;
    let emotion = applied_control_string(
        body.get("emotion"),
        false,
        "native TTS applied controls emotion",
    )?
    .ok_or_else(|| "native TTS applied controls emotion is required".to_string())?;
    let tone = applied_control_string(body.get("tone"), true, "native TTS applied controls tone")?;
    let provider_instruction = applied_control_string(
        body.get("providerInstruction"),
        true,
        "native TTS applied controls provider instruction",
    )?;
    let hash = applied_control_string(body.get("hash"), false, "native TTS applied controls hash")?
        .ok_or_else(|| "native TTS applied controls hash is required".to_string())?;

    let ignored = match body.get("ignored") {
        None => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                let item = item
                    .as_object()
                    .ok_or_else(|| "native TTS ignored control must be an object".to_string())?;
                let control = applied_control_string(
                    item.get("control"),
                    false,
                    "native TTS ignored control name",
                )?
                .ok_or_else(|| "native TTS ignored control name is required".to_string())?;
                let reason = applied_control_string(
                    item.get("reason"),
                    false,
                    "native TTS ignored control reason",
                )?
                .ok_or_else(|| "native TTS ignored control reason is required".to_string())?;
                Ok(Value::Object(Map::from_iter([
                    ("control".to_string(), Value::String(control)),
                    ("reason".to_string(), Value::String(reason)),
                ])))
            })
            .collect::<Result<Vec<_>, String>>()?,
        Some(_) => return Err("native TTS applied controls ignored must be an array".to_string()),
    };

    let mut normalized = Map::new();
    normalized.insert("speed".to_string(), Value::Number(speed));
    if let Some(pitch) = pitch {
        normalized.insert("pitch".to_string(), Value::Number(pitch));
    }
    normalized.insert("emotion".to_string(), Value::String(emotion));
    if let Some(tone) = tone {
        normalized.insert("tone".to_string(), Value::String(tone));
    }
    if let Some(provider_instruction) = provider_instruction {
        normalized.insert(
            "providerInstruction".to_string(),
            Value::String(provider_instruction),
        );
    }
    normalized.insert("ignored".to_string(), Value::Array(ignored));
    normalized.insert(
        "policyVersion".to_string(),
        Value::String("tts-projection-v2".to_string()),
    );
    normalized.insert("hash".to_string(), Value::String(hash));
    Ok(Some(Value::Object(normalized)))
}

fn validate_applied_controls_bounds(
    value: &Value,
    depth: usize,
    nodes: &mut usize,
) -> Result<(), String> {
    *nodes += 1;
    if *nodes > MAX_APPLIED_CONTROLS_NODES || depth > MAX_APPLIED_CONTROLS_DEPTH {
        return Err("native TTS applied controls exceed structural limits".to_string());
    }
    match value {
        Value::String(text) if text.chars().count() > MAX_APPLIED_CONTROLS_STRING_CHARS => {
            Err("native TTS applied controls string is too long".to_string())
        }
        Value::Array(items) => {
            if items.len() > MAX_APPLIED_CONTROLS_ARRAY_ITEMS {
                return Err("native TTS applied controls array is too large".to_string());
            }
            for item in items {
                validate_applied_controls_bounds(item, depth + 1, nodes)?;
            }
            Ok(())
        }
        Value::Object(items) => {
            if items.len() > MAX_APPLIED_CONTROLS_OBJECT_FIELDS
                || items
                    .keys()
                    .any(|key| key.chars().count() > MAX_APPLIED_CONTROLS_KEY_CHARS)
            {
                return Err("native TTS applied controls object is too large".to_string());
            }
            for item in items.values() {
                validate_applied_controls_bounds(item, depth + 1, nodes)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn applied_control_number(
    value: Option<&Value>,
    optional: bool,
    label: &str,
) -> Result<Option<Number>, String> {
    let Some(value) = value else {
        return if optional {
            Ok(None)
        } else {
            Err(format!("{label} is required"))
        };
    };
    if optional && (value.is_null() || value.as_str().is_some_and(|text| text.is_empty())) {
        return Ok(None);
    }
    let number = match value {
        Value::Number(number) => number
            .as_f64()
            .ok_or_else(|| format!("{label} must be a finite number"))?,
        Value::String(text) => text
            .trim()
            .parse::<f64>()
            .map_err(|_| format!("{label} must be a number"))?,
        _ => return Err(format!("{label} must be a number")),
    };
    if !number.is_finite() {
        return Err(format!("{label} must be a finite number"));
    }
    let number = if number == 0.0 {
        Number::from(0)
    } else if number.fract() == 0.0 && number > 0.0 && number <= u64::MAX as f64 {
        Number::from(number as u64)
    } else if number.fract() == 0.0 && number < 0.0 && number >= i64::MIN as f64 {
        Number::from(number as i64)
    } else {
        Number::from_f64(number).ok_or_else(|| format!("{label} must be a finite number"))?
    };
    Ok(Some(number))
}

fn applied_control_string(
    value: Option<&Value>,
    optional: bool,
    label: &str,
) -> Result<Option<String>, String> {
    let normalized = value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if normalized.is_none() && !optional {
        return Err(format!("{label} must be a non-empty string"));
    }
    Ok(normalized.map(str::to_string))
}

fn normalize_anchor(
    anchor: &NativeTTSRenderSegmentAnchor,
) -> Result<NativeTTSRenderSegmentAnchor, String> {
    let segment_id = normalized_token(&anchor.segment_id, "native TTS segment id")?;
    let paragraph_id = normalized_token(
        anchor.paragraph_id.as_deref().unwrap_or(""),
        "native TTS paragraph id",
    )?;
    let start_offset = anchor
        .start_offset
        .ok_or_else(|| "native TTS segment start offset is required".to_string())?;
    let end_offset = anchor
        .end_offset
        .ok_or_else(|| "native TTS segment end offset is required".to_string())?;
    if end_offset <= start_offset {
        return Err("native TTS segment offsets are invalid".to_string());
    }
    let segment_text_hash = normalized_hash(
        anchor.segment_text_hash.as_deref().unwrap_or(""),
        "native TTS segment text hash",
    )?;
    Ok(NativeTTSRenderSegmentAnchor {
        segment_id,
        paragraph_id: Some(paragraph_id),
        start_offset: Some(start_offset),
        end_offset: Some(end_offset),
        segment_text_hash: Some(segment_text_hash),
    })
}

fn cross_check_synthesis(
    spec: &NativeTTSRenderSpec,
    synthesis: &DesktopTTSSynthesisRequest,
) -> Result<(), String> {
    let options = clean_provider_options(synthesis.provider_options.clone());
    let model_id = effective_provider_model(&spec.provider_id, synthesis.model_id.as_deref());
    let input_text_hash = text_integrity_hash(&synthesis.text);
    let provider_options_hash = integrity_hash(&Value::Object(options))?;
    let checks = [
        (spec.provider_id.as_str(), synthesis.provider_id.trim()),
        (
            spec.provider_model.as_deref().unwrap_or(""),
            model_id.as_deref().unwrap_or(""),
        ),
        (
            spec.provider_voice_id.as_deref().unwrap_or(""),
            synthesis.voice_id.as_deref().map(str::trim).unwrap_or(""),
        ),
        (spec.input_text_hash.as_str(), input_text_hash.as_str()),
        (
            spec.provider_options_hash.as_str(),
            provider_options_hash.as_str(),
        ),
        (
            spec.format.as_str(),
            synthesis.format.as_deref().unwrap_or("mp3"),
        ),
        (
            spec.tone.as_deref().unwrap_or(""),
            synthesis.tone.as_deref().map(str::trim).unwrap_or(""),
        ),
        (
            spec.emotion.as_deref().unwrap_or(""),
            synthesis.emotion.as_deref().map(str::trim).unwrap_or(""),
        ),
    ];
    if checks.iter().any(|(expected, actual)| expected != actual)
        || spec.speed != synthesis.speed.unwrap_or(1.0)
    {
        return Err("native TTS render spec does not match synthesis request".to_string());
    }
    Ok(())
}

pub(super) fn normalize_synthesis_result(
    identity: &ValidatedRenderIdentity,
    mut result: super::command_contract::DesktopTTSSynthesisResult,
) -> Result<super::command_contract::DesktopTTSSynthesisResult, String> {
    let provider_id = result.provider_id.trim();
    let model_id = effective_provider_model(provider_id, result.model_id.as_deref());
    if provider_id != identity.render_spec.provider_id
        || model_id != identity.render_spec.provider_model
    {
        return Err("native TTS provider returned inconsistent model metadata".to_string());
    }
    result.provider_id = identity.render_spec.provider_id.clone();
    result.model_id = identity.render_spec.provider_model.clone();
    Ok(result)
}

fn effective_provider_model(provider_id: &str, configured: Option<&str>) -> Option<String> {
    let configured = configured.map(str::trim).filter(|value| !value.is_empty());
    match provider_id.trim() {
        "openai-tts" => Some(configured.unwrap_or("gpt-4o-mini-tts").to_string()),
        "elevenlabs" => Some(configured.unwrap_or("eleven_flash_v2_5").to_string()),
        "local-endpoint" => configured
            .filter(|value| *value != "endpoint-default")
            .map(str::to_string),
        _ => configured.map(str::to_string),
    }
}

fn normalized_token(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(format!("{label} is invalid"));
    }
    Ok(value.to_string())
}

fn validate_token(value: &str, label: &str) -> Result<(), String> {
    normalized_token(value, label).map(|_| ())
}

fn normalized_option(value: Option<&str>) -> Result<Option<String>, String> {
    let value = value.map(str::trim).filter(|item| !item.is_empty());
    value
        .map(|item| normalized_token(item, "native TTS render identity field"))
        .transpose()
}

fn normalized_hash(value: &str, label: &str) -> Result<String, String> {
    let value = normalized_token(value, label)?;
    if !valid_integrity_hash(&value) {
        return Err(format!("{label} is invalid"));
    }
    Ok(value)
}

fn valid_integrity_hash(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
