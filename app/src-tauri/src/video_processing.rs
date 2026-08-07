mod local_media;
mod retry_insights;
mod task_result;

use crate::worker_runtime::TaskTerminalResult;
use crate::{CancelProcessResult, ProcessSupervisors};
use std::sync::Arc;
use tauri::{AppHandle, State, Window};

#[tauri::command]
pub(crate) async fn process_local_media(
    window: Window,
    app: AppHandle,
    process_state: State<'_, Arc<ProcessSupervisors>>,
    selection_state: State<'_, Arc<crate::local_media::LocalMediaSelectionState>>,
    request: serde_json::Value,
) -> Result<TaskTerminalResult, String> {
    local_media::run_process_local_media(window, app, process_state, selection_state, request).await
}

#[tauri::command]
pub(crate) async fn retry_insights(
    window: Window,
    app: AppHandle,
    process_state: State<'_, Arc<ProcessSupervisors>>,
    request: serde_json::Value,
) -> Result<TaskTerminalResult, String> {
    retry_insights::run_retry_insights(window, app, process_state, request).await
}

#[tauri::command]
pub(crate) fn cancel_process(
    process_state: State<'_, Arc<ProcessSupervisors>>,
) -> Result<CancelProcessResult, String> {
    Ok(process_state.cancel_task())
}
