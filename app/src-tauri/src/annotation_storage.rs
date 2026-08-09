use crate::{ensure_runtime_dirs, resolve_runtime_paths, task_manifest};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri::AppHandle;

const ANNOTATIONS_FILE_NAME: &str = "annotations.json";
const ANNOTATIONS_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SummaryAnnotation {
    pub(crate) id: String,
    pub(crate) target_tab: String,
    pub(crate) text_anchor: String,
    pub(crate) char_index: usize,
    pub(crate) content: String,
    pub(crate) color: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationsPayload {
    pub(crate) schema_version: u32,
    pub(crate) annotations: Vec<SummaryAnnotation>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct LoadAnnotationsRequest {
    #[serde(alias = "taskId")]
    task_id: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SaveAnnotationsRequest {
    #[serde(alias = "taskId")]
    task_id: String,
    annotations: Vec<SummaryAnnotation>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub(crate) struct LoadAnnotationsResult {
    task_id: String,
    annotations: Vec<SummaryAnnotation>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub(crate) struct SaveAnnotationsResult {
    task_id: String,
    annotations: Vec<SummaryAnnotation>,
}

#[tauri::command]
pub(crate) fn load_annotations(
    app: AppHandle,
    request: LoadAnnotationsRequest,
) -> Result<LoadAnnotationsResult, String> {
    let paths = resolve_runtime_paths(&app)?;
    ensure_runtime_dirs(&paths)?;
    let output_root = task_manifest::configured_output_root(&paths)?;
    load_annotations_from_output_root(&output_root, request)
}

#[tauri::command]
pub(crate) fn save_annotations(
    app: AppHandle,
    request: SaveAnnotationsRequest,
) -> Result<SaveAnnotationsResult, String> {
    let paths = resolve_runtime_paths(&app)?;
    ensure_runtime_dirs(&paths)?;
    let output_root = task_manifest::configured_output_root(&paths)?;
    save_annotations_to_output_root(&output_root, request)
}

pub(crate) fn load_annotations_from_output_root(
    output_root: &Path,
    request: LoadAnnotationsRequest,
) -> Result<LoadAnnotationsResult, String> {
    let task = task_manifest::SupportedTask::open(output_root, &request.task_id)?;
    let annotations_path = annotations_path_for_task(&task);

    if !annotations_path.exists() {
        return Ok(LoadAnnotationsResult {
            task_id: request.task_id,
            annotations: Vec::new(),
        });
    }

    let content = fs::read_to_string(&annotations_path)
        .map_err(|_| "Failed to read annotations.".to_string())?;

    if content.trim().is_empty() {
        return Ok(LoadAnnotationsResult {
            task_id: request.task_id,
            annotations: Vec::new(),
        });
    }

    let payload: AnnotationsPayload = serde_json::from_str(&content)
        .map_err(|_| "Failed to parse annotations.".to_string())?;

    if payload.schema_version != ANNOTATIONS_SCHEMA_VERSION {
        return Err("Annotations schema version mismatch.".to_string());
    }

    Ok(LoadAnnotationsResult {
        task_id: request.task_id,
        annotations: payload.annotations,
    })
}

pub(crate) fn save_annotations_to_output_root(
    output_root: &Path,
    request: SaveAnnotationsRequest,
) -> Result<SaveAnnotationsResult, String> {
    let task = task_manifest::SupportedTask::open(output_root, &request.task_id)?;
    let annotations_path = annotations_path_for_task(&task);

    if let Some(parent) = annotations_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| "Failed to create annotations directory.".to_string())?;
    }

    let payload = AnnotationsPayload {
        schema_version: ANNOTATIONS_SCHEMA_VERSION,
        annotations: request.annotations.clone(),
    };

    let json = serde_json::to_string_pretty(&payload)
        .map_err(|_| "Failed to serialize annotations.".to_string())?;

    fs::write(&annotations_path, json + "\n")
        .map_err(|_| "Failed to write annotations.".to_string())?;

    Ok(SaveAnnotationsResult {
        task_id: request.task_id,
        annotations: request.annotations,
    })
}

fn annotations_path_for_task(task: &task_manifest::SupportedTask) -> std::path::PathBuf {
    task.task_dir().join("ai").join(ANNOTATIONS_FILE_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(test_name: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("StudyMind-annotations-{test_name}-{unique}"));
        fs::create_dir_all(&dir).expect("create test dir");
        dir
    }

    #[test]
    fn load_annotations_returns_empty_when_file_missing() {
        let output_root = temp_dir("load_annotations_empty");
        let task_id = "nonexistent-task";
        let task_dir = output_root.join("tasks").join(task_id);
        fs::create_dir_all(task_dir.join("ai")).unwrap();
        fs::write(
            task_dir.join("StudyMind-task.json"),
            r#"{"schema_version":4,"task_id":"nonexistent-task","created_at":"2026-08-08T00:00:00Z","updated_at":"2026-08-08T00:00:00Z","source_kind":"local_file","local_source":{"display_name":"test.mp3","media_kind":"audio","extension":"mp3"},"platform":"local","status":"completed","app_version":"app","worker_version":"app","model":"iic/SenseVoiceSmall","text_preview":"hello","insights_count":0,"artifacts":{}}"#,
        )
        .unwrap();

        let result = load_annotations_from_output_root(
            &output_root,
            LoadAnnotationsRequest {
                task_id: task_id.to_string(),
            },
        )
        .expect("load annotations");

        assert!(result.annotations.is_empty());
    }

    #[test]
    fn save_and_load_annotations_roundtrip() {
        let output_root = temp_dir("save_load_annotations");
        let task_id = "test-task-123";
        let task_dir = output_root.join("tasks").join(task_id);
        fs::create_dir_all(task_dir.join("ai")).unwrap();
        fs::write(
            task_dir.join("StudyMind-task.json"),
            r#"{"schema_version":4,"task_id":"test-task-123","created_at":"2026-08-08T00:00:00Z","updated_at":"2026-08-08T00:00:00Z","source_kind":"local_file","local_source":{"display_name":"test.mp3","media_kind":"audio","extension":"mp3"},"platform":"local","status":"completed","app_version":"app","worker_version":"app","model":"iic/SenseVoiceSmall","text_preview":"hello","insights_count":0,"artifacts":{}}"#,
        )
        .unwrap();

        let annotations = vec![SummaryAnnotation {
            id: "ann-001".to_string(),
            target_tab: "summary".to_string(),
            text_anchor: "核心概念".to_string(),
            char_index: 42,
            content: "这个概念很重要，需要复习".to_string(),
            color: Some("yellow".to_string()),
            created_at: "2026-08-08T10:00:00Z".to_string(),
            updated_at: "2026-08-08T10:00:00Z".to_string(),
        }];

        save_annotations_to_output_root(
            &output_root,
            SaveAnnotationsRequest {
                task_id: task_id.to_string(),
                annotations: annotations.clone(),
            },
        )
        .expect("save annotations");

        let result = load_annotations_from_output_root(
            &output_root,
            LoadAnnotationsRequest {
                task_id: task_id.to_string(),
            },
        )
        .expect("load annotations");

        assert_eq!(result.annotations.len(), 1);
        assert_eq!(result.annotations[0].id, "ann-001");
        assert_eq!(result.annotations[0].content, "这个概念很重要，需要复习");
        assert_eq!(result.annotations[0].color, Some("yellow".to_string()));
    }
}
