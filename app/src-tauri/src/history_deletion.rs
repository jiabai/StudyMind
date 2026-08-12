use crate::{
    append_desktop_log, ensure_runtime_dirs, resolve_runtime_paths, task_manifest,
    ProcessSupervisors, CACHE_DIR_NAME,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, State};

#[derive(Debug, Serialize, PartialEq, Eq)]
pub(crate) struct HistoryDeleteResult {
    pub(crate) task_id: String,
    pub(crate) deleted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HistoryDeleteError {
    Busy,
    Unavailable,
    UnsafeStorage,
    DeleteFailed,
}

impl HistoryDeleteError {
    fn public_code(self) -> &'static str {
        match self {
            Self::Busy => "HISTORY_DELETE_BUSY",
            Self::Unavailable => "HISTORY_DELETE_UNAVAILABLE",
            Self::UnsafeStorage => "HISTORY_DELETE_UNSAFE_STORAGE",
            Self::DeleteFailed => "HISTORY_DELETE_FAILED",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct HistoryDeleteRequest {
    #[serde(alias = "taskId")]
    pub(crate) task_id: String,
}

#[derive(Default)]
pub(crate) struct HistoryDeletionState {
    lock: Mutex<()>,
}

trait DirectoryRemover {
    fn remove_dir_all(&self, path: &Path) -> Result<(), ()>;
}

struct StdDirectoryRemover;

impl DirectoryRemover for StdDirectoryRemover {
    fn remove_dir_all(&self, path: &Path) -> Result<(), ()> {
        fs::remove_dir_all(path).map_err(|_| ())
    }
}

fn delete_history_task_from_roots<R: DirectoryRemover>(
    output_root: &Path,
    cache_root: &Path,
    task_id: &str,
    remover: &R,
) -> Result<HistoryDeleteResult, HistoryDeleteError> {
    let task = task_manifest::SupportedTask::open(output_root, task_id).map_err(|error| {
        if error == task_manifest::ARTIFACT_RECOVERY_ERROR {
            HistoryDeleteError::UnsafeStorage
        } else {
            HistoryDeleteError::Unavailable
        }
    })?;
    let supported_task_id = task.task_id().to_string();
    let task_dir = task.task_dir().to_path_buf();

    validate_unlinked_directory(output_root)?;
    validate_unlinked_directory(&output_root.join(task_manifest::TASKS_DIR_NAME))?;
    let output_root = output_root
        .canonicalize()
        .map_err(|_| HistoryDeleteError::UnsafeStorage)?;
    let tasks_root = output_root
        .join(task_manifest::TASKS_DIR_NAME)
        .canonicalize()
        .map_err(|_| HistoryDeleteError::UnsafeStorage)?;
    let task_dir = task_dir
        .canonicalize()
        .map_err(|_| HistoryDeleteError::UnsafeStorage)?;
    if task_dir.parent() != Some(tasks_root.as_path())
        || task_dir == tasks_root
        || task_dir == output_root
    {
        return Err(HistoryDeleteError::UnsafeStorage);
    }
    validate_unlinked_tree(&task_dir)?;

    let task_cache = cache_root
        .join(crate::AUDIO_REVIEW_CACHE_DIR_NAME)
        .join(task_id.trim());
    match fs::symlink_metadata(&task_cache) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(HistoryDeleteError::UnsafeStorage),
        Ok(metadata) => {
            if task_manifest::is_link_or_reparse_point(&metadata) || !metadata.is_dir() {
                return Err(HistoryDeleteError::UnsafeStorage);
            }
            validate_unlinked_directory(cache_root)?;
            validate_unlinked_directory(&cache_root.join(crate::AUDIO_REVIEW_CACHE_DIR_NAME))?;
            let cache_root = cache_root
                .canonicalize()
                .map_err(|_| HistoryDeleteError::UnsafeStorage)?;
            let task_cache = task_cache
                .canonicalize()
                .map_err(|_| HistoryDeleteError::UnsafeStorage)?;
            if !task_cache.starts_with(&cache_root) || task_cache == cache_root {
                return Err(HistoryDeleteError::UnsafeStorage);
            }
            validate_unlinked_tree(&task_cache)?;
            remover
                .remove_dir_all(&task_cache)
                .map_err(|_| HistoryDeleteError::DeleteFailed)?;
        }
    }
    remover
        .remove_dir_all(&task_dir)
        .map_err(|_| HistoryDeleteError::DeleteFailed)?;
    if task_dir.exists() {
        return Err(HistoryDeleteError::DeleteFailed);
    }

    Ok(HistoryDeleteResult {
        task_id: supported_task_id,
        deleted: true,
    })
}

fn delete_history_task_with_state<R: DirectoryRemover>(
    output_root: &Path,
    cache_root: &Path,
    task_id: &str,
    process_supervisors: &ProcessSupervisors,
    deletion_state: &HistoryDeletionState,
    remover: &R,
) -> Result<HistoryDeleteResult, HistoryDeleteError> {
    let _guard = deletion_state
        .lock
        .try_lock()
        .map_err(|_| HistoryDeleteError::Busy)?;
    if process_supervisors.is_task_active() {
        return Err(HistoryDeleteError::Busy);
    }
    delete_history_task_from_roots(output_root, cache_root, task_id, remover)
}

#[tauri::command]
pub(crate) fn delete_history_task(
    app: AppHandle,
    process_supervisors: State<'_, Arc<ProcessSupervisors>>,
    deletion_state: State<'_, Arc<HistoryDeletionState>>,
    request: HistoryDeleteRequest,
) -> Result<HistoryDeleteResult, String> {
    let started = Instant::now();
    let result = (|| {
        let paths = resolve_runtime_paths(&app).map_err(|_| HistoryDeleteError::DeleteFailed)?;
        ensure_runtime_dirs(&paths).map_err(|_| HistoryDeleteError::DeleteFailed)?;
        let output_root = task_manifest::configured_output_root(&paths)
            .map_err(|_| HistoryDeleteError::DeleteFailed)?;
        let cache_root = paths.user_data_dir.join(CACHE_DIR_NAME);
        delete_history_task_with_state(
            &output_root,
            &cache_root,
            &request.task_id,
            process_supervisors.inner(),
            deletion_state.inner(),
            &StdDirectoryRemover,
        )
    })();
    if let Ok(paths) = resolve_runtime_paths(&app) {
        let outcome = match &result {
            Ok(_) => "completed",
            Err(error) => error.public_code(),
        };
        let _ = append_desktop_log(
            &paths,
            "history.delete",
            &format!(
                "outcome={outcome} elapsed_ms={}",
                started.elapsed().as_millis()
            ),
        );
    }
    result.map_err(|error| error.public_code().to_string())
}

fn validate_unlinked_directory(path: &Path) -> Result<(), HistoryDeleteError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| HistoryDeleteError::UnsafeStorage)?;
    if task_manifest::is_link_or_reparse_point(&metadata) || !metadata.is_dir() {
        return Err(HistoryDeleteError::UnsafeStorage);
    }
    Ok(())
}

fn validate_unlinked_tree(path: &Path) -> Result<(), HistoryDeleteError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| HistoryDeleteError::UnsafeStorage)?;
    if task_manifest::is_link_or_reparse_point(&metadata) {
        return Err(HistoryDeleteError::UnsafeStorage);
    }
    if !metadata.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(path).map_err(|_| HistoryDeleteError::UnsafeStorage)? {
        let entry = entry.map_err(|_| HistoryDeleteError::UnsafeStorage)?;
        validate_unlinked_tree(&entry.path())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        delete_history_task_from_roots, delete_history_task_with_state, DirectoryRemover,
        HistoryDeleteError, HistoryDeleteRequest, HistoryDeletionState, StdDirectoryRemover,
    };
    use crate::ProcessSupervisors;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn deletes_only_the_supported_task_and_its_playback_cache() {
        let root = temp_dir("history-delete-safe-task");
        let output_root = root.join("outputs");
        let cache_root = root.join("cache");
        let task_id = "20260712-120000-local-abcdef123456";
        let other_task_id = "20260712-120001-local-fedcba654321";
        let task_dir = write_supported_task(&output_root, task_id, "abcdef123456");
        let other_task_dir = write_supported_task(&output_root, other_task_id, "fedcba654321");
        fs::create_dir_all(task_dir.join("ai")).expect("create task ai dir");
        fs::write(task_dir.join("ai/dissection.json"), b"{}").expect("write dissection json");
        fs::write(task_dir.join("ai/dissection.md"), b"# report")
            .expect("write dissection markdown");
        let playback_root = cache_root.join(".StudyMind-audio-review");
        let task_cache = playback_root.join(task_id);
        let other_cache = playback_root.join(other_task_id);
        fs::create_dir_all(&task_cache).expect("create task playback cache");
        fs::create_dir_all(&other_cache).expect("create other playback cache");
        fs::write(task_cache.join("audio.wav"), b"task-cache").expect("write task cache");
        fs::write(other_cache.join("audio.wav"), b"other-cache").expect("write other cache");

        let result = delete_history_task_from_roots(
            &output_root,
            &cache_root,
            task_id,
            &StdDirectoryRemover,
        )
        .expect("delete supported task");

        assert_eq!(result.task_id, task_id);
        assert!(result.deleted);
        assert!(!task_dir.exists());
        assert!(!task_cache.exists());
        assert!(other_task_dir.exists());
        assert!(other_cache.exists());
        assert!(output_root.exists());
        assert!(cache_root.exists());

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn rejects_unsupported_and_traversal_tasks_before_removal() {
        let root = temp_dir("history-delete-rejects-unsupported");
        let output_root = root.join("outputs");
        let cache_root = root.join("cache");
        let task_id = "20260712-120000-local-abcdef123456";
        let task_dir = write_supported_task(&output_root, task_id, "abcdef123456");
        let manifest_path = task_dir.join("StudyMind-task.json");
        let manifest = fs::read_to_string(&manifest_path).expect("read manifest");
        fs::write(
            &manifest_path,
            manifest.replace("\"schema_version\": 4", "\"schema_version\": 2"),
        )
        .expect("downgrade manifest");
        let remover = RecordingRemover::default();

        assert_eq!(
            delete_history_task_from_roots(&output_root, &cache_root, task_id, &remover,),
            Err(HistoryDeleteError::Unavailable),
        );
        assert_eq!(
            delete_history_task_from_roots(&output_root, &cache_root, "../outside", &remover,),
            Err(HistoryDeleteError::Unavailable),
        );
        assert!(remover.paths().is_empty());
        assert!(task_dir.exists());

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn rejects_linked_descendants_before_removal() {
        let root = temp_dir("history-delete-rejects-linked-descendant");
        let output_root = root.join("outputs");
        let cache_root = root.join("cache");
        let task_id = "20260712-120000-local-abcdef123456";
        let task_dir = write_supported_task(&output_root, task_id, "abcdef123456");
        let outside = root.join("outside.txt");
        fs::write(&outside, b"must remain").expect("write outside file");
        let linked = task_dir.join("media").join("outside-link");
        if create_file_symlink(&outside, &linked).is_err() {
            fs::remove_dir_all(root).expect("remove unsupported symlink test root");
            return;
        }
        let remover = RecordingRemover::default();

        let error = delete_history_task_from_roots(&output_root, &cache_root, task_id, &remover)
            .expect_err("linked task must be rejected");

        assert_eq!(error, HistoryDeleteError::UnsafeStorage);
        assert!(remover.paths().is_empty());
        assert_eq!(
            fs::read(&outside).expect("read outside file"),
            b"must remain"
        );
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn classifies_linked_tasks_root_recovery_as_unsafe_storage() {
        let root = temp_dir("history-delete-rejects-linked-tasks-root");
        let output_root = root.join("outputs");
        let external_output = root.join("external-output");
        let cache_root = root.join("cache");
        let task_id = "20260712-120000-local-abcdef123456";
        let external_task = write_supported_task(&external_output, task_id, "abcdef123456");
        fs::create_dir_all(&output_root).expect("create configured output root");
        create_dir_link(&external_output.join("tasks"), &output_root.join("tasks"))
            .expect("create linked tasks root fixture");
        let remover = RecordingRemover::default();

        let error = delete_history_task_from_roots(&output_root, &cache_root, task_id, &remover)
            .expect_err("linked tasks root must be rejected");

        assert_eq!(error, HistoryDeleteError::UnsafeStorage);
        assert!(remover.paths().is_empty());
        assert!(external_task.exists());
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn rejects_linked_playback_cache_root_before_task_removal() {
        let root = temp_dir("history-delete-rejects-linked-playback-root");
        let output_root = root.join("outputs");
        let cache_root = root.join("cache");
        let external_playback_root = root.join("external-playback");
        let task_id = "20260712-120000-local-abcdef123456";
        let task_dir = write_supported_task(&output_root, task_id, "abcdef123456");
        let external_task_cache = external_playback_root.join(task_id);
        fs::create_dir_all(&external_task_cache).expect("create external playback cache");
        fs::write(external_task_cache.join("audio.wav"), b"must remain")
            .expect("write external playback cache");
        fs::create_dir_all(&cache_root).expect("create configured cache root");
        create_dir_link(
            &external_playback_root,
            &cache_root.join(".StudyMind-audio-review"),
        )
        .expect("create linked playback root fixture");
        let remover = RecordingRemover::default();

        let error = delete_history_task_from_roots(&output_root, &cache_root, task_id, &remover)
            .expect_err("linked playback root must be rejected");

        assert_eq!(error, HistoryDeleteError::UnsafeStorage);
        assert!(remover.paths().is_empty());
        assert!(task_dir.exists());
        assert_eq!(
            fs::read(external_task_cache.join("audio.wav")).expect("read external cache"),
            b"must remain",
        );
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_dangling_playback_cache_symlink_before_task_removal() {
        let root = temp_dir("history-delete-rejects-dangling-cache-link");
        let output_root = root.join("outputs");
        let cache_root = root.join("cache");
        let task_id = "20260712-120000-local-abcdef123456";
        let task_dir = write_supported_task(&output_root, task_id, "abcdef123456");
        let playback_root = cache_root.join(".StudyMind-audio-review");
        fs::create_dir_all(&playback_root).expect("create playback root");
        std::os::unix::fs::symlink(root.join("missing-target"), playback_root.join(task_id))
            .expect("create dangling cache symlink");
        let remover = RecordingRemover::default();

        let error = delete_history_task_from_roots(&output_root, &cache_root, task_id, &remover)
            .expect_err("dangling cache link must be rejected");

        assert_eq!(error, HistoryDeleteError::UnsafeStorage);
        assert!(remover.paths().is_empty());
        assert!(task_dir.exists());
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[cfg(windows)]
    #[test]
    fn rejects_windows_junction_descendants_before_removal() {
        use std::process::{Command, Stdio};

        let root = temp_dir("history-delete-rejects-junction");
        let output_root = root.join("outputs");
        let cache_root = root.join("cache");
        let task_id = "20260712-120000-local-abcdef123456";
        let task_dir = write_supported_task(&output_root, task_id, "abcdef123456");
        let outside = root.join("outside-dir");
        fs::create_dir_all(&outside).expect("create outside directory");
        fs::write(outside.join("must-remain.txt"), b"must remain").expect("write outside file");
        let junction = task_dir.join("media").join("outside-junction");
        let status = Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("create junction fixture");
        assert!(status.success(), "junction fixture must be available");
        let remover = RecordingRemover::default();

        let error = delete_history_task_from_roots(&output_root, &cache_root, task_id, &remover)
            .expect_err("junction task must be rejected");

        assert_eq!(error, HistoryDeleteError::UnsafeStorage);
        assert!(remover.paths().is_empty());
        assert_eq!(
            fs::read(outside.join("must-remain.txt")).expect("read outside file"),
            b"must remain",
        );
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn cache_failure_leaves_the_primary_task_untouched() {
        let root = temp_dir("history-delete-cache-failure");
        let output_root = root.join("outputs");
        let cache_root = root.join("cache");
        let task_id = "20260712-120000-local-abcdef123456";
        let task_dir = write_supported_task(&output_root, task_id, "abcdef123456");
        let task_cache = cache_root.join(".StudyMind-audio-review").join(task_id);
        fs::create_dir_all(&task_cache).expect("create cache");
        fs::write(task_cache.join("audio.wav"), b"cache").expect("write cache");
        let remover = FailOnNthRemover::new(1);

        let error = delete_history_task_from_roots(&output_root, &cache_root, task_id, &remover)
            .expect_err("cache removal must fail");

        assert_eq!(error, HistoryDeleteError::DeleteFailed);
        assert!(task_dir.join("media/video.mp4").exists());
        assert!(task_cache.exists());
        assert_eq!(remover.calls(), 1);
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn primary_failure_reports_failure_after_removing_rebuildable_cache() {
        let root = temp_dir("history-delete-primary-failure");
        let output_root = root.join("outputs");
        let cache_root = root.join("cache");
        let task_id = "20260712-120000-local-abcdef123456";
        let task_dir = write_supported_task(&output_root, task_id, "abcdef123456");
        let task_cache = cache_root.join(".StudyMind-audio-review").join(task_id);
        fs::create_dir_all(&task_cache).expect("create cache");
        fs::write(task_cache.join("audio.wav"), b"cache").expect("write cache");
        let remover = FailOnNthRemover::new(2);

        let error = delete_history_task_from_roots(&output_root, &cache_root, task_id, &remover)
            .expect_err("primary removal must fail");

        assert_eq!(error, HistoryDeleteError::DeleteFailed);
        assert!(!task_cache.exists());
        assert!(task_dir.exists());
        assert_eq!(remover.calls(), 2);
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[cfg(windows)]
    #[test]
    fn locked_windows_artifact_returns_failure_without_claiming_deletion() {
        use std::fs::OpenOptions;
        use std::os::windows::fs::OpenOptionsExt;

        let root = temp_dir("history-delete-locked-artifact");
        let output_root = root.join("outputs");
        let cache_root = root.join("cache");
        let task_id = "20260712-120000-local-abcdef123456";
        let task_dir = write_supported_task(&output_root, task_id, "abcdef123456");
        let locked = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(task_dir.join("media/video.mp4"))
            .expect("open artifact without delete sharing");

        let error = delete_history_task_from_roots(
            &output_root,
            &cache_root,
            task_id,
            &StdDirectoryRemover,
        )
        .expect_err("locked artifact must fail deletion");

        assert_eq!(error, HistoryDeleteError::DeleteFailed);
        assert!(task_dir.exists());
        drop(locked);
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn history_delete_request_rejects_paths_urls_and_unknown_fields() {
        let valid = serde_json::from_value::<HistoryDeleteRequest>(serde_json::json!({
            "task_id": "task-safe-1"
        }))
        .expect("valid task id request");
        assert_eq!(valid.task_id, "task-safe-1");

        for forbidden in ["task_dir", "output_dir", "url", "command"] {
            let mut payload = serde_json::Map::from_iter([(
                "task_id".to_string(),
                serde_json::Value::String("task-safe-1".to_string()),
            )]);
            payload.insert(
                forbidden.to_string(),
                serde_json::Value::String("review-secret".to_string()),
            );
            let error =
                serde_json::from_value::<HistoryDeleteRequest>(serde_json::Value::Object(payload))
                    .expect_err("unknown field must fail");
            assert!(!error.to_string().contains("review-secret"));
        }
    }

    #[test]
    fn history_delete_errors_map_to_fixed_public_codes() {
        assert_eq!(
            HistoryDeleteError::Busy.public_code(),
            "HISTORY_DELETE_BUSY"
        );
        assert_eq!(
            HistoryDeleteError::Unavailable.public_code(),
            "HISTORY_DELETE_UNAVAILABLE"
        );
        assert_eq!(
            HistoryDeleteError::UnsafeStorage.public_code(),
            "HISTORY_DELETE_UNSAFE_STORAGE"
        );
        assert_eq!(
            HistoryDeleteError::DeleteFailed.public_code(),
            "HISTORY_DELETE_FAILED"
        );
    }

    #[test]
    fn active_worker_and_overlapping_deletion_reject_before_filesystem_mutation() {
        let root = temp_dir("history-delete-busy");
        let output_root = root.join("outputs");
        let cache_root = root.join("cache");
        let task_id = "20260712-120000-local-abcdef123456";
        let task_dir = write_supported_task(&output_root, task_id, "abcdef123456");
        let remover = RecordingRemover::default();
        let supervisors = ProcessSupervisors::default();
        let deletion_state = HistoryDeletionState::default();
        let worker_instance_id = supervisors.activate_task_for_test(1234);

        assert_eq!(
            delete_history_task_with_state(
                &output_root,
                &cache_root,
                task_id,
                &supervisors,
                &deletion_state,
                &remover,
            ),
            Err(HistoryDeleteError::Busy),
        );
        supervisors.finish_task_for_test(worker_instance_id);
        let deletion_guard = deletion_state.lock.try_lock().expect("hold delete lock");
        assert_eq!(
            delete_history_task_with_state(
                &output_root,
                &cache_root,
                task_id,
                &supervisors,
                &deletion_state,
                &remover,
            ),
            Err(HistoryDeleteError::Busy),
        );
        drop(deletion_guard);

        assert!(remover.paths().is_empty());
        assert!(task_dir.exists());
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[derive(Default)]
    struct RecordingRemover {
        paths: Mutex<Vec<PathBuf>>,
    }

    impl RecordingRemover {
        fn paths(&self) -> Vec<PathBuf> {
            self.paths.lock().expect("recording lock").clone()
        }
    }

    impl DirectoryRemover for RecordingRemover {
        fn remove_dir_all(&self, path: &Path) -> Result<(), ()> {
            self.paths
                .lock()
                .expect("recording lock")
                .push(path.to_path_buf());
            Ok(())
        }
    }

    struct FailOnNthRemover {
        fail_on: usize,
        calls: Mutex<usize>,
    }

    impl FailOnNthRemover {
        fn new(fail_on: usize) -> Self {
            Self {
                fail_on,
                calls: Mutex::new(0),
            }
        }

        fn calls(&self) -> usize {
            *self.calls.lock().expect("failure lock")
        }
    }

    impl DirectoryRemover for FailOnNthRemover {
        fn remove_dir_all(&self, path: &Path) -> Result<(), ()> {
            let mut calls = self.calls.lock().expect("failure lock");
            *calls += 1;
            if *calls == self.fail_on {
                return Err(());
            }
            fs::remove_dir_all(path).map_err(|_| ())
        }
    }

    fn write_supported_task(output_root: &Path, task_id: &str, video_id: &str) -> PathBuf {
        let task_dir = output_root.join("tasks").join(task_id);
        for relative in ["media", "transcript/original", "ai"] {
            fs::create_dir_all(task_dir.join(relative)).expect("create task artifact directory");
        }
        for (relative, content) in [
            ("media/video.mp4", "video"),
            ("media/audio.wav", "audio"),
            ("transcript/transcript.txt", "transcript"),
            ("transcript/segments.json", "[]"),
            ("transcript/original/transcript.txt", "original"),
            ("ai/summary.md", "summary"),
            ("ai/mindmap.mmd", "mindmap"),
            ("ai/insights.json", "{\"schemaVersion\":1,\"insights\":[]}"),
        ] {
            fs::write(task_dir.join(relative), content).expect("write task artifact");
        }
        fs::write(
            task_dir.join("StudyMind-task.json"),
            format!(
                r#"{{
  "schema_version": 4,
  "task_id": "{task_id}",
  "created_at": "2026-07-12T12:00:00Z",
  "local_source": {{
    "display_name": "Lecture-{video_id}.wmv",
    "media_kind": "video",
    "extension": "wmv"
  }},
  "platform": "local",
  "status": "completed",
  "artifacts": {{
    "video": "media/video.mp4",
    "audio": "media/audio.wav",
    "transcript_txt": "transcript/transcript.txt",
    "segments": "transcript/segments.json",
    "summary": "ai/summary.md",
    "mindmap": "ai/mindmap.mmd",
    "insights": "ai/insights.json"
  }},
  "error": null,
  "text_preview": "safe transcript",
  "insights_count": 0
}}"#,
            ),
        )
        .expect("write manifest");
        task_dir
    }

    fn temp_dir(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("StudyMind-{name}-{unique}"));
        fs::create_dir_all(&dir).expect("create temp root");
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

    #[cfg(windows)]
    fn create_dir_link(source: &Path, link: &Path) -> std::io::Result<()> {
        use std::process::{Command, Stdio};

        let status = Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(link)
            .arg(source)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(std::io::Error::other("junction fixture failed"))
        }
    }

    #[cfg(unix)]
    fn create_dir_link(source: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(source, link)
    }
}
