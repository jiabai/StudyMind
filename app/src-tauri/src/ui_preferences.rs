use serde::{de, Deserialize, Deserializer, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::AppHandle;

use crate::resolve_runtime_paths;

pub(crate) const UI_PREFERENCES_FILE_NAME: &str = "ui-preferences.json";
pub(crate) const UI_PREFERENCES_READ_FAILED: &str = "UI_PREFERENCES_READ_FAILED";
pub(crate) const UI_PREFERENCES_WRITE_FAILED: &str = "UI_PREFERENCES_WRITE_FAILED";
const UI_PREFERENCES_SCHEMA_VERSION: u8 = 2;
const UI_PREFERENCES_BACKUP_FILE_NAME: &str = ".ui-preferences.json.backup";
static UI_PREFERENCES_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) enum LanguagePreference {
    #[serde(rename = "system")]
    System,
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "zh-TW")]
    ZhTw,
    #[serde(rename = "en-US")]
    EnUs,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) enum RecordingAudioSourceMode {
    #[serde(rename = "mic")]
    Mic,
    #[serde(rename = "system")]
    System,
    #[serde(rename = "mixed")]
    Mixed,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordingPreferences {
    pub(crate) audio_source_mode: RecordingAudioSourceMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SaveUiPreferencesInput {
    pub(crate) language: Option<LanguagePreference>,
    pub(crate) recording: Option<RecordingPreferences>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PresentOrMissing<T> {
    Missing,
    Present(T),
}

impl<T> Default for PresentOrMissing<T> {
    fn default() -> Self {
        Self::Missing
    }
}

impl<'de, T> Deserialize<'de> for PresentOrMissing<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct PresentOrMissingVisitor<T>(PhantomData<T>);

        impl<'de, T> de::Visitor<'de> for PresentOrMissingVisitor<T>
        where
            T: Deserialize<'de>,
        {
            type Value = PresentOrMissing<T>;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a present value")
            }

            fn visit_none<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Err(E::custom("null is not a valid present value"))
            }

            fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
            where
                D: Deserializer<'de>,
            {
                T::deserialize(deserializer).map(PresentOrMissing::Present)
            }
        }

        deserializer.deserialize_option(PresentOrMissingVisitor(PhantomData))
    }
}

impl SaveUiPreferencesInput {
    pub(crate) fn recording(mode: RecordingAudioSourceMode) -> Self {
        Self {
            language: None,
            recording: Some(RecordingPreferences {
                audio_source_mode: mode,
            }),
        }
    }
}

impl<'de> Deserialize<'de> for SaveUiPreferencesInput {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct SaveUiPreferencesInputWire {
            #[serde(default)]
            language: PresentOrMissing<LanguagePreference>,
            #[serde(default)]
            recording: PresentOrMissing<RecordingPreferences>,
        }

        let input = SaveUiPreferencesInputWire::deserialize(deserializer)?;
        if matches!(input.language, PresentOrMissing::Missing)
            && matches!(input.recording, PresentOrMissing::Missing)
        {
            return Err(de::Error::custom(
                "expected at least one of language or recording",
            ));
        }

        Ok(Self {
            language: match input.language {
                PresentOrMissing::Missing => None,
                PresentOrMissing::Present(value) => Some(value),
            },
            recording: match input.recording {
                PresentOrMissing::Missing => None,
                PresentOrMissing::Present(value) => Some(value),
            },
        })
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UiPreferencesView {
    pub(crate) schema_version: u8,
    pub(crate) language: LanguagePreference,
    pub(crate) recording: RecordingPreferences,
    pub(crate) recovered: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UiPreferencesFile {
    schema_version: u8,
    language: LanguagePreference,
    recording: RecordingPreferences,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UiPreferencesV1File {
    schema_version: u8,
    language: LanguagePreference,
}

#[derive(Debug)]
struct UiPreferencesState {
    language: LanguagePreference,
    recording: RecordingPreferences,
}

#[derive(Debug)]
struct ParsedUiPreferences {
    state: UiPreferencesState,
    recovered: bool,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum UiPreferencesWireFile {
    V2(UiPreferencesFile),
    V1(UiPreferencesV1File),
}

#[tauri::command]
pub(crate) fn get_ui_preferences(app: AppHandle) -> Result<UiPreferencesView, String> {
    let paths = resolve_runtime_paths(&app).map_err(|_| UI_PREFERENCES_READ_FAILED.to_string())?;
    load_ui_preferences_from_file(&paths.user_data_dir.join(UI_PREFERENCES_FILE_NAME))
}

#[tauri::command]
pub(crate) fn save_ui_preferences(
    app: AppHandle,
    preferences: SaveUiPreferencesInput,
) -> Result<UiPreferencesView, String> {
    let paths = resolve_runtime_paths(&app).map_err(|_| UI_PREFERENCES_WRITE_FAILED.to_string())?;
    save_ui_preferences_to_file(
        &paths.user_data_dir.join(UI_PREFERENCES_FILE_NAME),
        preferences,
    )
}

pub(crate) fn load_ui_preferences_from_file(path: &Path) -> Result<UiPreferencesView, String> {
    let content = match fs::read(path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return load_missing_ui_preferences_from_backup(path);
        }
        Err(_) => return Err(UI_PREFERENCES_READ_FAILED.to_string()),
    };

    let parsed = parse_ui_preferences_content(&content);
    Ok(build_view(parsed.state, parsed.recovered))
}

fn load_missing_ui_preferences_from_backup(path: &Path) -> Result<UiPreferencesView, String> {
    match fs::read(ui_preferences_backup_path(path)) {
        Ok(content) => {
            let parsed = parse_ui_preferences_content(&content);
            Ok(build_view(parsed.state, true))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(default_view(false)),
        Err(_) => Err(UI_PREFERENCES_READ_FAILED.to_string()),
    }
}

fn parse_ui_preferences_content(content: &[u8]) -> ParsedUiPreferences {
    match serde_json::from_slice::<UiPreferencesWireFile>(content) {
        Ok(UiPreferencesWireFile::V2(file))
            if file.schema_version == UI_PREFERENCES_SCHEMA_VERSION =>
        {
            ParsedUiPreferences {
                state: UiPreferencesState {
                    language: file.language,
                    recording: file.recording,
                },
                recovered: false,
            }
        }
        Ok(UiPreferencesWireFile::V1(file)) if file.schema_version == 1 => ParsedUiPreferences {
            state: UiPreferencesState {
                language: file.language,
                recording: default_recording_preferences(),
            },
            recovered: false,
        },
        _ => ParsedUiPreferences {
            state: default_state(),
            recovered: true,
        },
    }
}

pub(crate) fn save_ui_preferences_to_file(
    path: &Path,
    preferences: SaveUiPreferencesInput,
) -> Result<UiPreferencesView, String> {
    let _write_guard = UI_PREFERENCES_WRITE_LOCK
        .lock()
        .map_err(|_| UI_PREFERENCES_WRITE_FAILED.to_string())?;
    save_ui_preferences_to_file_locked(path, preferences)
}

fn save_ui_preferences_to_file_locked(
    path: &Path,
    preferences: SaveUiPreferencesInput,
) -> Result<UiPreferencesView, String> {
    let existing =
        load_ui_preferences_from_file(path).map_err(|_| UI_PREFERENCES_WRITE_FAILED.to_string())?;
    let merged = UiPreferencesState {
        language: preferences.language.unwrap_or(existing.language),
        recording: preferences.recording.unwrap_or(existing.recording),
    };
    let file = UiPreferencesFile {
        schema_version: UI_PREFERENCES_SCHEMA_VERSION,
        language: merged.language,
        recording: merged.recording.clone(),
    };
    let bytes = (serde_json::to_string_pretty(&file)
        .map_err(|_| UI_PREFERENCES_WRITE_FAILED.to_string())?
        + "\n")
        .into_bytes();
    atomic_write_locked(path, &bytes).map_err(|_| UI_PREFERENCES_WRITE_FAILED.to_string())?;

    Ok(build_view(merged, false))
}

fn default_view(recovered: bool) -> UiPreferencesView {
    build_view(default_state(), recovered)
}

fn default_state() -> UiPreferencesState {
    UiPreferencesState {
        language: LanguagePreference::EnUs,
        recording: default_recording_preferences(),
    }
}

fn default_recording_preferences() -> RecordingPreferences {
    RecordingPreferences {
        audio_source_mode: RecordingAudioSourceMode::Mic,
    }
}

fn build_view(state: UiPreferencesState, recovered: bool) -> UiPreferencesView {
    UiPreferencesView {
        schema_version: UI_PREFERENCES_SCHEMA_VERSION,
        language: state.language,
        recording: state.recording,
        recovered,
    }
}

fn atomic_write_locked(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "preference path has no parent")
    })?;
    fs::create_dir_all(parent)?;
    let temp_path = preference_temp_path(parent);
    let write_result = (|| {
        let mut temp_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        temp_file.write_all(bytes)?;
        temp_file.sync_all()?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    let backup_path = ui_preferences_backup_path(path);
    let result = if path.exists() {
        if backup_path.exists() {
            if let Err(error) = fs::remove_file(&backup_path) {
                let _ = fs::remove_file(&temp_path);
                return Err(error);
            }
        }
        atomic_replace(&temp_path, path, &backup_path)
    } else {
        fs::rename(&temp_path, path)
    };

    if result.is_ok() {
        let _ = fs::remove_file(&backup_path);
    } else if path.exists() || backup_path.exists() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn preference_temp_path(parent: &Path) -> PathBuf {
    parent.join(format!(
        ".{UI_PREFERENCES_FILE_NAME}.{}.tmp",
        uuid::Uuid::new_v4()
    ))
}

fn ui_preferences_backup_path(path: &Path) -> PathBuf {
    path.parent()
        .map(|parent| parent.join(UI_PREFERENCES_BACKUP_FILE_NAME))
        .unwrap_or_else(|| PathBuf::from(UI_PREFERENCES_BACKUP_FILE_NAME))
}

fn replace_existing_with_backup_using<R, M>(
    temp_path: &Path,
    destination: &Path,
    backup_path: &Path,
    replace: R,
    move_file: M,
) -> io::Result<()>
where
    R: FnOnce(&Path, &Path, &Path) -> io::Result<()>,
    M: Fn(&Path, &Path) -> io::Result<()>,
{
    match replace(temp_path, destination, backup_path) {
        Ok(()) => Ok(()),
        Err(error) => {
            if !destination.exists() && backup_path.exists() {
                let _ = move_file(backup_path, destination);
            }
            if !destination.exists() && !backup_path.exists() && temp_path.exists() {
                let _ = move_file(temp_path, backup_path);
            }
            if temp_path.exists() && (destination.exists() || backup_path.exists()) {
                let _ = fs::remove_file(temp_path);
            }
            Err(error)
        }
    }
}

#[cfg(not(windows))]
fn atomic_replace(temp_path: &Path, destination: &Path, _backup_path: &Path) -> io::Result<()> {
    fs::rename(temp_path, destination)
}

#[cfg(windows)]
fn atomic_replace(temp_path: &Path, destination: &Path, backup_path: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    fn wide_path(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn ReplaceFileW(
            replaced_file_name: *const u16,
            replacement_file_name: *const u16,
            backup_file_name: *const u16,
            replace_flags: u32,
            exclude: *mut core::ffi::c_void,
            reserved: *mut core::ffi::c_void,
        ) -> i32;
    }

    replace_existing_with_backup_using(
        temp_path,
        destination,
        backup_path,
        |temp_path, destination, backup_path| {
            let destination_wide = wide_path(destination);
            let temp_wide = wide_path(temp_path);
            let backup_wide = wide_path(backup_path);
            let replaced = unsafe {
                ReplaceFileW(
                    destination_wide.as_ptr(),
                    temp_wide.as_ptr(),
                    backup_wide.as_ptr(),
                    0,
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            };
            if replaced == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        },
        |from, to| fs::rename(from, to),
    )
}

#[cfg(test)]
mod tests {
    use super::{
        load_ui_preferences_from_file, replace_existing_with_backup_using,
        save_ui_preferences_to_file, ui_preferences_backup_path, LanguagePreference,
        RecordingAudioSourceMode, SaveUiPreferencesInput, UI_PREFERENCES_FILE_NAME,
        UI_PREFERENCES_READ_FAILED, UI_PREFERENCES_WRITE_FAILED,
    };
    use std::fs;
    use std::io;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn missing_ui_preferences_default_to_english_without_recovery() {
        let path = temp_file("missing");

        let view = load_ui_preferences_from_file(&path).expect("missing preference is normal");
        let serialized = serde_json::to_value(view).expect("serialize default preference");

        assert_eq!(serialized["schemaVersion"], 2);
        assert_eq!(serialized["language"], "en-US");
        assert_eq!(serialized["recording"]["audioSourceMode"], "mic");
        assert_eq!(serialized["recovered"], false);
        assert!(!path.exists());
    }

    #[test]
    fn migrates_v1_ui_preferences_by_synthesizing_mic_recording_mode() {
        for language in ["system", "zh-CN", "zh-TW", "en-US"] {
            let path = temp_file(language);
            write_raw(
                &path,
                &format!(r#"{{"schemaVersion":1,"language":"{language}"}}"#),
            );
            let before = fs::read(&path).expect("read original v1 bytes");

            let view = load_ui_preferences_from_file(&path).expect("load valid preference");
            let serialized = serde_json::to_value(view).expect("serialize preference view");

            assert_eq!(serialized["schemaVersion"], 2);
            assert_eq!(serialized["language"], language);
            assert_eq!(serialized["recording"]["audioSourceMode"], "mic");
            assert_eq!(serialized["recovered"], false);
            assert_eq!(fs::read(&path).expect("read retained v1 bytes"), before);
        }
    }

    #[test]
    fn valid_v2_ui_preferences_round_trip_language_and_recording_values() {
        for (language, mode) in [
            ("system", "mic"),
            ("zh-CN", "system"),
            ("zh-TW", "mixed"),
            ("en-US", "mic"),
        ] {
            let path = temp_file(&format!("{language}-{mode}"));
            write_raw(
                &path,
                &format!(
                    r#"{{"schemaVersion":2,"language":"{language}","recording":{{"audioSourceMode":"{mode}"}}}}"#
                ),
            );

            let view = load_ui_preferences_from_file(&path).expect("load valid v2 preference");
            let serialized = serde_json::to_value(view).expect("serialize preference view");

            assert_eq!(serialized["schemaVersion"], 2);
            assert_eq!(serialized["language"], language);
            assert_eq!(serialized["recording"]["audioSourceMode"], mode);
            assert_eq!(serialized["recovered"], false);
        }
    }

    #[test]
    fn damaged_or_future_ui_preferences_recover_without_rewriting() {
        for (name, raw) in [
            ("corrupt", "{not-json"),
            (
                "future-schema",
                r#"{"schemaVersion":3,"language":"en-US","recording":{"audioSourceMode":"mic"}}"#,
            ),
            (
                "illegal-language",
                r#"{"schemaVersion":2,"language":"fr-FR","recording":{"audioSourceMode":"mic"}}"#,
            ),
            (
                "unknown-field",
                r#"{"schemaVersion":2,"language":"system","recording":{"audioSourceMode":"mic"},"account":"leak"}"#,
            ),
        ] {
            let path = temp_file(name);
            write_raw(&path, raw);
            let before = fs::read(&path).expect("read original bytes");

            let view = load_ui_preferences_from_file(&path).expect("recover damaged preference");
            let serialized = serde_json::to_value(view).expect("serialize recovered preference");

            assert_eq!(serialized["language"], "en-US");
            assert_eq!(serialized["recording"]["audioSourceMode"], "mic");
            assert_eq!(serialized["recovered"], true);
            assert_eq!(fs::read(&path).expect("read retained bytes"), before);
        }
    }

    #[test]
    fn invalid_recording_mode_recovers_without_rewriting() {
        let path = temp_file("illegal-recording-mode");
        write_raw(
            &path,
            r#"{"schemaVersion":2,"language":"zh-CN","recording":{"audioSourceMode":"bluetooth"}}"#,
        );
        let before = fs::read(&path).expect("read original bytes");

        let view = load_ui_preferences_from_file(&path).expect("recover invalid recording");
        let serialized = serde_json::to_value(view).expect("serialize recovered preference");

        assert_eq!(serialized["schemaVersion"], 2);
        assert_eq!(serialized["language"], "en-US");
        assert_eq!(serialized["recording"]["audioSourceMode"], "mic");
        assert_eq!(serialized["recovered"], true);
        assert_eq!(fs::read(&path).expect("read retained bytes"), before);
    }

    #[test]
    fn invalid_utf8_preferences_recover_without_rewriting() {
        let path = temp_file("invalid-utf8");
        fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
        let original = vec![0xff, 0xfe, b'{', b'}'];
        fs::write(&path, &original).expect("write invalid UTF-8 preference");

        let view = load_ui_preferences_from_file(&path).expect("recover invalid UTF-8");
        let serialized = serde_json::to_value(view).expect("serialize recovered preference");

        assert_eq!(serialized["language"], "en-US");
        assert_eq!(serialized["recording"]["audioSourceMode"], "mic");
        assert_eq!(serialized["recovered"], true);
        assert_eq!(fs::read(&path).expect("read retained bytes"), original);
    }

    #[test]
    fn successful_save_repairs_damaged_file_and_clears_recovery() {
        let path = temp_file("repair");
        write_raw(&path, "{not-json");

        let input: SaveUiPreferencesInput = serde_json::from_value(serde_json::json!({
            "language": "zh-TW",
            "recording": { "audioSourceMode": "mixed" },
        }))
        .expect("deserialize v2 save input");
        let view = save_ui_preferences_to_file(&path, input).expect("repair preference");
        let saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).expect("read saved preference"))
                .expect("saved JSON");
        let serialized = serde_json::to_value(view).expect("serialize saved view");

        assert_eq!(serialized["language"], "zh-TW");
        assert_eq!(serialized["recording"]["audioSourceMode"], "mixed");
        assert_eq!(serialized["recovered"], false);
        assert_eq!(saved["schemaVersion"], 2);
        assert_eq!(saved["language"], "zh-TW");
        assert_eq!(saved["recording"]["audioSourceMode"], "mixed");
        assert!(saved.get("recovered").is_none());
    }

    #[test]
    fn save_input_rejects_invalid_language_and_unknown_fields() {
        for payload in [
            serde_json::json!({"language": "fr-FR"}),
            serde_json::json!({"language": 7}),
            serde_json::json!({"language": null, "recording": {"audioSourceMode": "mic"}}),
            serde_json::json!({"recording": {"audioSourceMode": "bluetooth"}}),
            serde_json::json!({"language": "system", "recording": null}),
            serde_json::json!({"language": "system", "taskId": "not-local"}),
        ] {
            assert!(serde_json::from_value::<SaveUiPreferencesInput>(payload).is_err());
        }
    }

    #[test]
    fn save_input_accepts_partial_updates_with_missing_fields() {
        let language_only = serde_json::from_value::<SaveUiPreferencesInput>(serde_json::json!({
            "language": "zh-TW",
        }))
        .expect("language-only input is valid");
        assert_eq!(language_only.language, Some(LanguagePreference::ZhTw));
        assert!(language_only.recording.is_none());

        let recording_only = serde_json::from_value::<SaveUiPreferencesInput>(serde_json::json!({
            "recording": {"audioSourceMode": "system"},
        }))
        .expect("recording-only input is valid");
        assert!(recording_only.language.is_none());
        assert_eq!(
            recording_only
                .recording
                .expect("recording field is present")
                .audio_source_mode,
            RecordingAudioSourceMode::System
        );
    }

    #[test]
    fn save_input_rejects_empty_partial_updates() {
        assert!(serde_json::from_value::<SaveUiPreferencesInput>(serde_json::json!({})).is_err());
    }

    #[test]
    fn atomic_save_replaces_existing_file_without_temp_residue() {
        let path = temp_file("replace-existing");
        write_raw(
            &path,
            r#"{"schemaVersion":2,"language":"zh-CN","recording":{"audioSourceMode":"mic"}}"#,
        );

        let input: SaveUiPreferencesInput = serde_json::from_value(serde_json::json!({
            "language": "en-US",
            "recording": { "audioSourceMode": "system" },
        }))
        .expect("deserialize v2 save input");
        save_ui_preferences_to_file(&path, input).expect("replace existing preference");

        let view = load_ui_preferences_from_file(&path).expect("load replacement");
        let serialized = serde_json::to_value(view).expect("serialize replacement");
        assert_eq!(serialized["language"], "en-US");
        assert_eq!(serialized["recording"]["audioSourceMode"], "system");
        assert_no_temp_files(path.parent().expect("parent"));
    }

    #[test]
    fn recording_only_save_preserves_existing_language() {
        let path = temp_file("recording-only-save");
        write_raw(
            &path,
            r#"{"schemaVersion":2,"language":"zh-CN","recording":{"audioSourceMode":"mic"}}"#,
        );
        let input = SaveUiPreferencesInput::recording(RecordingAudioSourceMode::System);

        let view = save_ui_preferences_to_file(&path, input).expect("save recording only");
        let serialized = serde_json::to_value(view).expect("serialize saved view");
        let saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).expect("read saved preference"))
                .expect("saved JSON");

        assert_eq!(serialized["schemaVersion"], 2);
        assert_eq!(serialized["language"], "zh-CN");
        assert_eq!(serialized["recording"]["audioSourceMode"], "system");
        assert_eq!(serialized["recovered"], false);
        assert_eq!(saved["language"], "zh-CN");
        assert_eq!(saved["recording"]["audioSourceMode"], "system");
    }

    #[test]
    fn language_only_save_preserves_existing_recording() {
        let path = temp_file("language-only-save");
        write_raw(
            &path,
            r#"{"schemaVersion":2,"language":"zh-CN","recording":{"audioSourceMode":"mixed"}}"#,
        );

        let input = SaveUiPreferencesInput {
            language: Some(LanguagePreference::EnUs),
            recording: None,
        };
        let view = save_ui_preferences_to_file(&path, input).expect("save language only");
        let serialized = serde_json::to_value(view).expect("serialize saved view");

        assert_eq!(serialized["language"], "en-US");
        assert_eq!(serialized["recording"]["audioSourceMode"], "mixed");
        assert_eq!(serialized["recovered"], false);
    }

    #[test]
    fn concurrent_partial_saves_preserve_unrelated_preference_updates() {
        for attempt in 0..64 {
            let path = temp_file(&format!("concurrent-partial-save-{attempt}"));
            write_raw(
                &path,
                r#"{"schemaVersion":2,"language":"zh-CN","recording":{"audioSourceMode":"mic"}}"#,
            );
            let start = Arc::new(Barrier::new(3));
            let language_path = path.clone();
            let language_start = Arc::clone(&start);
            let language_thread = thread::spawn(move || {
                language_start.wait();
                save_ui_preferences_to_file(
                    &language_path,
                    SaveUiPreferencesInput {
                        language: Some(LanguagePreference::ZhTw),
                        recording: None,
                    },
                )
            });
            let recording_path = path.clone();
            let recording_start = Arc::clone(&start);
            let recording_thread = thread::spawn(move || {
                recording_start.wait();
                save_ui_preferences_to_file(
                    &recording_path,
                    SaveUiPreferencesInput::recording(RecordingAudioSourceMode::System),
                )
            });
            start.wait();

            language_thread
                .join()
                .expect("language save thread must not panic")
                .expect("language save must succeed");
            recording_thread
                .join()
                .expect("recording save thread must not panic")
                .expect("recording save must succeed");

            let view = load_ui_preferences_from_file(&path).expect("load concurrent result");
            assert_eq!(view.language, LanguagePreference::ZhTw);
            assert_eq!(
                view.recording.audio_source_mode,
                RecordingAudioSourceMode::System
            );
        }
    }

    #[test]
    fn partial_save_repairs_corrupt_file_from_defaults() {
        let path = temp_file("partial-save-repair");
        write_raw(&path, "{not-json");

        let input = SaveUiPreferencesInput {
            language: Some(LanguagePreference::ZhTw),
            recording: None,
        };
        let view = save_ui_preferences_to_file(&path, input).expect("repair preference");
        let serialized = serde_json::to_value(view).expect("serialize saved view");
        let saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).expect("read saved preference"))
                .expect("saved JSON");

        assert_eq!(serialized["language"], "zh-TW");
        assert_eq!(serialized["recording"]["audioSourceMode"], "mic");
        assert_eq!(serialized["recovered"], false);
        assert_eq!(saved["schemaVersion"], 2);
        assert_eq!(saved["recording"]["audioSourceMode"], "mic");
    }

    #[test]
    fn failed_atomic_replace_cleans_temp_file_and_returns_fixed_error() {
        let path = temp_file("replace-failure");
        fs::create_dir_all(&path).expect("create destination directory");

        let error = save_ui_preferences_to_file(
            &path,
            SaveUiPreferencesInput {
                language: Some(LanguagePreference::ZhCn),
                recording: None,
            },
        )
        .expect_err("directory destination must fail");

        assert_eq!(error, UI_PREFERENCES_WRITE_FAILED);
        assert!(!error.contains(&path.to_string_lossy().to_string()));
        assert_no_temp_files(path.parent().expect("parent"));
    }

    #[test]
    fn unreadable_preferences_return_fixed_non_path_error() {
        let path = temp_file("read-failure");
        fs::create_dir_all(&path).expect("create directory at file path");

        let error = load_ui_preferences_from_file(&path).expect_err("directory read must fail");

        assert_eq!(error, UI_PREFERENCES_READ_FAILED);
        assert!(!error.contains(&path.to_string_lossy().to_string()));
    }

    #[test]
    fn replace_failures_1175_1176_and_other_keep_old_main_and_remove_new_temp() {
        for error_code in [1175, 1176, 87] {
            let path = temp_file(&format!("replace-error-{error_code}"));
            let backup = ui_preferences_backup_path(&path);
            let temp = path
                .parent()
                .expect("parent")
                .join(format!(".ui-preferences.json.{error_code}.tmp"));
            write_raw(
                &path,
                r#"{"schemaVersion":2,"language":"zh-CN","recording":{"audioSourceMode":"mic"}}"#,
            );
            write_raw(
                &temp,
                r#"{"schemaVersion":2,"language":"en-US","recording":{"audioSourceMode":"system"}}"#,
            );

            let error = replace_existing_with_backup_using(
                &temp,
                &path,
                &backup,
                |_temp, _destination, _backup| Err(io::Error::from_raw_os_error(error_code)),
                |from, to| fs::rename(from, to),
            )
            .expect_err("replace must fail");
            let view = load_ui_preferences_from_file(&path).expect("old preference remains");
            let serialized = serde_json::to_value(view).expect("serialize preserved preference");

            assert_eq!(error.raw_os_error(), Some(error_code));
            assert_eq!(serialized["language"], "zh-CN");
            assert_eq!(serialized["recording"]["audioSourceMode"], "mic");
            assert_eq!(serialized["recovered"], false);
            assert!(!temp.exists(), "new temp survived error {error_code}");
        }
    }

    #[test]
    fn replace_failure_1177_restores_backup_before_returning_error() {
        let path = temp_file("replace-error-1177");
        let backup = ui_preferences_backup_path(&path);
        let temp = path
            .parent()
            .expect("parent")
            .join(".ui-preferences.json.1177.tmp");
        write_raw(
            &path,
            r#"{"schemaVersion":2,"language":"zh-TW","recording":{"audioSourceMode":"mixed"}}"#,
        );
        write_raw(
            &temp,
            r#"{"schemaVersion":2,"language":"en-US","recording":{"audioSourceMode":"mic"}}"#,
        );

        let error = replace_existing_with_backup_using(
            &temp,
            &path,
            &backup,
            |_temp, destination, backup| {
                fs::rename(destination, backup)?;
                Err(io::Error::from_raw_os_error(1177))
            },
            |from, to| fs::rename(from, to),
        )
        .expect_err("replace must fail");
        let view = load_ui_preferences_from_file(&path).expect("restored old preference");
        let serialized = serde_json::to_value(view).expect("serialize restored preference");

        assert_eq!(error.raw_os_error(), Some(1177));
        assert_eq!(serialized["language"], "zh-TW");
        assert_eq!(serialized["recording"]["audioSourceMode"], "mixed");
        assert_eq!(serialized["recovered"], false);
        assert!(!backup.exists());
        assert!(!temp.exists());
    }

    #[test]
    fn failed_1177_restore_keeps_discoverable_backup_until_next_successful_save() {
        let path = temp_file("replace-error-1177-restore-failed");
        let backup = ui_preferences_backup_path(&path);
        let temp = path
            .parent()
            .expect("parent")
            .join(".ui-preferences.json.1177-restore-failed.tmp");
        write_raw(
            &path,
            r#"{"schemaVersion":2,"language":"zh-CN","recording":{"audioSourceMode":"mixed"}}"#,
        );
        write_raw(
            &temp,
            r#"{"schemaVersion":2,"language":"en-US","recording":{"audioSourceMode":"mic"}}"#,
        );

        replace_existing_with_backup_using(
            &temp,
            &path,
            &backup,
            |_temp, destination, backup| {
                fs::rename(destination, backup)?;
                Err(io::Error::from_raw_os_error(1177))
            },
            |_from, _to| Err(io::Error::new(io::ErrorKind::PermissionDenied, "locked")),
        )
        .expect_err("replace and restore must fail");

        assert!(!path.exists());
        assert!(backup.exists());
        assert!(!temp.exists());
        let recovered = load_ui_preferences_from_file(&path).expect("load backup recovery");
        let recovered_serialized =
            serde_json::to_value(recovered).expect("serialize recovered backup preference");
        assert_eq!(recovered_serialized["language"], "zh-CN");
        assert_eq!(
            recovered_serialized["recording"]["audioSourceMode"],
            "mixed"
        );
        assert_eq!(recovered_serialized["recovered"], true);

        let input: SaveUiPreferencesInput = serde_json::from_value(serde_json::json!({
            "language": "en-US",
            "recording": { "audioSourceMode": "system" },
        }))
        .expect("deserialize v2 save input");
        let saved =
            save_ui_preferences_to_file(&path, input).expect("next save repairs recovered backup");
        let saved_serialized =
            serde_json::to_value(saved).expect("serialize saved repaired preference");
        assert_eq!(saved_serialized["language"], "en-US");
        assert_eq!(saved_serialized["recording"]["audioSourceMode"], "system");
        assert_eq!(saved_serialized["recovered"], false);
        assert!(!backup.exists());
        assert!(!temp.exists());
    }

    fn assert_no_temp_files(parent: &Path) {
        let entries = fs::read_dir(parent).expect("read preference parent");
        let residue = entries
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with(".ui-preferences.json.") && name.ends_with(".tmp"))
            .collect::<Vec<_>>();
        assert!(residue.is_empty(), "temporary files remain: {residue:?}");
    }

    fn temp_file(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir()
            .join(format!("StudyMind-ui-preferences-{name}-{unique}"))
            .join(UI_PREFERENCES_FILE_NAME)
    }

    fn write_raw(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
        fs::write(path, content).expect("write preference");
    }
}
