use crate::local_media_contract::{
    LocalMediaKind, LocalMediaSelectionView, AUDIO_EXTENSIONS, INVALID_LOCAL_MEDIA_SELECTION_CODE,
    VIDEO_EXTENSIONS,
};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

const LOCAL_MEDIA_SELECTION_CHANGED: &str = "LOCAL_MEDIA_SELECTION_CHANGED";
const LOCAL_MEDIA_UNSUPPORTED_FORMAT: &str = "LOCAL_MEDIA_UNSUPPORTED_FORMAT";
const LOCAL_MEDIA_UNAVAILABLE: &str = "LOCAL_MEDIA_UNAVAILABLE";
const LOCAL_MEDIA_LINKED: &str = "LOCAL_MEDIA_LINKED";
const LOCAL_MEDIA_STATE_UNAVAILABLE: &str = "LOCAL_MEDIA_SELECTION_INVALID";

#[derive(Clone)]
pub(crate) struct LocalMediaSelection {
    pub(crate) path: PathBuf,
    pub(crate) selection_token: String,
    pub(crate) display_name: String,
    pub(crate) media_kind: LocalMediaKind,
    pub(crate) extension: String,
    pub(crate) size_bytes: u64,
    modified_at: SystemTime,
}

impl fmt::Debug for LocalMediaSelection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("LocalMediaSelection(REDACTED)")
    }
}

#[derive(Default)]
pub(crate) struct LocalMediaSelectionState {
    current: Mutex<Option<LocalMediaSelection>>,
}

impl LocalMediaSelectionState {
    pub(crate) fn select_for_path(
        &self,
        path: &Path,
    ) -> Result<LocalMediaSelectionView, &'static str> {
        let inspected = inspect_source(path)?;
        let token = Uuid::new_v4().hyphenated().to_string();
        let selection = LocalMediaSelection {
            path: path.to_path_buf(),
            selection_token: token.clone(),
            display_name: inspected.display_name.clone(),
            media_kind: inspected.media_kind,
            extension: inspected.extension.clone(),
            size_bytes: inspected.size_bytes,
            modified_at: inspected.modified_at,
        };
        let view = LocalMediaSelectionView::try_new(
            &token,
            &inspected.display_name,
            inspected.media_kind,
            &inspected.extension,
            inspected.size_bytes,
        )?;
        let mut current = self
            .current
            .lock()
            .map_err(|_| LOCAL_MEDIA_STATE_UNAVAILABLE)?;
        *current = Some(selection);
        Ok(view)
    }

    pub(crate) fn resolve(
        &self,
        selection_token: &str,
    ) -> Result<LocalMediaSelection, &'static str> {
        let selected = {
            let current = self
                .current
                .lock()
                .map_err(|_| LOCAL_MEDIA_STATE_UNAVAILABLE)?;
            current
                .as_ref()
                .filter(|selection| selection.selection_token == selection_token)
                .cloned()
                .ok_or(INVALID_LOCAL_MEDIA_SELECTION_CODE)?
        };

        let inspected = match inspect_source(&selected.path) {
            Ok(inspected) => inspected,
            Err(error) => {
                self.clear_if_current(selection_token);
                return Err(error);
            }
        };
        if inspected.size_bytes != selected.size_bytes
            || inspected.modified_at != selected.modified_at
            || inspected.media_kind != selected.media_kind
            || inspected.extension != selected.extension
        {
            self.clear_if_current(selection_token);
            return Err(LOCAL_MEDIA_SELECTION_CHANGED);
        }
        Ok(selected)
    }

    pub(crate) fn clear(&self, selection_token: &str) -> Result<bool, &'static str> {
        let mut current = self
            .current
            .lock()
            .map_err(|_| LOCAL_MEDIA_STATE_UNAVAILABLE)?;
        if current
            .as_ref()
            .is_some_and(|selection| selection.selection_token == selection_token)
        {
            *current = None;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn clear_if_current(&self, selection_token: &str) {
        let _ = self.clear(selection_token);
    }
}

struct InspectedSource {
    display_name: String,
    media_kind: LocalMediaKind,
    extension: String,
    size_bytes: u64,
    modified_at: SystemTime,
}

fn inspect_source(path: &Path) -> Result<InspectedSource, &'static str> {
    if !path.is_absolute() {
        return Err(LOCAL_MEDIA_UNAVAILABLE);
    }
    reject_linked_components(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| LOCAL_MEDIA_UNAVAILABLE)?;
    if !metadata.is_file() {
        return Err(LOCAL_MEDIA_UNAVAILABLE);
    }
    if is_link_or_reparse_point(&metadata) {
        return Err(LOCAL_MEDIA_LINKED);
    }
    let size_bytes = metadata.len();
    if size_bytes == 0 {
        return Err(LOCAL_MEDIA_UNAVAILABLE);
    }
    let modified_at = metadata.modified().map_err(|_| LOCAL_MEDIA_UNAVAILABLE)?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or(LOCAL_MEDIA_UNSUPPORTED_FORMAT)?;
    let media_kind = media_kind_for_extension(&extension)?;
    let raw_name = path
        .file_name()
        .map(|value| value.to_string_lossy())
        .ok_or(LOCAL_MEDIA_UNAVAILABLE)?;
    let display_name = sanitize_display_name(&raw_name, &extension, media_kind);
    Ok(InspectedSource {
        display_name,
        media_kind,
        extension,
        size_bytes,
        modified_at,
    })
}

fn media_kind_for_extension(extension: &str) -> Result<LocalMediaKind, &'static str> {
    if VIDEO_EXTENSIONS.contains(&extension) {
        Ok(LocalMediaKind::Video)
    } else if AUDIO_EXTENSIONS.contains(&extension) {
        Ok(LocalMediaKind::Audio)
    } else {
        Err(LOCAL_MEDIA_UNSUPPORTED_FORMAT)
    }
}

fn sanitize_display_name(raw_name: &str, extension: &str, media_kind: LocalMediaKind) -> String {
    let cleaned = raw_name
        .chars()
        .filter(|value| !is_unsafe_basename_character(*value))
        .collect::<String>();
    let cleaned = cleaned.trim();
    let suffix = format!(".{extension}");
    let has_expected_suffix = cleaned.to_ascii_lowercase().ends_with(&suffix);
    let suffix_start = cleaned.len().saturating_sub(suffix.len());
    let raw_stem = if has_expected_suffix {
        &cleaned[..suffix_start]
    } else {
        ""
    };
    let fallback = match media_kind {
        LocalMediaKind::Video => "local-video",
        LocalMediaKind::Audio => "local-audio",
    };
    let stem = if raw_stem.trim_matches('.').trim().is_empty() {
        fallback
    } else {
        raw_stem.trim()
    };
    let rendered_suffix = if has_expected_suffix {
        &cleaned[suffix_start..]
    } else {
        suffix.as_str()
    };
    let max_stem_chars = 160usize.saturating_sub(rendered_suffix.chars().count());
    let bounded_stem = stem.chars().take(max_stem_chars).collect::<String>();
    format!("{bounded_stem}{rendered_suffix}")
}

fn is_unsafe_basename_character(value: char) -> bool {
    value == '/'
        || value == '\\'
        || value.is_control()
        || matches!(value, '\u{061c}' | '\u{200e}' | '\u{200f}')
        || ('\u{202a}'..='\u{202e}').contains(&value)
        || ('\u{2066}'..='\u{2069}').contains(&value)
}

fn reject_linked_components(path: &Path) -> Result<(), &'static str> {
    for component in path.ancestors() {
        let metadata = fs::symlink_metadata(component).map_err(|_| LOCAL_MEDIA_UNAVAILABLE)?;
        if is_link_or_reparse_point(&metadata) {
            return Err(LOCAL_MEDIA_LINKED);
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(windows)]
fn is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[tauri::command]
pub(crate) fn select_local_media(
    app: AppHandle,
    selection_state: State<'_, std::sync::Arc<LocalMediaSelectionState>>,
) -> Result<Option<LocalMediaSelectionView>, String> {
    let extensions = VIDEO_EXTENSIONS
        .iter()
        .chain(AUDIO_EXTENSIONS.iter())
        .copied()
        .collect::<Vec<_>>();
    let selected = app
        .dialog()
        .file()
        .add_filter("Video and audio", &extensions)
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|_| LOCAL_MEDIA_UNAVAILABLE.to_string())?;
    selection_state
        .select_for_path(&path)
        .map(Some)
        .map_err(str::to_string)
}

#[tauri::command]
pub(crate) fn clear_local_media_selection(
    selection_state: State<'_, std::sync::Arc<LocalMediaSelectionState>>,
    selection_token: String,
) -> Result<bool, String> {
    selection_state
        .clear(&selection_token)
        .map_err(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::LocalMediaSelectionState;
    use crate::local_media_contract::{
        LocalMediaSelectionView, INVALID_LOCAL_MEDIA_SELECTION_CODE,
    };
    use serde_json::Value;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time after epoch")
            .as_nanos();
        // macOS exposes /var as a symlink to /private/var; use the physical
        // temp root so ordinary fixtures do not look like linked sources.
        let temp_root = std::env::temp_dir()
            .canonicalize()
            .expect("resolve physical temp dir");
        let path = temp_root.join(format!(
            "StudyMind-local-media-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn write_media(root: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = root.join(name);
        fs::write(&path, bytes).expect("write media fixture");
        path
    }

    fn selection_token(view: &LocalMediaSelectionView) -> String {
        let value = serde_json::to_value(view).expect("serialize selection view");
        value["selectionToken"]
            .as_str()
            .expect("selection token")
            .to_string()
    }

    #[test]
    fn selects_regular_media_and_returns_only_safe_metadata() {
        let root = temp_dir("selects-regular");
        let source = write_media(&root, "Interview.MP4", b"video-bytes");
        let state = LocalMediaSelectionState::default();

        let view = state
            .select_for_path(&source)
            .expect("select regular video");
        let value = serde_json::to_value(&view).expect("serialize selection");
        let serialized = value.to_string();

        assert_eq!(value["displayName"], "Interview.MP4");
        assert_eq!(value["mediaKind"], "video");
        assert_eq!(value["extension"], "mp4");
        assert_eq!(value["sizeBytes"], 11);
        assert!(!serialized.contains(&root.to_string_lossy().to_string()));
        assert!(!serialized.contains("sourcePath"));

        let token = selection_token(&view);
        let selected = state.resolve(&token).expect("resolve current selection");
        assert_eq!(selected.path, source);

        fs::remove_dir_all(root).expect("remove temp dir");
    }

    #[test]
    fn replacement_invalidates_old_token_and_clear_requires_current_token() {
        let root = temp_dir("replace-and-clear");
        let first_path = write_media(&root, "first.mp4", b"first");
        let second_path = write_media(&root, "second.mp3", b"second");
        let state = LocalMediaSelectionState::default();

        let first = state
            .select_for_path(&first_path)
            .expect("select first media");
        let second = state
            .select_for_path(&second_path)
            .expect("select replacement media");
        let first_token = selection_token(&first);
        let second_token = selection_token(&second);

        assert_eq!(
            state
                .resolve(&first_token)
                .expect_err("old token must fail"),
            INVALID_LOCAL_MEDIA_SELECTION_CODE
        );
        assert!(!state.clear(&first_token).expect("clear stale token"));
        assert!(state.clear(&second_token).expect("clear current token"));
        assert_eq!(
            state
                .resolve(&second_token)
                .expect_err("cleared token must fail"),
            INVALID_LOCAL_MEDIA_SELECTION_CODE
        );

        fs::remove_dir_all(root).expect("remove temp dir");
    }

    #[test]
    fn revalidation_clears_changed_or_missing_selection_without_path_echo() {
        let root = temp_dir("revalidation");
        let source = write_media(&root, "recording.wav", b"original");
        let state = LocalMediaSelectionState::default();
        let view = state.select_for_path(&source).expect("select audio");
        let token = selection_token(&view);

        fs::write(&source, b"changed-size").expect("change selected file");
        let changed = state.resolve(&token).expect_err("changed media must fail");
        assert_eq!(changed, "LOCAL_MEDIA_SELECTION_CHANGED");
        assert!(!changed.contains(&root.to_string_lossy().to_string()));
        assert_eq!(
            state
                .resolve(&token)
                .expect_err("changed selection must be cleared"),
            INVALID_LOCAL_MEDIA_SELECTION_CODE
        );

        let view = state.select_for_path(&source).expect("reselect audio");
        let token = selection_token(&view);
        fs::remove_file(&source).expect("remove selected file");
        let missing = state.resolve(&token).expect_err("missing media must fail");
        assert_eq!(missing, "LOCAL_MEDIA_UNAVAILABLE");
        assert!(!missing.contains(&root.to_string_lossy().to_string()));

        fs::remove_dir_all(root).expect("remove temp dir");
    }

    #[test]
    fn rejects_unsupported_extension_without_exposing_the_path() {
        let root = temp_dir("unsupported");
        let source = write_media(&root, "private-secret.txt", b"text");
        let state = LocalMediaSelectionState::default();

        let error = match state.select_for_path(&source) {
            Ok(_) => panic!("unsupported file must fail"),
            Err(error) => error,
        };

        assert_eq!(error, "LOCAL_MEDIA_UNSUPPORTED_FORMAT");
        assert!(!error.contains("private-secret"));
        assert!(!error.contains(&root.to_string_lossy().to_string()));

        fs::remove_dir_all(root).expect("remove temp dir");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_source_or_ancestor() {
        use std::os::unix::fs::symlink;

        let root = temp_dir("linked");
        let real_dir = root.join("real");
        fs::create_dir_all(&real_dir).expect("create real dir");
        let source = write_media(&real_dir, "recording.mp3", b"audio");
        let linked_file = root.join("linked.mp3");
        symlink(&source, &linked_file).expect("create file symlink");
        let linked_dir = root.join("linked-dir");
        symlink(&real_dir, &linked_dir).expect("create directory symlink");
        let state = LocalMediaSelectionState::default();

        assert_eq!(
            state
                .select_for_path(&linked_file)
                .err()
                .expect("file symlink must fail"),
            "LOCAL_MEDIA_LINKED"
        );
        assert_eq!(
            state
                .select_for_path(&linked_dir.join("recording.mp3"))
                .err()
                .expect("linked ancestor must fail"),
            "LOCAL_MEDIA_LINKED"
        );

        fs::remove_file(linked_file).expect("remove file symlink");
        fs::remove_file(linked_dir).expect("remove directory symlink");
        fs::remove_dir_all(root).expect("remove temp dir");
    }

    #[test]
    fn selection_debug_output_never_contains_the_source_path() {
        let root = temp_dir("debug-redaction");
        let source = write_media(&root, "review-secret.wmv", b"video");
        let state = LocalMediaSelectionState::default();
        let view = state.select_for_path(&source).expect("select video");
        let token = selection_token(&view);
        let selected = state.resolve(&token).expect("resolve selection");

        let debug = format!("{selected:?}");
        assert!(!debug.contains("review-secret"));
        assert!(!debug.contains(&root.to_string_lossy().to_string()));
        assert_eq!(
            Value::String(debug).as_str(),
            Some("LocalMediaSelection(REDACTED)")
        );

        fs::remove_dir_all(root).expect("remove temp dir");
    }
}
