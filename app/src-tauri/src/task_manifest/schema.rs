use super::TASK_SCHEMA_VERSION;
use crate::local_media_contract::{extension_matches_kind, is_safe_display_name, LocalMediaKind};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

const SAFE_ARTIFACT_KEYS: [&str; 12] = [
    "video",
    "audio",
    "transcript_txt",
    "transcript_md",
    "segments",
    "summary",
    "mindmap",
    "insights",
    "insights_md",
    "preference_snapshot",
    "dissection",
    "dissection_md",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TaskArtifact {
    Audio,
    TranscriptTxt,
    TranscriptMd,
    Segments,
    Summary,
    Insights,
    Dissection,
    #[allow(dead_code)]
    DissectionMd,
}

impl TaskArtifact {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Audio => "audio",
            Self::TranscriptTxt => "transcript_txt",
            Self::TranscriptMd => "transcript_md",
            Self::Segments => "segments",
            Self::Summary => "summary",
            Self::Insights => "insights",
            Self::Dissection => "dissection",
            Self::DissectionMd => "dissection_md",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub(super) struct TaskManifestError {
    pub(super) code: String,
    pub(super) message: String,
    pub(super) stage: String,
}

impl TaskManifestError {
    pub(super) fn safe_code(&self) -> String {
        let is_safe = !self.code.is_empty()
            && self.code.len() <= 64
            && self.code.chars().enumerate().all(|(index, ch)| {
                if index == 0 {
                    ch.is_ascii_uppercase()
                } else {
                    ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_'
                }
            });
        if is_safe {
            self.code.clone()
        } else {
            "TASK_FAILED".to_string()
        }
    }

    pub(super) fn safe_message(&self) -> String {
        let normalized = self.message.to_ascii_lowercase();
        if normalized.contains("http://")
            || normalized.contains("https://")
            || normalized.contains("token")
            || normalized.contains("signature")
            || normalized.contains("authorization")
            || normalized.contains("cookie")
            || normalized.contains("credential")
            || normalized.contains("password")
            || normalized.contains("secret")
            || normalized.contains("session")
        {
            format!("Previous task failed ({}).", self.safe_code())
        } else {
            self.message.clone()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SafeTaskError {
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) stage: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct TranscriptMetadata {
    pub(crate) source: String,
    #[serde(default)]
    pub(crate) language: Option<String>,
    #[serde(default)]
    pub(crate) engine: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InsightView {
    pub(crate) id: u64,
    pub(crate) topic: String,
    pub(crate) match_reason: String,
    pub(crate) follow_up_questions: Vec<String>,
    pub(crate) suitable_use: String,
    pub(crate) source_chunk_id: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct LocalSourceManifest {
    display_name: String,
    media_kind: LocalMediaKind,
    extension: String,
}

impl LocalSourceManifest {
    fn is_safe(&self) -> bool {
        extension_matches_kind(&self.extension, self.media_kind)
            && is_safe_display_name(&self.display_name, &self.extension)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum TaskSourceSummary {
    LocalFile {
        #[serde(rename = "displayName")]
        display_name: String,
        #[serde(rename = "mediaKind")]
        media_kind: LocalMediaKind,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub(super) struct TaskManifest {
    #[serde(default)]
    pub(super) schema_version: u64,
    pub(super) task_id: String,
    pub(super) created_at: String,
    #[serde(default)]
    pub(super) updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    local_source: Option<LocalSourceManifest>,
    #[serde(default)]
    pub(super) platform: String,
    pub(super) status: String,
    #[serde(default)]
    pub(super) app_version: String,
    #[serde(default)]
    pub(super) worker_version: String,
    #[serde(default)]
    pub(super) model: String,
    #[serde(default)]
    pub(super) transcript: Option<TranscriptMetadata>,
    #[serde(default)]
    pub(super) artifacts: HashMap<String, String>,
    #[serde(default)]
    pub(super) error: Option<TaskManifestError>,
    #[serde(default)]
    pub(super) text_preview: String,
    #[serde(default)]
    pub(super) insights_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) title: Option<String>,
    #[serde(flatten)]
    pub(super) extra: HashMap<String, serde_json::Value>,
}

pub(crate) fn parse_insight_view(value: &serde_json::Value) -> Option<InsightView> {
    let id = value.get("id").and_then(serde_json::Value::as_u64)?;
    let topic = required_trimmed_string(value, "topic")?;
    let match_reason = required_trimmed_string(value, "matchReason")?;
    let follow_up_questions = value
        .get("followUpQuestions")
        .and_then(serde_json::Value::as_array)?
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        })
        .collect::<Option<Vec<_>>>()?;
    if follow_up_questions.is_empty() {
        return None;
    }
    let suitable_use = required_trimmed_string(value, "suitableUse")?;
    let source_chunk_id = match value.get("sourceChunkId")? {
        serde_json::Value::Null => None,
        raw => Some(raw.as_u64()?),
    };

    Some(InsightView {
        id,
        topic,
        match_reason,
        follow_up_questions,
        suitable_use,
        source_chunk_id,
    })
}

pub(crate) fn parse_insights_payload(payload: &serde_json::Value) -> Vec<InsightView> {
    if payload
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(1)
    {
        return vec![];
    }

    let Some(items) = payload
        .get("insights")
        .and_then(serde_json::Value::as_array)
    else {
        return vec![];
    };

    items
        .iter()
        .map(parse_insight_view)
        .collect::<Option<Vec<_>>>()
        .unwrap_or_default()
}

fn required_trimmed_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

impl TaskManifest {
    pub(super) fn safe_source_summary(&self) -> Option<TaskSourceSummary> {
        if self.schema_version != TASK_SCHEMA_VERSION {
            return None;
        }

        let source = self.local_source.as_ref()?;
        if self.platform != "local" || !source.is_safe() {
            return None;
        }
        Some(TaskSourceSummary::LocalFile {
            display_name: source.display_name.clone(),
            media_kind: source.media_kind,
        })
    }

    pub(super) fn safe_artifacts(&self) -> HashMap<String, String> {
        self.artifacts
            .iter()
            .filter(|(key, raw_path)| validate_relative_artifact_path(raw_path, key).is_ok())
            .map(|(key, raw_path)| (key.clone(), raw_path.clone()))
            .collect()
    }

    pub(super) fn source_privacy_ready(&self) -> bool {
        self.safe_source_summary().is_some()
    }

    pub(super) fn transcript_metadata(&self) -> Option<TranscriptMetadata> {
        self.transcript.clone()
    }
}

pub(super) fn validate_relative_artifact_path(
    raw_path: &str,
    field: &str,
) -> Result<PathBuf, String> {
    if !SAFE_ARTIFACT_KEYS.contains(&field) {
        return Err("Task manifest contains an unsupported artifact field.".to_string());
    }
    let fixed_dissection_path = match field {
        "dissection" => Some("ai/dissection.json"),
        "dissection_md" => Some("ai/dissection.md"),
        _ => None,
    };
    if fixed_dissection_path.is_some_and(|expected| raw_path != expected) {
        return Err("Dissection artifact path is invalid.".to_string());
    }
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err(format!("{field} artifact path cannot be empty."));
    }
    let path = PathBuf::from(trimmed);
    let normalized = trimmed.to_ascii_lowercase();
    let contains_sensitive_material = normalized.contains("://")
        || normalized.contains("xsec_token")
        || normalized.contains("token=")
        || normalized.contains("signature")
        || normalized.contains("authorization")
        || normalized.contains("credential")
        || normalized.contains("password")
        || normalized.contains("secret")
        || normalized.contains("session")
        || normalized.contains("cookie");
    if path.is_absolute()
        || has_forbidden_component(&path)
        || contains_sensitive_material
        || contains_hidden_component(&path)
    {
        return Err(format!(
            "{field} artifact path must stay inside the task directory."
        ));
    }
    Ok(path)
}

fn contains_hidden_component(path: &Path) -> bool {
    path.components()
        .any(|component| component.as_os_str().to_string_lossy().starts_with('.'))
}

pub(super) fn has_forbidden_component(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    })
}
