mod local_media;
mod retry_insights;
mod task_result;

use crate::task_manifest;
use crate::worker_runtime::TaskTerminalResult;
use crate::{CancelProcessResult, ProcessSupervisors};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, State, Window};

#[derive(Debug, Serialize)]
struct WorkerError {
    code: String,
    message: String,
    stage: String,
}

#[derive(Debug, Serialize)]
struct ProcessVideoResult {
    status: String,
    task_id: Option<String>,
    task_dir: Option<String>,
    artifacts: HashMap<String, String>,
    text: String,
    summary: String,
    insights: Vec<task_manifest::InsightView>,
    transcript: Option<task_manifest::TranscriptMetadata>,
    dissection: Option<crate::worker_runtime::TaskDissection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dissection_source_status: Option<task_manifest::DissectionSourceStatus>,
    error: Option<WorkerError>,
}

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

fn closed_task_result(value: serde_json::Value) -> TaskTerminalResult {
    TaskTerminalResult::from_value(value)
        .expect("trusted desktop task result must satisfy the terminal contract")
}
