use crate::{task_manifest, AUDIO_REVIEW_CACHE_DIR_NAME};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub(super) struct AudioPlaybackPaths {
    pub(super) source_path: String,
    pub(super) asset_path: String,
}

pub(super) fn load_audio_paths(
    task: &task_manifest::SupportedTask,
    direct_audio_root: &Path,
    playback_cache_root: &Path,
) -> Result<Option<AudioPlaybackPaths>, String> {
    let Some(audio_path) =
        task.validated_existing_artifact_path(task_manifest::TaskArtifact::Audio)?
    else {
        return Ok(None);
    };
    validate_audio_path(&audio_path)?;
    let source_path = audio_path
        .canonicalize()
        .map_err(|_| "Failed to resolve audio artifact.".to_string())?;
    let asset_path = ensure_audio_asset_path(
        &source_path,
        direct_audio_root,
        playback_cache_root,
        task.task_id(),
    )?;
    Ok(Some(AudioPlaybackPaths {
        source_path: task_manifest::path_to_frontend_string(source_path),
        asset_path: task_manifest::path_to_frontend_string(asset_path),
    }))
}

fn ensure_audio_asset_path(
    source_path: &Path,
    direct_audio_root: &Path,
    playback_cache_root: &Path,
    task_id: &str,
) -> Result<PathBuf, String> {
    let direct_audio_root = ensure_canonical_dir(direct_audio_root, "direct audio asset root")?;
    if source_path.starts_with(&direct_audio_root) {
        return Ok(source_path.to_path_buf());
    }
    let playback_cache_root =
        ensure_canonical_dir(playback_cache_root, "audio playback cache root")?;

    let extension = source_path
        .extension()
        .and_then(|extension| extension.to_str())
        .ok_or_else(|| "Audio artifact has no extension.".to_string())?
        .to_ascii_lowercase();
    let asset_dir = playback_cache_root
        .join(AUDIO_REVIEW_CACHE_DIR_NAME)
        .join(task_id);
    fs::create_dir_all(&asset_dir)
        .map_err(|_| "Failed to create audio playback directory.".to_string())?;
    let asset_dir = asset_dir
        .canonicalize()
        .map_err(|_| "Failed to resolve audio playback directory.".to_string())?;
    if !asset_dir.starts_with(&playback_cache_root) {
        return Err("Refusing to create audio playback asset outside app-local cache.".to_string());
    }

    let asset_path = asset_dir.join(format!("audio.{extension}"));
    copy_audio_asset(source_path, &asset_dir, &asset_path, &extension)?;
    validate_audio_asset_path(&asset_path, &playback_cache_root)
}

fn copy_audio_asset(
    source_path: &Path,
    asset_dir: &Path,
    asset_path: &Path,
    extension: &str,
) -> Result<(), String> {
    prepare_audio_asset_path(asset_path)?;
    let temp_path = asset_dir.join(format!(".audio-{}.{}.tmp", uuid::Uuid::new_v4(), extension));
    let mut source_file = fs::File::open(source_path)
        .map_err(|_| "Failed to read source audio for playback.".to_string())?;
    let mut temp_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
        .map_err(|_| "Failed to create temporary audio playback asset.".to_string())?;

    if io::copy(&mut source_file, &mut temp_file).is_err() {
        let _ = fs::remove_file(&temp_path);
        return Err("Failed to copy audio for playback.".to_string());
    }
    drop(temp_file);

    if fs::rename(&temp_path, asset_path).is_err() {
        let _ = fs::remove_file(&temp_path);
        return Err("Failed to install audio playback asset.".to_string());
    }

    Ok(())
}

fn prepare_audio_asset_path(asset_path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(asset_path) {
        Ok(metadata) => {
            if task_manifest::is_link_or_reparse_point(&metadata) {
                return Err("Refusing to replace linked audio playback asset.".to_string());
            }
            if !metadata.is_file() {
                return Err("Refusing to replace non-file audio playback asset.".to_string());
            }
            fs::remove_file(asset_path)
                .map_err(|_| "Failed to replace audio playback asset.".to_string())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Failed to inspect audio playback asset.".to_string()),
    }
}

fn validate_audio_asset_path(
    asset_path: &Path,
    playback_cache_root: &Path,
) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(asset_path)
        .map_err(|_| "Failed to inspect audio playback asset.".to_string())?;
    if task_manifest::is_link_or_reparse_point(&metadata) {
        return Err("Refusing to expose linked audio playback asset.".to_string());
    }
    if !metadata.is_file() {
        return Err("Refusing to expose non-file audio playback asset.".to_string());
    }

    let asset_path = asset_path
        .canonicalize()
        .map_err(|_| "Failed to resolve audio playback asset.".to_string())?;
    if asset_path.starts_with(playback_cache_root) {
        Ok(asset_path)
    } else {
        Err("Refusing to expose audio playback asset outside app-local cache.".to_string())
    }
}

fn ensure_canonical_dir(path: &Path, label: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(path).map_err(|_| format!("Failed to create {label}."))?;
    path.canonicalize()
        .map_err(|_| format!("Failed to resolve {label}."))
}

fn validate_audio_path(path: &Path) -> Result<(), String> {
    let Some(extension) = path.extension().and_then(|extension| extension.to_str()) else {
        return Err("Audio artifact has no extension.".to_string());
    };
    if matches!(
        extension.to_ascii_lowercase().as_str(),
        "wav" | "mp3" | "m4a" | "aac" | "flac" | "ogg"
    ) {
        Ok(())
    } else {
        Err("Path is not a supported audio file.".to_string())
    }
}
