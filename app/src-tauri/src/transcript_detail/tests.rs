use super::{
    load_transcript_detail_from_output_root, load_transcript_detail_from_roots,
    save_transcript_edit_to_output_root, LoadTranscriptDetailRequest, SaveTranscriptEditRequest,
    TranscriptSegmentView,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn load_detail_reads_text_segments_audio_and_backup_status() {
    let output_root = temp_dir("load_detail_task");
    let task_id = "20260705-153012-local-abcdef123456";
    let task_dir = create_task(&output_root, task_id);
    fs::write(
        task_dir.join("transcript").join("transcript.txt"),
        "original text\n",
    )
    .expect("write transcript");
    fs::write(task_dir.join("media").join("audio.wav"), b"fake wav").expect("write audio");
    fs::write(
            task_dir.join("transcript").join("segments.json"),
            r#"{"segments":[{"id":"seg-0001","start_ms":0,"end_ms":1200,"text":"original text","speaker":"solo"}]}"#,
        )
        .expect("write segments");
    write_manifest(&task_dir, task_id, true);

    let detail = load_transcript_detail_from_output_root(
        &output_root,
        LoadTranscriptDetailRequest {
            task_id: task_id.to_string(),
        },
    )
    .expect("load detail");

    assert_eq!(detail.task_id, task_id);
    assert_eq!(detail.text, "original text");
    assert_eq!(
        detail.segments,
        vec![TranscriptSegmentView {
            id: "seg-0001".to_string(),
            start_ms: 0,
            end_ms: 1200,
            text: "original text".to_string(),
            speaker: Some("solo".to_string()),
        }]
    );
    assert!(detail
        .audio_path
        .expect("audio path")
        .ends_with("media/audio.wav"));
    assert!(!detail.has_original_backup);
}

#[test]
fn load_detail_copies_external_output_audio_to_app_local_playback_path() {
    let output_root = temp_dir("load_detail_external_output_root");
    let app_local_root = temp_dir("load_detail_app_local");
    let app_local_outputs = app_local_root.join("outputs");
    let app_local_cache = app_local_root.join("cache");
    let task_id = "20260705-153012-local-abcdef123456";
    let task_dir = create_task(&output_root, task_id);
    let source_audio_path = task_dir.join("media").join("audio.wav");
    fs::write(
        task_dir.join("transcript").join("transcript.txt"),
        "original text\n",
    )
    .expect("write transcript");
    fs::write(&source_audio_path, b"fake wav").expect("write audio");
    write_manifest(&task_dir, task_id, false);

    let detail = load_transcript_detail_from_roots(
        &output_root,
        &app_local_outputs,
        &app_local_cache,
        LoadTranscriptDetailRequest {
            task_id: task_id.to_string(),
        },
    )
    .expect("load detail");

    let audio_path = detail.audio_path.expect("audio path");
    let audio_asset_path = detail.audio_asset_path.expect("audio asset path");
    assert!(audio_path.ends_with("media/audio.wav"));
    assert!(audio_asset_path.ends_with(
        "cache/.StudyMind-audio-review/20260705-153012-local-abcdef123456/audio.wav"
    ));
    assert_ne!(audio_path, audio_asset_path);
    let app_local_cache = app_local_cache
        .canonicalize()
        .expect("resolve app-local cache")
        .to_string_lossy()
        .replace('\\', "/");
    assert!(audio_asset_path.starts_with(&app_local_cache));
    assert_eq!(
        fs::read(audio_asset_path).expect("read copied audio"),
        b"fake wav"
    );
}

#[test]
fn load_detail_replaces_existing_cache_link_without_overwriting_link_target() {
    let output_root = temp_dir("load_detail_replaces_cache_link_output");
    let app_local_root = temp_dir("load_detail_replaces_cache_link_app_local");
    let app_local_outputs = app_local_root.join("outputs");
    let app_local_cache = app_local_root.join("cache");
    let outside_dir = temp_dir("load_detail_replaces_cache_link_outside");
    let task_id = "20260705-153012-local-abcdef123456";
    let task_dir = create_task(&output_root, task_id);
    let source_audio_path = task_dir.join("media").join("audio.wav");
    fs::write(
        task_dir.join("transcript").join("transcript.txt"),
        "original text\n",
    )
    .expect("write transcript");
    fs::write(&source_audio_path, b"fake wav").expect("write audio");
    write_manifest(&task_dir, task_id, false);

    let asset_dir = app_local_cache
        .join(crate::AUDIO_REVIEW_CACHE_DIR_NAME)
        .join(task_id);
    fs::create_dir_all(&asset_dir).expect("create asset dir");
    let outside_target = outside_dir.join("outside.wav");
    fs::write(&outside_target, b"do not overwrite").expect("write outside target");
    let asset_path = asset_dir.join("audio.wav");
    fs::hard_link(&outside_target, &asset_path).expect("create cache hard link");

    let detail = load_transcript_detail_from_roots(
        &output_root,
        &app_local_outputs,
        &app_local_cache,
        LoadTranscriptDetailRequest {
            task_id: task_id.to_string(),
        },
    )
    .expect("load detail");

    assert!(detail
        .audio_asset_path
        .expect("audio asset path")
        .ends_with(
            "cache/.StudyMind-audio-review/20260705-153012-local-abcdef123456/audio.wav"
        ));
    assert_eq!(
        fs::read(&outside_target).expect("read outside target"),
        b"do not overwrite"
    );
    assert_eq!(
        fs::read(&asset_path).expect("read copied audio"),
        b"fake wav"
    );
}

#[test]
fn load_detail_rejects_symlinked_audio_cache_target_before_copying() {
    let output_root = temp_dir("load_detail_rejects_symlinked_cache_output");
    let app_local_root = temp_dir("load_detail_rejects_symlinked_cache_app_local");
    let app_local_outputs = app_local_root.join("outputs");
    let app_local_cache = app_local_root.join("cache");
    let outside_dir = temp_dir("load_detail_rejects_symlinked_cache_outside");
    let task_id = "20260705-153012-local-abcdef123456";
    let task_dir = create_task(&output_root, task_id);
    let source_audio_path = task_dir.join("media").join("audio.wav");
    fs::write(
        task_dir.join("transcript").join("transcript.txt"),
        "original text\n",
    )
    .expect("write transcript");
    fs::write(&source_audio_path, b"fake wav").expect("write audio");
    write_manifest(&task_dir, task_id, false);

    let asset_dir = app_local_cache
        .join(crate::AUDIO_REVIEW_CACHE_DIR_NAME)
        .join(task_id);
    fs::create_dir_all(&asset_dir).expect("create asset dir");
    let outside_target = outside_dir.join("outside.wav");
    fs::write(&outside_target, b"do not overwrite").expect("write outside target");
    let asset_path = asset_dir.join("audio.wav");
    if let Err(error) = create_file_symlink(&outside_target, &asset_path) {
        eprintln!("skipping symlink regression; symlink creation is unavailable: {error}");
        return;
    }

    let error = load_transcript_detail_from_roots(
        &output_root,
        &app_local_outputs,
        &app_local_cache,
        LoadTranscriptDetailRequest {
            task_id: task_id.to_string(),
        },
    )
    .expect_err("reject symlinked cache target");

    assert!(error.contains("linked audio playback asset"));
    assert_eq!(
        fs::read(&outside_target).expect("read outside target"),
        b"do not overwrite"
    );
}

#[test]
fn save_detail_creates_original_backup_once_and_updates_manifest() {
    let output_root = temp_dir("save_detail_task");
    let task_id = "20260705-153012-local-abcdef123456";
    let task_dir = create_task(&output_root, task_id);
    fs::write(
        task_dir.join("transcript").join("transcript.txt"),
        "first version\n",
    )
    .expect("write transcript");
    fs::write(
        task_dir.join("transcript").join("transcript.md"),
        "# Transcript\n\n## Transcript\n\nfirst version\n",
    )
    .expect("write markdown");
    write_manifest(&task_dir, task_id, false);

    let result = save_transcript_edit_to_output_root(
        &output_root,
        SaveTranscriptEditRequest {
            task_id: task_id.to_string(),
            text: "second version".to_string(),
            segments: vec![TranscriptSegmentView {
                id: "seg-0001".to_string(),
                start_ms: 0,
                end_ms: 900,
                text: "second version".to_string(),
                speaker: None,
            }],
        },
    )
    .expect("save transcript");

    assert_eq!(result.text, "second version");
    assert!(result.has_original_backup);
    assert_eq!(
        fs::read_to_string(
            task_dir
                .join("transcript")
                .join("original")
                .join("transcript.txt")
        )
        .expect("read backup"),
        "first version\n"
    );
    assert_eq!(
        fs::read_to_string(task_dir.join("transcript").join("transcript.txt")).expect("read saved"),
        "second version\n"
    );
    assert!(
        fs::read_to_string(task_dir.join("transcript").join("segments.json"))
            .expect("read segments")
            .contains("seg-0001")
    );
    let manifest = fs::read_to_string(task_dir.join("StudyMind-task.json")).expect("read manifest");
    assert!(manifest.contains(r#""text_preview": "second version""#));
    assert!(manifest.contains(r#""segments": "transcript/segments.json""#));

    save_transcript_edit_to_output_root(
        &output_root,
        SaveTranscriptEditRequest {
            task_id: task_id.to_string(),
            text: "third version".to_string(),
            segments: vec![],
        },
    )
    .expect("save again");
    assert_eq!(
        fs::read_to_string(
            task_dir
                .join("transcript")
                .join("original")
                .join("transcript.txt")
        )
        .expect("read backup again"),
        "first version\n"
    );
}

#[test]
fn save_detail_rejects_linked_markdown_without_touching_external_target() {
    let output_root = temp_dir("save_detail_rejects_linked_markdown");
    let outside_dir = temp_dir("save_detail_external_markdown");
    let task_id = "20260705-153012-local-abcdef123456";
    let task_dir = create_task(&output_root, task_id);
    fs::write(
        task_dir.join("transcript").join("transcript.txt"),
        "first version\n",
    )
    .expect("write transcript");
    let outside_target = outside_dir.join("outside.md");
    fs::write(&outside_target, "external content\n").expect("write outside markdown");
    let linked_markdown = task_dir.join("transcript").join("transcript.md");
    if let Err(error) = create_file_symlink(&outside_target, &linked_markdown) {
        eprintln!("skipping symlink regression; symlink creation is unavailable: {error}");
        return;
    }
    write_manifest(&task_dir, task_id, false);

    let error = save_transcript_edit_to_output_root(
        &output_root,
        SaveTranscriptEditRequest {
            task_id: task_id.to_string(),
            text: "second version".to_string(),
            segments: vec![],
        },
    )
    .expect_err("linked markdown must be rejected");

    assert!(error.contains("link") || error.contains("outside"));
    assert_eq!(
        fs::read_to_string(&outside_target).expect("read outside markdown"),
        "external content\n"
    );
}

#[test]
fn save_detail_rejects_nested_alternate_transcript_path() {
    let output_root = temp_dir("save_detail_rejects_alternate_transcript");
    let task_id = "20260705-153012-local-abcdef123456";
    let task_dir = create_task(&output_root, task_id);
    let alternate_dir = task_dir.join("alternate").join("transcript");
    fs::create_dir_all(&alternate_dir).expect("create alternate transcript dir");
    let alternate_txt = alternate_dir.join("transcript.txt");
    fs::write(&alternate_txt, "alternate original\n").expect("write alternate transcript");
    write_manifest(&task_dir, task_id, false);
    let manifest_path = task_dir.join("StudyMind-task.json");
    let manifest = fs::read_to_string(&manifest_path)
        .expect("read manifest")
        .replace(
            "transcript/transcript.txt",
            "alternate/transcript/transcript.txt",
        );
    fs::write(&manifest_path, manifest).expect("write alternate manifest");

    let error = save_transcript_edit_to_output_root(
        &output_root,
        SaveTranscriptEditRequest {
            task_id: task_id.to_string(),
            text: "edited text".to_string(),
            segments: vec![],
        },
    )
    .expect_err("alternate transcript path must be rejected");

    assert!(error.contains("transcript/transcript.txt"));
    assert_eq!(
        fs::read_to_string(alternate_txt).expect("read unchanged alternate transcript"),
        "alternate original\n"
    );
    assert!(!task_dir.join("transcript").join("transcript.txt").exists());
}

#[test]
fn save_detail_never_backs_up_sensitive_legacy_source_metadata() {
    let output_root = temp_dir("save_detail_rejects_sensitive_legacy_source");
    let task_id = "20260710-120000-local-legacy";
    let task_dir = create_task(&output_root, task_id);
    fs::write(
        task_dir.join("transcript").join("transcript.txt"),
        "first version\n",
    )
    .expect("write transcript");
    fs::write(
        task_dir.join("transcript").join("transcript.md"),
        "# Transcript\n\n## Metadata\n\n".to_string()
            + "- Source URL: https://www.xiaohongshu.com/explore/"
            + "64a1b2c3d4e5f67890123456?xsec_token=review-secret\n\n"
            + "## Transcript\n\nfirst version\n",
    )
    .expect("write markdown");
    fs::write(
            task_dir.join("StudyMind-task.json"),
            format!(
                r#"{{
  "schema_version": 2,
  "task_id": "{task_id}",
  "created_at": "2026-07-10T12:00:00Z",
  "source_url": "https://www.xiaohongshu.com/explore/64a1b2c3d4e5f67890123456?xsec_token=review-secret",
  "platform": "xiaohongshu",
  "status": "completed",
  "artifacts": {{
    "transcript_txt": "transcript/transcript.txt",
    "transcript_md": "transcript/transcript.md"
  }},
  "error": null,
  "text_preview": "first version",
  "insights_count": 0
}}"#
            ),
        )
        .expect("write manifest");

    let error = save_transcript_edit_to_output_root(
        &output_root,
        SaveTranscriptEditRequest {
            task_id: task_id.to_string(),
            text: "second version".to_string(),
            segments: vec![],
        },
    )
    .expect_err("legacy source must be migrated first");

    assert!(error.contains("current history format"));
    assert!(!task_dir.join("transcript").join("original").exists());
}

#[test]
fn save_detail_rejects_empty_text_and_path_traversal() {
    let output_root = temp_dir("save_detail_rejects_invalid");
    let task_id = "20260705-153012-local-fedcba654321";
    let task_dir = create_task(&output_root, task_id);
    fs::write(task_dir.join("transcript").join("transcript.txt"), "text\n")
        .expect("write transcript");
    write_manifest(&task_dir, task_id, false);

    assert!(save_transcript_edit_to_output_root(
        &output_root,
        SaveTranscriptEditRequest {
            task_id: task_id.to_string(),
            text: " ".to_string(),
            segments: vec![],
        },
    )
    .is_err());

    fs::write(
        task_dir.join("StudyMind-task.json"),
        format!(
            r#"{{
  "schema_version": 1,
  "task_id": "{task_id}",
  "created_at": "2026-07-05T15:30:12Z",
  "status": "completed",
  "artifacts": {{"transcript_txt": "../outside.txt"}},
  "error": null,
  "text_preview": "",
  "insights_count": 0
}}"#
        ),
    )
    .expect("write unsafe manifest");

    assert!(load_transcript_detail_from_output_root(
        &output_root,
        LoadTranscriptDetailRequest {
            task_id: task_id.to_string(),
        },
    )
    .is_err());
}

#[test]
fn load_detail_degrades_missing_malformed_and_mixed_segments_without_hiding_valid_items() {
    let output_root = temp_dir("load_detail_segment_fallback_matrix");
    let task_id = "20260705-153012-local-abcdef123456";
    let task_dir = create_task(&output_root, task_id);
    fs::write(
        task_dir.join("transcript").join("transcript.txt"),
        "matrix transcript\n",
    )
    .expect("write transcript");
    write_manifest(&task_dir, task_id, true);

    let load = || {
        load_transcript_detail_from_output_root(
            &output_root,
            LoadTranscriptDetailRequest {
                task_id: task_id.to_string(),
            },
        )
        .expect("load detail")
    };

    assert!(load().segments.is_empty());

    let segments_path = task_dir.join("transcript").join("segments.json");
    fs::write(&segments_path, r#"{"segments":"invalid"}"#).expect("write malformed segments");
    assert!(load().segments.is_empty());

    fs::write(
        &segments_path,
        r#"{"segments":[
  {"id":"seg-0001","start_ms":0,"end_ms":1000,"text":"first","speaker":"host"},
  {"id":"seg-invalid-time","start_ms":1000,"end_ms":1000,"text":"invalid"},
  {"start_ms":1000,"end_ms":1500,"text":"missing id"},
  {"id":"seg-0002","start_ms":1500,"end_ms":2200,"text":"second"}
]}"#,
    )
    .expect("write mixed segments");

    assert_eq!(
        load().segments,
        vec![
            TranscriptSegmentView {
                id: "seg-0001".to_string(),
                start_ms: 0,
                end_ms: 1000,
                text: "first".to_string(),
                speaker: Some("host".to_string()),
            },
            TranscriptSegmentView {
                id: "seg-0002".to_string(),
                start_ms: 1500,
                end_ms: 2200,
                text: "second".to_string(),
                speaker: None,
            },
        ]
    );
}

#[test]
fn load_detail_routes_direct_audio_without_cache_and_allows_missing_audio() {
    let output_root = temp_dir("load_detail_direct_or_missing_audio");
    let task_id = "20260705-153012-local-abcdef123456";
    let task_dir = create_task(&output_root, task_id);
    fs::write(
        task_dir.join("transcript").join("transcript.txt"),
        "audio matrix\n",
    )
    .expect("write transcript");
    fs::write(task_dir.join("media").join("audio.wav"), b"fake wav").expect("write audio");
    write_manifest(&task_dir, task_id, false);

    let detail = load_transcript_detail_from_output_root(
        &output_root,
        LoadTranscriptDetailRequest {
            task_id: task_id.to_string(),
        },
    )
    .expect("load direct audio");
    assert_eq!(detail.audio_path, detail.audio_asset_path);
    assert!(detail
        .audio_path
        .expect("direct audio path")
        .ends_with("media/audio.wav"));
    assert!(!output_root
        .join("cache")
        .join(crate::AUDIO_REVIEW_CACHE_DIR_NAME)
        .exists());

    let manifest_path = task_dir.join("StudyMind-task.json");
    let manifest = fs::read_to_string(&manifest_path)
        .expect("read manifest")
        .replace("    \"audio\": \"media/audio.wav\",\n", "");
    fs::write(&manifest_path, manifest).expect("remove audio declaration");

    let detail = load_transcript_detail_from_output_root(
        &output_root,
        LoadTranscriptDetailRequest {
            task_id: task_id.to_string(),
        },
    )
    .expect("load text-only detail");
    assert_eq!(detail.text, "audio matrix");
    assert_eq!(detail.audio_path, None);
    assert_eq!(detail.audio_asset_path, None);
}

#[test]
fn save_detail_preserves_markdown_prefix_and_existing_empty_segments_declaration() {
    let output_root = temp_dir("save_detail_markdown_and_empty_segments");
    let task_id = "20260705-153012-local-abcdef123456";
    let task_dir = create_task(&output_root, task_id);
    fs::write(
        task_dir.join("transcript").join("transcript.txt"),
        "first version\n",
    )
    .expect("write transcript");
    let markdown_prefix = "# Transcript\n\n## Metadata\n\n- Source: safe-local-task\n\n";
    fs::write(
        task_dir.join("transcript").join("transcript.md"),
        format!("{markdown_prefix}## Transcript\n\nfirst version\n"),
    )
    .expect("write markdown");
    fs::write(
        task_dir.join("transcript").join("segments.json"),
        r#"{"segments":[{"id":"seg-0001","start_ms":0,"end_ms":1000,"text":"first version"}]}"#,
    )
    .expect("write segments");
    write_manifest(&task_dir, task_id, true);

    save_transcript_edit_to_output_root(
        &output_root,
        SaveTranscriptEditRequest {
            task_id: task_id.to_string(),
            text: "second version".to_string(),
            segments: vec![],
        },
    )
    .expect("save transcript");

    assert_eq!(
        fs::read_to_string(task_dir.join("transcript").join("transcript.md"))
            .expect("read markdown"),
        format!("{markdown_prefix}## Transcript\n\nsecond version\n")
    );
    let segments: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(task_dir.join("transcript").join("segments.json"))
            .expect("read segments"),
    )
    .expect("parse segments");
    assert_eq!(segments["segments"], serde_json::json!([]));
    let manifest = fs::read_to_string(task_dir.join("StudyMind-task.json")).expect("read manifest");
    assert!(manifest.contains(r#""segments": "transcript/segments.json""#));
}

#[test]
fn save_detail_mid_commit_failure_restores_complete_previous_revision() {
    let output_root = temp_dir("save-detail-transaction-rollback");
    let task_id = "20260722-120000-local-abcdef123456";
    let task_dir = create_task(&output_root, task_id);
    let transcript_path = task_dir.join("transcript").join("transcript.txt");
    let markdown_path = task_dir.join("transcript").join("transcript.md");
    let segments_path = task_dir.join("transcript").join("segments.json");
    let manifest_path = task_dir.join("StudyMind-task.json");
    fs::write(&transcript_path, b"first version\n").expect("write transcript");
    fs::write(
        &markdown_path,
        b"# Transcript\n\n## Transcript\n\nfirst version\n",
    )
    .expect("write markdown");
    write_manifest(&task_dir, task_id, false);
    let previous_transcript = fs::read(&transcript_path).expect("read transcript");
    let previous_markdown = fs::read(&markdown_path).expect("read markdown");
    let previous_manifest = fs::read(&manifest_path).expect("read manifest");
    crate::atomic_files::fail_next_install_for_test(markdown_path.clone());

    let error = save_transcript_edit_to_output_root(
        &output_root,
        SaveTranscriptEditRequest {
            task_id: task_id.to_string(),
            text: "second version".to_string(),
            segments: vec![TranscriptSegmentView {
                id: "seg-0001".to_string(),
                start_ms: 0,
                end_ms: 1000,
                text: "second version".to_string(),
                speaker: None,
            }],
        },
    )
    .expect_err("injected commit failure must fail save");

    assert_eq!(error, "Task artifacts could not be stored safely.");
    assert_eq!(
        fs::read(&transcript_path).expect("read transcript"),
        previous_transcript
    );
    assert_eq!(
        fs::read(&markdown_path).expect("read markdown"),
        previous_markdown
    );
    assert_eq!(
        fs::read(&manifest_path).expect("read manifest"),
        previous_manifest
    );
    assert!(!segments_path.exists());
    assert!(!task_dir
        .join("transcript")
        .join("original")
        .join("transcript.txt")
        .exists());
    assert!(!task_dir.join(".StudyMind-artifact-transaction.json").exists());
    assert_eq!(
        fs::read_dir(task_dir.join("transcript"))
            .expect("read transcript dir")
            .filter_map(Result::ok)
            .filter(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with(".StudyMind-artifact-"))
            .count(),
        0
    );
}

#[test]
fn transcript_detail_module_boundary_matches_approved_owners() {
    let source_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let module_root = source_root.join("transcript_detail");
    let root = fs::read_to_string(source_root.join("transcript_detail.rs"))
        .expect("read transcript detail root");
    let audio = fs::read_to_string(module_root.join("audio_playback.rs"))
        .expect("read audio playback module");
    let segments =
        fs::read_to_string(module_root.join("segments.rs")).expect("read segments module");
    let edit =
        fs::read_to_string(module_root.join("edit_storage.rs")).expect("read edit storage module");
    fs::read_to_string(module_root.join("tests.rs")).expect("read transcript detail tests");

    for declaration in [
        "mod audio_playback;",
        "mod segments;",
        "mod edit_storage;",
        "mod tests;",
    ] {
        assert!(root.contains(declaration), "missing {declaration}");
    }
    for moved_owner in [
        "fn copy_audio_asset",
        "fn segment_from_value",
        "fn create_original_backups",
    ] {
        assert!(!root.contains(moved_owner), "root still owns {moved_owner}");
    }
    assert!(audio.contains("fn copy_audio_asset"));
    assert!(segments.contains("fn segment_from_value"));
    assert!(edit.contains("fn create_original_backups"));

    for (name, source) in [
        ("audio_playback", audio.as_str()),
        ("segments", segments.as_str()),
        ("edit_storage", edit.as_str()),
    ] {
        for forbidden in [
            "tauri::",
            "AppHandle",
            "resolve_runtime_paths",
            "ensure_runtime_dirs",
            "TaskManifest",
            "StudyMind-task.json",
        ] {
            assert!(
                !source.contains(forbidden),
                "{name} must not depend on {forbidden}"
            );
        }
    }
    assert!(!audio.contains("TranscriptSegmentView"));
    assert!(!audio.contains("TaskEditSession"));
    assert!(!segments.contains("TaskEditSession"));
    assert!(!segments.contains("load_audio_paths"));
    assert!(!edit.contains("load_audio_paths"));
}

fn create_task(output_root: &Path, task_id: &str) -> PathBuf {
    let task_dir = output_root.join("tasks").join(task_id);
    fs::create_dir_all(task_dir.join("media")).expect("create media dir");
    fs::create_dir_all(task_dir.join("transcript")).expect("create transcript dir");
    fs::create_dir_all(task_dir.join("ai")).expect("create ai dir");
    task_dir
}

fn write_manifest(task_dir: &Path, task_id: &str, include_segments: bool) {
    let segments_entry = if include_segments {
        r#",
    "segments": "transcript/segments.json""#
    } else {
        ""
    };
    fs::write(
        task_dir.join("StudyMind-task.json"),
        format!(
            r#"{{
  "schema_version": 4,
  "task_id": "{task_id}",
  "created_at": "2026-07-05T15:30:12Z",
  "local_source": {{
    "display_name": "Lecture.wmv",
    "media_kind": "video",
    "extension": "wmv"
  }},
  "platform": "local",
  "status": "completed",
  "artifacts": {{
    "audio": "media/audio.wav",
    "transcript_txt": "transcript/transcript.txt",
    "transcript_md": "transcript/transcript.md"{segments_entry}
  }},
  "error": null,
  "text_preview": "original text",
  "insights_count": 0
}}"#
        ),
    )
    .expect("write manifest");
}

fn temp_dir(name: &str) -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("StudyMind-{name}-{unique}"));
    fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

#[cfg(windows)]
fn create_file_symlink(source: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(source, link)
}

#[cfg(unix)]
fn create_file_symlink(source: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, link)
}
