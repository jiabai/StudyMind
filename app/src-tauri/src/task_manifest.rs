mod access;
mod coordinator;
mod dissection;
mod schema;
mod storage;
mod transaction;

#[cfg(test)]
mod tests;

pub(crate) const TASK_MANIFEST_FILE_NAME: &str = "StudyMind-task.json";
pub(crate) const TASKS_DIR_NAME: &str = "tasks";
pub(crate) const TASK_SCHEMA_VERSION: u64 = 4;

#[allow(unused_imports)]
pub(crate) use access::{SupportedTask, TaskEditSession, TaskScan};
pub(crate) use dissection::{DissectionSourceStatus, DissectionView};
#[allow(unused_imports)]
pub(crate) use schema::{
    parse_insight_view, parse_insights_payload, InsightView, SafeTaskError, TaskArtifact,
    TaskSourceSummary, TranscriptMetadata,
};
#[allow(unused_imports)]
pub(crate) use storage::{
    configured_output_root, configured_output_root_from_project, is_link_or_reparse_point,
    path_to_frontend_string,
};
pub(crate) use transaction::{
    commit_task_artifacts, TaskArtifactMutation, ARTIFACT_RECOVERY_ERROR,
};

pub(crate) fn acquire_task_mutation(
    output_root: &std::path::Path,
    task_id: &str,
) -> Result<std::sync::Arc<coordinator::TaskLease>, String> {
    let task_dir = storage::task_dir_for(output_root, task_id)?;
    coordinator::acquire_task(&task_dir)
}

/// 将磁盘上处于 `processing` 墓碑态的任务回写为终态。
///
/// Worker 进程原生崩溃（segfault / 访问冲突）不会抛 Python 异常，因此
/// `orchestration.py` 的 `except Exception` 兜底无法覆盖——此时磁盘上的
/// `processing` tombstone（由 `persist_initial_manifest` 写入）不会被
/// `finalize` 覆盖，任务会永远停在"处理中"。本函数在 desktop 侧收到失败
/// 终端结果时调用，把所有 `processing` tombstone 回写为 `failed` + 对应
/// error，使任务在历史侧边栏显示为失败、可删除。
///
/// 安全性：`resource_throttle` 保证同一时刻只有一个 worker 运行，且
/// `processing` 是本次才引入的状态（旧崩溃残留为 `failed`），因此任何
/// `processing` tombstone 必然属于当前刚失败的任务，不会误伤历史任务。
/// 成功完成的任务其 tombstone 已被 `finalize` 覆盖为 `completed`，不会
/// 匹配 `processing`。
pub(crate) fn finalize_processing_tombstones(
    output_root: &std::path::Path,
    status: &str,
    error_code: &str,
    error_message: &str,
    error_stage: &str,
) -> Result<usize, String> {
    let paths = storage::list_task_manifest_paths(output_root)?;
    let mut finalized = 0usize;
    for manifest_path in paths {
        let (mut manifest, task_dir) = match storage::read_task_manifest_path(&manifest_path) {
            Ok(loaded) => loaded,
            Err(_) => continue,
        };
        if manifest.status != "processing" {
            continue;
        }
        manifest.status = status.to_string();
        manifest.error = Some(schema::TaskManifestError {
            code: error_code.to_string(),
            message: error_message.to_string(),
            stage: error_stage.to_string(),
        });
        if storage::write_task_manifest(&task_dir, &manifest).is_ok() {
            finalized += 1;
        }
    }
    Ok(finalized)
}
