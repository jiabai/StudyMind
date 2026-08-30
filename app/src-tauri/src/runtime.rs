use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub(crate) const OUTPUT_DIR_ENV: &str = "STUDYMIND_OUTPUT_DIR";
pub(crate) const CACHE_DIR_ENV: &str = "STUDYMIND_CACHE_DIR";
pub(crate) const MODEL_DIR_ENV: &str = "STUDYMIND_MODEL_DIR";
pub(crate) const RESOURCE_DIR_ENV: &str = "STUDYMIND_RESOURCE_DIR";
pub(crate) const USER_DATA_DIR_ENV: &str = "STUDYMIND_USER_DATA_DIR";
pub(crate) const ALLOW_REAL_ASR_ENV: &str = "STUDYMIND_ALLOW_REAL_ASR";
pub(crate) const MODELSCOPE_OFFLINE_ENV: &str = "MODELSCOPE_OFFLINE";
pub(crate) const CACHE_DIR_NAME: &str = "cache";
pub(crate) const AUDIO_REVIEW_CACHE_DIR_NAME: &str = ".StudyMind-audio-review";
pub(crate) const LEGACY_TEMP_DIR_NAME: &str = "work";
pub(crate) const DESKTOP_LOG_DIR_NAME: &str = "logs";
pub(crate) const RECORDINGS_DIR_NAME: &str = "recordings";
pub(crate) const RECORDING_TEMP_DIR_NAME: &str = ".tmp";
pub(crate) const RECORDING_SESSION_MARKER_NAME: &str = ".studymind-recording-session";

#[derive(Debug, Clone)]
pub(crate) struct RuntimePaths {
    pub(crate) resource_dir: PathBuf,
    pub(crate) user_data_dir: PathBuf,
}

pub(crate) fn resolve_runtime_paths(app: &AppHandle) -> Result<RuntimePaths, String> {
    let raw_resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    Ok(RuntimePaths {
        resource_dir: normalize_resource_dir(raw_resource_dir),
        user_data_dir: app
            .path()
            .app_local_data_dir()
            .map_err(|error| error.to_string())?,
    })
}

pub(crate) fn normalize_resource_dir(resource_dir: PathBuf) -> PathBuf {
    if resource_dir_has_runtime(&resource_dir) {
        return resource_dir;
    }

    let nested_resources = resource_dir.join("resources");
    if resource_dir_has_runtime(&nested_resources) {
        return nested_resources;
    }

    resource_dir
}

fn resource_dir_has_runtime(resource_dir: &Path) -> bool {
    bundled_python_path(resource_dir).is_file()
        || resource_dir.join("worker").is_dir()
        || resource_dir.join("bin").is_dir()
}

pub(crate) fn ensure_runtime_dirs(paths: &RuntimePaths) -> Result<(), String> {
    fs::create_dir_all(paths.user_data_dir.join("outputs")).map_err(|error| error.to_string())?;
    fs::create_dir_all(paths.user_data_dir.join(CACHE_DIR_NAME))
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(paths.user_data_dir.join(DESKTOP_LOG_DIR_NAME))
        .map_err(|error| error.to_string())?;
    remove_legacy_app_local_temp_dir(paths)?;
    fs::create_dir_all(paths.user_data_dir.join("models")).map_err(|error| error.to_string())?;
    let recordings_dir = paths.user_data_dir.join(RECORDINGS_DIR_NAME);
    fs::create_dir_all(recordings_dir.join(RECORDING_TEMP_DIR_NAME))
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn cleanup_stale_recording_temp_dirs(paths: &RuntimePaths) -> Result<(), String> {
    let recording_temp_dir = paths
        .user_data_dir
        .join(RECORDINGS_DIR_NAME)
        .join(RECORDING_TEMP_DIR_NAME);
    let canonical_user_data = paths
        .user_data_dir
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let canonical_temp_dir = recording_temp_dir
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !canonical_temp_dir.starts_with(&canonical_user_data)
        || canonical_temp_dir == canonical_user_data
    {
        return Err("Refusing to clean recording temp directory outside app-local data".into());
    }

    for entry in fs::read_dir(recording_temp_dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if is_link_or_reparse_point(&metadata) {
            return Err(
                "Refusing to clean symlink or reparse point in recording temp directory".into(),
            );
        }
        if !metadata.is_dir() {
            continue;
        }

        let canonical_entry = path.canonicalize().map_err(|error| error.to_string())?;
        if !canonical_entry.starts_with(&canonical_temp_dir)
            || canonical_entry == canonical_temp_dir
        {
            return Err("Refusing to clean recording temp path outside protected directory".into());
        }

        // Only remove directories that carry the recording-session marker written by
        // LocalRecordingFileStore::prepare; anything else is left untouched.
        if !has_recording_marker(&path) {
            continue;
        }

        fs::remove_dir_all(&path).map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn has_recording_marker(dir: &Path) -> bool {
    match fs::symlink_metadata(dir.join(RECORDING_SESSION_MARKER_NAME)) {
        Ok(metadata) => metadata.is_file() && !is_link_or_reparse_point(&metadata),
        Err(_) => false,
    }
}

fn is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

fn remove_legacy_app_local_temp_dir(paths: &RuntimePaths) -> Result<(), String> {
    let legacy_path = paths.user_data_dir.join(LEGACY_TEMP_DIR_NAME);
    if !legacy_path.exists() {
        return Ok(());
    }

    let user_data_dir = paths
        .user_data_dir
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let canonical_legacy = legacy_path
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if canonical_legacy == user_data_dir || !canonical_legacy.starts_with(&user_data_dir) {
        return Err("Refusing to remove legacy temporary directory outside app-local data".into());
    }

    let metadata = fs::symlink_metadata(&legacy_path).map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        fs::remove_dir_all(&legacy_path).map_err(|error| error.to_string())
    } else {
        fs::remove_file(&legacy_path).map_err(|error| error.to_string())
    }
}

pub(crate) fn bundled_python_path(resource_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        resource_dir.join("python").join("python.exe")
    } else {
        resource_dir.join("python").join("bin").join("python3")
    }
}

pub(crate) fn prepend_to_path(path: &Path) -> Result<String, String> {
    let existing_path = std::env::var_os("PATH").unwrap_or_default();
    let paths = std::iter::once(path.to_path_buf()).chain(std::env::split_paths(&existing_path));
    std::env::join_paths(paths)
        .map(|value| value.to_string_lossy().to_string())
        .map_err(|error| error.to_string())
}

pub(crate) fn path_to_env_string(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::{
        bundled_python_path, cleanup_stale_recording_temp_dirs, ensure_runtime_dirs,
        normalize_resource_dir, RuntimePaths, LEGACY_TEMP_DIR_NAME, RECORDINGS_DIR_NAME,
        RECORDING_SESSION_MARKER_NAME, RECORDING_TEMP_DIR_NAME,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn ensure_runtime_dirs_creates_app_local_cache_dir() {
        let root = temp_dir("ensure_runtime_dirs_creates_app_local_cache_dir");
        let paths = RuntimePaths {
            resource_dir: root.join("resources"),
            user_data_dir: root.join("user-data"),
        };
        let legacy_temp_dir = paths.user_data_dir.join(LEGACY_TEMP_DIR_NAME);
        fs::create_dir_all(&legacy_temp_dir).expect("create legacy temp dir");
        fs::write(legacy_temp_dir.join("history.json"), "{}").expect("write legacy temp file");

        ensure_runtime_dirs(&paths).expect("ensure runtime dirs");

        assert!(paths.user_data_dir.join("outputs").is_dir());
        assert!(paths.user_data_dir.join("cache").is_dir());
        assert!(paths.user_data_dir.join("logs").is_dir());
        assert!(paths
            .user_data_dir
            .join(RECORDINGS_DIR_NAME)
            .join(RECORDING_TEMP_DIR_NAME)
            .is_dir());
        assert!(!legacy_temp_dir.exists());
    }

    #[test]
    fn startup_cleanup_removes_only_stale_recording_session_children() {
        let root = temp_dir("startup_cleanup_removes_stale_recording_session_children");
        let paths = RuntimePaths {
            resource_dir: root.join("resources"),
            user_data_dir: root.join("user-data"),
        };
        let stale_dir = paths
            .user_data_dir
            .join(RECORDINGS_DIR_NAME)
            .join(RECORDING_TEMP_DIR_NAME)
            .join("old-session");
        fs::create_dir_all(&stale_dir).expect("create stale recording session");
        fs::write(
            stale_dir.join(RECORDING_SESSION_MARKER_NAME),
            b"studymind-recording-session\n",
        )
        .expect("write recording marker");
        fs::write(stale_dir.join("mic.wav"), b"temporary").expect("write stale capture");

        ensure_runtime_dirs(&paths).expect("ensure runtime dirs");
        assert!(stale_dir.is_dir());
        cleanup_stale_recording_temp_dirs(&paths).expect("cleanup stale recording sessions");

        assert!(!stale_dir.exists());
        assert!(paths
            .user_data_dir
            .join(RECORDINGS_DIR_NAME)
            .join(RECORDING_TEMP_DIR_NAME)
            .is_dir());
    }

    #[test]
    fn startup_cleanup_skips_temp_dirs_without_the_recording_marker() {
        let root = temp_dir("startup_cleanup_skips_temp_dirs_without_the_recording_marker");
        let paths = RuntimePaths {
            resource_dir: root.join("resources"),
            user_data_dir: root.join("user-data"),
        };
        let temp_root = paths
            .user_data_dir
            .join(RECORDINGS_DIR_NAME)
            .join(RECORDING_TEMP_DIR_NAME);

        let unmarked_dir = temp_root.join("foreign-dir");
        fs::create_dir_all(&unmarked_dir).expect("create unmarked dir");
        fs::write(unmarked_dir.join("data.bin"), b"keep").expect("write unmarked file");

        let marked_dir = temp_root.join("marked-session");
        fs::create_dir_all(&marked_dir).expect("create marked dir");
        fs::write(
            marked_dir.join(RECORDING_SESSION_MARKER_NAME),
            b"studymind-recording-session\n",
        )
        .expect("write recording marker");

        ensure_runtime_dirs(&paths).expect("ensure runtime dirs");
        cleanup_stale_recording_temp_dirs(&paths).expect("cleanup stale recording sessions");

        assert!(unmarked_dir.is_dir(), "unmarked dir must be left untouched");
        assert!(unmarked_dir.join("data.bin").is_file());
        assert!(!marked_dir.exists(), "marked stale session must be removed");
    }

    #[test]
    fn normalize_resource_dir_uses_packaged_resources_subdir_when_tauri_returns_install_root() {
        let root = temp_dir("normalize_resource_dir_uses_packaged_resources_subdir");
        let install_root = root.join("StudyMind");
        let resources = install_root.join("resources");
        let python = bundled_python_path(&resources);
        fs::create_dir_all(python.parent().expect("packaged python parent"))
            .expect("create packaged python dir");
        fs::write(python, "python").expect("write python");

        assert_eq!(normalize_resource_dir(install_root), resources);
    }

    fn temp_dir(test_name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("StudyMind-{test_name}-{unique}"));
        fs::create_dir_all(&dir).expect("create test dir");
        dir
    }
}
