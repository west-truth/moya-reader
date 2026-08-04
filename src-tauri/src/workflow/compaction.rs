use super::journal;
use super::state::{PersistedWorkflow, WorkflowJournalEvent};
use crate::native_identity::integrity_hash;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

const COMPACTING_SUFFIX: &str = ".compacting";
const BACKUP_SUFFIX: &str = ".backup";

pub(super) fn recover(journal_path: &Path) -> Result<(), String> {
    let temporary = sidecar_path(journal_path, COMPACTING_SUFFIX)?;
    let backup = sidecar_path(journal_path, BACKUP_SUFFIX)?;
    if journal_path.exists() {
        if backup.exists() && !is_complete_snapshot(journal_path) {
            fs::remove_file(journal_path).map_err(|_| {
                "native workflow incomplete compacted journal could not be removed".to_string()
            })?;
            fs::rename(&backup, journal_path)
                .map_err(|_| "native workflow journal backup could not be recovered".to_string())?;
        }
        remove_if_exists(&temporary)?;
        remove_if_exists(&backup)?;
        return sync_parent(journal_path);
    }

    if backup.exists() {
        if temporary.exists() && is_complete_snapshot(&temporary) {
            fs::rename(&temporary, journal_path).map_err(|_| {
                "native workflow compacted journal could not be recovered".to_string()
            })?;
            remove_if_exists(&backup)?;
        } else {
            remove_if_exists(&temporary)?;
            fs::rename(&backup, journal_path)
                .map_err(|_| "native workflow journal backup could not be recovered".to_string())?;
        }
        sync_parent(journal_path)?;
    } else {
        remove_if_exists(&temporary)?;
        sync_parent(journal_path)?;
    }
    Ok(())
}

pub(super) fn compact(
    journal_path: &Path,
    workflows: &mut BTreeMap<String, PersistedWorkflow>,
) -> Result<(), String> {
    recover(journal_path)?;
    for workflow in workflows.values_mut() {
        workflow.compact_completed_requests();
    }

    let temporary = sidecar_path(journal_path, COMPACTING_SUFFIX)?;
    let backup = sidecar_path(journal_path, BACKUP_SUFFIX)?;
    remove_if_exists(&temporary)?;
    remove_if_exists(&backup)?;
    write_snapshot(&temporary, workflows)?;
    sync_parent(journal_path)?;

    if journal_path.exists() {
        fs::rename(journal_path, &backup).map_err(|_| {
            "native workflow journal could not be prepared for compaction".to_string()
        })?;
    }
    if fs::rename(&temporary, journal_path).is_err() {
        if backup.exists() {
            let _ = fs::rename(&backup, journal_path);
        }
        return Err("native workflow compacted journal could not be installed".to_string());
    }
    sync_parent(journal_path)?;
    remove_if_exists(&backup)?;
    sync_parent(journal_path)
}

fn write_snapshot(
    path: &Path,
    workflows: &BTreeMap<String, PersistedWorkflow>,
) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
        .map_err(|_| "native workflow compacted journal is unavailable".to_string())?;
    for workflow in workflows.values() {
        let event = WorkflowJournalEvent::Submitted {
            workflow: workflow.clone(),
        };
        let encoded = serde_json::to_vec(&event)
            .map_err(|_| "native workflow snapshot could not be serialized".to_string())?;
        file.write_all(&encoded)
            .and_then(|_| file.write_all(b"\n"))
            .map_err(|_| "native workflow snapshot could not be persisted".to_string())?;
    }
    let marker = WorkflowJournalEvent::SnapshotCompleted {
        workflow_count: workflows.len(),
        state_hash: integrity_hash(workflows)?,
    };
    let encoded = serde_json::to_vec(&marker)
        .map_err(|_| "native workflow snapshot marker could not be serialized".to_string())?;
    file.write_all(&encoded)
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|_| "native workflow snapshot marker could not be persisted".to_string())?;
    file.sync_all()
        .map_err(|_| "native workflow snapshot could not be persisted".to_string())
}

fn is_complete_snapshot(path: &Path) -> bool {
    let Ok(file) = File::open(path) else {
        return false;
    };
    let Some(Ok(final_line)) = BufReader::new(file).lines().last() else {
        return false;
    };
    matches!(
        serde_json::from_str::<WorkflowJournalEvent>(&final_line),
        Ok(WorkflowJournalEvent::SnapshotCompleted { .. })
    ) && journal::replay(path).is_ok()
}

fn sidecar_path(path: &Path, suffix: &str) -> Result<PathBuf, String> {
    let mut file_name = path
        .file_name()
        .map(OsString::from)
        .ok_or_else(|| "native workflow journal path is invalid".to_string())?;
    file_name.push(suffix);
    Ok(path.with_file_name(file_name))
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("native workflow compaction sidecar is unavailable".to_string()),
    }
}

#[cfg(unix)]
fn sync_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "native workflow journal path is invalid".to_string())?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "native workflow journal directory could not be synced".to_string())
}

#[cfg(not(unix))]
fn sync_parent(_path: &Path) -> Result<(), String> {
    Ok(())
}
