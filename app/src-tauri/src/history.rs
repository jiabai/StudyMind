use crate::{append_desktop_log, ensure_runtime_dirs, resolve_runtime_paths, task_manifest};
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;
use tauri::AppHandle;

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub(crate) struct HistoryErrorView {
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) stage: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub(crate) struct HistoryListErrorView {
    pub(crate) code: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub(crate) struct HistoryListItemView {
    pub(crate) task_id: String,
    pub(crate) id: String,
    pub(crate) created_at: String,
    pub(crate) source: task_manifest::TaskSourceSummary,
    pub(crate) status: String,
    pub(crate) task_dir: String,
    pub(crate) output_dir: String,
    pub(crate) artifacts: HashMap<String, String>,
    pub(crate) error: Option<HistoryListErrorView>,
    pub(crate) text_preview: String,
    pub(crate) insights_count: usize,
}

#[derive(Debug, Deserialize)]
pub(crate) struct HistoryDetailRequest {
    #[serde(alias = "taskId")]
    task_id: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub(crate) struct HistoryDetailView {
    pub(crate) task_id: String,
    pub(crate) source: task_manifest::TaskSourceSummary,
    pub(crate) status: String,
    pub(crate) task_dir: String,
    pub(crate) artifacts: HashMap<String, String>,
    pub(crate) error: Option<HistoryErrorView>,
    pub(crate) text: String,
    pub(crate) summary: String,
    pub(crate) transcript: Option<task_manifest::TranscriptMetadata>,
    pub(crate) insights: Vec<task_manifest::InsightView>,
    pub(crate) dissection: Option<crate::worker_runtime::TaskDissection>,
    pub(crate) dissection_source_status: Option<task_manifest::DissectionSourceStatus>,
}

#[tauri::command]
pub(crate) fn get_history(app: AppHandle) -> Result<Vec<HistoryListItemView>, String> {
    let paths = resolve_runtime_paths(&app)?;
    ensure_runtime_dirs(&paths)?;
    let output_root = task_manifest::configured_output_root(&paths)?;
    let started = Instant::now();
    let (items, ignored) = load_history_with_stats(&output_root)?;
    let _ = append_desktop_log(
        &paths,
        "history.list",
        &format!(
            "supported_count={} ignored_count={} elapsed_ms={}",
            items.len(),
            ignored,
            started.elapsed().as_millis()
        ),
    );
    Ok(items)
}

#[tauri::command]
pub(crate) fn get_history_detail(
    app: AppHandle,
    request: HistoryDetailRequest,
) -> Result<HistoryDetailView, String> {
    let paths = resolve_runtime_paths(&app)?;
    ensure_runtime_dirs(&paths)?;
    let output_root = task_manifest::configured_output_root(&paths)?;
    let started = Instant::now();
    let result = load_history_detail_from_output_root(&output_root, request);
    let _ = append_desktop_log(
        &paths,
        "history.detail",
        &format!(
            "outcome={} elapsed_ms={}",
            if result.is_ok() {
                "completed"
            } else {
                "rejected"
            },
            started.elapsed().as_millis()
        ),
    );
    result
}

#[cfg(test)]
pub(crate) fn load_history_from_output_root(
    output_root: &Path,
) -> Result<Vec<HistoryListItemView>, String> {
    load_history_with_stats(output_root).map(|(items, _)| items)
}

fn load_history_with_stats(
    output_root: &Path,
) -> Result<(Vec<HistoryListItemView>, usize), String> {
    let scan = task_manifest::SupportedTask::scan(output_root)?;
    let ignored = scan.ignored_count();
    let mut items = scan
        .into_tasks()
        .into_iter()
        .map(|task| history_item_from_supported_task(output_root, task))
        .collect::<Vec<_>>();
    items.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok((items, ignored))
}

fn history_item_from_supported_task(
    output_root: &Path,
    task: task_manifest::SupportedTask,
) -> HistoryListItemView {
    let task_id = task.task_id().to_string();
    HistoryListItemView {
        task_id: task_id.clone(),
        id: task_id,
        created_at: task.created_at().to_string(),
        source: task.source(),
        status: task.status().to_string(),
        task_dir: task.task_dir_frontend_string(),
        output_dir: task_manifest::path_to_frontend_string(output_root),
        artifacts: task.declared_artifacts(),
        error: task
            .safe_error()
            .map(|error| HistoryListErrorView { code: error.code }),
        text_preview: task.text_preview().to_string(),
        insights_count: task.insights_count(),
    }
}

pub(crate) fn load_history_detail_from_output_root(
    output_root: &Path,
    request: HistoryDetailRequest,
) -> Result<HistoryDetailView, String> {
    let task =
        task_manifest::SupportedTask::open(output_root, &request.task_id).map_err(|error| {
            if error == "Task is unavailable in the current history format." {
                "History task is unavailable.".to_string()
            } else {
                error
            }
        })?;
    let text = task
        .read_text_artifact(task_manifest::TaskArtifact::TranscriptTxt)?
        .unwrap_or_default();
    let summary = task
        .read_text_artifact(task_manifest::TaskArtifact::Summary)?
        .unwrap_or_default();
    let insights = task.read_insights()?;
    let dissection = task.read_dissection()?;
    Ok(HistoryDetailView {
        task_id: task.task_id().to_string(),
        source: task.source(),
        status: task.status().to_string(),
        task_dir: task.task_dir_frontend_string(),
        artifacts: task.declared_artifacts(),
        error: task.safe_error().map(|error| HistoryErrorView {
            code: error.code,
            message: error.message,
            stage: error.stage,
        }),
        text,
        summary,
        transcript: task.transcript_metadata(),
        insights,
        dissection: dissection.as_ref().map(|view| view.report.clone()),
        dissection_source_status: dissection.map(|view| view.source_status),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        load_history_detail_from_output_root, load_history_from_output_root,
        load_history_with_stats, HistoryDetailRequest,
    };
    use crate::{
        local_media_contract::LocalMediaKind,
        task_manifest::{self, TaskSourceSummary},
    };
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{Instant, SystemTime, UNIX_EPOCH};

    #[test]
    fn load_history_from_output_root_reads_task_manifests() {
        let output_root = temp_dir("history_from_manifests");
        let task_id = "20260705-153012-douyin-7645505408425004329";
        let task_dir = output_root.join("tasks").join(task_id);
        fs::create_dir_all(task_dir.join("transcript")).expect("create transcript dir");
        fs::create_dir_all(task_dir.join("ai")).expect("create ai dir");
        fs::write(
            task_dir.join("transcript").join("transcript.txt"),
            format!("full transcript\n{}", "body ".repeat(200_000)),
        )
        .expect("write transcript");
        fs::write(
            task_dir.join("ai").join("summary.md"),
            format!("# summary\n{}", "summary ".repeat(100_000)),
        )
        .expect("write summary");
        fs::write(
            task_dir.join("ai").join("insights.json"),
            r#"{"schemaVersion":1,"insights":[{"id":1,"topic":"first topic","matchReason":"matched","followUpQuestions":["next question"],"suitableUse":"content planning","sourceChunkId":7}]}"#,
        )
        .expect("write insights");
        fs::write(
            task_dir.join("StudyMind-task.json"),
            format!(
                r#"{{
  "schema_version": 3,
  "source_privacy_migration_version": 2,
  "task_id": "{task_id}",
  "created_at": "2026-07-05T15:30:12Z",
  "source_url": "https://www.douyin.com/video/7645505408425004329",
  "source_identity": {{
    "version": 1,
    "platform": "douyin",
    "stable_id": "7645505408425004329",
    "effective_part": null,
    "canonical_url": "https://www.douyin.com/video/7645505408425004329"
  }},
  "platform": "douyin",
  "status": "completed",
  "artifacts": {{
    "transcript_txt": "transcript/transcript.txt",
    "summary": "ai/summary.md",
    "insights": "ai/insights.json",
    "mindmap": "ai/.StudyMind-artifact-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0.rollback",
    "preference_snapshot": "ai/.preference-snapshot.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.part.json",
    "debug_url": "https://example.test/?xsec_token=review-secret"
  }},
  "error": null,
  "text_preview": "full transcript",
  "insights_count": 1
}}"#
            ),
        )
        .expect("write manifest");

        let legacy_dir = output_root.join("tasks").join("unsupported-legacy");
        fs::create_dir_all(&legacy_dir).expect("create legacy dir");
        fs::write(
            legacy_dir.join("StudyMind-task.json"),
            r#"{"schema_version":2,"task_id":"unsupported-legacy","created_at":"2026-07-01T00:00:00Z","source_url":"https://example.test/?xsec_token=review-secret","status":"completed"}"#,
        )
        .expect("write legacy manifest");

        let list_started = Instant::now();
        let (history, ignored) = load_history_with_stats(&output_root).expect("load history");
        let list_elapsed = list_started.elapsed();

        assert_eq!(history.len(), 1);
        assert_eq!(ignored, 1);
        assert_eq!(history[0].task_id, task_id);
        assert_eq!(
            history[0].source,
            TaskSourceSummary::Url {
                url: "https://www.douyin.com/video/7645505408425004329".to_string(),
            }
        );
        let detail_started = Instant::now();
        let detail = load_history_detail_from_output_root(
            &output_root,
            HistoryDetailRequest {
                task_id: task_id.to_string(),
            },
        )
        .expect("load detail");
        let detail_elapsed = detail_started.elapsed();
        assert!(detail.text.starts_with("full transcript"));
        assert!(detail.text.len() > 900_000);
        assert!(detail.summary.starts_with("# summary"));
        assert!(detail.summary.len() > 700_000);
        assert_eq!(detail.insights[0].topic, "first topic");
        assert_eq!(detail.insights[0].match_reason, "matched");
        assert_eq!(
            detail.insights[0].follow_up_questions,
            vec!["next question"]
        );
        assert_eq!(detail.insights[0].source_chunk_id, Some(7));
        assert_eq!(history[0].artifacts["summary"], "ai/summary.md");
        assert!(!history[0].artifacts.contains_key("mindmap"));
        assert!(!history[0].artifacts.contains_key("preference_snapshot"));
        assert!(!history[0].artifacts.contains_key("debug_url"));
        let serialized_list = serde_json::to_string(&history).expect("serialize history");
        assert!(!serialized_list.contains("review-secret"));
        assert!(!serialized_list.contains("body body body"));
        assert!(!serialized_list.contains("# summary"));
        assert!(!serialized_list.contains("first topic"));
        println!(
            "history_vnext_probe supported={} ignored={} list_us={} detail_us={}",
            history.len(),
            ignored,
            list_elapsed.as_micros(),
            detail_elapsed.as_micros()
        );
    }

    #[test]
    fn load_history_projects_local_sources_and_reads_their_task_artifacts() {
        let output_root = temp_dir("history-local-sources");
        let video_task = "20260723-120000-local-abcdef123456";
        let audio_task = "20260723-120001-local-fedcba654321";
        write_local_task(&output_root, video_task, "Interview.wmv", "video", "wmv");
        write_local_task(
            &output_root,
            audio_task,
            "Field recording.MP3",
            "audio",
            "mp3",
        );

        let history = load_history_from_output_root(&output_root).expect("load local history");

        assert_eq!(history.len(), 2);
        let video_item = history
            .iter()
            .find(|item| item.task_id == video_task)
            .expect("video history item");
        let audio_item = history
            .iter()
            .find(|item| item.task_id == audio_task)
            .expect("audio history item");
        assert_eq!(
            audio_item.source,
            TaskSourceSummary::LocalFile {
                display_name: "Field recording.MP3".to_string(),
                media_kind: LocalMediaKind::Audio,
            }
        );
        assert_eq!(
            video_item.source,
            TaskSourceSummary::LocalFile {
                display_name: "Interview.wmv".to_string(),
                media_kind: LocalMediaKind::Video,
            }
        );
        let detail = load_history_detail_from_output_root(
            &output_root,
            HistoryDetailRequest {
                task_id: video_task.to_string(),
            },
        )
        .expect("load local detail");
        assert_eq!(detail.source, video_item.source);
        assert_eq!(detail.text, "local transcript");
        assert_eq!(
            detail.artifacts["transcript_txt"],
            "transcript/transcript.txt"
        );
        let serialized = serde_json::to_value(detail).expect("serialize local detail");
        assert!(serialized.get("url").is_none());
        assert_eq!(serialized["source"]["kind"], "local_file");
        assert_eq!(serialized["source"]["displayName"], "Interview.wmv");
        assert_eq!(serialized["source"]["mediaKind"], "video");
    }

    #[test]
    fn load_history_never_returns_sensitive_legacy_source_url() {
        let output_root = temp_dir("history_redacts_sensitive_legacy_source");
        let task_id = "20260710-120000-xiaohongshu-legacy";
        let task_dir = output_root.join("tasks").join(task_id);
        fs::create_dir_all(&task_dir).expect("create task dir");
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
  "artifacts": {{}},
  "error": {{
    "code": "VIDEO_DOWNLOAD_FAILED",
    "message": "failed https://www.xiaohongshu.com/explore/64a1b2c3d4e5f67890123456?xsec_token=review-secret",
    "stage": "video_extracting"
  }},
  "text_preview": "",
  "insights_count": 0
}}"#
            ),
        )
        .expect("write manifest");

        let (history, ignored) = load_history_with_stats(&output_root).expect("load history");

        assert!(history.is_empty());
        assert_eq!(ignored, 1);
        let serialized = serde_json::to_string(&history).expect("serialize history");
        assert!(!serialized.contains("review-secret"));
        assert!(!serialized.contains("xsec_token"));
    }

    #[test]
    fn load_history_skips_corrupt_manifest_without_hiding_valid_tasks() {
        let output_root = temp_dir("history_skips_corrupt_manifest");
        let corrupt_dir = output_root.join("tasks").join("corrupt-task");
        fs::create_dir_all(&corrupt_dir).expect("create corrupt task");
        fs::write(corrupt_dir.join("StudyMind-task.json"), b"{not-json")
            .expect("write corrupt manifest");

        let valid_task_id = "20260710-120000-douyin-7645505408425004329";
        let valid_task_dir = output_root.join("tasks").join(valid_task_id);
        fs::create_dir_all(valid_task_dir.join("transcript")).expect("create valid task");
        fs::write(
            valid_task_dir.join("transcript").join("transcript.txt"),
            "valid transcript\n",
        )
        .expect("write valid transcript");
        fs::write(
            valid_task_dir.join("StudyMind-task.json"),
            format!(
                r#"{{
  "schema_version": 3,
  "source_privacy_migration_version": 2,
  "source_privacy_quarantined": false,
  "task_id": "{valid_task_id}",
  "created_at": "2026-07-10T12:00:00Z",
  "source_url": "https://www.douyin.com/video/7645505408425004329",
  "source_identity": {{
    "version": 1,
    "platform": "douyin",
    "stable_id": "7645505408425004329",
    "effective_part": null,
    "canonical_url": "https://www.douyin.com/video/7645505408425004329"
  }},
  "platform": "douyin",
  "status": "completed",
  "artifacts": {{"transcript_txt": "transcript/transcript.txt"}},
  "error": null,
  "text_preview": "valid transcript",
  "insights_count": 0
}}"#
            ),
        )
        .expect("write valid manifest");

        let history = load_history_from_output_root(&output_root)
            .expect("corrupt manifest should be isolated");

        assert_eq!(history.len(), 1);
        assert_eq!(history[0].task_id, valid_task_id);
    }

    #[test]
    fn load_history_hides_ai_artifacts_until_source_privacy_is_ready() {
        let output_root = temp_dir("history_hides_ai_until_source_privacy_ready");
        let task_id = "20260710-120000-xiaohongshu-incomplete";
        let task_dir = output_root.join("tasks").join(task_id);
        fs::create_dir_all(task_dir.join("ai")).expect("create ai dir");
        fs::write(
            task_dir.join("ai").join("summary.md"),
            "secret summary review-secret",
        )
        .expect("write summary");
        fs::write(
            task_dir.join("ai").join("insights.json"),
            r#"{"schemaVersion":1,"insights":[{"id":1,"topic":"review-secret","matchReason":"matched","followUpQuestions":["next"],"suitableUse":"planning","sourceChunkId":1}]}"#,
        )
        .expect("write insights");
        fs::write(
            task_dir.join("StudyMind-task.json"),
            format!(
                r#"{{
  "schema_version": 3,
  "source_privacy_migration_version": 0,
  "task_id": "{task_id}",
  "created_at": "2026-07-10T12:00:00Z",
  "source_url": "https://www.xiaohongshu.com/explore/64a1b2c3d4e5f67890123456?xsec_token=review-secret",
  "platform": "xiaohongshu",
  "status": "completed",
  "artifacts": {{
    "summary": "ai/summary.md",
    "insights": "ai/insights.json"
  }},
  "error": null,
  "text_preview": "",
  "insights_count": 1
}}"#
            ),
        )
        .expect("write manifest");

        let (history, ignored) = load_history_with_stats(&output_root).expect("load history");

        assert!(history.is_empty());
        assert_eq!(ignored, 1);
        let serialized = serde_json::to_string(&history).expect("serialize history");
        assert!(!serialized.contains("review-secret"));
        assert!(!serialized.contains("xsec_token"));
    }

    #[test]
    fn load_history_skips_quarantined_tasks() {
        let output_root = temp_dir("history_skips_quarantined_tasks");
        let task_id = "20260710-120000-xiaohongshu-review-secret";
        let task_dir = output_root.join("tasks").join(task_id);
        fs::create_dir_all(&task_dir).expect("create task dir");
        fs::write(
            task_dir.join("StudyMind-task.json"),
            format!(
                r#"{{
  "schema_version": 3,
  "source_privacy_migration_version": 2,
  "source_privacy_quarantined": true,
  "task_id": "{task_id}",
  "created_at": "2026-07-10T12:00:00Z",
  "source_url": "",
  "platform": "xiaohongshu",
  "status": "completed",
  "artifacts": {{}},
  "error": null,
  "text_preview": "",
  "insights_count": 0
}}"#
            ),
        )
        .expect("write manifest");

        let history = load_history_from_output_root(&output_root).expect("load history");

        assert!(history.is_empty());
    }

    #[test]
    fn load_history_accepts_only_exact_current_schema_with_source_identity() {
        let output_root = temp_dir("history_strict_current_schema");
        for (task_id, schema_version, source_url, source_identity) in [
            (
                "legacy-v1",
                1,
                "https://example.test/?xsec_token=review-secret",
                "",
            ),
            ("missing-identity", 3, "", ""),
            (
                "future-schema",
                4,
                "https://www.youtube.com/watch?v=abcdefghijk",
                r#", "source_identity": {"version":1,"platform":"youtube","stable_id":"abcdefghijk","effective_part":null,"canonical_url":"https://www.youtube.com/watch?v=abcdefghijk"}"#,
            ),
        ] {
            let task_dir = output_root.join("tasks").join(task_id);
            fs::create_dir_all(&task_dir).expect("create task dir");
            fs::write(
                task_dir.join("StudyMind-task.json"),
                format!(
                    r#"{{"schema_version":{schema_version},"source_privacy_migration_version":2,"source_privacy_quarantined":false,"task_id":"{task_id}","created_at":"2026-07-11T00:00:00Z","source_url":"{source_url}"{source_identity},"status":"completed","artifacts":{{}},"error":null,"text_preview":"safe preview","insights_count":0}}"#,
                ),
            )
            .expect("write manifest");
        }

        let (history, ignored) = load_history_with_stats(&output_root).expect("load history");

        assert!(history.is_empty());
        assert_eq!(ignored, 3);
        let error = load_history_detail_from_output_root(
            &output_root,
            HistoryDetailRequest {
                task_id: "legacy-v1".to_string(),
            },
        )
        .expect_err("legacy detail must be rejected");
        assert_eq!(error, "History task is unavailable.");
        assert!(!error.contains("review-secret"));
    }

    #[test]
    fn load_history_list_does_not_read_or_validate_artifact_files() {
        let output_root = temp_dir("history_rejects_traversal");
        let task_id = "20260705-153012-source-demo";
        let task_dir = output_root.join("tasks").join(task_id);
        fs::create_dir_all(&task_dir).expect("create task dir");
        fs::write(
            task_dir.join("StudyMind-task.json"),
            format!(
                r#"{{
  "schema_version": 3,
  "source_privacy_migration_version": 2,
  "task_id": "{task_id}",
  "created_at": "2026-07-05T15:30:12Z",
  "source_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "source_identity": {{
    "version": 1,
    "platform": "youtube",
    "stable_id": "dQw4w9WgXcQ",
    "effective_part": null,
    "canonical_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
  }},
  "status": "completed",
  "artifacts": {{"transcript_txt": "../outside.txt"}},
  "error": null,
  "text_preview": "",
  "insights_count": 0
}}"#
            ),
        )
        .expect("write manifest");

        let history = load_history_from_output_root(&output_root).expect("list manifest only");
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].task_id, task_id);
    }

    #[test]
    fn load_history_ignores_insights_without_v1_schema() {
        let output_root = temp_dir("history_ignores_insights_without_schema");
        let task_id = "20260705-153012-source-demo";
        write_task_with_insights_payload(
            &output_root,
            task_id,
            r#"{"insights":[{"id":1,"topic":"first topic","matchReason":"matched","followUpQuestions":["next question"],"suitableUse":"content planning","sourceChunkId":7}]}"#,
        );

        let history = load_history_from_output_root(&output_root).expect("load history");

        assert_eq!(history.len(), 1);
        let detail = load_history_detail_from_output_root(
            &output_root,
            HistoryDetailRequest {
                task_id: task_id.to_string(),
            },
        )
        .expect("load detail");
        assert!(detail.insights.is_empty());
    }

    #[test]
    fn load_history_ignores_insights_when_any_item_is_invalid() {
        let output_root = temp_dir("history_ignores_invalid_insight_item");
        let task_id = "20260705-153012-source-demo";
        write_task_with_insights_payload(
            &output_root,
            task_id,
            r#"{"schemaVersion":1,"insights":[{"id":1,"topic":"first topic","matchReason":"matched","followUpQuestions":["next question"],"suitableUse":"content planning","sourceChunkId":7},{"id":2,"topic":"second topic","followUpQuestions":["next question"],"suitableUse":"content planning","sourceChunkId":8}]}"#,
        );

        let history = load_history_from_output_root(&output_root).expect("load history");

        assert_eq!(history.len(), 1);
        let detail = load_history_detail_from_output_root(
            &output_root,
            HistoryDetailRequest {
                task_id: task_id.to_string(),
            },
        )
        .expect("load detail");
        assert!(detail.insights.is_empty());
    }

    #[test]
    fn history_detail_restores_dissection_and_marks_changed_transcript_stale() {
        let output_root = temp_dir("history-dissection-integrity");
        let task_id = "20260731-120000-youtube-abcdefghijk";
        let task_dir = output_root.join("tasks").join(task_id);
        fs::create_dir_all(task_dir.join("transcript")).expect("create transcript dir");
        fs::create_dir_all(task_dir.join("ai")).expect("create ai dir");
        fs::write(task_dir.join("transcript/transcript.txt"), b"abc").expect("write transcript");
        fs::write(
            task_dir.join("ai/dissection.json"),
            r#"{"schemaVersion":1,"sourceTranscriptSha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","sourceLanguage":null,"sourceChunks":[{"id":1,"startByte":0,"endByte":3,"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}],"overallNarrative":{"openingHook":null,"structureType":"statement","turningPoint":null,"closingType":null},"segments":[{"id":1,"title":"Opening","sourceChunkIds":[1],"coreClaim":"abc","supportingPoints":[],"rhetoricalDevices":[],"rhythmNote":"Brief","reusablePattern":"Direct","riskFlags":[]}],"highlights":["abc"],"reusableTemplate":{"name":"Direct","skeleton":["A","B","C"]},"audienceFit":[],"strengths":["Direct"],"weaknesses":["Brief"]}"#,
        )
        .expect("write report");
        fs::write(
            task_dir.join("StudyMind-task.json"),
            format!(
                r#"{{"schema_version":3,"source_privacy_migration_version":2,"source_privacy_quarantined":false,"task_id":"{task_id}","created_at":"2026-07-31T12:00:00Z","source_url":"https://www.youtube.com/watch?v=abcdefghijk","source_identity":{{"version":1,"platform":"youtube","stable_id":"abcdefghijk","effective_part":null,"canonical_url":"https://www.youtube.com/watch?v=abcdefghijk"}},"platform":"youtube","status":"completed","artifacts":{{"transcript_txt":"transcript/transcript.txt","dissection":"ai/dissection.json","dissection_md":"ai/dissection.md"}},"error":null,"text_preview":"abc","insights_count":0}}"#
            ),
        )
        .expect("write manifest");

        let current = load_history_detail_from_output_root(
            &output_root,
            HistoryDetailRequest {
                task_id: task_id.to_string(),
            },
        )
        .expect("load current report");
        assert!(current.dissection.is_some());
        assert_eq!(
            current.dissection_source_status,
            Some(task_manifest::DissectionSourceStatus::Current)
        );

        fs::write(task_dir.join("transcript/transcript.txt"), b"abd").expect("edit transcript");
        let stale = load_history_detail_from_output_root(
            &output_root,
            HistoryDetailRequest {
                task_id: task_id.to_string(),
            },
        )
        .expect("load stale report");
        assert!(stale.dissection.is_some());
        assert_eq!(
            stale.dissection_source_status,
            Some(task_manifest::DissectionSourceStatus::Stale)
        );
    }

    #[test]
    fn optional_workspace_history_count_probe_is_manifest_only() {
        let Ok(project_root) = std::env::var("STUDYMIND_HISTORY_PROBE_PROJECT_ROOT") else {
            return;
        };
        let output_root =
            task_manifest::configured_output_root_from_project(Path::new(&project_root))
                .expect("resolve configured output root");
        let started = Instant::now();
        let (items, ignored) = load_history_with_stats(&output_root).expect("count history");
        println!(
            "history_workspace_probe supported={} ignored={} list_us={}",
            items.len(),
            ignored,
            started.elapsed().as_micros()
        );
    }

    fn write_task_with_insights_payload(
        output_root: &PathBuf,
        task_id: &str,
        insights_payload: &str,
    ) {
        let task_dir = output_root.join("tasks").join(task_id);
        fs::create_dir_all(task_dir.join("ai")).expect("create ai dir");
        fs::write(task_dir.join("ai").join("insights.json"), insights_payload)
            .expect("write insights");
        fs::write(
            task_dir.join("StudyMind-task.json"),
            format!(
                r#"{{
  "schema_version": 3,
  "source_privacy_migration_version": 2,
  "task_id": "{task_id}",
  "created_at": "2026-07-05T15:30:12Z",
  "source_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "source_identity": {{
    "version": 1,
    "platform": "youtube",
    "stable_id": "dQw4w9WgXcQ",
    "effective_part": null,
    "canonical_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
  }},
  "platform": "youtube",
  "status": "completed",
  "artifacts": {{"insights": "ai/insights.json"}},
  "error": null,
  "text_preview": "",
  "insights_count": 1
}}"#
            ),
        )
        .expect("write manifest");
    }

    fn write_local_task(
        output_root: &Path,
        task_id: &str,
        display_name: &str,
        media_kind: &str,
        extension: &str,
    ) {
        let task_dir = output_root.join("tasks").join(task_id);
        fs::create_dir_all(task_dir.join("transcript")).expect("create transcript dir");
        fs::write(
            task_dir.join("transcript").join("transcript.txt"),
            "local transcript\n",
        )
        .expect("write local transcript");
        fs::write(
            task_dir.join("StudyMind-task.json"),
            format!(
                r#"{{
  "schema_version": 3,
  "source_privacy_migration_version": 2,
  "source_privacy_quarantined": false,
  "task_id": "{task_id}",
  "created_at": "2026-07-23T12:00:00Z",
  "source_kind": "local_file",
  "source_url": "",
  "source_identity": null,
  "local_source": {{
    "display_name": "{display_name}",
    "media_kind": "{media_kind}",
    "extension": "{extension}"
  }},
  "platform": "local",
  "status": "completed",
  "model": "iic/SenseVoiceSmall",
  "artifacts": {{"transcript_txt": "transcript/transcript.txt"}},
  "error": null,
  "text_preview": "local transcript",
  "insights_count": 0
}}"#
            ),
        )
        .expect("write local manifest");
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
}
