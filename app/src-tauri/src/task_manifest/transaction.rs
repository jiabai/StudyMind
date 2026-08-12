use crate::atomic_files::{
    atomic_remove_file, atomic_write, install_staged_file, write_synced_new_file,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub(super) const JOURNAL_FILE_NAME: &str = ".StudyMind-artifact-transaction.json";
const SCHEMA_VERSION: u64 = 1;
const MANIFEST_DESTINATION: &str = "StudyMind-task.json";
const MAX_ENTRIES: usize = 8;
const MAX_JOURNAL_BYTES: u64 = 64 * 1024;
const COMMIT_ERROR: &str = "Task artifacts could not be stored safely.";
pub(crate) const ARTIFACT_RECOVERY_ERROR: &str = "Task artifacts could not be recovered safely.";
const ALLOWED_DESTINATIONS: [&str; 10] = [
    "StudyMind-task.json",
    "transcript/transcript.txt",
    "transcript/transcript.md",
    "transcript/segments.json",
    "transcript/original/transcript.txt",
    "transcript/original/transcript.md",
    "ai/summary.md",
    "ai/mindmap.mmd",
    "ai/insights.json",
    "ai/insights.md",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecoveryOutcome {
    None,
    RolledBack,
    CommittedCleaned,
}

#[derive(Debug, Clone)]
pub(crate) struct TaskArtifactMutation {
    pub(crate) destination: String,
    pub(crate) content: Option<Vec<u8>>,
}

impl TaskArtifactMutation {
    pub(crate) fn replace(destination: &str, content: Vec<u8>) -> Self {
        Self {
            destination: destination.to_string(),
            content: Some(content),
        }
    }

    pub(crate) fn manifest(content: Vec<u8>) -> Self {
        Self::replace(MANIFEST_DESTINATION, content)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct TransactionJournal {
    schema_version: u64,
    transaction_id: String,
    state: String,
    entries: Vec<TransactionEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct TransactionEntry {
    destination: String,
    staging: Option<String>,
    rollback: Option<String>,
    existed_before: bool,
}

pub(crate) fn commit_task_artifacts(
    task_dir: &Path,
    mutations: Vec<TaskArtifactMutation>,
) -> Result<(), String> {
    validate_directory_chain(task_dir).map_err(|_| COMMIT_ERROR.to_string())?;
    recover_task_artifacts(task_dir)?;
    let mutations =
        validate_mutations(task_dir, mutations).map_err(|_| COMMIT_ERROR.to_string())?;
    let transaction_id = Uuid::new_v4().simple().to_string();
    let entries = build_entries(task_dir, &transaction_id, &mutations)
        .map_err(|_| COMMIT_ERROR.to_string())?;
    let material_paths = material_paths(task_dir, &entries);

    validate_commit_paths(task_dir, &entries).map_err(|_| COMMIT_ERROR.to_string())?;
    if prepare_materials(task_dir, &entries, &mutations).is_err() {
        cleanup_paths_best_effort(&material_paths);
        return Err(COMMIT_ERROR.to_string());
    }
    if validate_materialized_commit(task_dir, &entries).is_err() {
        cleanup_paths_best_effort(&material_paths);
        return Err(COMMIT_ERROR.to_string());
    }

    let prepared = TransactionJournal {
        schema_version: SCHEMA_VERSION,
        transaction_id,
        state: "prepared".to_string(),
        entries,
    };
    if write_journal(task_dir, &prepared).is_err() {
        cleanup_paths_best_effort(&material_paths);
        return Err(COMMIT_ERROR.to_string());
    }

    let apply_result = (|| {
        for entry in &prepared.entries {
            validate_materialized_entry(task_dir, entry)?;
            let destination = destination_path(task_dir, &entry.destination);
            match &entry.staging {
                Some(staging) => {
                    install_staged_file(&task_dir.join(staging), &destination).map_err(|_| ())?
                }
                None => atomic_remove_file(&destination).map_err(|_| ())?,
            }
        }
        let committed = TransactionJournal {
            state: "committed".to_string(),
            ..prepared.clone()
        };
        write_journal(task_dir, &committed)
    })();

    if apply_result.is_err() {
        if recover_task_artifacts(task_dir).is_err() {
            return Err(ARTIFACT_RECOVERY_ERROR.to_string());
        }
        return Err(COMMIT_ERROR.to_string());
    }

    let _ = remove_journal_then_cleanup(task_dir, &material_paths, false);
    Ok(())
}

pub(crate) fn recover_task_artifacts(task_dir: &Path) -> Result<RecoveryOutcome, String> {
    recover_task_artifacts_inner(task_dir).map_err(|_| ARTIFACT_RECOVERY_ERROR.to_string())
}

fn recover_task_artifacts_inner(task_dir: &Path) -> Result<RecoveryOutcome, ()> {
    validate_directory(task_dir)?;
    let journal_path = task_dir.join(JOURNAL_FILE_NAME);
    if !path_exists(&journal_path)? {
        cleanup_closed_orphans_best_effort(task_dir)?;
        return Ok(RecoveryOutcome::None);
    }
    validate_regular_file(&journal_path)?;
    let metadata = fs::symlink_metadata(&journal_path).map_err(|_| ())?;
    if metadata.len() > MAX_JOURNAL_BYTES {
        return Err(());
    }
    let journal_bytes = fs::read(&journal_path).map_err(|_| ())?;
    let journal: TransactionJournal = serde_json::from_slice(&journal_bytes).map_err(|_| ())?;
    let journal_value: serde_json::Value =
        serde_json::from_slice(&journal_bytes).map_err(|_| ())?;
    validate_closed_shape(&journal_value)?;
    validate_journal(&journal)?;
    validate_recovery_paths(task_dir, &journal)?;
    let material_paths = material_paths(task_dir, &journal.entries);

    let outcome = if journal.state == "prepared" {
        let rollback_payloads = load_all_rollbacks(task_dir, &journal.entries)?;
        for entry in &journal.entries {
            let destination = destination_path(task_dir, &entry.destination);
            if entry.existed_before {
                let payload = rollback_payloads
                    .iter()
                    .find(|(name, _)| name == &entry.destination)
                    .map(|(_, payload)| payload)
                    .ok_or(())?;
                atomic_write(&destination, payload).map_err(|_| ())?;
            } else {
                atomic_remove_file(&destination).map_err(|_| ())?;
            }
        }
        RecoveryOutcome::RolledBack
    } else {
        RecoveryOutcome::CommittedCleaned
    };

    remove_journal_then_cleanup(task_dir, &material_paths, true)?;
    Ok(outcome)
}

fn validate_mutations(
    task_dir: &Path,
    mutations: Vec<TaskArtifactMutation>,
) -> Result<Vec<TaskArtifactMutation>, ()> {
    if mutations.is_empty() || mutations.len() > MAX_ENTRIES {
        return Err(());
    }
    let mut destinations = HashSet::new();
    let mut ordered = Vec::with_capacity(mutations.len());
    let mut manifest = None;
    for mutation in mutations {
        if !allowed_destination(&mutation.destination)
            || !destinations.insert(mutation.destination.clone())
        {
            return Err(());
        }
        ensure_destination_parent(task_dir, &mutation.destination)?;
        validate_optional_regular_file(&destination_path(task_dir, &mutation.destination))?;
        if mutation.destination == MANIFEST_DESTINATION {
            manifest = Some(mutation);
        } else {
            ordered.push(mutation);
        }
    }
    if let Some(manifest) = manifest {
        ordered.push(manifest);
    }
    Ok(ordered)
}

fn build_entries(
    task_dir: &Path,
    transaction_id: &str,
    mutations: &[TaskArtifactMutation],
) -> Result<Vec<TransactionEntry>, ()> {
    mutations
        .iter()
        .enumerate()
        .map(|(index, mutation)| {
            let existed_before = path_exists(&destination_path(task_dir, &mutation.destination))?;
            Ok(TransactionEntry {
                destination: mutation.destination.clone(),
                staging: mutation.content.as_ref().map(|_| {
                    internal_relative_path(&mutation.destination, transaction_id, index, "staging")
                }),
                rollback: existed_before.then(|| {
                    internal_relative_path(&mutation.destination, transaction_id, index, "rollback")
                }),
                existed_before,
            })
        })
        .collect()
}

fn prepare_materials(
    task_dir: &Path,
    entries: &[TransactionEntry],
    mutations: &[TaskArtifactMutation],
) -> Result<(), ()> {
    for (entry, mutation) in entries.iter().zip(mutations) {
        if entry.destination != mutation.destination {
            return Err(());
        }
        if let (Some(staging), Some(content)) = (&entry.staging, &mutation.content) {
            write_synced_new_file(&task_dir.join(staging), content).map_err(|_| ())?;
        }
        if let Some(rollback) = &entry.rollback {
            let destination = destination_path(task_dir, &entry.destination);
            validate_regular_file(&destination)?;
            let previous = fs::read(destination).map_err(|_| ())?;
            write_synced_new_file(&task_dir.join(rollback), &previous).map_err(|_| ())?;
        }
    }
    Ok(())
}

fn validate_journal(journal: &TransactionJournal) -> Result<(), ()> {
    if journal.schema_version != SCHEMA_VERSION
        || !valid_transaction_id(&journal.transaction_id)
        || !matches!(journal.state.as_str(), "prepared" | "committed")
        || journal.entries.is_empty()
        || journal.entries.len() > MAX_ENTRIES
    {
        return Err(());
    }
    let mut destinations = HashSet::new();
    for (index, entry) in journal.entries.iter().enumerate() {
        if !allowed_destination(&entry.destination)
            || !destinations.insert(entry.destination.clone())
        {
            return Err(());
        }
        let expected_staging = internal_relative_path(
            &entry.destination,
            &journal.transaction_id,
            index,
            "staging",
        );
        if entry
            .staging
            .as_ref()
            .is_some_and(|value| value != &expected_staging)
        {
            return Err(());
        }
        let expected_rollback = internal_relative_path(
            &entry.destination,
            &journal.transaction_id,
            index,
            "rollback",
        );
        if (entry.existed_before && entry.rollback.as_deref() != Some(&expected_rollback))
            || (!entry.existed_before && entry.rollback.is_some())
        {
            return Err(());
        }
    }
    if destinations.contains(MANIFEST_DESTINATION)
        && journal
            .entries
            .last()
            .map(|entry| entry.destination.as_str())
            != Some(MANIFEST_DESTINATION)
    {
        return Err(());
    }
    Ok(())
}

fn validate_closed_shape(value: &serde_json::Value) -> Result<(), ()> {
    let journal = value.as_object().ok_or(())?;
    if !has_exact_keys(
        journal,
        &["schema_version", "transaction_id", "state", "entries"],
    ) {
        return Err(());
    }
    let entries = journal
        .get("entries")
        .and_then(serde_json::Value::as_array)
        .ok_or(())?;
    for entry in entries {
        let entry = entry.as_object().ok_or(())?;
        if !has_exact_keys(
            entry,
            &["destination", "staging", "rollback", "existed_before"],
        ) {
            return Err(());
        }
    }
    Ok(())
}

fn has_exact_keys(object: &serde_json::Map<String, serde_json::Value>, expected: &[&str]) -> bool {
    object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
}

fn validate_recovery_paths(task_dir: &Path, journal: &TransactionJournal) -> Result<(), ()> {
    for entry in &journal.entries {
        ensure_destination_parent(task_dir, &entry.destination)?;
        validate_optional_regular_file(&destination_path(task_dir, &entry.destination))?;
        for relative in [&entry.staging, &entry.rollback].into_iter().flatten() {
            validate_optional_regular_file(&task_dir.join(relative))?;
        }
    }
    Ok(())
}

fn load_all_rollbacks(
    task_dir: &Path,
    entries: &[TransactionEntry],
) -> Result<Vec<(String, Vec<u8>)>, ()> {
    entries
        .iter()
        .filter(|entry| entry.existed_before)
        .map(|entry| {
            let rollback = entry.rollback.as_ref().ok_or(())?;
            let path = task_dir.join(rollback);
            validate_regular_file(&path)?;
            Ok((entry.destination.clone(), fs::read(path).map_err(|_| ())?))
        })
        .collect()
}

fn write_journal(task_dir: &Path, journal: &TransactionJournal) -> Result<(), ()> {
    validate_directory_chain(task_dir)?;
    let mut bytes = serde_json::to_vec_pretty(journal).map_err(|_| ())?;
    bytes.push(b'\n');
    atomic_write(&task_dir.join(JOURNAL_FILE_NAME), &bytes).map_err(|_| ())
}

fn remove_journal_then_cleanup(
    task_dir: &Path,
    material_paths: &[PathBuf],
    required: bool,
) -> Result<(), ()> {
    if atomic_remove_file(&task_dir.join(JOURNAL_FILE_NAME)).is_err() {
        return if required { Err(()) } else { Ok(()) };
    }
    cleanup_paths_best_effort(material_paths);
    Ok(())
}

fn cleanup_paths_best_effort(paths: &[PathBuf]) {
    for path in paths {
        let _ = atomic_remove_file(path);
    }
}

fn cleanup_closed_orphans_best_effort(task_dir: &Path) -> Result<(), ()> {
    validate_directory_chain(task_dir)?;
    for relative in ["", "transcript", "transcript/original", "ai"] {
        let directory = if relative.is_empty() {
            task_dir.to_path_buf()
        } else {
            task_dir.join(relative)
        };
        if validate_directory(&directory).is_err() {
            continue;
        }
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if (closed_material_name(name) || closed_journal_staging_name(name))
                && validate_regular_file(&path).is_ok()
            {
                let _ = atomic_remove_file(&path);
            }
        }
    }
    Ok(())
}

fn closed_material_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(".StudyMind-artifact-") else {
        return false;
    };
    let Some((stem, kind)) = rest.rsplit_once('.') else {
        return false;
    };
    if !matches!(kind, "staging" | "rollback") {
        return false;
    }
    let Some((transaction_id, index)) = stem.rsplit_once('-') else {
        return false;
    };
    valid_transaction_id(transaction_id)
        && index
            .parse::<usize>()
            .is_ok_and(|value| value < MAX_ENTRIES)
}

fn closed_journal_staging_name(name: &str) -> bool {
    let Some(id) = name
        .strip_prefix(".StudyMind-artifact-transaction.")
        .and_then(|value| value.strip_suffix(".part.json"))
    else {
        return false;
    };
    valid_transaction_id(id)
}

fn material_paths(task_dir: &Path, entries: &[TransactionEntry]) -> Vec<PathBuf> {
    entries
        .iter()
        .flat_map(|entry| [&entry.staging, &entry.rollback])
        .flatten()
        .map(|relative| task_dir.join(relative))
        .collect()
}

fn ensure_destination_parent(task_dir: &Path, destination: &str) -> Result<(), ()> {
    if !allowed_destination(destination) {
        return Err(());
    }
    let path = destination_path(task_dir, destination);
    let parent = path.parent().ok_or(())?;
    validate_directory_chain(task_dir)?;
    fs::create_dir_all(parent).map_err(|_| ())?;
    validate_destination_parent(task_dir, destination)
}

fn validate_destination_parent(task_dir: &Path, destination: &str) -> Result<(), ()> {
    if !allowed_destination(destination) {
        return Err(());
    }
    validate_directory_chain(task_dir)?;
    let mut current = task_dir.to_path_buf();
    for component in destination
        .split('/')
        .take(destination.matches('/').count())
    {
        current.push(component);
        validate_directory(&current)?;
    }
    Ok(())
}

fn validate_commit_paths(task_dir: &Path, entries: &[TransactionEntry]) -> Result<(), ()> {
    validate_directory_chain(task_dir)?;
    for entry in entries {
        validate_destination_parent(task_dir, &entry.destination)?;
        validate_optional_regular_file(&destination_path(task_dir, &entry.destination))?;
    }
    Ok(())
}

fn validate_materialized_commit(task_dir: &Path, entries: &[TransactionEntry]) -> Result<(), ()> {
    validate_commit_paths(task_dir, entries)?;
    for entry in entries {
        validate_materialized_entry(task_dir, entry)?;
    }
    Ok(())
}

fn validate_materialized_entry(task_dir: &Path, entry: &TransactionEntry) -> Result<(), ()> {
    validate_destination_parent(task_dir, &entry.destination)?;
    validate_optional_regular_file(&destination_path(task_dir, &entry.destination))?;
    if let Some(staging) = &entry.staging {
        validate_regular_file(&task_dir.join(staging))?;
    }
    if let Some(rollback) = &entry.rollback {
        validate_regular_file(&task_dir.join(rollback))?;
    }
    Ok(())
}

fn destination_path(task_dir: &Path, destination: &str) -> PathBuf {
    destination
        .split('/')
        .fold(task_dir.to_path_buf(), |path, component| {
            path.join(component)
        })
}

fn internal_relative_path(
    destination: &str,
    transaction_id: &str,
    index: usize,
    kind: &str,
) -> String {
    let name = format!(".StudyMind-artifact-{transaction_id}-{index}.{kind}");
    destination
        .rsplit_once('/')
        .map(|(parent, _)| format!("{parent}/{name}"))
        .unwrap_or(name)
}

fn allowed_destination(destination: &str) -> bool {
    ALLOWED_DESTINATIONS.contains(&destination)
}

fn valid_transaction_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate_directory(path: &Path) -> Result<(), ()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    if metadata.is_dir() && !super::storage::is_link_or_reparse_point(&metadata) {
        Ok(())
    } else {
        Err(())
    }
}

fn validate_directory_chain(path: &Path) -> Result<(), ()> {
    for ancestor in path.ancestors() {
        if ancestor.as_os_str().is_empty() {
            break;
        }
        validate_directory(ancestor)?;
    }
    Ok(())
}

fn validate_regular_file(path: &Path) -> Result<(), ()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    if metadata.is_file() && !super::storage::is_link_or_reparse_point(&metadata) {
        Ok(())
    } else {
        Err(())
    }
}

fn validate_optional_regular_file(path: &Path) -> Result<(), ()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.is_file() && !super::storage::is_link_or_reparse_point(&metadata) {
                Ok(())
            } else {
                Err(())
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(()),
    }
}

fn path_exists(path: &Path) -> Result<bool, ()> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(()),
    }
}

#[cfg(test)]
pub(super) fn validate_journal_value_for_test(value: serde_json::Value) -> Result<(), String> {
    validate_closed_shape(&value).map_err(|_| ARTIFACT_RECOVERY_ERROR.to_string())?;
    let journal: TransactionJournal =
        serde_json::from_value(value).map_err(|_| ARTIFACT_RECOVERY_ERROR.to_string())?;
    validate_journal(&journal).map_err(|_| ARTIFACT_RECOVERY_ERROR.to_string())
}
