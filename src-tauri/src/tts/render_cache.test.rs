use crate::native_identity::{integrity_hash, text_integrity_hash};
use crate::tts::cache_contract::{
    NativeTTSCacheEvidenceRequest, NativeTTSCacheReadinessRequest, NativeTTSExpectedRender,
    NativeTTSRecoveryPolicy, NativeTTSRenderRequest, NativeTTSRenderSegmentAnchor,
    NativeTTSRenderSpec, MAX_READINESS_RENDERS,
};
use crate::tts::cache_identity::{render_spec_hash, validate_render_request};
use crate::tts::cache_record::{
    cache_evidence, cleanup_stale_temporary_files_for_test, provider_result_for_test,
    prune_cache_records, record_path,
};
use crate::tts::cache_runtime::{cache_readiness_at, render_cached_with, test_runtime};
use crate::tts::command_contract::DesktopTTSSynthesisRequest;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

const TYPESCRIPT_FULL_RENDER_SPEC_FIXTURE: &str = r#"
{
  "novelId": "novel-fixture",
  "chapterId": "chapter-fixture",
  "contentRevision": "content-revision-fixture",
  "chapterTextHash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "speakerId": "speaker-fixture",
  "voiceProfileId": "voice-profile-fixture",
  "providerId": "openai-tts",
  "providerModel": "gpt-4o-mini-tts",
  "providerVersion": "2026-07",
  "providerVoiceId": "alloy",
  "voiceProfileRevision": "voice-revision-fixture",
  "segmentAnchors": [
    {
      "segmentId": "segment-fixture",
      "paragraphId": "paragraph-fixture",
      "startOffset": 3,
      "endOffset": 29,
      "segmentTextHash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
  ],
  "inputTextHash": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "providerOptionsHash": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "format": "mp3",
  "speed": 1.125,
  "pitch": 1,
  "tone": "calm",
  "emotion": "focused",
  "emotionPolicy": "explicit",
  "pronunciationRevisionId": "pronunciation-r7",
  "pronunciationFingerprint": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "voiceEntryFingerprint": "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  "appliedControls": {
    "speed": 1.125,
    "pitch": 1,
    "emotion": "focused",
    "tone": "calm",
    "providerInstruction": "Read with measured clarity.",
    "ignored": [
      {
        "control": "style",
        "reason": "provider does not support style"
      },
      {
        "control": "accent",
        "reason": "voice catalog fixed"
      }
    ],
    "policyVersion": "tts-projection-v2",
    "hash": "sha256:1111111111111111111111111111111111111111111111111111111111111111"
  },
  "alignmentMode": "provider_marks",
  "chunkerVersion": "exact-segment-chunker-v2",
  "synthesisProjectionVersion": "tts-projection-v2"
}
"#;

const TYPESCRIPT_FULL_RENDER_SPEC_HASH: &str =
    "sha256:ac5b5e43937cfbcaa5297ba370a1d42b8dc3b6dba55c26a24abbb929852ed460";

fn temp_dir(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "noveldesk-native-tts-{name}-{}-{}",
        std::process::id(),
        crate::native_identity::persistent_id128(
            "test",
            &[&format!("{:?}", std::time::SystemTime::now())]
        )
        .expect("temporary id")
    ));
    let _ = fs::remove_dir_all(&path);
    path
}

fn request(operation_id: &str) -> NativeTTSRenderRequest {
    let text = "Exact source text must never persist.";
    let options = json!({ "instructions": "Clear diction" });
    let spec = NativeTTSRenderSpec {
        novel_id: "novel-1".to_string(),
        chapter_id: "chapter-1".to_string(),
        content_revision: Some("content-revision-1".to_string()),
        chapter_text_hash: Some(text_integrity_hash(text)),
        speaker_id: "speaker-1".to_string(),
        voice_profile_id: "voice-profile-1".to_string(),
        provider_id: "openai-tts".to_string(),
        provider_model: Some("gpt-4o-mini-tts".to_string()),
        provider_version: Some("2026-07".to_string()),
        provider_voice_id: Some("alloy".to_string()),
        voice_profile_revision: Some("voice-revision-1".to_string()),
        segment_anchors: vec![NativeTTSRenderSegmentAnchor {
            segment_id: "segment-1".to_string(),
            paragraph_id: Some("paragraph-1".to_string()),
            start_offset: Some(0),
            end_offset: Some(text.len() as u64),
            segment_text_hash: Some(text_integrity_hash(text)),
        }],
        input_text_hash: text_integrity_hash(text),
        provider_options_hash: integrity_hash(&options).expect("options hash"),
        format: "mp3".to_string(),
        speed: 1.0,
        pitch: None,
        tone: Some("calm".to_string()),
        emotion: Some("neutral".to_string()),
        emotion_policy: Some("explicit".to_string()),
        pronunciation_revision_id: None,
        pronunciation_fingerprint: None,
        voice_entry_fingerprint: None,
        applied_controls: None,
        alignment_mode: None,
        chunker_version: None,
        synthesis_projection_version: None,
    };
    let render_spec_hash = render_spec_hash(&spec).expect("render spec hash");
    NativeTTSRenderRequest {
        operation_id: operation_id.to_string(),
        content_revision: "content-revision-1".to_string(),
        render_spec: spec,
        render_spec_hash,
        cache_only: false,
        recovery_policy: NativeTTSRecoveryPolicy::default(),
        synthesis: DesktopTTSSynthesisRequest {
            provider_id: "openai-tts".to_string(),
            model_id: Some("gpt-4o-mini-tts".to_string()),
            text: text.to_string(),
            voice_id: Some("alloy".to_string()),
            speed: Some(1.0),
            emotion: Some("neutral".to_string()),
            tone: Some("calm".to_string()),
            format: Some("mp3".to_string()),
            provider_options: Some(options),
        },
    }
}

fn expected(render: &NativeTTSRenderRequest) -> NativeTTSExpectedRender {
    NativeTTSExpectedRender {
        render_spec: render.render_spec.clone(),
        render_spec_hash: render.render_spec_hash.clone(),
    }
}

fn readiness(render: &NativeTTSRenderRequest) -> NativeTTSCacheReadinessRequest {
    NativeTTSCacheReadinessRequest {
        novel_id: render.render_spec.novel_id.clone(),
        content_revision: render.content_revision.clone(),
        expected: vec![expected(render)],
    }
}

#[test]
fn matches_typescript_full_render_spec_fixture_and_detects_new_field_tampering() {
    let fixture: NativeTTSRenderSpec =
        serde_json::from_str(TYPESCRIPT_FULL_RENDER_SPEC_FIXTURE).expect("TypeScript fixture");
    let fixture_hash = render_spec_hash(&fixture).expect("fixture hash");
    assert_eq!(fixture_hash, TYPESCRIPT_FULL_RENDER_SPEC_HASH);

    let mut mutations = Vec::new();
    let mut pronunciation_revision = fixture.clone();
    pronunciation_revision.pronunciation_revision_id = Some("pronunciation-r8".to_string());
    mutations.push(pronunciation_revision);
    let mut pronunciation_fingerprint = fixture.clone();
    pronunciation_fingerprint.pronunciation_fingerprint =
        Some("sha256:2222222222222222222222222222222222222222222222222222222222222222".to_string());
    mutations.push(pronunciation_fingerprint);
    let mut voice_entry = fixture.clone();
    voice_entry.voice_entry_fingerprint =
        Some("sha256:3333333333333333333333333333333333333333333333333333333333333333".to_string());
    mutations.push(voice_entry);
    let mut applied_controls = fixture.clone();
    applied_controls
        .applied_controls
        .as_mut()
        .and_then(Value::as_object_mut)
        .expect("applied controls object")
        .insert("speed".to_string(), json!(1.25));
    mutations.push(applied_controls);
    let mut alignment = fixture.clone();
    alignment.alignment_mode = Some("estimated_chunk".to_string());
    mutations.push(alignment);
    let mut chunker = fixture.clone();
    chunker.chunker_version = Some("exact-segment-chunker-v3".to_string());
    mutations.push(chunker);
    let mut projection = fixture;
    projection.synthesis_projection_version = Some("tts-projection-v3".to_string());
    mutations.push(projection);

    for mutation in mutations {
        assert_ne!(
            render_spec_hash(&mutation).expect("mutated hash"),
            TYPESCRIPT_FULL_RENDER_SPEC_HASH
        );
    }

    let mut stale = request("new-field-hash-drift");
    stale.render_spec.pronunciation_revision_id = Some("pronunciation-r7".to_string());
    stale.render_spec_hash = render_spec_hash(&stale.render_spec).expect("updated baseline hash");
    validate_render_request(&stale).expect("updated baseline request");
    stale.render_spec.pronunciation_revision_id = Some("pronunciation-r8".to_string());
    assert!(validate_render_request(&stale)
        .expect_err("stale hash after pronunciation tamper")
        .contains("hash drift"));
}

#[test]
fn normalizes_new_identity_fields_and_deserializes_legacy_specs_without_them() {
    let mut legacy_value = serde_json::to_value(request("legacy-spec").render_spec)
        .expect("serialize legacy-compatible spec");
    let legacy_body = legacy_value.as_object_mut().expect("render spec object");
    for field in [
        "pronunciationRevisionId",
        "pronunciationFingerprint",
        "voiceEntryFingerprint",
        "appliedControls",
        "alignmentMode",
        "chunkerVersion",
        "synthesisProjectionVersion",
    ] {
        legacy_body.remove(field);
    }
    let legacy: NativeTTSRenderSpec =
        serde_json::from_value(legacy_value).expect("legacy render spec without new fields");
    assert!(legacy.pronunciation_revision_id.is_none());
    assert!(legacy.applied_controls.is_none());
    assert!(legacy.alignment_mode.is_none());

    let mut raw = request("normalized-new-fields");
    raw.render_spec.pronunciation_revision_id = Some(" pronunciation-r7 ".to_string());
    raw.render_spec.pronunciation_fingerprint = Some(" pronunciation-fp ".to_string());
    raw.render_spec.voice_entry_fingerprint = Some(" voice-entry-fp ".to_string());
    raw.render_spec.applied_controls = Some(json!({
        "speed": "1",
        "pitch": "",
        "emotion": " neutral ",
        "tone": " calm ",
        "providerInstruction": " Read clearly. ",
        "ignored": [{ "control": " style ", "reason": " unsupported " }],
        "policyVersion": "caller-value-is-replaced",
        "hash": " controls-hash ",
        "unknownField": "discarded like the TypeScript normalizer"
    }));
    raw.render_spec.alignment_mode = Some(" provider_marks ".to_string());
    raw.render_spec.chunker_version = Some(" exact-segment-chunker-v2 ".to_string());
    raw.render_spec.synthesis_projection_version = Some(" tts-projection-v2 ".to_string());

    let mut normalized = raw.render_spec.clone();
    normalized.pronunciation_revision_id = Some("pronunciation-r7".to_string());
    normalized.pronunciation_fingerprint = Some("pronunciation-fp".to_string());
    normalized.voice_entry_fingerprint = Some("voice-entry-fp".to_string());
    normalized.applied_controls = Some(json!({
        "speed": 1,
        "emotion": "neutral",
        "tone": "calm",
        "providerInstruction": "Read clearly.",
        "ignored": [{ "control": "style", "reason": "unsupported" }],
        "policyVersion": "tts-projection-v2",
        "hash": "controls-hash"
    }));
    normalized.alignment_mode = Some("provider_marks".to_string());
    normalized.chunker_version = Some("exact-segment-chunker-v2".to_string());
    normalized.synthesis_projection_version = Some("tts-projection-v2".to_string());
    raw.render_spec_hash = render_spec_hash(&normalized).expect("normalized expected hash");

    let validated = validate_render_request(&raw).expect("normalized request");
    assert_eq!(
        validated.render_spec.applied_controls,
        normalized.applied_controls
    );
    assert_eq!(validated.render_spec_hash, raw.render_spec_hash);
}

#[test]
fn applied_controls_reject_secrets_and_unbounded_or_invalid_json() {
    let mut secret = request("applied-controls-secret");
    secret.render_spec.applied_controls = Some(json!({
        "speed": 1,
        "emotion": "neutral",
        "ignored": [],
        "hash": "sha256:controls",
        "apiToken": "sk-must-not-enter-cache-identity"
    }));
    secret.render_spec_hash = render_spec_hash(&secret.render_spec).expect("secret raw hash");
    assert!(validate_render_request(&secret)
        .expect_err("secret-like applied controls")
        .contains("secret-like"));

    let mut oversized = request("applied-controls-oversized");
    oversized.render_spec.applied_controls = Some(json!({
        "speed": 1,
        "emotion": "neutral",
        "ignored": [],
        "hash": "sha256:controls",
        "metadata": "x".repeat(2_049)
    }));
    oversized.render_spec_hash =
        render_spec_hash(&oversized.render_spec).expect("oversized raw hash");
    assert!(validate_render_request(&oversized)
        .expect_err("oversized applied controls")
        .contains("too long"));

    let mut invalid = request("applied-controls-invalid");
    invalid.render_spec.applied_controls = Some(json!(["not", "an", "object"]));
    invalid.render_spec_hash = render_spec_hash(&invalid.render_spec).expect("invalid raw hash");
    assert!(validate_render_request(&invalid)
        .expect_err("non-object applied controls")
        .contains("must be an object"));
}

#[test]
fn rejects_hash_identity_and_synthesis_drift() {
    let baseline = request("drift-baseline");
    validate_render_request(&baseline).expect("baseline request");

    let mut hash_drift = baseline.clone();
    hash_drift.render_spec.speed = 1.2;
    assert!(validate_render_request(&hash_drift)
        .expect_err("stale expected hash")
        .contains("hash drift"));

    let mut synthesis_drift = baseline.clone();
    synthesis_drift.synthesis.voice_id = Some("ash".to_string());
    assert!(validate_render_request(&synthesis_drift)
        .expect_err("voice mismatch")
        .contains("does not match"));

    let mut revision_drift = baseline.clone();
    revision_drift.content_revision = "content-revision-2".to_string();
    assert!(validate_render_request(&revision_drift)
        .expect_err("content revision mismatch")
        .contains("content revision identity drift"));

    let mut anchor_drift = baseline.clone();
    anchor_drift.render_spec.segment_anchors[0].paragraph_id = None;
    anchor_drift.render_spec_hash =
        render_spec_hash(&anchor_drift.render_spec).expect("anchor drift hash");
    assert!(validate_render_request(&anchor_drift)
        .expect_err("missing paragraph anchor")
        .contains("paragraph id"));

    let mut pitch = baseline;
    pitch.render_spec.pitch = Some(0.9);
    pitch.render_spec_hash = render_spec_hash(&pitch.render_spec).expect("pitch hash");
    assert!(validate_render_request(&pitch)
        .expect_err("unsupported pitch")
        .contains("non-default pitch"));
}

#[test]
fn rejects_secrets_before_cache_probe_and_persists_no_sensitive_inputs() {
    tauri::async_runtime::block_on(async {
        let directory = temp_dir("sensitive");
        let mut secret = request("secret");
        secret.synthesis.provider_options = Some(json!({ "apiKey": "sk-never-probe" }));
        let error = render_cached_with(&test_runtime(), &directory, secret, |_| async {
            panic!("secret request must not synthesize")
        })
        .await
        .expect_err("secret request");
        assert!(error.contains("secret-like"));
        assert!(!directory.exists());

        let render = request("persist");
        let result = render_cached_with(&test_runtime(), &directory, render, |_| async {
            Ok(provider_result_for_test("AQID"))
        })
        .await
        .expect("render persisted");
        let encoded =
            fs::read_to_string(record_path(&directory, &result.cache_key)).expect("record");
        for forbidden in [
            "Exact source text",
            "Clear diction",
            "providerOptions\"",
            "providerRequestId",
            "sk-never-probe",
        ] {
            assert!(
                !encoded.contains(forbidden),
                "persisted forbidden value: {forbidden}"
            );
        }
        let _ = fs::remove_dir_all(directory);
    });
}

#[test]
fn cache_hit_does_not_synthesize_twice() {
    tauri::async_runtime::block_on(async {
        let directory = temp_dir("hit");
        let runtime = test_runtime();
        let calls = Arc::new(AtomicUsize::new(0));
        for (index, expected_hit) in [false, true].into_iter().enumerate() {
            let calls = calls.clone();
            let result = render_cached_with(
                &runtime,
                &directory,
                request(&format!("hit-{index}")),
                move |_| async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(provider_result_for_test("AQID"))
                },
            )
            .await
            .expect("cached render");
            assert_eq!(result.cache_hit, expected_hit);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let _ = fs::remove_dir_all(directory);
    });
}

#[test]
fn cache_evidence_reports_only_valid_requested_render_hashes() {
    tauri::async_runtime::block_on(async {
        let directory = temp_dir("evidence");
        let render = request("evidence");
        let render_spec_hash = render.render_spec_hash.clone();
        let result = render_cached_with(&test_runtime(), &directory, render, |_| async {
            Ok(provider_result_for_test("AQID"))
        })
        .await
        .expect("cached render");

        let evidence = cache_evidence(
            &directory,
            NativeTTSCacheEvidenceRequest {
                render_spec_hashes: vec![render_spec_hash.clone(), "sha256:missing".to_string()],
            },
        )
        .expect("cache evidence");
        assert_eq!(evidence.len(), 1);
        assert_eq!(evidence[0].render_spec_hash, render_spec_hash);
        assert_eq!(evidence[0].cache_key, result.cache_key);
        assert_eq!(evidence[0].byte_size, 3);
        let _ = fs::remove_dir_all(directory);
    });
}

#[test]
fn cache_evidence_rejects_a_record_with_a_forged_cache_key() {
    tauri::async_runtime::block_on(async {
        let directory = temp_dir("forged-evidence-key");
        let render = request("forged-evidence-key");
        let render_spec_hash = render.render_spec_hash.clone();
        let result = render_cached_with(&test_runtime(), &directory, render, |_| async {
            Ok(provider_result_for_test("AQID"))
        })
        .await
        .expect("cached render");
        let original_path = record_path(&directory, &result.cache_key);
        let mut record: Value = serde_json::from_slice(&fs::read(&original_path).expect("record"))
            .expect("record json");
        let forged_key = "tts_99999999999999999999999999999999";
        record["cacheKey"] = Value::String(forged_key.to_string());
        let forged_path = record_path(&directory, forged_key);
        fs::write(
            &forged_path,
            serde_json::to_vec(&record).expect("encoded record"),
        )
        .expect("forged record");
        fs::remove_file(original_path).expect("remove original record");

        let evidence = cache_evidence(
            &directory,
            NativeTTSCacheEvidenceRequest {
                render_spec_hashes: vec![render_spec_hash],
            },
        )
        .expect("cache evidence");
        assert!(evidence.is_empty());
        assert!(!forged_path.exists());
        let _ = fs::remove_dir_all(directory);
    });
}

#[test]
fn cache_only_miss_never_calls_provider() {
    tauri::async_runtime::block_on(async {
        let directory = temp_dir("cache-only-miss");
        let calls = Arc::new(AtomicUsize::new(0));
        let mut render = request("cache-only-miss");
        render.cache_only = true;
        assert!(!super::should_persist_pending(&render));
        let provider_calls = calls.clone();
        let error = render_cached_with(&test_runtime(), &directory, render, move |_| async move {
            provider_calls.fetch_add(1, Ordering::SeqCst);
            Ok(provider_result_for_test("AQID"))
        })
        .await
        .expect_err("offline-only miss must fail closed");

        assert!(error.contains("cache miss"));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let _ = fs::remove_dir_all(directory);
    });
}

#[test]
fn cache_prune_removes_oldest_unprotected_records_below_low_water() {
    let directory = temp_dir("prune");
    fs::create_dir_all(&directory).expect("cache directory");
    let old_key = "tts_11111111111111111111111111111111";
    let protected_key = "tts_22222222222222222222222222222222";
    let old_path = record_path(&directory, old_key);
    let protected_path = record_path(&directory, protected_key);
    fs::File::create(&old_path)
        .and_then(|file| file.set_len(20 * 1024 * 1024))
        .expect("old sparse record");
    fs::File::create(&protected_path)
        .and_then(|file| file.set_len(20 * 1024 * 1024))
        .expect("protected sparse record");
    fs::write(directory.join(format!("{old_key}.access")), b"1").expect("old access");
    fs::write(directory.join(format!("{protected_key}.access")), b"2").expect("protected access");

    let result = prune_cache_records(&directory, 32 * 1024 * 1024, &[protected_key.to_string()])
        .expect("prune cache");

    assert_eq!(result.removed_items, 1);
    assert!(!old_path.exists());
    assert!(protected_path.exists());
    assert!(result.after_bytes <= 32 * 1024 * 1024);
    let _ = fs::remove_dir_all(directory);
}

#[test]
fn readiness_reconstructs_after_restart_and_quarantines_corruption() {
    tauri::async_runtime::block_on(async {
        let directory = temp_dir("readiness");
        let render = request("readiness-render");
        let result = render_cached_with(&test_runtime(), &directory, render.clone(), |_| async {
            Ok(provider_result_for_test("AQIDBA=="))
        })
        .await
        .expect("render");

        let ready = cache_readiness_at(&directory, readiness(&render)).expect("restart readiness");
        assert!(ready.ok);
        assert_eq!((ready.planned, ready.ready, ready.missing), (1, 1, 0));
        assert_eq!(ready.byte_size, 4);
        assert_eq!(
            ready.ready_render_spec_hashes,
            vec![render.render_spec_hash.clone()]
        );

        fs::write(
            record_path(&directory, &result.cache_key),
            b"{\"corrupt\":true}",
        )
        .expect("corrupt record");
        let missing =
            cache_readiness_at(&directory, readiness(&render)).expect("corrupt readiness");
        assert!(!missing.ok);
        assert_eq!((missing.ready, missing.missing), (0, 1));
        assert_ne!(ready.evidence_hash, missing.evidence_hash);
        assert!(fs::read_dir(&directory)
            .expect("cache directory")
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-")));
        let _ = fs::remove_dir_all(directory);
    });
}

#[test]
fn cancellation_aborts_provider_future_without_commit() {
    tauri::async_runtime::block_on(async {
        let directory = temp_dir("cancel");
        let runtime = Arc::new(test_runtime());
        let task_runtime = runtime.clone();
        let task_directory = directory.clone();
        let task = tauri::async_runtime::spawn(async move {
            render_cached_with(
                &task_runtime,
                &task_directory,
                request("cancel-operation"),
                |_| async { std::future::pending::<Result<_, String>>().await },
            )
            .await
        });
        while !runtime.cancel("cancel-operation").await {
            tokio::task::yield_now().await;
        }
        let error = task
            .await
            .expect("render task")
            .expect_err("cancelled render");
        assert!(error.contains("cancelled"));
        assert!(
            !directory.exists()
                || fs::read_dir(&directory)
                    .expect("cache directory")
                    .next()
                    .is_none()
        );
        let _ = fs::remove_dir_all(directory);
    });
}

#[test]
fn cancellation_before_registration_is_consumed_and_tombstones_are_bounded() {
    tauri::async_runtime::block_on(async {
        let directory = temp_dir("pre-cancel");
        let runtime = test_runtime();
        assert!(runtime.cancel("pre-cancelled-operation").await);
        let calls = Arc::new(AtomicUsize::new(0));
        let synthesis_calls = calls.clone();
        let error = render_cached_with(
            &runtime,
            &directory,
            request("pre-cancelled-operation"),
            move |_| async move {
                synthesis_calls.fetch_add(1, Ordering::SeqCst);
                Ok(provider_result_for_test("AQID"))
            },
        )
        .await
        .expect_err("pre-cancelled render");
        assert!(error.contains("cancelled"));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(!directory.exists());

        for index in 0..300 {
            assert!(runtime.cancel(&format!("pending-{index}")).await);
        }
        assert_eq!(runtime.pending_cancellation_count().await, 256);
    });
}

#[test]
fn effective_provider_models_match_bridge_defaults_and_cache_hits() {
    tauri::async_runtime::block_on(async {
        let directory = temp_dir("models");
        let runtime = test_runtime();
        let mut openai = request("openai-default-miss");
        openai.render_spec.provider_model = None;
        openai.synthesis.model_id = None;
        let mut normalized_openai = openai.render_spec.clone();
        normalized_openai.provider_model = Some("gpt-4o-mini-tts".to_string());
        openai.render_spec_hash = render_spec_hash(&normalized_openai).expect("OpenAI hash");
        let miss = render_cached_with(&runtime, &directory, openai.clone(), |_| async {
            Ok(provider_result_for_test("AQID"))
        })
        .await
        .expect("OpenAI miss");
        assert!(!miss.cache_hit);
        assert_eq!(miss.synthesis.model_id.as_deref(), Some("gpt-4o-mini-tts"));

        openai.operation_id = "openai-default-hit".to_string();
        let hit = render_cached_with(&runtime, &directory, openai, |_| async {
            panic!("cache hit must not synthesize")
        })
        .await
        .expect("OpenAI hit");
        assert!(hit.cache_hit);
        assert_eq!(hit.synthesis.model_id, miss.synthesis.model_id);

        let mut elevenlabs = request("elevenlabs-default");
        elevenlabs.render_spec.provider_id = "elevenlabs".to_string();
        elevenlabs.render_spec.provider_model = None;
        elevenlabs.synthesis.provider_id = "elevenlabs".to_string();
        elevenlabs.synthesis.model_id = None;
        let mut normalized_elevenlabs = elevenlabs.render_spec.clone();
        normalized_elevenlabs.provider_model = Some("eleven_flash_v2_5".to_string());
        elevenlabs.render_spec_hash =
            render_spec_hash(&normalized_elevenlabs).expect("ElevenLabs hash");
        let elevenlabs_identity =
            validate_render_request(&elevenlabs).expect("ElevenLabs default model");
        assert_eq!(
            elevenlabs_identity.render_spec.provider_model.as_deref(),
            Some("eleven_flash_v2_5")
        );

        let mut local = request("local-default");
        local.render_spec.provider_id = "local-endpoint".to_string();
        local.render_spec.provider_model = Some("endpoint-default".to_string());
        local.synthesis.provider_id = "local-endpoint".to_string();
        local.synthesis.model_id = Some("endpoint-default".to_string());
        let mut normalized_local = local.render_spec.clone();
        normalized_local.provider_model = None;
        local.render_spec_hash = render_spec_hash(&normalized_local).expect("local endpoint hash");
        let local_identity = validate_render_request(&local).expect("local default model alias");
        assert_eq!(local_identity.render_spec.provider_model, None);
        let _ = fs::remove_dir_all(directory);
    });
}

#[test]
fn readiness_rejects_oversized_batches_before_identity_work() {
    let render = request("readiness-limit");
    let request = NativeTTSCacheReadinessRequest {
        novel_id: render.render_spec.novel_id.clone(),
        content_revision: render.content_revision.clone(),
        expected: vec![expected(&render); MAX_READINESS_RENDERS + 1],
    };
    let error = cache_readiness_at(&temp_dir("readiness-limit"), request)
        .expect_err("oversized readiness batch");
    assert!(error.contains("limited"));
}

#[test]
fn stale_temporary_cleanup_requires_exact_cache_pattern_and_age() {
    let directory = temp_dir("temporary-cleanup");
    fs::create_dir_all(&directory).expect("cache directory");
    let cache_key = "tts_0123456789abcdef0123456789abcdef";
    let stale = directory.join(format!("{cache_key}.tmp-123-100"));
    let fresh = directory.join(format!("{cache_key}.tmp-123-950"));
    let malformed = directory.join("tts_0123456789abcdef0123456789abcdeg.tmp-123-100");
    let unrelated = directory.join("notes.tmp-123-100");
    fs::write(&stale, b"stale").expect("stale temporary");
    fs::write(&fresh, b"fresh").expect("fresh temporary");
    fs::write(&malformed, b"malformed").expect("malformed temporary");
    fs::write(&unrelated, b"unrelated").expect("unrelated file");

    cleanup_stale_temporary_files_for_test(&directory, 1_000, 100).expect("temporary cleanup");
    assert!(!stale.exists());
    assert!(fresh.exists());
    assert!(malformed.exists());
    assert!(unrelated.exists());
    let _ = fs::remove_dir_all(directory);
}

#[test]
fn identical_concurrent_renders_are_deduplicated_per_key() {
    tauri::async_runtime::block_on(async {
        let directory = temp_dir("concurrent");
        let runtime = Arc::new(test_runtime());
        let calls = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(tokio::sync::Notify::new());
        let mut tasks = Vec::new();
        for index in 0..2 {
            let runtime = runtime.clone();
            let directory = directory.clone();
            let calls = calls.clone();
            let release = release.clone();
            tasks.push(tauri::async_runtime::spawn(async move {
                render_cached_with(
                    &runtime,
                    &directory,
                    request(&format!("concurrent-{index}")),
                    move |_| async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        release.notified().await;
                        Ok(provider_result_for_test("AQID"))
                    },
                )
                .await
            }));
        }
        while calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        release.notify_waiters();
        let first = tasks
            .remove(0)
            .await
            .expect("first task")
            .expect("first render");
        let second = tasks
            .remove(0)
            .await
            .expect("second task")
            .expect("second render");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_ne!(first.cache_hit, second.cache_hit);
        let _ = fs::remove_dir_all(directory);
    });
}
