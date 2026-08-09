use crate::{
    append_desktop_log, ensure_runtime_dirs, local_media_contract::TITLE_MAX_LEN,
    resolve_runtime_paths, task_manifest, ProcessSupervisors,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, State};

#[derive(Debug, Serialize, PartialEq, Eq)]
pub(crate) struct TaskRenameResult {
    pub(crate) task_id: String,
    pub(crate) title: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TaskRenameError {
    Busy,
    Unavailable,
    InvalidTitle,
    SaveFailed,
}

impl TaskRenameError {
    pub(crate) fn public_code(self) -> &'static str {
        match self {
            Self::Busy => "TASK_RENAME_BUSY",
            Self::Unavailable => "TASK_RENAME_UNAVAILABLE",
            Self::InvalidTitle => "TASK_RENAME_INVALID_TITLE",
            Self::SaveFailed => "TASK_RENAME_FAILED",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TaskRenameRequest {
    #[serde(alias = "taskId")]
    pub(crate) task_id: String,
    #[serde(alias = "title")]
    pub(crate) title: Option<String>,
}

fn normalize_title(raw: &Option<String>) -> Result<Option<String>, TaskRenameError> {
    match raw {
        None => Ok(None),
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            if trimmed.chars().count() > TITLE_MAX_LEN {
                return Err(TaskRenameError::InvalidTitle);
            }
            if trimmed.chars().any(|ch| ch.is_control()) {
                return Err(TaskRenameError::InvalidTitle);
            }
            Ok(Some(trimmed.to_string()))
        }
    }
}

pub(crate) fn rename_task_title_from_root(
    output_root: &std::path::Path,
    task_id: &str,
    title: Option<String>,
) -> Result<TaskRenameResult, TaskRenameError> {
    let task = task_manifest::SupportedTask::open(output_root, task_id)
        .map_err(|_| TaskRenameError::Unavailable)?;
    let resolved_task_id = task.task_id().to_string();
    let mut session = task.into_edit_session();
    session.set_title(title.clone());
    session.save().map_err(|_| TaskRenameError::SaveFailed)?;
    Ok(TaskRenameResult {
        task_id: resolved_task_id,
        title,
    })
}

#[tauri::command]
pub(crate) fn rename_task_title(
    app: AppHandle,
    process_supervisors: State<'_, Arc<ProcessSupervisors>>,
    request: TaskRenameRequest,
) -> Result<TaskRenameResult, String> {
    let started = Instant::now();
    let result = (|| {
        let normalized = normalize_title(&request.title)?;
        if process_supervisors.is_task_active() {
            return Err(TaskRenameError::Busy);
        }
        let paths = resolve_runtime_paths(&app).map_err(|_| TaskRenameError::SaveFailed)?;
        ensure_runtime_dirs(&paths).map_err(|_| TaskRenameError::SaveFailed)?;
        let output_root = task_manifest::configured_output_root(&paths)
            .map_err(|_| TaskRenameError::SaveFailed)?;
        rename_task_title_from_root(&output_root, &request.task_id, normalized)
    })();
    if let Ok(paths) = resolve_runtime_paths(&app) {
        let outcome = match &result {
            Ok(_) => "completed",
            Err(error) => error.public_code(),
        };
        let _ = append_desktop_log(
            &paths,
            "task.rename",
            &format!(
                "outcome={outcome} elapsed_ms={}",
                started.elapsed().as_millis()
            ),
        );
    }
    result.map_err(|error| error.public_code().to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_title, rename_task_title_from_root, TaskRenameError, TaskRenameRequest,
        TaskRenameResult,
    };
    use crate::task_manifest;
    use serde_json;
    use std::fs;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn write_supported_task(output_root: &Path, task_id: &str) {
        let task_dir = output_root.join("tasks").join(task_id);
        fs::create_dir_all(task_dir.join("transcript")).expect("create transcript dir");
        fs::write(
            task_dir.join("transcript/transcript.txt"),
            "transcript",
        )
        .expect("write transcript");
        fs::write(
            task_dir.join("StudyMind-task.json"),
            format!(
                r#"{{
  "schema_version": 4,
  "task_id": "{task_id}",
  "created_at": "2026-07-12T12:00:00Z",
  "local_source": {{
    "display_name": "Lecture.wmv",
    "media_kind": "video",
    "extension": "wmv"
  }},
  "platform": "local",
  "status": "completed",
  "artifacts": {{"transcript_txt": "transcript/transcript.txt"}},
  "error": null,
  "text_preview": "transcript",
  "insights_count": 0
}}"#
            ),
        )
        .expect("write manifest");
    }

    fn read_title(output_root: &Path, task_id: &str) -> Option<String> {
        let manifest_path = output_root
            .join("tasks")
            .join(task_id)
            .join("StudyMind-task.json");
        let content = fs::read_to_string(&manifest_path).expect("read manifest");
        let value: serde_json::Value = serde_json::from_str(&content).expect("parse manifest");
        value
            .get("title")
            .and_then(|v| v.as_str())
            .map(str::to_string)
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("StudyMind-{name}-{unique}"));
        fs::create_dir_all(&dir).expect("create temp root");
        dir
    }

    #[test]
    fn sets_title_on_supported_task_and_persists() {
        let output_root = temp_dir("rename-set-title");
        let task_id = "20260712-120000-local-abcdef123456";
        write_supported_task(&output_root, task_id);

        let result = rename_task_title_from_root(
            &output_root,
            task_id,
            Some("离散数学·第3讲".to_string()),
        )
        .expect("rename task");

        assert_eq!(
            result,
            TaskRenameResult {
                task_id: task_id.to_string(),
                title: Some("离散数学·第3讲".to_string()),
            }
        );
        assert_eq!(
            read_title(&output_root, task_id),
            Some("离散数学·第3讲".to_string())
        );
    }

    #[test]
    fn clearing_title_persists_none_and_omits_field() {
        let output_root = temp_dir("rename-clear-title");
        let task_id = "20260712-120000-local-abcdef123456";
        write_supported_task(&output_root, task_id);
        rename_task_title_from_root(&output_root, task_id, Some("title".to_string()))
            .expect("set title first");

        let result =
            rename_task_title_from_root(&output_root, task_id, None).expect("clear title");

        assert_eq!(
            result,
            TaskRenameResult {
                task_id: task_id.to_string(),
                title: None,
            }
        );
        assert_eq!(read_title(&output_root, task_id), None);
    }

    #[test]
    fn rejects_unsupported_task_id() {
        let output_root = temp_dir("rename-unsupported");
        let task_id = "20260712-120000-local-abcdef123456";
        write_supported_task(&output_root, task_id);

        assert_eq!(
            rename_task_title_from_root(&output_root, "missing-task", Some("x".to_string())),
            Err(TaskRenameError::Unavailable)
        );
    }

    #[test]
    fn normalize_title_trims_and_treats_blank_as_none() {
        assert_eq!(normalize_title(&None), Ok(None));
        assert_eq!(normalize_title(&Some("   ".to_string())), Ok(None));
        assert_eq!(
            normalize_title(&Some("  离散数学  ".to_string())),
            Ok(Some("离散数学".to_string()))
        );
    }

    #[test]
    fn normalize_title_rejects_oversized_and_control_chars() {
        let long = "a".repeat(81);
        assert_eq!(
            normalize_title(&Some(long)),
            Err(TaskRenameError::InvalidTitle)
        );
        assert_eq!(
            normalize_title(&Some("a\u{0000}b".to_string())),
            Err(TaskRenameError::InvalidTitle)
        );
        let exact = "a".repeat(80);
        assert_eq!(normalize_title(&Some(exact.clone())), Ok(Some(exact)));
    }

    #[test]
    fn rename_request_rejects_unknown_fields() {
        let valid = serde_json::from_value::<TaskRenameRequest>(serde_json::json!({
            "task_id": "task-safe-1",
            "title": "safe title"
        }))
        .expect("valid rename request");
        assert_eq!(valid.task_id, "task-safe-1");
        assert_eq!(valid.title.as_deref(), Some("safe title"));

        let mut payload = serde_json::Map::from_iter([
            ("task_id".to_string(), serde_json::Value::String("t".to_string())),
            ("output_dir".to_string(), serde_json::Value::String("secret".to_string())),
        ]);
        serde_json::from_value::<TaskRenameRequest>(serde_json::Value::Object(payload))
            .expect_err("unknown field must fail");

        payload = serde_json::Map::from_iter([
            ("task_id".to_string(), serde_json::Value::String("t".to_string())),
            ("title".to_string(), serde_json::Value::String("ok".to_string())),
        ]);
        let req = serde_json::from_value::<TaskRenameRequest>(serde_json::Value::Object(payload))
            .expect("title optional and accepted");
        assert_eq!(req.title.as_deref(), Some("ok"));
    }

    #[test]
    fn title_field_is_optional_for_legacy_manifests() {
        let output_root = temp_dir("rename-legacy-optional");
        let task_id = "20260712-120000-local-abcdef123456";
        write_supported_task(&output_root, task_id);

        let task = task_manifest::SupportedTask::open(&output_root, task_id)
            .expect("open legacy task without title");
        assert_eq!(task.title(), None);
    }
}
