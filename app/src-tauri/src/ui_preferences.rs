use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::AppHandle;

use crate::resolve_runtime_paths;

pub(crate) const UI_PREFERENCES_FILE_NAME: &str = "ui-preferences.json";
pub(crate) const UI_PREFERENCES_READ_FAILED: &str = "UI_PREFERENCES_READ_FAILED";
pub(crate) const UI_PREFERENCES_WRITE_FAILED: &str = "UI_PREFERENCES_WRITE_FAILED";
const UI_PREFERENCES_SCHEMA_VERSION: u8 = 1;
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

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveUiPreferencesInput {
    pub(crate) language: LanguagePreference,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UiPreferencesView {
    pub(crate) schema_version: u8,
    pub(crate) language: LanguagePreference,
    pub(crate) recovered: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UiPreferencesFile {
    schema_version: u8,
    language: LanguagePreference,
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

    Ok(parse_ui_preferences_content(&content, false))
}

fn load_missing_ui_preferences_from_backup(path: &Path) -> Result<UiPreferencesView, String> {
    match fs::read(ui_preferences_backup_path(path)) {
        Ok(content) => Ok(parse_ui_preferences_content(&content, true)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(default_view(false)),
        Err(_) => Err(UI_PREFERENCES_READ_FAILED.to_string()),
    }
}

fn parse_ui_preferences_content(content: &[u8], recovered: bool) -> UiPreferencesView {
    let Ok(file) = serde_json::from_slice::<UiPreferencesFile>(&content) else {
        return default_view(true);
    };
    if file.schema_version != UI_PREFERENCES_SCHEMA_VERSION {
        return default_view(true);
    }

    UiPreferencesView {
        schema_version: UI_PREFERENCES_SCHEMA_VERSION,
        language: file.language,
        recovered,
    }
}

pub(crate) fn save_ui_preferences_to_file(
    path: &Path,
    preferences: SaveUiPreferencesInput,
) -> Result<UiPreferencesView, String> {
    let file = UiPreferencesFile {
        schema_version: UI_PREFERENCES_SCHEMA_VERSION,
        language: preferences.language,
    };
    let bytes = (serde_json::to_string_pretty(&file)
        .map_err(|_| UI_PREFERENCES_WRITE_FAILED.to_string())?
        + "\n")
        .into_bytes();
    atomic_write(path, &bytes).map_err(|_| UI_PREFERENCES_WRITE_FAILED.to_string())?;

    Ok(UiPreferencesView {
        schema_version: UI_PREFERENCES_SCHEMA_VERSION,
        language: preferences.language,
        recovered: false,
    })
}

fn default_view(recovered: bool) -> UiPreferencesView {
    UiPreferencesView {
        schema_version: UI_PREFERENCES_SCHEMA_VERSION,
        language: LanguagePreference::EnUs,
        recovered,
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let _write_guard = UI_PREFERENCES_WRITE_LOCK
        .lock()
        .map_err(|_| io::Error::other("UI preference write lock poisoned"))?;
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
        SaveUiPreferencesInput, UI_PREFERENCES_FILE_NAME, UI_PREFERENCES_READ_FAILED,
        UI_PREFERENCES_WRITE_FAILED,
    };
    use std::fs;
    use std::io;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn missing_ui_preferences_default_to_english_without_recovery() {
        let path = temp_file("missing");

        let view = load_ui_preferences_from_file(&path).expect("missing preference is normal");

        assert_eq!(view.schema_version, 1);
        assert_eq!(view.language, LanguagePreference::EnUs);
        assert!(!view.recovered);
        assert!(!path.exists());
    }

    #[test]
    fn valid_ui_preferences_round_trip_all_language_values() {
        for language in ["system", "zh-CN", "zh-TW", "en-US"] {
            let path = temp_file(language);
            write_raw(
                &path,
                &format!(r#"{{"schemaVersion":1,"language":"{language}"}}"#),
            );

            let view = load_ui_preferences_from_file(&path).expect("load valid preference");
            let serialized = serde_json::to_value(view).expect("serialize preference view");

            assert_eq!(serialized["schemaVersion"], 1);
            assert_eq!(serialized["language"], language);
            assert_eq!(serialized["recovered"], false);
        }
    }

    #[test]
    fn damaged_or_future_ui_preferences_recover_without_rewriting() {
        for (name, raw) in [
            ("corrupt", "{not-json"),
            ("future-schema", r#"{"schemaVersion":2,"language":"en-US"}"#),
            (
                "illegal-language",
                r#"{"schemaVersion":1,"language":"fr-FR"}"#,
            ),
            (
                "unknown-field",
                r#"{"schemaVersion":1,"language":"system","account":"leak"}"#,
            ),
        ] {
            let path = temp_file(name);
            write_raw(&path, raw);
            let before = fs::read(&path).expect("read original bytes");

            let view = load_ui_preferences_from_file(&path).expect("recover damaged preference");

            assert_eq!(view.language, LanguagePreference::EnUs);
            assert!(view.recovered);
            assert_eq!(fs::read(&path).expect("read retained bytes"), before);
        }
    }

    #[test]
    fn invalid_utf8_preferences_recover_without_rewriting() {
        let path = temp_file("invalid-utf8");
        fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
        let original = vec![0xff, 0xfe, b'{', b'}'];
        fs::write(&path, &original).expect("write invalid UTF-8 preference");

        let view = load_ui_preferences_from_file(&path).expect("recover invalid UTF-8");

        assert_eq!(view.language, LanguagePreference::EnUs);
        assert!(view.recovered);
        assert_eq!(fs::read(&path).expect("read retained bytes"), original);
    }

    #[test]
    fn successful_save_repairs_damaged_file_and_clears_recovery() {
        let path = temp_file("repair");
        write_raw(&path, "{not-json");

        let view = save_ui_preferences_to_file(
            &path,
            SaveUiPreferencesInput {
                language: LanguagePreference::ZhTw,
            },
        )
        .expect("repair preference");
        let saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).expect("read saved preference"))
                .expect("saved JSON");

        assert_eq!(view.language, LanguagePreference::ZhTw);
        assert!(!view.recovered);
        assert_eq!(saved["schemaVersion"], 1);
        assert_eq!(saved["language"], "zh-TW");
        assert!(saved.get("recovered").is_none());
    }

    #[test]
    fn save_input_rejects_invalid_language_and_unknown_fields() {
        for payload in [
            serde_json::json!({"language": "fr-FR"}),
            serde_json::json!({"language": 7}),
            serde_json::json!({"language": "system", "taskId": "not-local"}),
        ] {
            assert!(serde_json::from_value::<SaveUiPreferencesInput>(payload).is_err());
        }
    }

    #[test]
    fn atomic_save_replaces_existing_file_without_temp_residue() {
        let path = temp_file("replace-existing");
        write_raw(&path, r#"{"schemaVersion":1,"language":"zh-CN"}"#);

        save_ui_preferences_to_file(
            &path,
            SaveUiPreferencesInput {
                language: LanguagePreference::EnUs,
            },
        )
        .expect("replace existing preference");

        let view = load_ui_preferences_from_file(&path).expect("load replacement");
        assert_eq!(view.language, LanguagePreference::EnUs);
        assert_no_temp_files(path.parent().expect("parent"));
    }

    #[test]
    fn failed_atomic_replace_cleans_temp_file_and_returns_fixed_error() {
        let path = temp_file("replace-failure");
        fs::create_dir_all(&path).expect("create destination directory");

        let error = save_ui_preferences_to_file(
            &path,
            SaveUiPreferencesInput {
                language: LanguagePreference::ZhCn,
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
            write_raw(&path, r#"{"schemaVersion":1,"language":"zh-CN"}"#);
            write_raw(&temp, r#"{"schemaVersion":1,"language":"en-US"}"#);

            let error = replace_existing_with_backup_using(
                &temp,
                &path,
                &backup,
                |_temp, _destination, _backup| Err(io::Error::from_raw_os_error(error_code)),
                |from, to| fs::rename(from, to),
            )
            .expect_err("replace must fail");
            let view = load_ui_preferences_from_file(&path).expect("old preference remains");

            assert_eq!(error.raw_os_error(), Some(error_code));
            assert_eq!(view.language, LanguagePreference::ZhCn);
            assert!(!view.recovered);
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
        write_raw(&path, r#"{"schemaVersion":1,"language":"zh-TW"}"#);
        write_raw(&temp, r#"{"schemaVersion":1,"language":"en-US"}"#);

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

        assert_eq!(error.raw_os_error(), Some(1177));
        assert_eq!(view.language, LanguagePreference::ZhTw);
        assert!(!view.recovered);
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
        write_raw(&path, r#"{"schemaVersion":1,"language":"zh-CN"}"#);
        write_raw(&temp, r#"{"schemaVersion":1,"language":"en-US"}"#);

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
        assert_eq!(recovered.language, LanguagePreference::ZhCn);
        assert!(recovered.recovered);

        let saved = save_ui_preferences_to_file(
            &path,
            SaveUiPreferencesInput {
                language: LanguagePreference::EnUs,
            },
        )
        .expect("next save repairs recovered backup");
        assert_eq!(saved.language, LanguagePreference::EnUs);
        assert!(!saved.recovered);
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
