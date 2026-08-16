use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use crate::{
    ensure_runtime_dirs, path_to_env_string, resolve_runtime_paths, RuntimePaths,
    AUDIO_REVIEW_CACHE_DIR_NAME, CACHE_DIR_NAME,
};

pub(crate) const DOTENV_FILE_NAME: &str = ".env";
pub(crate) const LLM_PROVIDER_ENV: &str = "STUDYMIND_LLM_PROVIDER";
pub(crate) const LLM_BASE_URL_ENV: &str = "STUDYMIND_LLM_BASE_URL";
pub(crate) const LLM_API_KEY_ENV: &str = "STUDYMIND_LLM_API_KEY";
pub(crate) const LLM_MODEL_ENV: &str = "STUDYMIND_LLM_MODEL";
pub(crate) const LLM_TIMEOUT_ENV: &str = "STUDYMIND_LLM_TIMEOUT_SECONDS";
pub(crate) const LLM_SOURCE_ENV: &str = "STUDYMIND_LLM_SOURCE";
pub(crate) const LLM_CHECKOUT_URL_ENV: &str = "STUDYMIND_LLM_CHECKOUT_URL";
pub(crate) const LLM_SESSION_TOKEN_ENV: &str = "STUDYMIND_LLM_SESSION_TOKEN";
pub(crate) const LLM_CHECKOUT_REQUEST_ID_ENV: &str = "STUDYMIND_LLM_CHECKOUT_REQUEST_ID";
pub(crate) const ASR_MODEL_ENV: &str = "STUDYMIND_ASR_MODEL";
pub(crate) const ASR_MODEL_DOWNLOAD_URL_ENV: &str = "STUDYMIND_ASR_MODEL_DOWNLOAD_URL";
pub(crate) const ASR_MODEL_DOWNLOAD_SHA256_ENV: &str = "STUDYMIND_ASR_MODEL_DOWNLOAD_SHA256";
pub(crate) const MODELSCOPE_ENDPOINT_ENV: &str = "STUDYMIND_MODELSCOPE_ENDPOINT";
pub(crate) const SENSEVOICE_REVISION_ENV: &str = "STUDYMIND_SENSEVOICE_REVISION";

const LEGACY_LOCAL_LLM_ENV_KEYS: [&str; 5] = [
    LLM_PROVIDER_ENV,
    LLM_BASE_URL_ENV,
    LLM_API_KEY_ENV,
    LLM_MODEL_ENV,
    LLM_TIMEOUT_ENV,
];
const APP_SETTINGS_DOTENV_TEMPLATE: &str = "# StudyMind desktop local settings.\n\
# This file lives in app-local data and is read by the desktop client/worker.\n\
# Insight LLM configuration is managed by the StudyMind server Admin Web.\n\
# Do not put STUDYMIND_LLM_* keys here.\n\
\n\
# StudyMind server used for desktop account login and managed LLM checkout.\n\
STUDYMIND_SERVER_BASE_URL=https://studymind.8xf.pro\n\
\n\
# Optional output directory for generated videos, transcripts, and insights.\n\
# Leave blank to use app-local data outputs/.\n\
STUDYMIND_OUTPUT_DIR=\n\
\n\
# Local ASR model for new transcription tasks.\n\
STUDYMIND_ASR_MODEL=iic/SenseVoiceSmall\n\
\n\
# Optional release ASR model download overrides.\n\
# STUDYMIND_ASR_MODEL_DOWNLOAD_URL=\n\
# STUDYMIND_ASR_MODEL_DOWNLOAD_SHA256=\n\
# STUDYMIND_MODELSCOPE_ENDPOINT=\n\
# STUDYMIND_SENSEVOICE_REVISION=master\n";

#[derive(Debug, Deserialize)]
pub(crate) struct LlmConfigInput {
    #[serde(default)]
    pub(crate) output_dir: String,
    #[serde(default)]
    pub(crate) asr_model: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct LlmConfigView {
    pub(crate) output_dir: String,
    pub(crate) asr_model: String,
    pub(crate) supported_asr_models: Vec<String>,
    pub(crate) config_path: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub(crate) struct AudioReviewCacheUsageView {
    pub(crate) size_bytes: u64,
    pub(crate) cache_path: String,
}

#[tauri::command]
pub(crate) fn get_llm_config(app: AppHandle) -> Result<LlmConfigView, String> {
    let paths = resolve_runtime_paths(&app)?;
    ensure_runtime_dirs(&paths)?;
    load_llm_config_from_file(&env_path(&paths))
}

#[tauri::command]
pub(crate) fn save_llm_config(
    app: AppHandle,
    config: LlmConfigInput,
) -> Result<LlmConfigView, String> {
    let paths = resolve_runtime_paths(&app)?;
    ensure_runtime_dirs(&paths)?;
    save_llm_config_to_file(&env_path(&paths), config)
}

#[tauri::command]
pub(crate) fn get_audio_review_cache_usage(
    app: AppHandle,
) -> Result<AudioReviewCacheUsageView, String> {
    let paths = resolve_runtime_paths(&app)?;
    ensure_runtime_dirs(&paths)?;
    audio_review_cache_usage_from_cache(&paths.user_data_dir.join(CACHE_DIR_NAME))
}

#[tauri::command]
pub(crate) fn clear_audio_review_cache(
    app: AppHandle,
) -> Result<AudioReviewCacheUsageView, String> {
    let paths = resolve_runtime_paths(&app)?;
    ensure_runtime_dirs(&paths)?;
    clear_audio_review_cache_from_cache(&paths.user_data_dir.join(CACHE_DIR_NAME))
}

pub(crate) fn load_llm_config_from_file(path: &Path) -> Result<LlmConfigView, String> {
    ensure_app_settings_dotenv(path)?;
    let values = parse_dotenv_values(path)?;
    Ok(LlmConfigView {
        output_dir: values
            .get(crate::OUTPUT_DIR_ENV)
            .cloned()
            .unwrap_or_default(),
        asr_model: resolve_asr_model_value(values.get(ASR_MODEL_ENV).cloned())?,
        supported_asr_models: supported_asr_models(),
        config_path: path_to_env_string(path),
    })
}

pub(crate) fn save_llm_config_to_file(
    path: &Path,
    config: LlmConfigInput,
) -> Result<LlmConfigView, String> {
    ensure_app_settings_dotenv(path)?;
    let output_dir = sanitize_optional_env_value(config.output_dir, crate::OUTPUT_DIR_ENV)?;
    let asr_model = resolve_asr_model_value(Some(config.asr_model))?;
    write_dotenv_updates_removing(
        path,
        &[
            (crate::OUTPUT_DIR_ENV, output_dir),
            (ASR_MODEL_ENV, asr_model),
        ],
        &[
            LLM_PROVIDER_ENV,
            LLM_BASE_URL_ENV,
            LLM_API_KEY_ENV,
            LLM_MODEL_ENV,
            LLM_TIMEOUT_ENV,
        ],
    )?;
    load_llm_config_from_file(path)
}

pub(crate) fn env_path(paths: &RuntimePaths) -> PathBuf {
    paths.user_data_dir.join(DOTENV_FILE_NAME)
}

pub(crate) fn audio_review_cache_usage_from_cache(
    cache_root: &Path,
) -> Result<AudioReviewCacheUsageView, String> {
    let cache_root = ensure_canonical_dir(cache_root, "app-local cache directory")?;
    let cache_dir = audio_review_cache_dir(&cache_root);
    Ok(AudioReviewCacheUsageView {
        size_bytes: directory_size_bytes(&cache_dir)?,
        cache_path: path_to_env_string(cache_dir),
    })
}

pub(crate) fn clear_audio_review_cache_from_cache(
    cache_root: &Path,
) -> Result<AudioReviewCacheUsageView, String> {
    let cache_root = ensure_canonical_dir(cache_root, "app-local cache directory")?;
    let cache_dir = audio_review_cache_dir(&cache_root);
    if cache_dir.exists() {
        let metadata = fs::symlink_metadata(&cache_dir)
            .map_err(|error| format!("Failed to inspect audio playback cache: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("Refusing to clear symlinked audio playback cache.".to_string());
        }
        let canonical_cache = cache_dir
            .canonicalize()
            .map_err(|error| format!("Failed to resolve audio playback cache: {error}"))?;
        if canonical_cache == cache_root || !canonical_cache.starts_with(&cache_root) {
            return Err(
                "Refusing to clear audio playback cache outside app-local cache.".to_string(),
            );
        }
        if metadata.is_dir() {
            fs::remove_dir_all(&cache_dir)
                .map_err(|error| format!("Failed to clear audio playback cache: {error}"))?;
        } else {
            fs::remove_file(&cache_dir)
                .map_err(|error| format!("Failed to clear audio playback cache file: {error}"))?;
        }
    }
    audio_review_cache_usage_from_cache(&cache_root)
}

fn audio_review_cache_dir(cache_root: &Path) -> PathBuf {
    cache_root.join(AUDIO_REVIEW_CACHE_DIR_NAME)
}

fn ensure_canonical_dir(path: &Path, label: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(path).map_err(|error| format!("Failed to create {label}: {error}"))?;
    path.canonicalize()
        .map_err(|error| format!("Failed to resolve {label}: {error}"))
}

fn directory_size_bytes(path: &Path) -> Result<u64, String> {
    if !path.exists() {
        return Ok(0);
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Failed to inspect audio playback cache: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Ok(0);
    }
    if metadata.is_file() {
        return Ok(metadata.len());
    }

    let mut size = 0;
    for entry in fs::read_dir(path)
        .map_err(|error| format!("Failed to read audio playback cache: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Failed to read audio playback cache: {error}"))?;
        size += directory_size_bytes(&entry.path())?;
    }
    Ok(size)
}

pub(crate) fn legacy_local_llm_env_removals() -> Vec<String> {
    LEGACY_LOCAL_LLM_ENV_KEYS
        .iter()
        .map(|key| (*key).to_string())
        .collect()
}

pub(crate) fn configured_env_value(
    config_values: &HashMap<String, String>,
    key: &str,
) -> Option<String> {
    config_values
        .get(key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            std::env::var(key)
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
}

pub(crate) fn asr_model_source(config_values: &HashMap<String, String>) -> String {
    if configured_env_value(config_values, ASR_MODEL_DOWNLOAD_URL_ENV).is_some() {
        "custom_url".to_string()
    } else {
        "modelscope".to_string()
    }
}

pub(crate) fn supported_asr_models() -> Vec<String> {
    crate::SUPPORTED_ASR_MODELS
        .iter()
        .map(|model| (*model).to_string())
        .collect()
}

pub(crate) fn resolve_asr_model_value(value: Option<String>) -> Result<String, String> {
    let model = value.unwrap_or_default().trim().to_string();
    if model.is_empty() {
        return Ok(crate::DEFAULT_ASR_MODEL.to_string());
    }

    if crate::SUPPORTED_ASR_MODELS.contains(&model.as_str()) {
        Ok(model)
    } else {
        Err(format!("Unsupported ASR model: {model}"))
    }
}

pub(crate) fn parse_dotenv_values(path: &Path) -> Result<HashMap<String, String>, String> {
    if !path.exists() {
        return Ok(HashMap::new());
    }

    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let mut values = HashMap::new();
    for raw_line in content.lines() {
        let Some((key, value)) = parse_dotenv_assignment(raw_line) else {
            continue;
        };
        values.insert(key.to_string(), strip_env_quotes(value.trim()).to_string());
    }
    Ok(values)
}

pub(crate) fn ensure_app_settings_dotenv(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, APP_SETTINGS_DOTENV_TEMPLATE).map_err(|error| error.to_string())
}

fn write_dotenv_updates_removing(
    path: &Path,
    updates: &[(&str, String)],
    remove_keys: &[&str],
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let existing_content = if path.exists() {
        fs::read_to_string(path).map_err(|error| error.to_string())?
    } else {
        String::new()
    };
    let update_map: HashMap<&str, &str> = updates
        .iter()
        .map(|(key, value)| (*key, value.as_str()))
        .collect();
    let mut written_keys: Vec<String> = Vec::new();
    let mut lines = Vec::new();

    for line in existing_content.lines() {
        if let Some((key, _)) = parse_dotenv_assignment(line) {
            if remove_keys.iter().any(|remove_key| remove_key == &key) {
                continue;
            }

            if let Some(value) = update_map.get(key) {
                if !written_keys.iter().any(|written| written == key) {
                    lines.push(format!("{key}={value}"));
                    written_keys.push(key.to_string());
                }
                continue;
            }
        }

        lines.push(line.to_string());
    }

    for (key, value) in updates {
        if !written_keys.iter().any(|written| written == key) {
            lines.push(format!("{key}={value}"));
        }
    }

    fs::write(path, format!("{}\n", lines.join("\n"))).map_err(|error| error.to_string())
}

fn parse_dotenv_assignment(line: &str) -> Option<(&str, &str)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') || !line.contains('=') {
        return None;
    }

    let line = line.strip_prefix("export ").unwrap_or(line).trim();
    let (key, value) = line.split_once('=')?;
    let key = key.trim();
    if key.is_empty() {
        return None;
    }

    Some((key, value))
}

fn strip_env_quotes(value: &str) -> &str {
    let bytes = value.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

fn sanitize_optional_env_value(value: String, label: &str) -> Result<String, String> {
    if value.contains('\n') || value.contains('\r') {
        return Err(format!("{label} must be a single line."));
    }

    Ok(value.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::{audio_review_cache_usage_from_cache, clear_audio_review_cache_from_cache};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn audio_review_cache_usage_and_clear_only_touch_playback_cache() {
        let app_root = temp_dir("audio_review_cache_usage_and_clear");
        let cache_root = app_root.join("cache");
        let outputs_root = app_root.join("outputs");
        let cache_dir = cache_root.join(".StudyMind-audio-review");
        let task_audio = outputs_root
            .join("tasks")
            .join("task-1")
            .join("media")
            .join("audio.wav");
        fs::create_dir_all(cache_dir.join("task-1")).expect("create cache dir");
        fs::create_dir_all(task_audio.parent().expect("task audio parent"))
            .expect("create task dir");
        fs::write(cache_dir.join("task-1").join("audio.wav"), [1_u8; 5])
            .expect("write cached audio");
        fs::write(cache_dir.join("task-1").join("metadata.json"), [2_u8; 7])
            .expect("write cache metadata");
        fs::write(&task_audio, [3_u8; 11]).expect("write original task audio");

        let usage = audio_review_cache_usage_from_cache(&cache_root).expect("read cache usage");

        assert_eq!(usage.size_bytes, 12);
        assert!(usage.cache_path.ends_with("cache/.StudyMind-audio-review"));

        let cleared = clear_audio_review_cache_from_cache(&cache_root).expect("clear audio cache");

        assert_eq!(cleared.size_bytes, 0);
        assert!(!cache_dir.exists());
        assert_eq!(
            fs::read(task_audio).expect("read original task audio"),
            [3_u8; 11]
        );
    }

    fn temp_dir(test_name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("StudyMind-{test_name}-{unique}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }
}
