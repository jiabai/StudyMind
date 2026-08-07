use serde::{Deserialize, Serialize};
use std::path::Path;
use uuid::{Uuid, Variant, Version};

pub(crate) const LOCAL_MEDIA_CONTRACT_VERSION: u32 = 4;
pub(crate) const INVALID_LOCAL_MEDIA_SELECTION_CODE: &str = "LOCAL_MEDIA_SELECTION_INVALID";
pub(crate) const INVALID_LOCAL_MEDIA_WORKER_REQUEST_MESSAGE: &str =
    "Local media request payload was invalid.";
pub(crate) const VIDEO_EXTENSIONS: [&str; 7] = ["mp4", "m4v", "mov", "mkv", "avi", "wmv", "webm"];
pub(crate) const AUDIO_EXTENSIONS: [&str; 8] =
    ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "wma"];

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum LocalMediaKind {
    Video,
    Audio,
}

impl LocalMediaKind {
    fn extensions(self) -> &'static [&'static str] {
        match self {
            Self::Video => &VIDEO_EXTENSIONS,
            Self::Audio => &AUDIO_EXTENSIONS,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalMediaSelectionView {
    selection_token: String,
    display_name: String,
    media_kind: LocalMediaKind,
    extension: String,
    size_bytes: u64,
}

impl LocalMediaSelectionView {
    pub(crate) fn try_new(
        selection_token: &str,
        display_name: &str,
        media_kind: LocalMediaKind,
        extension: &str,
        size_bytes: u64,
    ) -> Result<Self, &'static str> {
        if !is_selection_token(selection_token)
            || !extension_matches_kind(extension, media_kind)
            || !is_safe_display_name(display_name, extension)
            || size_bytes == 0
        {
            return Err(INVALID_LOCAL_MEDIA_SELECTION_CODE);
        }

        Ok(Self {
            selection_token: selection_token.to_string(),
            display_name: display_name.to_string(),
            media_kind,
            extension: extension.to_string(),
            size_bytes,
        })
    }

    #[cfg(test)]
    pub(crate) fn selection_token(&self) -> &str {
        &self.selection_token
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawProcessLocalMediaIpcRequest {
    selection_token: String,
    asr_model: String,
}

#[derive(Eq, PartialEq)]
pub(crate) struct ProcessLocalMediaIpcRequest {
    pub(crate) selection_token: String,
    pub(crate) asr_model: String,
}

pub(crate) fn parse_process_local_media_ipc_request(
    value: serde_json::Value,
) -> Result<ProcessLocalMediaIpcRequest, &'static str> {
    let raw: RawProcessLocalMediaIpcRequest =
        serde_json::from_value(value).map_err(|_| INVALID_LOCAL_MEDIA_SELECTION_CODE)?;
    if !is_selection_token(&raw.selection_token)
        || !crate::SUPPORTED_ASR_MODELS.contains(&raw.asr_model.as_str())
    {
        return Err(INVALID_LOCAL_MEDIA_SELECTION_CODE);
    }
    Ok(ProcessLocalMediaIpcRequest {
        selection_token: raw.selection_token,
        asr_model: raw.asr_model,
    })
}

#[derive(Serialize)]
struct ProcessLocalMediaWorkerRequest<'a> {
    contract_version: u32,
    source_path: &'a str,
    media_kind: LocalMediaKind,
    safe_display_name: &'a str,
    source_extension: &'a str,
    asr_model: &'a str,
}

pub(crate) fn serialize_process_local_media_worker_request(
    source_path: &Path,
    media_kind: LocalMediaKind,
    safe_display_name: &str,
    source_extension: &str,
    asr_model: &str,
) -> Result<String, &'static str> {
    let source_path_value = source_path
        .to_str()
        .filter(|value| !value.is_empty())
        .ok_or(INVALID_LOCAL_MEDIA_WORKER_REQUEST_MESSAGE)?;
    let path_extension_matches = source_path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case(source_extension));

    if !source_path.is_absolute()
        || !path_extension_matches
        || !extension_matches_kind(source_extension, media_kind)
        || !is_safe_display_name(safe_display_name, source_extension)
        || !crate::SUPPORTED_ASR_MODELS.contains(&asr_model)
    {
        return Err(INVALID_LOCAL_MEDIA_WORKER_REQUEST_MESSAGE);
    }

    serde_json::to_string(&ProcessLocalMediaWorkerRequest {
        contract_version: LOCAL_MEDIA_CONTRACT_VERSION,
        source_path: source_path_value,
        media_kind,
        safe_display_name,
        source_extension,
        asr_model,
    })
    .map_err(|_| INVALID_LOCAL_MEDIA_WORKER_REQUEST_MESSAGE)
}

fn is_selection_token(value: &str) -> bool {
    let Ok(uuid) = Uuid::parse_str(value) else {
        return false;
    };
    uuid.hyphenated().to_string() == value
        && uuid.get_variant() == Variant::RFC4122
        && matches!(
            uuid.get_version(),
            Some(Version::Mac | Version::Dce | Version::Md5 | Version::Random | Version::Sha1)
        )
}

pub(crate) fn extension_matches_kind(extension: &str, media_kind: LocalMediaKind) -> bool {
    media_kind.extensions().contains(&extension)
}

pub(crate) fn is_safe_display_name(value: &str, extension: &str) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= 160
        && value != "."
        && value != ".."
        && !value.chars().any(is_unsafe_basename_character)
        && value.to_lowercase().ends_with(&format!(".{extension}"))
}

fn is_unsafe_basename_character(value: char) -> bool {
    value == '/'
        || value == '\\'
        || value.is_control()
        || matches!(value, '\u{061c}' | '\u{200e}' | '\u{200f}')
        || ('\u{202a}'..='\u{202e}').contains(&value)
        || ('\u{2066}'..='\u{2069}').contains(&value)
}
