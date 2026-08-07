mod access;
mod coordinator;
mod dissection;
mod schema;
mod source_identity;
mod storage;
mod transaction;

#[cfg(test)]
mod tests;

pub(crate) const TASK_MANIFEST_FILE_NAME: &str = "StudyMind-task.json";
pub(crate) const TASKS_DIR_NAME: &str = "tasks";
pub(crate) const TASK_SCHEMA_VERSION: u64 = 3;
pub(crate) const SOURCE_PRIVACY_MIGRATION_VERSION: u64 = 2;

#[allow(unused_imports)]
pub(crate) use access::{SupportedTask, TaskEditSession, TaskScan};
pub(crate) use dissection::{DissectionSourceStatus, DissectionView};
#[allow(unused_imports)]
pub(crate) use schema::{
    parse_insight_view, parse_insights_payload, InsightView, SafeTaskError, TaskArtifact,
    TaskSourceSummary, TranscriptMetadata,
};
pub(crate) use source_identity::SourceIdentity;
#[allow(unused_imports)]
pub(crate) use storage::{
    configured_output_root, configured_output_root_from_project, is_link_or_reparse_point,
    path_to_frontend_string,
};
pub(crate) use transaction::{commit_task_artifacts, TaskArtifactMutation};

pub(crate) fn acquire_task_mutation(
    output_root: &std::path::Path,
    task_id: &str,
) -> Result<std::sync::Arc<coordinator::TaskLease>, String> {
    let task_dir = storage::task_dir_for(output_root, task_id)?;
    coordinator::acquire_task(&task_dir)
}
