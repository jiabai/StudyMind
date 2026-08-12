use crate::{ensure_runtime_dirs, resolve_runtime_paths, task_manifest};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri::AppHandle;

const SUMMARY_EMPTY_ERROR: &str = "Summary cannot be empty.";
const SUMMARY_LINK_ERROR: &str = "Task summary artifact cannot be a link or reparse point.";
const SUMMARY_INVALID_ERROR: &str = "Task summary artifact is invalid.";

#[derive(Debug, Deserialize)]
pub(crate) struct SaveSummaryEditRequest {
    #[serde(alias = "taskId")]
    pub(crate) task_id: String,
    pub(crate) summary: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub(crate) struct SaveSummaryEditResult {
    pub(crate) task_id: String,
    pub(crate) summary: String,
}

#[tauri::command]
pub(crate) fn save_summary_edit(
    app: AppHandle,
    request: SaveSummaryEditRequest,
) -> Result<SaveSummaryEditResult, String> {
    let paths = resolve_runtime_paths(&app)?;
    ensure_runtime_dirs(&paths)?;
    let output_root = task_manifest::configured_output_root(&paths)?;
    save_summary_edit_to_output_root(&output_root, request)
}

pub(crate) fn save_summary_edit_to_output_root(
    output_root: &Path,
    request: SaveSummaryEditRequest,
) -> Result<SaveSummaryEditResult, String> {
    let summary = request.summary.trim();
    if summary.is_empty() {
        return Err(SUMMARY_EMPTY_ERROR.to_string());
    }

    let task = task_manifest::SupportedTask::open(output_root, &request.task_id)?;
    let summary_path =
        task.required_existing_artifact_path(task_manifest::TaskArtifact::Summary)?;
    validate_summary_artifact(&task, &summary_path)?;

    let summary = format!("{summary}\n");
    task_manifest::commit_task_artifacts(
        task.task_dir(),
        vec![task_manifest::TaskArtifactMutation::replace(
            "ai/summary.md",
            summary.as_bytes().to_vec(),
        )],
    )?;

    Ok(SaveSummaryEditResult {
        task_id: request.task_id,
        summary,
    })
}

fn validate_summary_artifact(
    task: &task_manifest::SupportedTask,
    summary_path: &Path,
) -> Result<(), String> {
    task.validate_existing_path(summary_path, task_manifest::TaskArtifact::Summary)?;
    if summary_path != task.task_dir().join("ai").join("summary.md") {
        return Err(SUMMARY_INVALID_ERROR.to_string());
    }

    let metadata = fs::symlink_metadata(summary_path).map_err(|_| SUMMARY_INVALID_ERROR)?;
    let parent_metadata = summary_path
        .parent()
        .and_then(|parent| fs::symlink_metadata(parent).ok())
        .ok_or_else(|| SUMMARY_INVALID_ERROR.to_string())?;
    if !metadata.is_file()
        || task_manifest::is_link_or_reparse_point(&metadata)
        || has_multiple_hard_links(summary_path).map_err(|_| SUMMARY_INVALID_ERROR.to_string())?
    {
        return Err(SUMMARY_LINK_ERROR.to_string());
    }
    if !parent_metadata.is_dir() || task_manifest::is_link_or_reparse_point(&parent_metadata) {
        return Err(SUMMARY_LINK_ERROR.to_string());
    }
    Ok(())
}

#[cfg(windows)]
fn has_multiple_hard_links(path: &Path) -> Result<bool, ()> {
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle;

    #[repr(C)]
    struct ByHandleFileInformation {
        file_attributes: u32,
        creation_time_low: u32,
        creation_time_high: u32,
        last_access_time_low: u32,
        last_access_time_high: u32,
        last_write_time_low: u32,
        last_write_time_high: u32,
        volume_serial_number: u32,
        file_size_high: u32,
        file_size_low: u32,
        number_of_links: u32,
        file_index_high: u32,
        file_index_low: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        #[link_name = "GetFileInformationByHandle"]
        fn get_file_information_by_handle(
            file_handle: *mut core::ffi::c_void,
            file_information: *mut ByHandleFileInformation,
        ) -> i32;
    }

    let file = fs::File::open(path).map_err(|_| ())?;
    let mut information = MaybeUninit::<ByHandleFileInformation>::zeroed();
    let succeeded = unsafe {
        get_file_information_by_handle(file.as_raw_handle(), information.as_mut_ptr()) != 0
    };
    if !succeeded {
        return Err(());
    }
    let information = unsafe { information.assume_init() };
    Ok(information.number_of_links > 1)
}

#[cfg(unix)]
fn has_multiple_hard_links(path: &Path) -> Result<bool, ()> {
    use std::os::unix::fs::MetadataExt;

    Ok(fs::symlink_metadata(path).map_err(|_| ())?.nlink() > 1)
}

#[cfg(not(any(unix, windows)))]
fn has_multiple_hard_links(_path: &Path) -> Result<bool, ()> {
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::{save_summary_edit_to_output_root, SaveSummaryEditRequest, SaveSummaryEditResult};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn save_summary_edit_round_trips_normalized_markdown_without_touching_mindmap() {
        let output_root = temp_dir("summary-round-trip");
        let task_id = "20260705-153012-local-summary123456";
        let task_dir = create_task(&output_root, task_id, true, Some("# Previous\n"));
        let mindmap_path = task_dir.join("ai").join("mindmap.mmd");
        let previous_mindmap = fs::read(&mindmap_path).expect("read previous mindmap");

        let result = save_summary_edit_to_output_root(
            &output_root,
            SaveSummaryEditRequest {
                task_id: task_id.to_string(),
                summary: "  # New title  \n\nBody text \n".to_string(),
            },
        )
        .expect("save summary");

        assert_eq!(
            result,
            SaveSummaryEditResult {
                task_id: task_id.to_string(),
                summary: "# New title  \n\nBody text\n".to_string(),
            }
        );
        assert_eq!(
            fs::read_to_string(task_dir.join("ai").join("summary.md")).expect("read summary"),
            "# New title  \n\nBody text\n"
        );
        assert_eq!(
            fs::read(&mindmap_path).expect("read unchanged mindmap"),
            previous_mindmap
        );
    }

    #[test]
    fn save_summary_edit_rejects_blank_content() {
        let output_root = temp_dir("summary-blank");
        let task_id = "20260705-153012-local-summary123457";
        create_task(&output_root, task_id, true, Some("old summary\n"));

        let error = save_summary_edit_to_output_root(
            &output_root,
            SaveSummaryEditRequest {
                task_id: task_id.to_string(),
                summary: " \n\t ".to_string(),
            },
        )
        .expect_err("blank summary must be rejected");

        assert_eq!(error, "Summary cannot be empty.");
    }

    #[test]
    fn save_summary_edit_rejects_missing_or_undeclared_summary_artifact() {
        let undeclared_root = temp_dir("summary-undeclared");
        let undeclared_task = "20260705-153012-local-summary123458";
        create_task(
            &undeclared_root,
            undeclared_task,
            false,
            Some("old summary\n"),
        );
        let undeclared_error = save_summary_edit_to_output_root(
            &undeclared_root,
            SaveSummaryEditRequest {
                task_id: undeclared_task.to_string(),
                summary: "new summary".to_string(),
            },
        )
        .expect_err("undeclared summary must be rejected");
        assert_eq!(
            undeclared_error,
            "Task manifest is missing summary artifact."
        );

        let missing_root = temp_dir("summary-missing");
        let missing_task = "20260705-153012-local-summary123459";
        create_task(&missing_root, missing_task, true, None);
        let missing_error = save_summary_edit_to_output_root(
            &missing_root,
            SaveSummaryEditRequest {
                task_id: missing_task.to_string(),
                summary: "new summary".to_string(),
            },
        )
        .expect_err("missing summary must be rejected");
        assert_eq!(missing_error, "Task manifest is missing summary artifact.");
    }

    #[test]
    fn save_summary_edit_rejects_linked_summary_target() {
        let output_root = temp_dir("summary-linked");
        let task_id = "20260705-153012-local-summary123460";
        let task_dir = create_task(&output_root, task_id, true, Some("old summary\n"));
        let summary_path = task_dir.join("ai").join("summary.md");
        let linked_source = task_dir.join("ai").join("summary-source.md");
        fs::write(&linked_source, "source summary\n").expect("write linked source");
        fs::remove_file(&summary_path).expect("remove ordinary summary");

        if let Err(error) = create_file_symlink(&linked_source, &summary_path) {
            eprintln!("symlink creation unavailable; trying hard link instead: {error}");
            if let Err(error) = fs::hard_link(&linked_source, &summary_path) {
                eprintln!("skipping linked summary regression; link creation unavailable: {error}");
                return;
            }
        }

        let error = save_summary_edit_to_output_root(
            &output_root,
            SaveSummaryEditRequest {
                task_id: task_id.to_string(),
                summary: "new summary".to_string(),
            },
        )
        .expect_err("linked summary must be rejected");

        assert!(matches!(
            error.as_str(),
            "Task summary artifact cannot be a link or reparse point."
                | "Path is outside the requested task directory."
        ));
        assert!(!error.contains(task_id));
        assert!(!error.contains("new summary"));
        assert_eq!(
            fs::read_to_string(&linked_source).expect("read linked source"),
            "source summary\n"
        );
    }

    #[test]
    fn save_summary_edit_rejects_hard_linked_summary_target() {
        let output_root = temp_dir("summary-hard-linked");
        let outside_root = temp_dir("summary-hard-linked-outside");
        let task_id = "20260705-153012-local-summary123461";
        let task_dir = create_task(&output_root, task_id, true, None);
        let summary_path = task_dir.join("ai").join("summary.md");
        let outside_target = outside_root.join("outside-summary.md");
        fs::write(&outside_target, "do not overwrite\n").expect("write outside target");

        if let Err(error) = fs::hard_link(&outside_target, &summary_path) {
            eprintln!(
                "skipping hard-link summary regression; hard-link creation unavailable: {error}"
            );
            return;
        }

        let error = save_summary_edit_to_output_root(
            &output_root,
            SaveSummaryEditRequest {
                task_id: task_id.to_string(),
                summary: "new summary".to_string(),
            },
        )
        .expect_err("hard-linked summary must be rejected");

        assert!(matches!(
            error.as_str(),
            "Task summary artifact cannot be a link or reparse point."
                | "Path is outside the requested task directory."
        ));
        assert_eq!(
            fs::read_to_string(&outside_target).expect("read outside target"),
            "do not overwrite\n"
        );
    }

    #[test]
    fn save_summary_edit_atomic_failure_preserves_previous_bytes() {
        let output_root = temp_dir("summary-atomic-failure");
        let task_id = "20260705-153012-local-summary123462";
        let task_dir = create_task(&output_root, task_id, true, Some("old summary\n"));
        let summary_path = task_dir.join("ai").join("summary.md");
        let previous_bytes = fs::read(&summary_path).expect("read previous summary");
        crate::atomic_files::fail_next_install_for_test(summary_path.clone());

        let error = save_summary_edit_to_output_root(
            &output_root,
            SaveSummaryEditRequest {
                task_id: task_id.to_string(),
                summary: "new summary".to_string(),
            },
        )
        .expect_err("injected atomic install failure must fail save");

        assert_eq!(error, "Task artifacts could not be stored safely.");
        assert_eq!(
            fs::read(&summary_path).expect("read restored summary"),
            previous_bytes
        );
        assert!(!task_dir
            .join(".StudyMind-artifact-transaction.json")
            .exists());
    }

    #[test]
    fn history_detail_reads_summary_saved_by_summary_edit() {
        let output_root = temp_dir("summary-history-detail");
        let task_id = "20260705-153012-local-summary123463";
        create_task(&output_root, task_id, true, Some("old summary\n"));

        save_summary_edit_to_output_root(
            &output_root,
            SaveSummaryEditRequest {
                task_id: task_id.to_string(),
                summary: "  # Saved summary  ".to_string(),
            },
        )
        .expect("save summary");

        let request: crate::history::HistoryDetailRequest =
            serde_json::from_value(serde_json::json!({ "taskId": task_id }))
                .expect("decode history detail request");
        let detail = crate::history::load_history_detail_from_output_root(&output_root, request)
            .expect("load history detail");

        assert_eq!(detail.summary, "# Saved summary\n");
    }

    #[test]
    fn summary_detail_module_and_command_are_registered() {
        let lib_source = fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("src")
                .join("lib.rs"),
        )
        .expect("read lib source");
        assert!(lib_source.contains("mod summary_detail;"));
        assert!(lib_source.contains("summary_detail::save_summary_edit"));
    }

    fn create_task(
        output_root: &Path,
        task_id: &str,
        declare_summary: bool,
        summary: Option<&str>,
    ) -> PathBuf {
        let task_dir = output_root.join("tasks").join(task_id);
        fs::create_dir_all(task_dir.join("ai")).expect("create ai dir");
        let artifacts = if declare_summary {
            r#""summary": "ai/summary.md""#
        } else {
            ""
        };
        fs::write(
            task_dir.join("StudyMind-task.json"),
            format!(
                r#"{{
  "schema_version": 4,
  "task_id": "{task_id}",
  "created_at": "2026-07-05T15:30:12Z",
  "local_source": {{
    "display_name": "Lecture.wmv",
    "media_kind": "video",
    "extension": "wmv"
  }},
  "platform": "local",
  "status": "completed",
  "artifacts": {{
    {artifacts}
  }},
  "error": null,
  "text_preview": "",
  "insights_count": 0
}}"#,
                artifacts = artifacts,
            ),
        )
        .expect("write manifest");
        if let Some(summary) = summary {
            fs::write(task_dir.join("ai").join("summary.md"), summary).expect("write summary");
        }
        fs::write(task_dir.join("ai").join("mindmap.mmd"), "graph TD\nA-->B\n")
            .expect("write mindmap");
        task_dir
    }

    fn temp_dir(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("StudyMind-{name}-{unique}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[cfg(windows)]
    fn create_file_symlink(source: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(source, link)
    }

    #[cfg(unix)]
    fn create_file_symlink(source: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(source, link)
    }
}
