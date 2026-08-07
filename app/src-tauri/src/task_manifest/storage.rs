use super::{
    schema::{has_forbidden_component, validate_relative_artifact_path, TaskManifest},
    TASKS_DIR_NAME, TASK_MANIFEST_FILE_NAME,
};
use crate::atomic_files;
use crate::{path_to_env_string, settings, RuntimePaths, OUTPUT_DIR_ENV};
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) fn configured_output_root(paths: &RuntimePaths) -> Result<PathBuf, String> {
    configured_output_root_from_project(&paths.user_data_dir)
}

pub(crate) fn configured_output_root_from_project(project_root: &Path) -> Result<PathBuf, String> {
    let config_values =
        settings::parse_dotenv_values(&project_root.join(settings::DOTENV_FILE_NAME))?;
    let output_root = settings::configured_env_value(&config_values, OUTPUT_DIR_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| project_root.join("outputs"));
    Ok(output_root)
}

pub(crate) fn path_to_frontend_string(path: impl AsRef<Path>) -> String {
    path_to_env_string(path)
}

pub(super) fn load_task_manifest(
    output_root: &Path,
    task_id: &str,
) -> Result<(TaskManifest, PathBuf), String> {
    let task_dir = task_dir_for(output_root, task_id)?;
    validate_storage_entry(&task_dir, true, "task directory")?;
    let manifest_path = task_dir.join(TASK_MANIFEST_FILE_NAME);
    validate_storage_entry(&manifest_path, false, "task manifest")?;
    let content = fs::read_to_string(&manifest_path)
        .map_err(|_| "Failed to read task manifest.".to_string())?;
    let manifest: TaskManifest =
        serde_json::from_str(&content).map_err(|_| "Failed to parse task manifest.".to_string())?;
    if manifest.task_id != task_id.trim() {
        return Err("Task manifest id does not match requested task.".to_string());
    }
    Ok((manifest, task_dir))
}

pub(super) fn task_dir_for(output_root: &Path, task_id: &str) -> Result<PathBuf, String> {
    let task_id = validate_task_id(task_id)?;
    Ok(output_root.join(TASKS_DIR_NAME).join(task_id))
}

pub(super) fn list_task_manifest_paths(output_root: &Path) -> Result<Vec<PathBuf>, String> {
    let tasks_dir = output_root.join(TASKS_DIR_NAME);
    if !tasks_dir.exists() {
        return Ok(vec![]);
    }

    let mut paths = Vec::new();
    for entry in
        fs::read_dir(tasks_dir).map_err(|_| "Failed to read task storage directory.".to_string())?
    {
        let entry = entry.map_err(|_| "Failed to inspect task storage entry.".to_string())?;
        let task_dir = entry.path();
        let Ok(task_metadata) = fs::symlink_metadata(&task_dir) else {
            continue;
        };
        if !task_metadata.is_dir() || is_link_or_reparse_point(&task_metadata) {
            continue;
        }
        let manifest_path = task_dir.join(TASK_MANIFEST_FILE_NAME);
        let Ok(manifest_metadata) = fs::symlink_metadata(&manifest_path) else {
            continue;
        };
        if manifest_metadata.is_file() && !is_link_or_reparse_point(&manifest_metadata) {
            paths.push(manifest_path);
        }
    }
    Ok(paths)
}

pub(super) fn read_task_manifest_path(path: &Path) -> Result<(TaskManifest, PathBuf), String> {
    validate_storage_entry(path, false, "task manifest")?;
    let content =
        fs::read_to_string(path).map_err(|_| "Failed to read task manifest.".to_string())?;
    let manifest: TaskManifest =
        serde_json::from_str(&content).map_err(|_| "Failed to parse task manifest.".to_string())?;
    let task_dir = path
        .parent()
        .ok_or_else(|| "Task manifest has no parent directory.".to_string())?
        .to_path_buf();
    validate_storage_entry(&task_dir, true, "task directory")?;
    Ok((manifest, task_dir))
}

#[allow(dead_code)]
pub(super) fn write_task_manifest(task_dir: &Path, manifest: &TaskManifest) -> Result<(), String> {
    let bytes = encode_task_manifest(manifest)?;
    atomic_files::atomic_write(&task_dir.join(TASK_MANIFEST_FILE_NAME), &bytes)
        .map_err(|_| "Failed to save task manifest.".to_string())
}

pub(super) fn encode_task_manifest(manifest: &TaskManifest) -> Result<Vec<u8>, String> {
    Ok((serde_json::to_string_pretty(manifest)
        .map_err(|_| "Failed to encode task manifest.".to_string())?
        + "\n")
        .into_bytes())
}

pub(super) fn artifact_path(
    task_dir: &Path,
    manifest: &TaskManifest,
    key: &str,
) -> Result<Option<PathBuf>, String> {
    let Some(raw_path) = manifest.artifacts.get(key).map(String::as_str) else {
        return Ok(None);
    };
    let relative = validate_relative_artifact_path(raw_path, key)?;
    Ok(Some(task_dir.join(relative)))
}

pub(super) fn required_artifact_path(
    task_dir: &Path,
    manifest: &TaskManifest,
    key: &str,
) -> Result<PathBuf, String> {
    artifact_path(task_dir, manifest, key)?
        .ok_or_else(|| format!("Task manifest is missing {key} artifact."))
}

pub(super) fn validate_task_artifact_path(
    task_dir: &Path,
    path: &Path,
    _field: &str,
) -> Result<(), String> {
    let task_dir = task_dir
        .canonicalize()
        .map_err(|_| "Failed to resolve task directory.".to_string())?;
    let path = path
        .canonicalize()
        .map_err(|_| "Failed to resolve requested task artifact.".to_string())?;
    if path.starts_with(task_dir) {
        Ok(())
    } else {
        Err("Path is outside the requested task directory.".to_string())
    }
}

pub(super) fn ensure_artifact_parent(task_dir: &Path, path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Artifact path has no parent directory.".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "Failed to create artifact directory.".to_string())?;

    let task_dir = task_dir
        .canonicalize()
        .map_err(|_| "Failed to resolve task directory.".to_string())?;
    let parent = parent
        .canonicalize()
        .map_err(|_| "Failed to resolve artifact directory.".to_string())?;
    if parent.starts_with(task_dir) {
        Ok(())
    } else {
        Err("Artifact path is outside the requested task directory.".to_string())
    }
}

fn validate_task_id(task_id: &str) -> Result<String, String> {
    let task_id = task_id.trim();
    if task_id.is_empty() {
        return Err("Task id cannot be empty.".to_string());
    }
    let path = Path::new(task_id);
    if path.is_absolute()
        || has_forbidden_component(path)
        || task_id.contains('/')
        || task_id.contains('\\')
    {
        return Err("Task id must be a single directory name.".to_string());
    }
    Ok(task_id.to_string())
}

fn validate_storage_entry(path: &Path, expect_directory: bool, label: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| format!("Failed to inspect {label}."))?;
    if is_link_or_reparse_point(&metadata) {
        return Err(format!("Refusing to use linked {label}."));
    }
    if expect_directory && !metadata.is_dir() {
        return Err(format!("{label} is not a directory."));
    }
    if !expect_directory && !metadata.is_file() {
        return Err(format!("{label} is not a file."));
    }
    Ok(())
}

pub(crate) fn is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink() || is_windows_reparse_point(metadata)
}

#[cfg(windows)]
fn is_windows_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_windows_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}
