use crate::{
    atomic_files::atomic_write, ensure_runtime_dirs, resolve_runtime_paths, task_manifest,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::AppHandle;

const TRANSCRIPT_NOTES_FILE_NAME: &str = "notes.json";
const TRANSCRIPT_NOTES_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct TranscriptNote {
    pub(crate) id: String,
    pub(crate) transcript_segment_id: String,
    pub(crate) source_text: String,
    pub(crate) content: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
struct TranscriptNotesPayload {
    schema_version: u32,
    notes: Vec<TranscriptNote>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct LoadTranscriptNotesRequest {
    #[serde(alias = "taskId")]
    pub(crate) task_id: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SaveTranscriptNotesRequest {
    #[serde(alias = "taskId")]
    pub(crate) task_id: String,
    pub(crate) notes: Vec<TranscriptNote>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub(crate) struct LoadTranscriptNotesResult {
    pub(crate) task_id: String,
    pub(crate) notes: Vec<TranscriptNote>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub(crate) struct SaveTranscriptNotesResult {
    pub(crate) task_id: String,
    pub(crate) notes: Vec<TranscriptNote>,
}

#[tauri::command]
pub(crate) fn load_transcript_notes(
    app: AppHandle,
    request: LoadTranscriptNotesRequest,
) -> Result<LoadTranscriptNotesResult, String> {
    let paths = resolve_runtime_paths(&app)?;
    ensure_runtime_dirs(&paths)?;
    let output_root = task_manifest::configured_output_root(&paths)?;
    load_transcript_notes_from_output_root(&output_root, request)
}

#[tauri::command]
pub(crate) fn save_transcript_notes(
    app: AppHandle,
    request: SaveTranscriptNotesRequest,
) -> Result<SaveTranscriptNotesResult, String> {
    let paths = resolve_runtime_paths(&app)?;
    ensure_runtime_dirs(&paths)?;
    let output_root = task_manifest::configured_output_root(&paths)?;
    save_transcript_notes_to_output_root(&output_root, request)
}

pub(crate) fn load_transcript_notes_from_output_root(
    output_root: &Path,
    request: LoadTranscriptNotesRequest,
) -> Result<LoadTranscriptNotesResult, String> {
    let task = task_manifest::SupportedTask::open(output_root, &request.task_id)?;
    let path = notes_path_for_task(&task);

    if !path.exists() {
        return Ok(LoadTranscriptNotesResult {
            task_id: request.task_id,
            notes: Vec::new(),
        });
    }

    let content =
        fs::read_to_string(&path).map_err(|_| "Failed to read transcript notes.".to_string())?;
    if content.trim().is_empty() {
        return Err("Transcript notes file is empty.".to_string());
    }

    let payload: TranscriptNotesPayload = serde_json::from_str(&content)
        .map_err(|_| "Failed to parse transcript notes.".to_string())?;
    if payload.schema_version != TRANSCRIPT_NOTES_SCHEMA_VERSION {
        return Err("Transcript notes schema version mismatch.".to_string());
    }

    Ok(LoadTranscriptNotesResult {
        task_id: request.task_id,
        notes: payload.notes,
    })
}

pub(crate) fn save_transcript_notes_to_output_root(
    output_root: &Path,
    request: SaveTranscriptNotesRequest,
) -> Result<SaveTranscriptNotesResult, String> {
    let task = task_manifest::SupportedTask::open(output_root, &request.task_id)?;
    let path = notes_path_for_task(&task);
    let payload = TranscriptNotesPayload {
        schema_version: TRANSCRIPT_NOTES_SCHEMA_VERSION,
        notes: request.notes.clone(),
    };
    let json = serde_json::to_string_pretty(&payload)
        .map_err(|_| "Failed to serialize transcript notes.".to_string())?
        + "\n";

    atomic_write(&path, json.as_bytes())
        .map_err(|_| "Failed to write transcript notes.".to_string())?;

    Ok(SaveTranscriptNotesResult {
        task_id: request.task_id,
        notes: request.notes,
    })
}

fn notes_path_for_task(task: &task_manifest::SupportedTask) -> PathBuf {
    task.task_dir()
        .join("transcript")
        .join(TRANSCRIPT_NOTES_FILE_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(test_name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("StudyMind-transcript-notes-{test_name}-{unique}"));
        fs::create_dir_all(&dir).expect("create test dir");
        dir
    }

    fn create_supported_task(output_root: &Path, task_id: &str) {
        let task_dir = output_root.join("tasks").join(task_id);
        fs::create_dir_all(&task_dir).expect("create task dir");
        fs::write(
            task_dir.join("StudyMind-task.json"),
            format!(
                r#"{{"schema_version":4,"task_id":"{task_id}","created_at":"2026-08-08T00:00:00Z","updated_at":"2026-08-08T00:00:00Z","source_kind":"local_file","local_source":{{"display_name":"test.mp3","media_kind":"audio","extension":"mp3"}},"platform":"local","status":"completed","app_version":"app","worker_version":"app","model":"iic/SenseVoiceSmall","text_preview":"hello","insights_count":0,"artifacts":{{}}}}"#,
            ),
        )
        .expect("write task manifest");
    }

    fn notes_path(output_root: &Path, task_id: &str) -> PathBuf {
        output_root
            .join("tasks")
            .join(task_id)
            .join("transcript")
            .join(TRANSCRIPT_NOTES_FILE_NAME)
    }

    #[test]
    fn load_missing_notes_returns_empty() {
        let output_root = temp_dir("load_missing_notes");
        create_supported_task(&output_root, "task-1");
        let result = load_transcript_notes_from_output_root(
            &output_root,
            LoadTranscriptNotesRequest {
                task_id: "task-1".to_string(),
            },
        )
        .expect("load notes");
        assert!(result.notes.is_empty());
    }

    #[test]
    fn save_and_load_notes_roundtrip_preserves_empty_content_and_source_snapshot() {
        let output_root = temp_dir("save_load_notes");
        create_supported_task(&output_root, "task-1");
        let notes = vec![TranscriptNote {
            id: "note-1".to_string(),
            transcript_segment_id: "segment-1".to_string(),
            source_text: "原文字块".to_string(),
            content: String::new(),
            created_at: "2026-08-11T10:00:00+00:00".to_string(),
            updated_at: "2026-08-11T10:00:00+00:00".to_string(),
        }];
        save_transcript_notes_to_output_root(
            &output_root,
            SaveTranscriptNotesRequest {
                task_id: "task-1".to_string(),
                notes: notes.clone(),
            },
        )
        .expect("save notes");
        let loaded = load_transcript_notes_from_output_root(
            &output_root,
            LoadTranscriptNotesRequest {
                task_id: "task-1".to_string(),
            },
        )
        .expect("load notes");
        assert_eq!(loaded.notes, notes);
        assert!(fs::read_to_string(notes_path(&output_root, "task-1"))
            .expect("read notes")
            .ends_with('\n'));
    }

    #[test]
    fn empty_content_and_schema_mismatch_are_rejected() {
        let output_root = temp_dir("invalid_notes");
        create_supported_task(&output_root, "task-1");
        let path = notes_path(&output_root, "task-1");
        fs::create_dir_all(path.parent().expect("notes parent")).expect("create notes dir");
        fs::write(&path, "").expect("write empty notes");
        assert!(load_transcript_notes_from_output_root(
            &output_root,
            LoadTranscriptNotesRequest {
                task_id: "task-1".to_string(),
            },
        )
        .is_err());
        fs::write(&path, r#"{"schema_version":99,"notes":[]}"#).expect("write invalid schema");
        assert!(load_transcript_notes_from_output_root(
            &output_root,
            LoadTranscriptNotesRequest {
                task_id: "task-1".to_string(),
            },
        )
        .is_err());
    }
}
