use super::task_result::{map_task_worker_result, TaskCommandContext};
use crate::local_media::LocalMediaSelectionState;
use crate::local_media_contract::{
    parse_process_local_media_ipc_request, serialize_process_local_media_worker_request,
};
use crate::task_rename::rename_task_title_from_root;
use crate::worker_runtime::{TaskTerminalResult, WorkerJob};
use crate::{
    append_desktop_log, ensure_runtime_dirs, resolve_runtime_paths, run_blocking_worker_command,
    task_manifest, ProcessSupervisors,
};
use serde_json::Value;
use std::fmt;
use std::sync::Arc;
use tauri::{AppHandle, State, Window};

const ASR_MODEL_UNSUPPORTED: &str = "ASR_MODEL_UNSUPPORTED";
const LOCAL_MEDIA_VALIDATION_FAILED: &str = "LOCAL_MEDIA_VALIDATION_FAILED";

const RESELECTION_ERROR_CODES: &[&str] = &[
    "LOCAL_MEDIA_SELECTION_INVALID",
    "LOCAL_MEDIA_SELECTION_CHANGED",
    "LOCAL_MEDIA_UNSUPPORTED_FORMAT",
    "LOCAL_MEDIA_UNAVAILABLE",
    "LOCAL_MEDIA_LINKED",
    LOCAL_MEDIA_VALIDATION_FAILED,
    "LOCAL_MEDIA_KIND_MISMATCH",
    "LOCAL_VIDEO_STREAM_MISSING",
    "LOCAL_VIDEO_AUDIO_STREAM_MISSING",
    "LOCAL_AUDIO_STREAM_MISSING",
];

struct ResolvedLocalMediaWorkerRequest {
    selection_token: String,
    worker_payload: String,
    title: Option<String>,
}

impl fmt::Debug for ResolvedLocalMediaWorkerRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ResolvedLocalMediaWorkerRequest(REDACTED)")
    }
}

struct LocalMediaRequestFailure {
    code: &'static str,
    selection_token: Option<String>,
}

impl fmt::Debug for LocalMediaRequestFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LocalMediaRequestFailure")
            .field("code", &self.code)
            .field("selection_token", &"[REDACTED]")
            .finish()
    }
}

pub(super) async fn run_process_local_media(
    window: Window,
    app: AppHandle,
    process_state: State<'_, Arc<ProcessSupervisors>>,
    selection_state: State<'_, Arc<LocalMediaSelectionState>>,
    request: Value,
) -> Result<TaskTerminalResult, String> {
    let process_state = Arc::clone(process_state.inner());
    let selection_state = Arc::clone(selection_state.inner());
    run_blocking_worker_command(move || {
        process_local_media_blocking(window, app, process_state, selection_state, request)
    })
    .await
}

fn process_local_media_blocking(
    window: Window,
    app: AppHandle,
    process_state: Arc<ProcessSupervisors>,
    selection_state: Arc<LocalMediaSelectionState>,
    request: Value,
) -> Result<TaskTerminalResult, String> {
    let paths = resolve_runtime_paths(&app)?;
    ensure_runtime_dirs(&paths)?;
    let prepared = match resolve_local_media_worker_request(selection_state.as_ref(), request) {
        Ok(prepared) => prepared,
        Err(failure) => {
            clear_selection_for_request_failure(selection_state.as_ref(), &failure);
            return Ok(local_media_failure_result(failure.code));
        }
    };

    let result = map_task_worker_result(
        process_state
            .task_worker(&paths)
            .execute(WorkerJob::process_local_media(
                prepared.worker_payload,
                window,
            ))?,
        TaskCommandContext::ProcessLocalMedia,
    )?;
    if should_clear_selection_after_result(&result) {
        let _ = selection_state.clear(&prepared.selection_token);
    }
    // Worker 进程失败（崩溃/取消/超时）时，磁盘上的 processing tombstone
    // 不会被 Python 侧 finalize 覆盖（原生崩溃不抛 Python 异常）。在此回写
    // 为 interrupted 终态，使任务在历史侧边栏显示为"中断"、可删除。串行化
    // 保证同时最多一个 processing tombstone，回写安全；失败仅记日志，不
    // 阻断主流程。
    if should_finalize_processing_tombstone(&result) {
        if let Some(error) = result.error.as_ref() {
            if let Ok(output_root) = task_manifest::configured_output_root(&paths) {
                if let Err(err) = task_manifest::finalize_processing_tombstones(
                    &output_root,
                    &error.code,
                    &error.message,
                    error.stage.as_str(),
                ) {
                    let _ = append_desktop_log(
                        &paths,
                        "task.process_local_media.tombstone",
                        &format!("finalize_failed outcome={}", err),
                    );
                }
            }
        }
    }
    // 新建课题时若用户指定了标题，在 worker 落盘 manifest 后由 Rust 端后置写入 title。
    // 复用 rename_task_title_from_root 逻辑，失败仅记日志，不阻断主流程。
    if let (Some(task_id), Some(title)) = (result.task_id.as_deref(), prepared.title.as_deref()) {
        if let Ok(output_root) = task_manifest::configured_output_root(&paths) {
            if let Err(error) = rename_task_title_from_root(
                &output_root,
                task_id,
                Some(title.to_string()),
            ) {
                let _ = append_desktop_log(
                    &paths,
                    "task.process_local_media.title",
                    &format!("outcome={} task_id={}", error.public_code(), task_id),
                );
            }
        }
    }
    Ok(result)
}

fn resolve_local_media_worker_request(
    selection_state: &LocalMediaSelectionState,
    request: Value,
) -> Result<ResolvedLocalMediaWorkerRequest, LocalMediaRequestFailure> {
    let request = parse_process_local_media_ipc_request(request).map_err(|code| {
        LocalMediaRequestFailure {
            code,
            selection_token: None,
        }
    })?;
    let selection_token = request.selection_token;
    let asr_model = request.asr_model;
    let title = request.title;
    let selected =
        selection_state
            .resolve(&selection_token)
            .map_err(|code| LocalMediaRequestFailure {
                code,
                selection_token: Some(selection_token.clone()),
            })?;
    let worker_payload = serialize_process_local_media_worker_request(
        &selected.path,
        selected.media_kind,
        &selected.display_name,
        &selected.extension,
        &asr_model,
    )
    .map_err(|_| LocalMediaRequestFailure {
        code: LOCAL_MEDIA_VALIDATION_FAILED,
        selection_token: Some(selection_token.clone()),
    })?;

    Ok(ResolvedLocalMediaWorkerRequest {
        selection_token,
        worker_payload,
        title,
    })
}

fn clear_selection_for_request_failure(
    selection_state: &LocalMediaSelectionState,
    failure: &LocalMediaRequestFailure,
) {
    if !RESELECTION_ERROR_CODES.contains(&failure.code) {
        return;
    }
    if let Some(selection_token) = failure.selection_token.as_deref() {
        let _ = selection_state.clear(selection_token);
    }
}

fn should_clear_selection_after_result(result: &TaskTerminalResult) -> bool {
    result.status.as_str() == "completed"
        || result
            .error
            .as_ref()
            .is_some_and(|error| RESELECTION_ERROR_CODES.contains(&error.code.as_str()))
}

/// 是否应把磁盘上的 processing tombstone 回写为终态。
///
/// 仅当 worker 进程确实终结（崩溃/取消/超时/协议违例）且未返回任何任务
/// 身份时才回写。`WORKER_ALREADY_RUNNING` 明确排除：此时另一个任务仍在
/// 运行，其 tombstone 属于活任务，误改写会把它标成失败；同样排除
/// `WORKER_REQUEST_TRANSPORT_FAILED`（请求未送达，worker 从未启动，没有
/// 属于本次运行的 tombstone）。
fn should_finalize_processing_tombstone(result: &TaskTerminalResult) -> bool {
    result.status.as_str() == "failed"
        && result.task_id.is_none()
        && result.error.as_ref().is_some_and(|error| {
            matches!(
                error.code.as_str(),
                "WORKER_PROCESS_FAILED"
                    | "WORKER_CANCELLED"
                    | "WORKER_IDLE_TIMEOUT"
                    | "WORKER_EXECUTION_TIMEOUT"
                    | "WORKER_PROTOCOL_VIOLATION"
            )
        })
}

fn local_media_failure_result(code: &'static str) -> TaskTerminalResult {
    let (message, stage) = match code {
        "LOCAL_MEDIA_SELECTION_INVALID" => (
            "The local media selection is no longer available.",
            "waiting_input",
        ),
        "LOCAL_MEDIA_SELECTION_CHANGED" => (
            "The selected local media changed and must be selected again.",
            "waiting_input",
        ),
        "LOCAL_MEDIA_UNSUPPORTED_FORMAT" => (
            "The selected local media format is not supported.",
            "waiting_input",
        ),
        "LOCAL_MEDIA_UNAVAILABLE" => (
            "The selected local media is no longer available.",
            "waiting_input",
        ),
        "LOCAL_MEDIA_LINKED" => ("Linked local media is not accepted.", "waiting_input"),
        ASR_MODEL_UNSUPPORTED => (
            "The configured ASR model is not supported.",
            "video_transcribing",
        ),
        _ => (
            "The local media could not be validated.",
            "video_extracting",
        ),
    };
    TaskTerminalResult::from_value(serde_json::json!({
        "status": "failed",
        "task_id": null,
        "task_dir": null,
        "artifacts": {},
        "text": "",
        "summary": "",
        "insights": [],
        "transcript": null,
        "dissection": null,
        "error": {
            "code": code,
            "message": message,
            "stage": stage
        }
    }))
    .expect("trusted local-media result must satisfy the terminal contract")
}

#[cfg(test)]
mod tests {
    use super::{
        resolve_local_media_worker_request, should_clear_selection_after_result,
        should_finalize_processing_tombstone,
    };
    use crate::local_media::LocalMediaSelectionState;
    use crate::worker_runtime::TaskTerminalResult;
    use serde_json::json;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time after epoch")
            .as_nanos();
        // macOS exposes /var as a symlink to /private/var; use the physical
        // temp root so ordinary fixtures do not look like linked sources.
        let temp_root = std::env::temp_dir()
            .canonicalize()
            .expect("resolve physical temp dir");
        let path = temp_root.join(format!(
            "StudyMind-local-command-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn write_media(root: &Path, name: &str) -> PathBuf {
        let path = root.join(name);
        fs::write(&path, b"local-media-bytes").expect("write local media");
        path
    }

    fn result(status: &str, code: Option<&str>) -> TaskTerminalResult {
        TaskTerminalResult::from_value(json!({
            "status": status,
            "task_id": if status == "completed" { Some("task-1") } else { None },
            "task_dir": if status == "completed" { Some("C:/StudyMind/task-1") } else { None },
            "artifacts": {},
            "text": "",
            "summary": "",
            "insights": [],
            "transcript": null,
            "dissection": null,
            "error": code.map(|code| json!({
                "code": code,
                "message": "",
                "stage": "video_extracting"
            }))
        }))
        .expect("valid terminal result")
    }

    #[test]
    fn resolves_token_to_one_shot_v4_payload_without_exposing_path_elsewhere() {
        let root = temp_dir("payload");
        let source = write_media(&root, "Interview.WMV");
        let state = LocalMediaSelectionState::default();
        let view = state.select_for_path(&source).expect("select local video");
        let prepared = resolve_local_media_worker_request(
            &state,
            json!({
                "selectionToken": view.selection_token(),
                "asrModel": "iic/SenseVoiceSmall"
            }),
        )
        .expect("prepare local request");
        let payload: serde_json::Value =
            serde_json::from_str(&prepared.worker_payload).expect("parse worker payload");

        assert_eq!(prepared.selection_token, view.selection_token());
        assert_eq!(payload["contract_version"], 4);
        assert_eq!(payload["source_path"], source.to_string_lossy().as_ref());
        assert_eq!(payload["media_kind"], "video");
        assert_eq!(payload["safe_display_name"], "Interview.WMV");
        assert_eq!(payload["source_extension"], "wmv");
        assert_eq!(payload["asr_model"], "iic/SenseVoiceSmall");
        assert!(!format!("{prepared:?}").contains(&root.to_string_lossy().to_string()));

        fs::remove_dir_all(root).expect("remove temp dir");
    }

    #[test]
    fn malformed_or_stale_ipc_request_fails_with_fixed_non_echoing_code() {
        let state = LocalMediaSelectionState::default();
        for request in [
            json!({}),
            json!({"selectionToken": "review-secret"}),
            json!({
                "selectionToken": "7ea6cd50-4dd6-4e89-a0e5-1aee4b68d274",
                "sourcePath": "C:/Users/review-secret/video.mp4"
            }),
            json!({"selectionToken": "7ea6cd50-4dd6-4e89-a0e5-1aee4b68d274"}),
        ] {
            let error = resolve_local_media_worker_request(&state, request)
                .expect_err("invalid request must fail");
            assert_eq!(error.code, "LOCAL_MEDIA_SELECTION_INVALID");
            assert!(!format!("{error:?}").contains("review-secret"));
        }
    }

    #[test]
    fn selection_cleanup_is_closed_over_success_invalid_source_and_retryable_failure() {
        assert!(should_clear_selection_after_result(&result(
            "completed",
            None
        )));

        for code in [
            "LOCAL_MEDIA_SELECTION_INVALID",
            "LOCAL_MEDIA_SELECTION_CHANGED",
            "LOCAL_MEDIA_UNSUPPORTED_FORMAT",
            "LOCAL_MEDIA_UNAVAILABLE",
            "LOCAL_MEDIA_LINKED",
            "LOCAL_MEDIA_VALIDATION_FAILED",
            "LOCAL_MEDIA_KIND_MISMATCH",
            "LOCAL_VIDEO_STREAM_MISSING",
            "LOCAL_VIDEO_AUDIO_STREAM_MISSING",
            "LOCAL_AUDIO_STREAM_MISSING",
        ] {
            assert!(
                should_clear_selection_after_result(&result("failed", Some(code))),
                "{code} must require reselection"
            );
        }

        for code in [
            "WORKER_CANCELLED",
            "WORKER_IDLE_TIMEOUT",
            "WORKER_PROCESS_FAILED",
            "LOCAL_VIDEO_COPY_FAILED",
            "AUDIO_NORMALIZATION_FAILED",
        ] {
            assert!(
                !should_clear_selection_after_result(&result("failed", Some(code))),
                "{code} must retain the selection for retry"
            );
        }
    }

    #[test]
    fn tombstone_finalization_only_fires_for_terminal_worker_failures() {
        // worker 进程已终结且未返回任务身份 → 应回写
        for code in [
            "WORKER_PROCESS_FAILED",
            "WORKER_CANCELLED",
            "WORKER_IDLE_TIMEOUT",
            "WORKER_EXECUTION_TIMEOUT",
            "WORKER_PROTOCOL_VIOLATION",
        ] {
            assert!(
                should_finalize_processing_tombstone(&result("failed", Some(code))),
                "{code} must trigger tombstone finalization"
            );
        }

        // WORKER_ALREADY_RUNNING：另一任务仍在运行，其 tombstone 属于活任务，绝不回写
        assert!(!should_finalize_processing_tombstone(&result(
            "failed",
            Some("WORKER_ALREADY_RUNNING")
        )));
        // WORKER_REQUEST_TRANSPORT_FAILED：worker 从未启动，没有属于本次运行的 tombstone
        assert!(!should_finalize_processing_tombstone(&result(
            "failed",
            Some("WORKER_REQUEST_TRANSPORT_FAILED")
        )));

        // 成功完成（task_id 非 null）不回写；failed 无 error 的结果在协议层
        // 就被 validate_task_result 拒绝（failed 必须携带 error），无需覆盖
        assert!(!should_finalize_processing_tombstone(&result(
            "completed",
            None
        )));
    }
}
