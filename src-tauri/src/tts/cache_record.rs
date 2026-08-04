use super::cache_contract::{
    NativeTTSCacheEvidence, NativeTTSCacheEvidenceRequest, NativeTTSRenderSpec,
};
use super::cache_identity::ValidatedRenderIdentity;
use super::cache_identity::{render_spec_hash, validate_cached_identity};
use super::command_contract::DesktopTTSSynthesisResult;
use crate::native_identity::bytes_integrity_hash;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const CACHE_SCHEMA_VERSION: u32 = 2;
const MAX_CACHE_RECORD_BYTES: u64 = 64 * 1024 * 1024;
const MAX_QUARANTINED_RECORDS: usize = 32;
const STALE_TEMPORARY_AGE_MS: u64 = 60 * 60 * 1_000;
const MAX_TEMPORARY_REMOVALS_PER_ACCESS: usize = 64;
const MAX_CACHE_DIRECTORY_SCAN: usize = 4_096;
const MIN_CACHE_QUOTA_BYTES: u64 = 32 * 1024 * 1024;
const MAX_CACHE_QUOTA_BYTES: u64 = 64 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct NativeTTSCacheRecord {
    schema_version: u32,
    cache_key: String,
    render_spec_hash: String,
    content_revision: String,
    render_spec: NativeTTSRenderSpec,
    content_type: String,
    audio_base64: String,
    byte_size: usize,
    audio_hash: String,
    created_at_ms: u64,
}

impl NativeTTSCacheRecord {
    pub(super) fn from_result(
        identity: &ValidatedRenderIdentity,
        result: &DesktopTTSSynthesisResult,
    ) -> Result<Self, String> {
        let audio = decode_audio(&result.audio_base64)?;
        if audio.is_empty() || audio.len() != result.byte_size {
            return Err("native TTS provider returned inconsistent audio metadata".to_string());
        }
        Ok(Self {
            schema_version: CACHE_SCHEMA_VERSION,
            cache_key: identity.cache_key.clone(),
            render_spec_hash: identity.render_spec_hash.clone(),
            content_revision: identity.content_revision.clone(),
            render_spec: identity.render_spec.clone(),
            content_type: result.content_type.clone(),
            audio_base64: result.audio_base64.clone(),
            byte_size: result.byte_size,
            audio_hash: bytes_integrity_hash(&audio),
            created_at_ms: now_ms(),
        })
    }

    fn validate(&self, expected: &ValidatedRenderIdentity) -> Result<(), String> {
        if self.schema_version != CACHE_SCHEMA_VERSION
            || self.cache_key != expected.cache_key
            || self.render_spec_hash != expected.render_spec_hash
            || self.content_revision != expected.content_revision
            || render_spec_hash(&self.render_spec).ok().as_deref()
                != Some(expected.render_spec_hash.as_str())
            || self.content_type.trim().is_empty()
        {
            return Err("native TTS cache metadata integrity check failed".to_string());
        }
        let audio = decode_audio(&self.audio_base64)?;
        if audio.is_empty()
            || audio.len() != self.byte_size
            || bytes_integrity_hash(&audio) != self.audio_hash
        {
            return Err("native TTS cache audio integrity check failed".to_string());
        }
        Ok(())
    }

    pub(super) fn byte_size(&self) -> usize {
        self.byte_size
    }

    pub(super) fn synthesis_result(&self) -> DesktopTTSSynthesisResult {
        DesktopTTSSynthesisResult {
            provider_id: self.render_spec.provider_id.clone(),
            model_id: self.render_spec.provider_model.clone(),
            content_type: self.content_type.clone(),
            audio_base64: self.audio_base64.clone(),
            byte_size: self.byte_size,
            provider_request_id: None,
        }
    }
}

pub(super) fn read_cache_record(
    cache_dir: &Path,
    identity: &ValidatedRenderIdentity,
) -> Result<Option<NativeTTSCacheRecord>, String> {
    let path = record_path(cache_dir, &identity.cache_key);
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("native TTS cache metadata could not be read".to_string()),
    };
    if !metadata.is_file() || metadata.len() > MAX_CACHE_RECORD_BYTES {
        quarantine_corrupt_cache(cache_dir, &path)?;
        return Ok(None);
    }
    let encoded = fs::read(&path).map_err(|_| "native TTS cache could not be read".to_string())?;
    if let Ok(record) = serde_json::from_slice::<NativeTTSCacheRecord>(&encoded) {
        if record.validate(identity).is_ok() {
            touch_access_record(cache_dir, &identity.cache_key);
            return Ok(Some(record));
        }
    }
    quarantine_corrupt_cache(cache_dir, &path)?;
    Ok(None)
}

pub(super) fn prepare_cache_access(cache_dir: &Path) -> Result<(), String> {
    if !cache_dir.exists() {
        return Ok(());
    }
    cleanup_stale_temporary_files_at(cache_dir, now_ms(), STALE_TEMPORARY_AGE_MS)
}

pub(super) fn persist_cache_record(
    cache_dir: &Path,
    identity: &ValidatedRenderIdentity,
    record: &NativeTTSCacheRecord,
) -> Result<(), String> {
    fs::create_dir_all(cache_dir)
        .map_err(|_| "native TTS cache directory is unavailable".to_string())?;
    let path = record_path(cache_dir, &identity.cache_key);
    if path.exists() {
        return Err("native TTS immutable cache record already exists".to_string());
    }
    let encoded = serde_json::to_vec(record)
        .map_err(|_| "native TTS cache record could not be serialized".to_string())?;
    if encoded.len() as u64 > MAX_CACHE_RECORD_BYTES {
        return Err("native TTS cache record exceeds the local limit".to_string());
    }
    let temporary = temporary_path(&path);
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| "native TTS cache temporary file is unavailable".to_string())?;
    if file
        .write_all(&encoded)
        .and_then(|_| file.sync_all())
        .is_err()
    {
        let _ = fs::remove_file(&temporary);
        return Err("native TTS cache record could not be persisted".to_string());
    }
    drop(file);
    if fs::rename(&temporary, &path).is_err() {
        let _ = fs::remove_file(&temporary);
        return Err("native TTS cache record could not be committed".to_string());
    }
    sync_parent(cache_dir)?;
    touch_access_record(cache_dir, &identity.cache_key);
    Ok(())
}

pub(super) fn record_path(cache_dir: &Path, cache_key: &str) -> PathBuf {
    cache_dir.join(format!("{cache_key}.json"))
}

fn access_path(cache_dir: &Path, cache_key: &str) -> PathBuf {
    cache_dir.join(format!("{cache_key}.access"))
}

fn touch_access_record(cache_dir: &Path, cache_key: &str) {
    let _ = fs::write(access_path(cache_dir, cache_key), now_ms().to_string());
}

struct CacheFile {
    cache_key: String,
    path: PathBuf,
    byte_size: u64,
    last_accessed_ms: u64,
}

pub(super) fn prune_cache_records(
    cache_dir: &Path,
    max_bytes: u64,
    protected_cache_keys: &[String],
) -> Result<super::cache_contract::NativeTTSCachePruneResult, String> {
    use super::cache_contract::NativeTTSCachePruneResult;

    let max_bytes = max_bytes.clamp(MIN_CACHE_QUOTA_BYTES, MAX_CACHE_QUOTA_BYTES);
    if !cache_dir.exists() {
        return Ok(NativeTTSCachePruneResult {
            before_bytes: 0,
            after_bytes: 0,
            removed_bytes: 0,
            removed_items: 0,
            retained_items: 0,
        });
    }
    let protected = protected_cache_keys.iter().cloned().collect::<HashSet<_>>();
    let mut files = Vec::new();
    for entry in fs::read_dir(cache_dir)
        .map_err(|_| "native TTS cache directory could not be inspected".to_string())?
        .take(MAX_CACHE_DIRECTORY_SCAN)
        .flatten()
    {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(cache_key) = name.strip_suffix(".json") else {
            continue;
        };
        if !cache_key.starts_with("tts_") || cache_key.len() != 36 {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let last_accessed_ms = fs::read_to_string(access_path(cache_dir, cache_key))
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .or_else(|| {
                metadata
                    .modified()
                    .ok()?
                    .duration_since(UNIX_EPOCH)
                    .ok()?
                    .as_millis()
                    .try_into()
                    .ok()
            })
            .unwrap_or_default();
        files.push(CacheFile {
            cache_key: cache_key.to_string(),
            path,
            byte_size: metadata.len(),
            last_accessed_ms,
        });
    }
    let before_bytes = files.iter().map(|file| file.byte_size).sum::<u64>();
    let low_water = max_bytes.saturating_mul(9) / 10;
    let target = if before_bytes > max_bytes {
        low_water
    } else {
        max_bytes
    };
    files.sort_by_key(|file| file.last_accessed_ms);
    let mut after_bytes = before_bytes;
    let mut removed_bytes = 0_u64;
    let mut removed_items = 0_usize;
    for file in &files {
        if after_bytes <= target {
            break;
        }
        if protected.contains(&file.cache_key) {
            continue;
        }
        match fs::remove_file(&file.path) {
            Ok(()) => {
                let _ = fs::remove_file(access_path(cache_dir, &file.cache_key));
                after_bytes = after_bytes.saturating_sub(file.byte_size);
                removed_bytes = removed_bytes.saturating_add(file.byte_size);
                removed_items += 1;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("native TTS cache item could not be removed".to_string()),
        }
    }
    if removed_items > 0 {
        sync_parent(cache_dir)?;
    }
    Ok(NativeTTSCachePruneResult {
        before_bytes,
        after_bytes,
        removed_bytes,
        removed_items,
        retained_items: files.len().saturating_sub(removed_items),
    })
}

pub(super) fn cache_evidence(
    cache_dir: &Path,
    request: NativeTTSCacheEvidenceRequest,
) -> Result<Vec<NativeTTSCacheEvidence>, String> {
    if request.render_spec_hashes.len() > super::cache_contract::MAX_READINESS_RENDERS {
        return Err("native TTS cache evidence request is too large".to_string());
    }
    let requested = request
        .render_spec_hashes
        .into_iter()
        .filter(|value| value.starts_with("sha256:") && value.len() == 71)
        .collect::<HashSet<_>>();
    if requested.is_empty() || !cache_dir.exists() {
        return Ok(Vec::new());
    }
    let mut evidence = Vec::new();
    for entry in fs::read_dir(cache_dir)
        .map_err(|_| "native TTS cache directory could not be inspected".to_string())?
        .take(MAX_CACHE_DIRECTORY_SCAN)
        .flatten()
    {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        if metadata.len() > MAX_CACHE_RECORD_BYTES {
            quarantine_corrupt_cache(cache_dir, &path)?;
            continue;
        }
        let Ok(encoded) = fs::read(&path) else {
            continue;
        };
        let Ok(record) = serde_json::from_slice::<NativeTTSCacheRecord>(&encoded) else {
            continue;
        };
        let expected_file_name = format!("{}.json", record.cache_key);
        if !requested.contains(&record.render_spec_hash)
            || path.file_name().and_then(|value| value.to_str())
                != Some(expected_file_name.as_str())
        {
            continue;
        }
        let Ok(identity) = validate_cached_identity(
            &record.content_revision,
            &record.render_spec,
            &record.render_spec_hash,
        ) else {
            quarantine_corrupt_cache(cache_dir, &path)?;
            continue;
        };
        if identity.cache_key != record.cache_key || record.validate(&identity).is_err() {
            quarantine_corrupt_cache(cache_dir, &path)?;
            continue;
        }
        touch_access_record(cache_dir, &record.cache_key);
        evidence.push(NativeTTSCacheEvidence {
            render_spec_hash: record.render_spec_hash,
            cache_key: record.cache_key,
            byte_size: record.byte_size,
        });
    }
    evidence.sort_by(|left, right| left.render_spec_hash.cmp(&right.render_spec_hash));
    Ok(evidence)
}

fn quarantine_corrupt_cache(cache_dir: &Path, path: &Path) -> Result<(), String> {
    let quarantine = cache_dir.join(format!(
        "{}.corrupt-{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("record"),
        now_ms()
    ));
    match fs::rename(path, &quarantine) {
        Ok(()) => {
            prune_quarantine(cache_dir);
            sync_parent(cache_dir)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("native TTS cache corruption could not be quarantined".to_string()),
    }
}

fn prune_quarantine(cache_dir: &Path) {
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return;
    };
    let mut paths = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.contains(".corrupt-"))
        })
        .collect::<Vec<_>>();
    paths.sort();
    let remove_count = paths.len().saturating_sub(MAX_QUARANTINED_RECORDS);
    for path in paths.into_iter().take(remove_count) {
        let _ = fs::remove_file(path);
    }
}

fn temporary_path(path: &Path) -> PathBuf {
    path.with_extension(format!("tmp-{}-{}", std::process::id(), now_ms()))
}

fn cleanup_stale_temporary_files_at(
    cache_dir: &Path,
    current_time_ms: u64,
    minimum_age_ms: u64,
) -> Result<(), String> {
    let entries = fs::read_dir(cache_dir)
        .map_err(|_| "native TTS cache directory could not be inspected".to_string())?;
    let mut removed = 0;
    for entry in entries.take(MAX_CACHE_DIRECTORY_SCAN).flatten() {
        if removed >= MAX_TEMPORARY_REMOVALS_PER_ACCESS {
            break;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() || file_type.is_symlink() {
            continue;
        }
        let Some(created_at_ms) = temporary_file_created_at(&entry.file_name()) else {
            continue;
        };
        if current_time_ms.saturating_sub(created_at_ms) < minimum_age_ms {
            continue;
        }
        match fs::remove_file(entry.path()) {
            Ok(()) => removed += 1,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Err("native TTS stale temporary file could not be removed".to_string())
            }
        }
    }
    if removed > 0 {
        sync_parent(cache_dir)?;
    }
    Ok(())
}

fn temporary_file_created_at(name: &std::ffi::OsStr) -> Option<u64> {
    let name = name.to_str()?;
    let (cache_key, suffix) = name.split_once(".tmp-")?;
    let digest = cache_key.strip_prefix("tts_")?;
    if digest.len() != 32
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return None;
    }
    let (process_id, created_at_ms) = suffix.split_once('-')?;
    if process_id.is_empty()
        || created_at_ms.is_empty()
        || !process_id.bytes().all(|byte| byte.is_ascii_digit())
        || !created_at_ms.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    process_id.parse::<u32>().ok()?;
    created_at_ms.parse::<u64>().ok()
}

fn decode_audio(value: &str) -> Result<Vec<u8>, String> {
    BASE64_STANDARD
        .decode(value)
        .map_err(|_| "native TTS audio payload is invalid".to_string())
}

#[cfg(unix)]
fn sync_parent(path: &Path) -> Result<(), String> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "native TTS cache directory could not be synchronized".to_string())
}

#[cfg(not(unix))]
fn sync_parent(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
pub(super) fn provider_result_for_test(audio_base64: &str) -> DesktopTTSSynthesisResult {
    let byte_size = BASE64_STANDARD
        .decode(audio_base64)
        .map(|audio| audio.len())
        .unwrap_or(0);
    DesktopTTSSynthesisResult {
        provider_id: "openai-tts".to_string(),
        model_id: Some("gpt-4o-mini-tts".to_string()),
        content_type: "audio/mpeg".to_string(),
        audio_base64: audio_base64.to_string(),
        byte_size,
        provider_request_id: Some("must-not-persist".to_string()),
    }
}

#[cfg(test)]
pub(super) fn cleanup_stale_temporary_files_for_test(
    cache_dir: &Path,
    current_time_ms: u64,
    minimum_age_ms: u64,
) -> Result<(), String> {
    cleanup_stale_temporary_files_at(cache_dir, current_time_ms, minimum_age_ms)
}
