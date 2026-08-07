use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use crate::{
    atomic_files::atomic_write, ensure_runtime_dirs, path_to_env_string, resolve_runtime_paths,
    RuntimePaths,
};

pub(crate) const INSIGHT_PREFERENCES_FILE_NAME: &str = "insight-preferences.json";
const INSIGHT_PREFERENCES_SCHEMA_VERSION: u32 = 2;
const PROFILE_RESET_REQUIRED_MESSAGE: &str = "灵感档案需要重新设置";
const PREFERENCES_READ_ERROR: &str = "Failed to read insight preferences.";
const PREFERENCES_WRITE_ERROR: &str = "Failed to save insight preferences.";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InspirationProfile {
    pub(crate) role: String,
    pub(crate) domain: String,
    pub(crate) stage: String,
    pub(crate) city_context: String,
    pub(crate) gender_perspective: String,
    pub(crate) platforms: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyInspirationProfileV1 {
    role: String,
    domain: String,
    stage: String,
    city_context: String,
    gender_perspective: String,
    platforms: Vec<String>,
    default_styles: Vec<String>,
    default_avoid: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GenerationPreferences {
    pub(crate) goal: String,
    pub(crate) scenario: String,
    pub(crate) angles: Vec<String>,
    pub(crate) audience: String,
    pub(crate) styles: Vec<String>,
    pub(crate) avoid: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LegacyGenerationPreferenceSeed {
    pub(crate) styles: Vec<String>,
    pub(crate) avoid: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InsightPreferenceStateView {
    pub(crate) profile: Option<InspirationProfile>,
    pub(crate) profile_skipped: bool,
    pub(crate) profile_status: String,
    pub(crate) profile_error: Option<String>,
    pub(crate) default_generation_preferences: Option<GenerationPreferences>,
    pub(crate) legacy_generation_preference_seed: Option<LegacyGenerationPreferenceSeed>,
    pub(crate) preferences_path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InsightPreferencesFile {
    schema_version: u32,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    profile: Option<InspirationProfile>,
    #[serde(default)]
    profile_skipped: bool,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    default_generation_preferences: Option<GenerationPreferences>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    legacy_generation_preference_seed: Option<LegacyGenerationPreferenceSeed>,
}

impl Default for InsightPreferencesFile {
    fn default() -> Self {
        Self {
            schema_version: INSIGHT_PREFERENCES_SCHEMA_VERSION,
            profile: None,
            profile_skipped: false,
            default_generation_preferences: None,
            legacy_generation_preference_seed: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyInsightPreferencesFileV1 {
    #[serde(default)]
    profile: Option<LegacyInspirationProfileV1>,
    #[serde(default)]
    profile_skipped: bool,
    #[serde(default)]
    default_generation_preferences: Option<GenerationPreferences>,
}

#[tauri::command]
pub(crate) fn get_insight_preferences(
    app: AppHandle,
) -> Result<InsightPreferenceStateView, String> {
    let paths = resolve_runtime_paths(&app)?;
    ensure_runtime_dirs(&paths)?;
    load_insight_preferences_from_file(&insight_preferences_path(&paths))
}

#[tauri::command]
pub(crate) fn save_inspiration_profile(
    app: AppHandle,
    profile: InspirationProfile,
) -> Result<InsightPreferenceStateView, String> {
    let paths = resolve_runtime_paths(&app)?;
    ensure_runtime_dirs(&paths)?;
    save_inspiration_profile_to_file(&insight_preferences_path(&paths), profile)
}

#[tauri::command]
pub(crate) fn skip_inspiration_profile(
    app: AppHandle,
) -> Result<InsightPreferenceStateView, String> {
    let paths = resolve_runtime_paths(&app)?;
    ensure_runtime_dirs(&paths)?;
    skip_inspiration_profile_to_file(&insight_preferences_path(&paths))
}

#[tauri::command]
pub(crate) fn clear_inspiration_profile(
    app: AppHandle,
) -> Result<InsightPreferenceStateView, String> {
    let paths = resolve_runtime_paths(&app)?;
    ensure_runtime_dirs(&paths)?;
    clear_inspiration_profile_to_file(&insight_preferences_path(&paths))
}

#[tauri::command]
pub(crate) fn save_default_generation_preferences(
    app: AppHandle,
    preferences: GenerationPreferences,
) -> Result<InsightPreferenceStateView, String> {
    let paths = resolve_runtime_paths(&app)?;
    ensure_runtime_dirs(&paths)?;
    save_default_generation_preferences_to_file(&insight_preferences_path(&paths), preferences)
}

pub(crate) fn insight_preferences_path(paths: &RuntimePaths) -> PathBuf {
    paths.user_data_dir.join(INSIGHT_PREFERENCES_FILE_NAME)
}

pub(crate) fn load_insight_preferences_from_file(
    path: &Path,
) -> Result<InsightPreferenceStateView, String> {
    if !path.exists() {
        return Ok(state_from_file(
            path,
            InsightPreferencesFile::default(),
            false,
        ));
    }

    let (mut file, source) = read_preferences_file(path)?;
    let legacy_profile_is_invalid = source == PreferencesSource::InvalidLegacyV1;
    let profile_is_invalid = legacy_profile_is_invalid
        || file
            .profile
            .as_ref()
            .map(|profile| !is_valid_inspiration_profile(profile))
            .unwrap_or(false);
    let file_was_normalized = normalize_invalid_preferences(&mut file);
    let should_migrate = source == PreferencesSource::ValidLegacyV1;
    if profile_is_invalid && source != PreferencesSource::V2 {
        return Ok(state_from_file(path, file, true));
    }
    if file_was_normalized || should_migrate {
        write_preferences_file(path, &file)?;
    }

    Ok(state_from_file(path, file, false))
}

pub(crate) fn save_inspiration_profile_to_file(
    path: &Path,
    profile: InspirationProfile,
) -> Result<InsightPreferenceStateView, String> {
    save_inspiration_profile_to_file_using_writer(path, profile, |destination, bytes| {
        atomic_write(destination, bytes).map_err(|_| ())
    })
}

fn save_inspiration_profile_to_file_using_writer<F>(
    path: &Path,
    profile: InspirationProfile,
    writer: F,
) -> Result<InsightPreferenceStateView, String>
where
    F: FnOnce(&Path, &[u8]) -> Result<(), ()>,
{
    if !is_valid_inspiration_profile(&profile) {
        return Err("Invalid inspiration profile.".to_string());
    }

    let (mut file, _) = read_preferences_file_or_default(path)?;
    normalize_invalid_preferences(&mut file);
    file.profile = Some(profile);
    file.profile_skipped = false;
    write_preferences_file_using(path, &file, writer)?;
    Ok(state_from_file(path, file, false))
}

pub(crate) fn skip_inspiration_profile_to_file(
    path: &Path,
) -> Result<InsightPreferenceStateView, String> {
    skip_inspiration_profile_to_file_using_writer(path, |destination, bytes| {
        atomic_write(destination, bytes).map_err(|_| ())
    })
}

fn skip_inspiration_profile_to_file_using_writer<F>(
    path: &Path,
    writer: F,
) -> Result<InsightPreferenceStateView, String>
where
    F: FnOnce(&Path, &[u8]) -> Result<(), ()>,
{
    let (mut file, _) = read_preferences_file_or_default(path)?;
    normalize_invalid_preferences(&mut file);
    file.profile = None;
    file.profile_skipped = true;
    write_preferences_file_using(path, &file, writer)?;
    Ok(state_from_file(path, file, false))
}

pub(crate) fn clear_inspiration_profile_to_file(
    path: &Path,
) -> Result<InsightPreferenceStateView, String> {
    let (mut file, _) = read_preferences_file_or_default(path)?;
    clear_invalid_default_generation_preferences(&mut file);
    file.profile = None;
    file.profile_skipped = false;
    file.legacy_generation_preference_seed = None;
    write_preferences_file(path, &file)?;
    Ok(state_from_file(path, file, false))
}

pub(crate) fn save_default_generation_preferences_to_file(
    path: &Path,
    preferences: GenerationPreferences,
) -> Result<InsightPreferenceStateView, String> {
    if !is_valid_generation_preferences(&preferences) {
        return Err("Invalid default generation preferences.".to_string());
    }

    let (mut file, source) = read_preferences_file_or_default(path)?;
    if source == PreferencesSource::InvalidLegacyV1 {
        return Err(PROFILE_RESET_REQUIRED_MESSAGE.to_string());
    }
    file.default_generation_preferences = Some(preferences);
    file.legacy_generation_preference_seed = None;
    write_preferences_file(path, &file)?;
    Ok(state_from_file(path, file, false))
}

fn state_from_file(
    path: &Path,
    file: InsightPreferencesFile,
    force_profile_invalid: bool,
) -> InsightPreferenceStateView {
    if force_profile_invalid {
        return InsightPreferenceStateView {
            profile: None,
            profile_skipped: false,
            profile_status: "invalid".to_string(),
            profile_error: Some(PROFILE_RESET_REQUIRED_MESSAGE.to_string()),
            default_generation_preferences: file
                .default_generation_preferences
                .filter(is_valid_generation_preferences),
            legacy_generation_preference_seed: None,
            preferences_path: path_to_env_string(path),
        };
    }

    let has_profile = file.profile.is_some();
    let profile_is_valid = file
        .profile
        .as_ref()
        .map(is_valid_inspiration_profile)
        .unwrap_or(false);
    let profile_status = if profile_is_valid {
        "valid"
    } else if file.profile.is_some() {
        "invalid"
    } else if file.profile_skipped {
        "skipped"
    } else {
        "missing"
    };

    InsightPreferenceStateView {
        profile: if profile_is_valid { file.profile } else { None },
        profile_skipped: !profile_is_valid && !has_profile && file.profile_skipped,
        profile_status: profile_status.to_string(),
        profile_error: (profile_status == "invalid")
            .then(|| PROFILE_RESET_REQUIRED_MESSAGE.to_string()),
        default_generation_preferences: file
            .default_generation_preferences
            .filter(is_valid_generation_preferences),
        legacy_generation_preference_seed: file.legacy_generation_preference_seed,
        preferences_path: path_to_env_string(path),
    }
}

fn read_preferences_file_or_default(
    path: &Path,
) -> Result<(InsightPreferencesFile, PreferencesSource), String> {
    if path.exists() {
        read_preferences_file(path)
    } else {
        Ok((InsightPreferencesFile::default(), PreferencesSource::V2))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreferencesSource {
    V2,
    ValidLegacyV1,
    InvalidLegacyV1,
}

fn read_preferences_file(
    path: &Path,
) -> Result<(InsightPreferencesFile, PreferencesSource), String> {
    let content = fs::read_to_string(path).map_err(|_| PREFERENCES_READ_ERROR.to_string())?;
    let value: serde_json::Value =
        serde_json::from_str(&content).map_err(|_| PREFERENCES_READ_ERROR.to_string())?;
    if value.get("schemaVersion").is_some() {
        let file: InsightPreferencesFile =
            serde_json::from_value(value).map_err(|_| PREFERENCES_READ_ERROR.to_string())?;
        if file.schema_version != INSIGHT_PREFERENCES_SCHEMA_VERSION {
            return Err(PREFERENCES_READ_ERROR.to_string());
        }
        return Ok((file, PreferencesSource::V2));
    }

    let legacy: LegacyInsightPreferencesFileV1 =
        serde_json::from_value(value).map_err(|_| PREFERENCES_READ_ERROR.to_string())?;
    let legacy_profile_is_invalid = legacy
        .profile
        .as_ref()
        .map(|profile| !is_valid_legacy_inspiration_profile(profile))
        .unwrap_or(false);
    let source = if legacy_profile_is_invalid {
        PreferencesSource::InvalidLegacyV1
    } else {
        PreferencesSource::ValidLegacyV1
    };
    Ok((migrate_legacy_preferences(legacy), source))
}

fn write_preferences_file(path: &Path, file: &InsightPreferencesFile) -> Result<(), String> {
    write_preferences_file_using(path, file, |destination, bytes| {
        atomic_write(destination, bytes).map_err(|_| ())
    })
}

fn write_preferences_file_using<F>(
    path: &Path,
    file: &InsightPreferencesFile,
    writer: F,
) -> Result<(), String>
where
    F: FnOnce(&Path, &[u8]) -> Result<(), ()>,
{
    let content =
        serde_json::to_string_pretty(file).map_err(|_| PREFERENCES_WRITE_ERROR.to_string())? + "\n";
    writer(path, content.as_bytes()).map_err(|_| PREFERENCES_WRITE_ERROR.to_string())
}

fn migrate_legacy_preferences(legacy: LegacyInsightPreferencesFileV1) -> InsightPreferencesFile {
    let default_generation_preferences = legacy
        .default_generation_preferences
        .filter(is_valid_generation_preferences);
    let (profile, legacy_generation_preference_seed) = match legacy.profile {
        Some(profile) => {
            let is_valid = is_valid_legacy_inspiration_profile(&profile);
            let seed = (is_valid && default_generation_preferences.is_none())
                .then(|| LegacyGenerationPreferenceSeed {
                    styles: profile.default_styles.clone(),
                    avoid: profile.default_avoid.clone(),
                })
                .filter(|seed| !seed.styles.is_empty() || !seed.avoid.is_empty());
            (Some(profile.into()), seed)
        }
        None => (None, None),
    };
    InsightPreferencesFile {
        schema_version: INSIGHT_PREFERENCES_SCHEMA_VERSION,
        profile,
        profile_skipped: legacy.profile_skipped,
        default_generation_preferences,
        legacy_generation_preference_seed,
    }
}

impl From<LegacyInspirationProfileV1> for InspirationProfile {
    fn from(profile: LegacyInspirationProfileV1) -> Self {
        Self {
            role: profile.role,
            domain: profile.domain,
            stage: profile.stage,
            city_context: profile.city_context,
            gender_perspective: profile.gender_perspective,
            platforms: profile.platforms,
        }
    }
}

fn clear_invalid_default_generation_preferences(file: &mut InsightPreferencesFile) -> bool {
    if file
        .default_generation_preferences
        .as_ref()
        .map(|preferences| !is_valid_generation_preferences(preferences))
        .unwrap_or(false)
    {
        file.default_generation_preferences = None;
        true
    } else {
        false
    }
}

fn normalize_invalid_preferences(file: &mut InsightPreferencesFile) -> bool {
    let default_was_invalid = clear_invalid_default_generation_preferences(file);
    let seed_was_invalid = clear_invalid_legacy_generation_preference_seed(file);
    default_was_invalid || seed_was_invalid
}

fn clear_invalid_legacy_generation_preference_seed(file: &mut InsightPreferencesFile) -> bool {
    if file
        .legacy_generation_preference_seed
        .as_ref()
        .map(|seed| !is_valid_legacy_generation_preference_seed(seed))
        .unwrap_or(false)
    {
        file.legacy_generation_preference_seed = None;
        true
    } else {
        false
    }
}

fn is_valid_inspiration_profile(profile: &InspirationProfile) -> bool {
    is_allowed_single(&profile.role, PROFILE_ROLE_IDS)
        && is_allowed_single(&profile.domain, PROFILE_DOMAIN_IDS)
        && is_allowed_single(&profile.stage, PROFILE_STAGE_IDS)
        && is_allowed_single(&profile.city_context, PROFILE_CITY_CONTEXT_IDS)
        && is_allowed_single(&profile.gender_perspective, PROFILE_GENDER_PERSPECTIVE_IDS)
        && is_allowed_multi(&profile.platforms, PROFILE_PLATFORM_IDS, 0, 3)
}

fn is_valid_legacy_inspiration_profile(profile: &LegacyInspirationProfileV1) -> bool {
    is_allowed_single(&profile.role, PROFILE_ROLE_IDS)
        && is_allowed_single(&profile.domain, PROFILE_DOMAIN_IDS)
        && is_allowed_single(&profile.stage, PROFILE_STAGE_IDS)
        && is_allowed_single(&profile.city_context, PROFILE_CITY_CONTEXT_IDS)
        && is_allowed_single(&profile.gender_perspective, PROFILE_GENDER_PERSPECTIVE_IDS)
        && is_allowed_multi(&profile.platforms, PROFILE_PLATFORM_IDS, 0, 3)
        && is_allowed_multi(&profile.default_styles, PROFILE_DEFAULT_STYLE_IDS, 0, 3)
        && is_allowed_multi(&profile.default_avoid, PROFILE_DEFAULT_AVOID_IDS, 0, 3)
}

fn is_valid_legacy_generation_preference_seed(seed: &LegacyGenerationPreferenceSeed) -> bool {
    is_allowed_multi(&seed.styles, GENERATION_STYLE_IDS, 0, 3)
        && is_allowed_multi(&seed.avoid, GENERATION_AVOID_IDS, 0, 3)
}

fn is_valid_generation_preferences(preferences: &GenerationPreferences) -> bool {
    is_allowed_single(&preferences.goal, GENERATION_GOAL_IDS)
        && is_allowed_single(&preferences.scenario, GENERATION_SCENARIO_IDS)
        && is_allowed_multi(&preferences.angles, GENERATION_ANGLE_IDS, 1, 3)
        && is_allowed_single(&preferences.audience, GENERATION_AUDIENCE_IDS)
        && is_allowed_multi(&preferences.styles, GENERATION_STYLE_IDS, 1, 2)
        && is_allowed_multi(&preferences.avoid, GENERATION_AVOID_IDS, 0, 3)
}

fn is_allowed_single(value: &str, allowed: &[&str]) -> bool {
    allowed.contains(&value)
}

fn is_allowed_multi(values: &[String], allowed: &[&str], min: usize, max: usize) -> bool {
    if values.len() < min || values.len() > max {
        return false;
    }
    let mut seen = HashSet::new();
    values
        .iter()
        .all(|value| allowed.contains(&value.as_str()) && seen.insert(value))
}

const PROFILE_ROLE_IDS: &[&str] = &[
    "content_creator",
    "product_ops",
    "marketing_sales",
    "entrepreneur",
    "student_researcher",
    "teacher_trainer",
    "investor_business_analyst",
    "general_learner",
    "unspecified",
];
const PROFILE_DOMAIN_IDS: &[&str] = &[
    "content_media",
    "product_operations",
    "marketing_sales",
    "education_training",
    "technology_rd",
    "management_consulting",
    "investment_business",
    "freelance",
    "general_perspective",
    "unspecified",
];
const PROFILE_STAGE_IDS: &[&str] = &[
    "student",
    "early_career",
    "experienced_professional",
    "manager",
    "entrepreneur_operator",
    "retired",
    "unspecified",
];
const PROFILE_CITY_CONTEXT_IDS: &[&str] = &[
    "tier1_city",
    "new_tier1_city",
    "lower_tier_city",
    "county_township",
    "overseas",
    "unspecified",
];
const PROFILE_GENDER_PERSPECTIVE_IDS: &[&str] = &[
    "unspecified",
    "female_perspective",
    "male_perspective",
    "neutral_perspective",
];
const PROFILE_PLATFORM_IDS: &[&str] = &[
    "douyin",
    "xiaohongshu",
    "wechat_channels",
    "bilibili",
    "wechat_official_account",
    "podcast",
    "course_community",
    "internal_sharing",
];
const PROFILE_DEFAULT_STYLE_IDS: &[&str] = &[
    "direct_sharp",
    "gentle_inspiring",
    "professional_analysis",
    "grounded",
    "storytelling",
    "short_video_friendly",
    "long_form_friendly",
];
const PROFILE_DEFAULT_AVOID_IDS: &[&str] = &[
    "chicken_soup",
    "academic",
    "vague",
    "clickbait",
    "commercialized",
    "negative",
    "grand_narrative",
];
const GENERATION_GOAL_IDS: &[&str] = &[
    "content_creation",
    "learning_understanding",
    "review_deconstruction",
    "business_insight",
    "controversy_discussion",
    "action_advice",
];
const GENERATION_SCENARIO_IDS: &[&str] = &[
    "personal_notes",
    "short_video",
    "article_official_account",
    "livestream_podcast",
    "team_sharing",
    "client_communication",
    "course_community",
];
const GENERATION_ANGLE_IDS: &[&str] = &[
    "topic_angle",
    "contrarian_view",
    "audience_pain_point",
    "practical_advice",
    "case_analogy",
    "risk_controversy",
    "trend_judgment",
    "reusable_method",
    "memorable_phrase",
    "cognitive_refresh",
];
const GENERATION_AUDIENCE_IDS: &[&str] = &[
    "self",
    "beginners",
    "peers",
    "clients",
    "boss_team",
    "fans_readers",
];
const GENERATION_STYLE_IDS: &[&str] = &[
    "direct_sharp",
    "gentle_inspiring",
    "professional_analysis",
    "grounded",
    "storytelling",
    "short_video_friendly",
    "long_form_friendly",
];
const GENERATION_AVOID_IDS: &[&str] = &[
    "chicken_soup",
    "academic",
    "vague",
    "clickbait",
    "commercialized",
    "negative",
    "grand_narrative",
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn load_missing_preferences_file_reports_missing_profile() {
        let path = temp_file("missing_preferences");

        let state = load_insight_preferences_from_file(&path).expect("load state");

        assert_eq!(state.profile, None);
        assert!(!state.profile_skipped);
        assert_eq!(state.profile_status, "missing");
        assert_eq!(state.profile_error, None);
        assert_eq!(state.default_generation_preferences, None);
        assert!(state.preferences_path.ends_with("insight-preferences.json"));
    }

    #[test]
    fn save_skip_and_clear_profile_round_trip() {
        let path = temp_file("profile_round_trip");

        let saved = save_inspiration_profile_to_file(&path, valid_profile()).expect("save profile");
        assert_eq!(saved.profile, Some(valid_profile()));
        assert!(!saved.profile_skipped);
        assert_eq!(saved.profile_status, "valid");
        assert_eq!(read_json(&path)["schemaVersion"], 2);

        let skipped = skip_inspiration_profile_to_file(&path).expect("skip profile");
        assert_eq!(skipped.profile, None);
        assert!(skipped.profile_skipped);
        assert_eq!(skipped.profile_status, "skipped");

        let cleared = clear_inspiration_profile_to_file(&path).expect("clear profile");
        assert_eq!(cleared.profile, None);
        assert!(!cleared.profile_skipped);
        assert_eq!(cleared.profile_status, "missing");
    }

    #[test]
    fn invalid_profile_requires_reset_and_preserves_valid_default_preferences() {
        let path = temp_file("invalid_profile");
        write_json(
            &path,
            r#"{
  "profile": {
    "role": "content_creation",
    "domain": "marketing_sales",
    "stage": "manager",
    "cityContext": "new_tier1_city",
    "genderPerspective": "unspecified",
    "platforms": ["douyin"],
    "defaultStyles": [],
    "defaultAvoid": []
  },
  "profileSkipped": false,
  "defaultGenerationPreferences": {
    "goal": "content_creation",
    "scenario": "short_video",
    "angles": ["topic_angle"],
    "audience": "beginners",
    "styles": ["direct_sharp"],
    "avoid": []
  }
}"#,
        );

        let state = load_insight_preferences_from_file(&path).expect("load state");

        assert_eq!(state.profile, None);
        assert!(!state.profile_skipped);
        assert_eq!(state.profile_status, "invalid");
        assert_eq!(
            state.profile_error,
            Some("灵感档案需要重新设置".to_string())
        );
        assert_eq!(
            state.default_generation_preferences,
            Some(valid_generation_preferences())
        );
    }

    #[test]
    fn invalid_default_generation_preferences_are_cleared_on_read() {
        let path = temp_file("invalid_default_generation_preferences");
        write_json(
            &path,
            r#"{
  "profile": null,
  "profileSkipped": true,
  "defaultGenerationPreferences": {
    "goal": "内容创作",
    "scenario": "short_video",
    "angles": [],
    "audience": "beginners",
    "styles": ["direct_sharp"],
    "avoid": []
  }
}"#,
        );

        let state = load_insight_preferences_from_file(&path).expect("load state");
        let written = fs::read_to_string(&path).expect("read preferences file");

        assert!(state.profile_skipped);
        assert_eq!(state.default_generation_preferences, None);
        assert!(!written.contains("defaultGenerationPreferences"));
    }

    #[test]
    fn save_profile_rejects_invalid_ids_before_writing() {
        let path = temp_file("reject_invalid_profile");
        let mut profile = valid_profile();
        profile.platforms = vec![
            "douyin".to_string(),
            "bilibili".to_string(),
            "podcast".to_string(),
            "xiaohongshu".to_string(),
        ];

        let error = save_inspiration_profile_to_file(&path, profile).expect_err("reject profile");

        assert!(error.contains("Invalid inspiration profile"));
        assert!(!path.exists());
    }

    #[test]
    fn save_default_generation_preferences_validates_ids_before_writing() {
        let path = temp_file("default_generation_preferences");

        let saved =
            save_default_generation_preferences_to_file(&path, valid_generation_preferences())
                .expect("save defaults");
        assert_eq!(
            saved.default_generation_preferences,
            Some(valid_generation_preferences())
        );

        let mut invalid = valid_generation_preferences();
        invalid.goal = "内容创作".to_string();
        let error = save_default_generation_preferences_to_file(&path, invalid)
            .expect_err("reject default");

        assert!(error.contains("Invalid default generation preferences"));
    }

    #[test]
    fn migrates_v1_profile_and_keeps_complete_generation_defaults() {
        let path = temp_file("migrate_v1_with_defaults");
        write_json(
            &path,
            &v1_preferences_json(
                &["direct_sharp"],
                &["clickbait"],
                Some(valid_generation_preferences()),
            ),
        );

        let state = load_insight_preferences_from_file(&path).expect("migrate preferences");
        let written = read_json(&path);

        assert_eq!(state.profile_status, "valid");
        assert_eq!(
            state.default_generation_preferences,
            Some(valid_generation_preferences())
        );
        assert_eq!(written["schemaVersion"], 2);
        assert!(fs::read_to_string(&path)
            .expect("read migrated preferences")
            .ends_with('\n'));
        assert!(written["profile"].get("defaultStyles").is_none());
        assert!(written["profile"].get("defaultAvoid").is_none());
        assert!(written.get("legacyGenerationPreferenceSeed").is_none());
        let legacy_profile = serde_json::json!({
            "role": "marketing_sales",
            "domain": "marketing_sales",
            "stage": "manager",
            "cityContext": "new_tier1_city",
            "genderPerspective": "unspecified",
            "platforms": ["douyin"],
            "defaultStyles": ["direct_sharp"],
            "defaultAvoid": []
        });
        assert!(serde_json::from_value::<InspirationProfile>(legacy_profile).is_err());
    }

    #[test]
    fn migrates_v1_profile_values_to_edit_only_seed_without_defaults() {
        let path = temp_file("migrate_v1_to_seed");
        let mut invalid_defaults = valid_generation_preferences();
        invalid_defaults.styles = vec![];
        write_json(
            &path,
            &v1_preferences_json(
                &["direct_sharp", "grounded", "storytelling"],
                &["clickbait", "vague"],
                Some(invalid_defaults),
            ),
        );

        let state = load_insight_preferences_from_file(&path).expect("migrate preferences");
        let state_json = serde_json::to_value(&state).expect("serialize state");
        let written = read_json(&path);

        assert_eq!(state.default_generation_preferences, None);
        assert_eq!(
            state_json["legacyGenerationPreferenceSeed"]["styles"],
            serde_json::json!(["direct_sharp", "grounded", "storytelling"])
        );
        assert_eq!(
            state_json["legacyGenerationPreferenceSeed"]["avoid"],
            serde_json::json!(["clickbait", "vague"])
        );
        assert_eq!(written["schemaVersion"], 2);
        assert_eq!(
            written["legacyGenerationPreferenceSeed"],
            state_json["legacyGenerationPreferenceSeed"]
        );
    }

    #[test]
    fn invalid_v1_profile_requires_reset_without_partial_migration() {
        let path = temp_file("invalid_v1_no_partial_migration");
        let original = v1_preferences_json(
            &[
                "direct_sharp",
                "grounded",
                "storytelling",
                "professional_analysis",
            ],
            &["clickbait"],
            Some(valid_generation_preferences()),
        );
        write_json(&path, &original);

        let state = load_insight_preferences_from_file(&path).expect("load invalid profile");

        assert_eq!(state.profile_status, "invalid");
        assert_eq!(
            state.default_generation_preferences,
            Some(valid_generation_preferences())
        );
        assert_eq!(fs::read_to_string(&path).expect("read original"), original);
    }

    #[test]
    fn default_save_preserves_invalid_v1_preferences_bytes() {
        let path = temp_file("default_save_preserves_invalid_v1");
        let original = v1_preferences_json(
            &[
                "direct_sharp",
                "grounded",
                "storytelling",
                "professional_analysis",
            ],
            &["clickbait"],
            Some(valid_generation_preferences()),
        );
        write_json(&path, &original);
        let mut replacement = valid_generation_preferences();
        replacement.goal = "learning_understanding".to_string();

        let error = save_default_generation_preferences_to_file(&path, replacement)
            .expect_err("invalid legacy profile must be reset first");

        assert_eq!(error, PROFILE_RESET_REQUIRED_MESSAGE);
        assert_eq!(
            fs::read(&path).expect("read original bytes"),
            original.as_bytes()
        );
    }

    #[test]
    fn invalid_v1_resolution_actions_do_not_salvage_legacy_seed() {
        let save_path = write_invalid_v1_preferences("invalid_v1_save_resolution", None);
        let saved = save_inspiration_profile_to_file(&save_path, valid_profile())
            .expect("replace invalid profile");

        let skip_path = write_invalid_v1_preferences("invalid_v1_skip_resolution", None);
        let skipped = skip_inspiration_profile_to_file(&skip_path).expect("skip invalid profile");

        let clear_path = write_invalid_v1_preferences("invalid_v1_clear_resolution", None);
        let cleared =
            clear_inspiration_profile_to_file(&clear_path).expect("clear invalid profile");

        for (path, state) in [
            (save_path, saved),
            (skip_path, skipped),
            (clear_path, cleared),
        ] {
            let written = read_json(&path);
            assert_eq!(state.legacy_generation_preference_seed, None);
            assert!(written.get("legacyGenerationPreferenceSeed").is_none());
            assert!(written["profile"].get("defaultStyles").is_none());
            assert!(written["profile"].get("defaultAvoid").is_none());
        }
    }

    #[test]
    fn invalid_v1_resolution_actions_preserve_valid_complete_defaults() {
        let defaults = valid_generation_preferences();
        let save_path = write_invalid_v1_preferences(
            "invalid_v1_save_preserves_defaults",
            Some(defaults.clone()),
        );
        let saved = save_inspiration_profile_to_file(&save_path, valid_profile())
            .expect("replace invalid profile");

        let skip_path = write_invalid_v1_preferences(
            "invalid_v1_skip_preserves_defaults",
            Some(defaults.clone()),
        );
        let skipped = skip_inspiration_profile_to_file(&skip_path).expect("skip invalid profile");

        let clear_path = write_invalid_v1_preferences(
            "invalid_v1_clear_preserves_defaults",
            Some(defaults.clone()),
        );
        let cleared =
            clear_inspiration_profile_to_file(&clear_path).expect("clear invalid profile");

        assert_eq!(saved.default_generation_preferences, Some(defaults.clone()));
        assert_eq!(
            skipped.default_generation_preferences,
            Some(defaults.clone())
        );
        assert_eq!(cleared.default_generation_preferences, Some(defaults));
    }

    #[test]
    fn confirmed_generation_defaults_remove_migration_seed_atomically() {
        let path = temp_file("confirm_removes_seed");
        write_json(&path, &v2_preferences_json(true, true));

        let state =
            save_default_generation_preferences_to_file(&path, valid_generation_preferences())
                .expect("save defaults");
        let written = read_json(&path);

        assert_eq!(
            state.default_generation_preferences,
            Some(valid_generation_preferences())
        );
        assert!(written.get("legacyGenerationPreferenceSeed").is_none());
        assert_eq!(written["schemaVersion"], 2);
    }

    #[test]
    fn clearing_profile_removes_unconfirmed_migration_seed() {
        let path = temp_file("clear_removes_seed");
        write_json(&path, &v2_preferences_json(true, true));

        let state = clear_inspiration_profile_to_file(&path).expect("clear profile");
        let written = read_json(&path);

        assert_eq!(state.profile, None);
        assert!(!state.profile_skipped);
        assert_eq!(
            state.default_generation_preferences,
            Some(valid_generation_preferences())
        );
        assert!(written.get("legacyGenerationPreferenceSeed").is_none());
        assert_eq!(written["schemaVersion"], 2);
    }

    #[test]
    fn unknown_v2_migration_seed_style_is_cleared() {
        assert_invalid_v2_seed_is_cleared(&["unknown_style"], &["clickbait"]);
    }

    #[test]
    fn duplicate_v2_migration_seed_styles_are_cleared() {
        assert_invalid_v2_seed_is_cleared(&["direct_sharp", "direct_sharp"], &["clickbait"]);
    }

    #[test]
    fn duplicate_v2_migration_seed_avoid_values_are_cleared() {
        assert_invalid_v2_seed_is_cleared(&["direct_sharp"], &["clickbait", "clickbait"]);
    }

    #[test]
    fn v2_migration_seed_with_more_than_three_styles_is_cleared() {
        assert_invalid_v2_seed_is_cleared(
            &[
                "direct_sharp",
                "grounded",
                "storytelling",
                "professional_analysis",
            ],
            &[],
        );
    }

    #[test]
    fn v2_migration_seed_with_more_than_three_avoid_values_is_cleared() {
        assert_invalid_v2_seed_is_cleared(&[], &["clickbait", "vague", "academic", "negative"]);
    }

    #[test]
    fn valid_three_style_v2_migration_seed_remains_exposed_unchanged() {
        let path = temp_file("valid_three_style_seed");
        let styles = ["direct_sharp", "grounded", "storytelling"];
        let avoid = ["clickbait", "vague", "academic"];
        write_v2_seed(&path, &styles, &avoid);

        let state = load_insight_preferences_from_file(&path).expect("load preferences");

        assert_eq!(
            state.legacy_generation_preference_seed,
            Some(LegacyGenerationPreferenceSeed {
                styles: styles.iter().map(|value| (*value).to_string()).collect(),
                avoid: avoid.iter().map(|value| (*value).to_string()).collect(),
            })
        );
        assert_eq!(
            read_json(&path)["legacyGenerationPreferenceSeed"]["styles"],
            serde_json::json!(styles)
        );
    }

    #[test]
    fn profile_save_serializes_normalized_seed_in_authoritative_write() {
        let path = temp_file("profile_save_single_write");
        write_v2_seed(&path, &["unknown_style"], &["clickbait"]);
        let serialized = std::cell::RefCell::new(None);
        let mut profile = valid_profile();
        profile.role = "content_creator".to_string();

        let state = save_inspiration_profile_to_file_using_writer(
            &path,
            profile.clone(),
            |_destination, bytes| {
                serialized.replace(Some(bytes.to_vec()));
                Ok(())
            },
        )
        .expect("serialize profile save");
        let written: serde_json::Value = serde_json::from_slice(
            serialized
                .borrow()
                .as_deref()
                .expect("capture authoritative write"),
        )
        .expect("parse authoritative write");

        assert_eq!(state.profile, Some(profile));
        assert_eq!(state.legacy_generation_preference_seed, None);
        assert!(written.get("legacyGenerationPreferenceSeed").is_none());
        assert_eq!(written["profile"]["role"], "content_creator");
    }

    #[test]
    fn profile_skip_serializes_normalized_seed_in_authoritative_write() {
        let path = temp_file("profile_skip_single_write");
        write_v2_seed(&path, &["direct_sharp", "direct_sharp"], &["clickbait"]);
        let serialized = std::cell::RefCell::new(None);

        let state = skip_inspiration_profile_to_file_using_writer(&path, |_destination, bytes| {
            serialized.replace(Some(bytes.to_vec()));
            Ok(())
        })
        .expect("serialize profile skip");
        let written: serde_json::Value = serde_json::from_slice(
            serialized
                .borrow()
                .as_deref()
                .expect("capture authoritative write"),
        )
        .expect("parse authoritative write");

        assert_eq!(state.profile, None);
        assert!(state.profile_skipped);
        assert_eq!(state.legacy_generation_preference_seed, None);
        assert!(written.get("legacyGenerationPreferenceSeed").is_none());
        assert_eq!(written["profileSkipped"], true);
    }

    #[test]
    fn profile_save_and_skip_preserve_valid_migration_seed() {
        let save_path = temp_file("profile_save_preserves_seed");
        write_v2_seed(&save_path, &["grounded"], &["clickbait"]);
        let saved =
            save_inspiration_profile_to_file(&save_path, valid_profile()).expect("save profile");

        let skip_path = temp_file("profile_skip_preserves_seed");
        write_v2_seed(&skip_path, &["grounded"], &["clickbait"]);
        let skipped = skip_inspiration_profile_to_file(&skip_path).expect("skip profile");

        let expected = Some(LegacyGenerationPreferenceSeed {
            styles: vec!["grounded".to_string()],
            avoid: vec!["clickbait".to_string()],
        });
        assert_eq!(saved.legacy_generation_preference_seed, expected);
        assert_eq!(skipped.legacy_generation_preference_seed, expected);
    }

    #[test]
    fn failed_atomic_replacement_preserves_original_preferences_bytes() {
        let path = temp_file("failed_atomic_replacement");
        let original = v2_preferences_json(false, false);
        write_json(&path, &original);
        let (mut file, _) = read_preferences_file(&path).expect("read preferences");
        file.profile_skipped = true;

        let error = write_preferences_file_using(&path, &file, |destination, bytes| {
            crate::atomic_files::atomic_write_with_replace_for_test(
                destination,
                bytes,
                |_staging, _destination| {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "injected replacement failure",
                    ))
                },
            )
            .map_err(|_| ())
        })
        .expect_err("replacement must fail");

        assert_eq!(error, PREFERENCES_WRITE_ERROR);
        assert_eq!(
            fs::read(&path).expect("read original bytes"),
            original.as_bytes()
        );
    }

    fn valid_profile() -> InspirationProfile {
        InspirationProfile {
            role: "marketing_sales".to_string(),
            domain: "marketing_sales".to_string(),
            stage: "manager".to_string(),
            city_context: "new_tier1_city".to_string(),
            gender_perspective: "unspecified".to_string(),
            platforms: vec!["douyin".to_string(), "bilibili".to_string()],
        }
    }

    fn valid_generation_preferences() -> GenerationPreferences {
        GenerationPreferences {
            goal: "content_creation".to_string(),
            scenario: "short_video".to_string(),
            angles: vec!["topic_angle".to_string()],
            audience: "beginners".to_string(),
            styles: vec!["direct_sharp".to_string()],
            avoid: vec![],
        }
    }

    fn temp_file(name: &str) -> PathBuf {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_millis();
        std::env::temp_dir()
            .join("StudyMind-insight-preferences-tests")
            .join(format!("{name}-{millis}"))
            .join("insight-preferences.json")
    }

    fn write_json(path: &PathBuf, content: &str) {
        fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
        fs::write(path, content).expect("write json");
    }

    fn read_json(path: &PathBuf) -> serde_json::Value {
        serde_json::from_str(&fs::read_to_string(path).expect("read json")).expect("parse json")
    }

    fn assert_invalid_v2_seed_is_cleared(styles: &[&str], avoid: &[&str]) {
        let name = format!("invalid_v2_seed_{}_{}", styles.join("_"), avoid.join("_"));
        let path = temp_file(&name);
        write_v2_seed(&path, styles, avoid);

        let state = load_insight_preferences_from_file(&path).expect("load preferences");
        let written = read_json(&path);

        assert_eq!(state.profile, Some(valid_profile()));
        assert_eq!(
            state.default_generation_preferences,
            Some(valid_generation_preferences())
        );
        assert_eq!(state.legacy_generation_preference_seed, None);
        assert!(written.get("legacyGenerationPreferenceSeed").is_none());
    }

    fn write_v2_seed(path: &PathBuf, styles: &[&str], avoid: &[&str]) {
        let mut value: serde_json::Value =
            serde_json::from_str(&v2_preferences_json(false, true)).expect("parse v2 preferences");
        value["legacyGenerationPreferenceSeed"] = serde_json::json!({
            "styles": styles,
            "avoid": avoid
        });
        write_json(
            path,
            &(serde_json::to_string_pretty(&value).expect("serialize v2 preferences") + "\n"),
        );
    }

    fn write_invalid_v1_preferences(
        name: &str,
        defaults: Option<GenerationPreferences>,
    ) -> PathBuf {
        let path = temp_file(name);
        write_json(
            &path,
            &v1_preferences_json(
                &[
                    "direct_sharp",
                    "grounded",
                    "storytelling",
                    "professional_analysis",
                ],
                &["clickbait"],
                defaults,
            ),
        );
        path
    }

    fn v1_preferences_json(
        default_styles: &[&str],
        default_avoid: &[&str],
        defaults: Option<GenerationPreferences>,
    ) -> String {
        serde_json::to_string_pretty(&serde_json::json!({
            "profile": {
                "role": "marketing_sales",
                "domain": "marketing_sales",
                "stage": "manager",
                "cityContext": "new_tier1_city",
                "genderPerspective": "unspecified",
                "platforms": ["douyin", "bilibili"],
                "defaultStyles": default_styles,
                "defaultAvoid": default_avoid
            },
            "profileSkipped": false,
            "defaultGenerationPreferences": defaults
        }))
        .expect("serialize v1 preferences")
            + "\n"
    }

    fn v2_preferences_json(with_seed: bool, with_defaults: bool) -> String {
        let mut value = serde_json::json!({
            "schemaVersion": 2,
            "profile": {
                "role": "marketing_sales",
                "domain": "marketing_sales",
                "stage": "manager",
                "cityContext": "new_tier1_city",
                "genderPerspective": "unspecified",
                "platforms": ["douyin", "bilibili"]
            },
            "profileSkipped": false
        });
        if with_seed {
            value["legacyGenerationPreferenceSeed"] = serde_json::json!({
                "styles": ["grounded"],
                "avoid": ["clickbait"]
            });
        }
        if with_defaults {
            value["defaultGenerationPreferences"] =
                serde_json::to_value(valid_generation_preferences()).expect("serialize defaults");
        }
        serde_json::to_string_pretty(&value).expect("serialize v2 preferences") + "\n"
    }
}
