use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use super::wav_writer::read_wave_info;
use super::{RecordingError, RECORDING_LIBRARY_UNAVAILABLE};

const RECORDING_FILE_PREFIX: &str = "recording_";
const RECORDING_FILE_SUFFIX: &str = ".wav";
pub(crate) const RECORDING_LIBRARY_CONTRACT_VERSION: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordingLibraryEntry {
    pub(crate) recording_id: String,
    pub(crate) path: String,
    pub(crate) display_name: String,
    pub(crate) size_bytes: u64,
    pub(crate) duration_ms: u64,
    pub(crate) created_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordingLibraryView {
    pub(crate) contract_version: u8,
    pub(crate) entries: Vec<RecordingLibraryEntry>,
    pub(crate) total_bytes: u64,
}

pub(crate) fn collect_recording_library(
    recordings_dir: &Path,
) -> Result<RecordingLibraryView, RecordingError> {
    let mut entries = fs::read_dir(recordings_dir)
        .map_err(|_| RecordingError::new(RECORDING_LIBRARY_UNAVAILABLE))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| read_entry(&entry.path()))
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        right
            .created_at_ms
            .cmp(&left.created_at_ms)
            .then_with(|| right.recording_id.cmp(&left.recording_id))
    });
    let total_bytes = entries.iter().map(|entry| entry.size_bytes).sum();
    Ok(RecordingLibraryView {
        contract_version: RECORDING_LIBRARY_CONTRACT_VERSION,
        entries,
        total_bytes,
    })
}

fn read_entry(path: &Path) -> Option<RecordingLibraryEntry> {
    let file_name = path.file_name()?.to_str()?.to_string();
    if file_name.starts_with('.') || file_name == crate::RECORDING_TEMP_DIR_NAME {
        return None;
    }
    if !file_name.to_ascii_lowercase().ends_with(RECORDING_FILE_SUFFIX) {
        return None;
    }
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let info = read_wave_info(path).ok()?;
    let bytes_per_second =
        u64::from(info.format.block_align).checked_mul(u64::from(info.format.sample_rate))?;
    if bytes_per_second == 0 {
        return None;
    }
    let duration_ms = info.data_bytes.saturating_mul(1_000) / bytes_per_second;
    Some(RecordingLibraryEntry {
        recording_id: file_name.clone(),
        path: path.to_string_lossy().to_string(),
        display_name: file_name.clone(),
        size_bytes: metadata.len(),
        duration_ms,
        created_at_ms: created_at_ms(&file_name, &metadata),
    })
}

fn created_at_ms(file_name: &str, metadata: &fs::Metadata) -> u64 {
    parse_recording_timestamp(file_name).unwrap_or_else(|| modified_ms(metadata))
}

fn parse_recording_timestamp(file_name: &str) -> Option<u64> {
    let digits = file_name
        .strip_prefix(RECORDING_FILE_PREFIX)?
        .strip_suffix(RECORDING_FILE_SUFFIX)?;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse::<u64>().ok()
}

fn modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn collect_recording_library_for_app(
    app: &tauri::AppHandle,
) -> Result<RecordingLibraryView, RecordingError> {
    let paths = crate::resolve_runtime_paths(app)
        .map_err(|_| RecordingError::new(RECORDING_LIBRARY_UNAVAILABLE))?;
    collect_recording_library(&paths.user_data_dir.join(crate::RECORDINGS_DIR_NAME))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    use crate::audio_capture::wav_writer::{WaveFormat, WaveWriter};
    use uuid::Uuid;

    fn temp_root(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "studymind-recording-library-{}-{}",
            label,
            Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("create temp root");
        dir
    }

    fn write_wav(path: &Path, frames: u64) {
        let format = WaveFormat::pcm_s16le(1, 16_000).expect("pcm format");
        let mut writer = WaveWriter::create(path, format).expect("create writer");
        writer.write_silence(frames).expect("write silence");
        writer.finish().expect("finish wav");
    }

    fn collect(dir: &Path) -> RecordingLibraryView {
        collect_recording_library(dir).expect("collect library")
    }

    #[test]
    fn empty_directory_returns_empty_list() {
        let root = temp_root("empty");
        let view = collect(&root);
        assert!(view.entries.is_empty());
        assert_eq!(view.total_bytes, 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn lists_saved_recordings_newest_first() {
        let root = temp_root("order");
        write_wav(&root.join("recording_1000.wav"), 16_000);
        write_wav(&root.join("recording_3000.wav"), 16_000);
        write_wav(&root.join("recording_2000.wav"), 16_000);

        let view = collect(&root);
        let ids = view
            .entries
            .iter()
            .map(|entry| entry.recording_id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["recording_3000.wav", "recording_2000.wav", "recording_1000.wav"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn skips_temp_dir_dot_files_and_non_wav() {
        let root = temp_root("skip");
        write_wav(&root.join("recording_1000.wav"), 16_000);
        fs::create_dir_all(root.join(crate::RECORDING_TEMP_DIR_NAME)).expect("create temp dir");
        write_wav(
            &root
                .join(crate::RECORDING_TEMP_DIR_NAME)
                .join("recording_9999.wav"),
            16_000,
        );
        write_wav(&root.join(".hidden.wav"), 16_000);
        fs::write(root.join("notes.txt"), b"not audio").expect("write txt");

        let view = collect(&root);
        assert_eq!(view.entries.len(), 1);
        assert_eq!(view.entries[0].recording_id, "recording_1000.wav");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn duration_comes_from_the_wave_header() {
        let root = temp_root("duration");
        write_wav(&root.join("recording_1000.wav"), 16_000 * 3);

        let view = collect(&root);
        assert_eq!(view.entries.len(), 1);
        assert_eq!(view.entries[0].duration_ms, 3_000);
        assert!(view.entries[0].size_bytes > 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn skips_unreadable_file_and_keeps_the_rest() {
        let root = temp_root("corrupt");
        write_wav(&root.join("recording_1000.wav"), 16_000);
        fs::write(root.join("recording_2000.wav"), b"not a wave file").expect("write corrupt");

        let view = collect(&root);
        assert_eq!(view.entries.len(), 1);
        assert_eq!(view.entries[0].recording_id, "recording_1000.wav");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn falls_back_to_mtime_when_filename_has_no_timestamp() {
        let root = temp_root("mtime");
        let path = root.join("recording_unknown.wav");
        write_wav(&path, 16_000);

        let view = collect(&root);
        assert_eq!(view.entries.len(), 1);
        let modified_ms = fs::metadata(&path)
            .expect("metadata")
            .modified()
            .expect("modified")
            .duration_since(UNIX_EPOCH)
            .expect("after epoch")
            .as_millis() as u64;
        let diff = view.entries[0].created_at_ms.abs_diff(modified_ms);
        assert!(diff < 5_000, "unexpected created_at_ms drift: {diff}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_directory_reports_library_unavailable() {
        let root = temp_root("missing");
        let missing = root.join("does-not-exist");
        let error = collect_recording_library(&missing).expect_err("must fail");
        assert_eq!(error.code, RECORDING_LIBRARY_UNAVAILABLE);
        let _ = fs::remove_dir_all(&root);
    }
}
