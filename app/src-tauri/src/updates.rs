use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri::{AppHandle, Manager};

const UPDATE_PREFERENCES_FILE_NAME: &str = "updates.json";
const RELEASES_PAGE_URL: &str = "https://github.com/jiabai/StudyMind/releases/latest";

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateDeliveryView {
    in_app_updates: bool,
    releases_url: String,
}

#[tauri::command]
pub(crate) fn get_update_delivery() -> UpdateDeliveryView {
    UpdateDeliveryView {
        in_app_updates: !cfg!(target_os = "macos"),
        releases_url: RELEASES_PAGE_URL.to_string(),
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdatePreferencesView {
    last_checked_at: Option<String>,
    postponed_until: Option<i64>,
    skipped_version: Option<String>,
}

#[tauri::command]
pub(crate) fn get_update_preferences(app: AppHandle) -> Result<UpdatePreferencesView, String> {
    let user_data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    load_update_preferences_from_file(&user_data_dir.join(UPDATE_PREFERENCES_FILE_NAME))
}

#[tauri::command]
pub(crate) fn save_update_preferences(
    app: AppHandle,
    preferences: UpdatePreferencesView,
) -> Result<UpdatePreferencesView, String> {
    let user_data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    save_update_preferences_to_file(
        &user_data_dir.join(UPDATE_PREFERENCES_FILE_NAME),
        preferences,
    )
}

fn load_update_preferences_from_file(path: &Path) -> Result<UpdatePreferencesView, String> {
    if !path.exists() {
        return Ok(UpdatePreferencesView::default());
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    if content.trim().is_empty() {
        return Ok(UpdatePreferencesView::default());
    }

    serde_json::from_str::<UpdatePreferencesView>(&content).map_err(|error| error.to_string())
}

fn save_update_preferences_to_file(
    path: &Path,
    preferences: UpdatePreferencesView,
) -> Result<UpdatePreferencesView, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let content = serde_json::to_string_pretty(&preferences).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())?;
    Ok(preferences)
}

#[cfg(test)]
mod tests {
    use super::{
        get_update_delivery, load_update_preferences_from_file, save_update_preferences_to_file,
        UpdatePreferencesView,
    };
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn update_delivery_disables_in_app_updates_on_macos_only() {
        let delivery = get_update_delivery();

        assert_eq!(delivery.in_app_updates, !cfg!(target_os = "macos"));
        assert_eq!(
            delivery.releases_url,
            "https://github.com/jiabai/StudyMind/releases/latest"
        );
    }

    #[test]
    fn update_preferences_round_trip_uses_app_local_updates_json() {
        let path = temp_dir("update_preferences_round_trip").join("updates.json");
        assert_eq!(
            load_update_preferences_from_file(&path).expect("load missing preferences"),
            UpdatePreferencesView::default()
        );

        let preferences = UpdatePreferencesView {
            last_checked_at: Some("2026-06-23T10:00:00.000Z".to_string()),
            postponed_until: Some(1_800_000),
            skipped_version: None,
        };
        let saved = save_update_preferences_to_file(&path, preferences.clone())
            .expect("save update preferences");
        let raw = fs::read_to_string(&path).expect("read update preferences");
        let loaded = load_update_preferences_from_file(&path).expect("load update preferences");

        assert_eq!(saved, preferences);
        assert_eq!(loaded, preferences);
        assert!(raw.contains("lastCheckedAt"));
        assert!(raw.contains("postponedUntil"));
        assert!(raw.contains("skippedVersion"));
    }

    fn temp_dir(test_name: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "studymind-tauri-updates-{}-{}",
            test_name,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        ));
        fs::create_dir_all(&dir).expect("create test dir");
        dir
    }
}