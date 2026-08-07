use super::{
    coordinator::{acquire_task, try_acquire_task, TaskLease},
    dissection::build_dissection_view,
    schema::{
        parse_insights_payload, validate_relative_artifact_path, InsightView, SafeTaskError,
        TaskArtifact, TaskManifest, TaskSourceSummary, TranscriptMetadata,
    },
    source_identity::SourceIdentity,
    storage::{
        artifact_path, encode_task_manifest, ensure_artifact_parent, list_task_manifest_paths,
        load_task_manifest, path_to_frontend_string, read_task_manifest_path,
        required_artifact_path, task_dir_for, validate_task_artifact_path, write_task_manifest,
    },
    transaction::recover_task_artifacts,
};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

enum ScanCandidate {
    Ready(SupportedTask),
    Busy,
    Unsupported,
}

#[derive(Debug, Clone)]
pub(crate) struct SupportedTask {
    manifest: TaskManifest,
    task_dir: PathBuf,
    _lease: Arc<TaskLease>,
}

#[derive(Debug)]
pub(crate) struct TaskScan {
    tasks: Vec<SupportedTask>,
    ignored_count: usize,
}

impl TaskScan {
    pub(crate) fn into_tasks(self) -> Vec<SupportedTask> {
        self.tasks
    }

    pub(crate) fn ignored_count(&self) -> usize {
        self.ignored_count
    }
}

impl SupportedTask {
    pub(crate) fn open(output_root: &Path, task_id: &str) -> Result<Self, String> {
        let task_dir = task_dir_for(output_root, task_id)?;
        let lease = acquire_task(&task_dir)?;
        recover_task_artifacts(&task_dir)?;
        let (manifest, task_dir) = load_task_manifest(output_root, task_id)?;
        if !manifest.source_privacy_ready() {
            return Err("Task is unavailable in the current history format.".to_string());
        }
        Ok(Self {
            manifest,
            task_dir,
            _lease: lease,
        })
    }

    pub(crate) fn scan(output_root: &Path) -> Result<TaskScan, String> {
        let mut tasks = Vec::new();
        let mut ignored_count = 0;
        for manifest_path in list_task_manifest_paths(output_root)? {
            match Self::from_manifest_path(output_root, &manifest_path) {
                Ok(ScanCandidate::Ready(task)) => tasks.push(task),
                Ok(ScanCandidate::Busy) => {}
                Ok(ScanCandidate::Unsupported) => ignored_count += 1,
                Err(_) => ignored_count += 1,
            }
        }
        Ok(TaskScan {
            tasks,
            ignored_count,
        })
    }

    fn from_manifest_path(
        output_root: &Path,
        manifest_path: &Path,
    ) -> Result<ScanCandidate, String> {
        let task_dir = manifest_path
            .parent()
            .ok_or_else(|| "Task manifest has no parent directory.".to_string())?;
        let Some(lease) = try_acquire_task(task_dir)? else {
            return Ok(ScanCandidate::Busy);
        };
        recover_task_artifacts(task_dir)?;
        let (manifest, task_dir) = read_task_manifest_path(manifest_path)?;
        let expected_task_dir = match task_dir_for(output_root, &manifest.task_id) {
            Ok(path) => path,
            Err(_) => return Ok(ScanCandidate::Unsupported),
        };
        if expected_task_dir != task_dir || !manifest.source_privacy_ready() {
            return Ok(ScanCandidate::Unsupported);
        }
        Ok(ScanCandidate::Ready(Self {
            manifest,
            task_dir,
            _lease: lease,
        }))
    }

    pub(crate) fn task_id(&self) -> &str {
        &self.manifest.task_id
    }

    pub(crate) fn created_at(&self) -> &str {
        &self.manifest.created_at
    }

    pub(crate) fn status(&self) -> &str {
        &self.manifest.status
    }

    pub(crate) fn model(&self) -> &str {
        &self.manifest.model
    }

    pub(crate) fn safe_source_url(&self) -> &str {
        self.manifest.safe_source_url()
    }

    pub(crate) fn source_identity(&self) -> Option<&SourceIdentity> {
        self.manifest.safe_source_identity()
    }

    pub(crate) fn source(&self) -> TaskSourceSummary {
        self.manifest
            .safe_source_summary()
            .expect("supported task source must remain valid")
    }

    pub(crate) fn transcript_metadata(&self) -> Option<TranscriptMetadata> {
        self.manifest.transcript_metadata()
    }

    pub(crate) fn declared_artifacts(&self) -> HashMap<String, String> {
        self.manifest.safe_artifacts()
    }

    pub(crate) fn existing_artifacts(&self) -> HashMap<String, String> {
        self.manifest
            .artifacts
            .iter()
            .filter_map(|(key, raw_path)| {
                let relative = validate_relative_artifact_path(raw_path, key).ok()?;
                let path = self.task_dir.join(relative);
                if !path.is_file()
                    || validate_task_artifact_path(&self.task_dir, &path, key).is_err()
                {
                    return None;
                }
                Some((key.clone(), raw_path.clone()))
            })
            .collect()
    }

    pub(crate) fn safe_error(&self) -> Option<SafeTaskError> {
        self.manifest.error.as_ref().map(|error| SafeTaskError {
            code: error.safe_code(),
            message: error.safe_message(),
            stage: error.stage.clone(),
        })
    }

    pub(crate) fn text_preview(&self) -> &str {
        &self.manifest.text_preview
    }

    pub(crate) fn insights_count(&self) -> usize {
        self.manifest.insights_count
    }

    pub(crate) fn task_dir_frontend_string(&self) -> String {
        path_to_frontend_string(&self.task_dir)
    }

    pub(crate) fn read_text_artifact(
        &self,
        artifact: TaskArtifact,
    ) -> Result<Option<String>, String> {
        let Some(path) = artifact_path(&self.task_dir, &self.manifest, artifact.as_str())? else {
            return Ok(None);
        };
        validate_task_artifact_path(&self.task_dir, &path, artifact.as_str())?;
        Ok(fs::read_to_string(path)
            .ok()
            .map(|text| text.trim().to_string()))
    }

    pub(crate) fn read_insights(&self) -> Result<Vec<InsightView>, String> {
        let Some(path) = self.validated_existing_artifact_path(TaskArtifact::Insights)? else {
            return Ok(vec![]);
        };
        let Ok(content) = fs::read_to_string(path) else {
            return Ok(vec![]);
        };
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(&content) else {
            return Ok(vec![]);
        };
        Ok(parse_insights_payload(&payload))
    }

    pub(crate) fn read_dissection(&self) -> Result<Option<super::DissectionView>, String> {
        let Some(report_path) = self.validated_existing_artifact_path(TaskArtifact::Dissection)?
        else {
            return Ok(None);
        };
        let transcript_path = self.required_existing_artifact_path(TaskArtifact::TranscriptTxt)?;
        let report_bytes = fs::read(report_path)
            .map_err(|_| "Task dissection artifact is invalid.".to_string())?;
        let transcript_bytes = fs::read(transcript_path)
            .map_err(|_| "Task dissection artifact is invalid.".to_string())?;
        let report = serde_json::from_slice(&report_bytes)
            .map_err(|_| "Task dissection artifact is invalid.".to_string())?;
        build_dissection_view(report, &transcript_bytes).map(Some)
    }

    pub(crate) fn validated_existing_artifact_path(
        &self,
        artifact: TaskArtifact,
    ) -> Result<Option<PathBuf>, String> {
        let Some(path) = artifact_path(&self.task_dir, &self.manifest, artifact.as_str())? else {
            return Ok(None);
        };
        if !path.exists() {
            return Ok(None);
        }
        validate_task_artifact_path(&self.task_dir, &path, artifact.as_str())?;
        Ok(Some(path))
    }

    pub(crate) fn required_existing_artifact_path(
        &self,
        artifact: TaskArtifact,
    ) -> Result<PathBuf, String> {
        self.validated_existing_artifact_path(artifact)?
            .ok_or_else(|| format!("Task manifest is missing {} artifact.", artifact.as_str()))
    }

    pub(crate) fn artifact_path_or_default(
        &self,
        artifact: TaskArtifact,
        default_relative_path: &str,
    ) -> Result<PathBuf, String> {
        if let Some(path) = artifact_path(&self.task_dir, &self.manifest, artifact.as_str())? {
            return Ok(path);
        }
        let relative = validate_relative_artifact_path(default_relative_path, artifact.as_str())?;
        Ok(self.task_dir.join(relative))
    }

    pub(crate) fn task_dir(&self) -> &Path {
        &self.task_dir
    }

    pub(crate) fn validate_existing_path(
        &self,
        path: &Path,
        artifact: TaskArtifact,
    ) -> Result<(), String> {
        validate_task_artifact_path(&self.task_dir, path, artifact.as_str())
    }

    pub(crate) fn into_edit_session(self) -> TaskEditSession {
        TaskEditSession {
            manifest: self.manifest,
            task_dir: self.task_dir,
            _lease: self._lease,
        }
    }
}

pub(crate) struct TaskEditSession {
    manifest: TaskManifest,
    task_dir: PathBuf,
    _lease: Arc<TaskLease>,
}

impl TaskEditSession {
    pub(crate) fn task_dir(&self) -> &Path {
        &self.task_dir
    }

    pub(crate) fn required_existing_artifact_path(
        &self,
        artifact: TaskArtifact,
    ) -> Result<PathBuf, String> {
        let path = required_artifact_path(&self.task_dir, &self.manifest, artifact.as_str())?;
        validate_task_artifact_path(&self.task_dir, &path, artifact.as_str())?;
        Ok(path)
    }

    pub(crate) fn artifact_path_or_default(
        &self,
        artifact: TaskArtifact,
        default_relative_path: &str,
    ) -> Result<PathBuf, String> {
        if let Some(path) = artifact_path(&self.task_dir, &self.manifest, artifact.as_str())? {
            return Ok(path);
        }
        let relative = validate_relative_artifact_path(default_relative_path, artifact.as_str())?;
        Ok(self.task_dir.join(relative))
    }

    pub(crate) fn has_artifact(&self, artifact: TaskArtifact) -> bool {
        self.manifest.artifacts.contains_key(artifact.as_str())
    }

    pub(crate) fn validate_existing_path(
        &self,
        path: &Path,
        artifact: TaskArtifact,
    ) -> Result<(), String> {
        validate_task_artifact_path(&self.task_dir, path, artifact.as_str())
    }

    pub(crate) fn ensure_artifact_parent(&self, path: &Path) -> Result<(), String> {
        ensure_artifact_parent(&self.task_dir, path)
    }

    pub(crate) fn set_artifact(
        &mut self,
        artifact: TaskArtifact,
        relative_path: &str,
    ) -> Result<(), String> {
        validate_relative_artifact_path(relative_path, artifact.as_str())?;
        self.manifest
            .artifacts
            .insert(artifact.as_str().to_string(), relative_path.to_string());
        Ok(())
    }

    pub(crate) fn set_text_preview(&mut self, text_preview: String) {
        self.manifest.text_preview = text_preview;
    }

    pub(crate) fn declared_artifacts(&self) -> HashMap<String, String> {
        self.manifest.safe_artifacts()
    }

    #[allow(dead_code)]
    pub(crate) fn save(&self) -> Result<(), String> {
        write_task_manifest(&self.task_dir, &self.manifest)
    }

    pub(crate) fn encoded_manifest(&self) -> Result<Vec<u8>, String> {
        encode_task_manifest(&self.manifest)
    }
}
