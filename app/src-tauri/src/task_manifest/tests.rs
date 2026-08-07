use super::{
    parse_insight_view,
    schema::{TaskManifest, TaskManifestError},
    storage::validate_task_artifact_path,
    transaction::{
        recover_task_artifacts, validate_journal_value_for_test, RecoveryOutcome, JOURNAL_FILE_NAME,
    },
    SourceIdentity, SupportedTask, TaskArtifact, TaskSourceSummary,
};
use crate::local_media_contract::LocalMediaKind;
use serde_json::json;
use std::fs;
use std::io;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn transaction_contract_fixtures_match_rust_parser() {
    let contract: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../contracts/task-artifact-transaction-v1.json"
    ))
    .expect("parse transaction contract");
    for fixture in contract["validFixtures"]
        .as_array()
        .expect("valid fixtures")
    {
        validate_journal_value_for_test(fixture.clone()).expect("valid journal fixture");
    }
    for fixture in contract["invalidFixtures"]
        .as_array()
        .expect("invalid fixtures")
    {
        assert!(validate_journal_value_for_test(fixture["journal"].clone()).is_err());
    }
}

#[test]
fn prepared_transaction_recovery_restores_previous_revision_idempotently() {
    let task_dir = temp_dir("prepared-transaction-recovery");
    let transcript_dir = task_dir.join("transcript");
    fs::create_dir_all(&transcript_dir).expect("create transcript dir");
    let transcript = transcript_dir.join("transcript.txt");
    fs::write(&transcript, b"mixed new text\n").expect("write mixed transcript");
    let transaction_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let rollback = transcript_dir.join(format!(".StudyMind-artifact-{transaction_id}-0.rollback"));
    fs::write(&rollback, b"old text\n").expect("write rollback");
    fs::write(
        task_dir.join(JOURNAL_FILE_NAME),
        serde_json::to_vec_pretty(&json!({
            "schema_version": 1,
            "transaction_id": transaction_id,
            "state": "prepared",
            "entries": [{
                "destination": "transcript/transcript.txt",
                "staging": format!("transcript/.StudyMind-artifact-{transaction_id}-0.staging"),
                "rollback": format!("transcript/.StudyMind-artifact-{transaction_id}-0.rollback"),
                "existed_before": true
            }]
        }))
        .expect("encode journal"),
    )
    .expect("write journal");

    assert_eq!(
        recover_task_artifacts(&task_dir).expect("recover prepared transaction"),
        RecoveryOutcome::RolledBack
    );
    assert_eq!(
        fs::read(&transcript).expect("read restored transcript"),
        b"old text\n"
    );
    assert!(!task_dir.join(JOURNAL_FILE_NAME).exists());
    assert!(!rollback.exists());
    assert_eq!(
        recover_task_artifacts(&task_dir).expect("repeat recovery"),
        RecoveryOutcome::None
    );
}

#[test]
fn committed_transaction_recovery_keeps_new_revision_and_cleans_material() {
    let task_dir = temp_dir("committed-transaction-recovery");
    let ai_dir = task_dir.join("ai");
    fs::create_dir_all(&ai_dir).expect("create ai dir");
    let summary = ai_dir.join("summary.md");
    fs::write(&summary, b"# New summary\n").expect("write new summary");
    let transaction_id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let rollback = ai_dir.join(format!(".StudyMind-artifact-{transaction_id}-0.rollback"));
    fs::write(&rollback, b"# Old summary\n").expect("write rollback");
    fs::write(
        task_dir.join(JOURNAL_FILE_NAME),
        serde_json::to_vec_pretty(&json!({
            "schema_version": 1,
            "transaction_id": transaction_id,
            "state": "committed",
            "entries": [{
                "destination": "ai/summary.md",
                "staging": format!("ai/.StudyMind-artifact-{transaction_id}-0.staging"),
                "rollback": format!("ai/.StudyMind-artifact-{transaction_id}-0.rollback"),
                "existed_before": true
            }]
        }))
        .expect("encode journal"),
    )
    .expect("write journal");

    assert_eq!(
        recover_task_artifacts(&task_dir).expect("recover committed transaction"),
        RecoveryOutcome::CommittedCleaned
    );
    assert_eq!(
        fs::read(&summary).expect("read summary"),
        b"# New summary\n"
    );
    assert!(!rollback.exists());
    assert!(!task_dir.join(JOURNAL_FILE_NAME).exists());
}

#[test]
fn invalid_transaction_journal_fails_closed_without_echo_or_mutation() {
    let task_dir = temp_dir("invalid-transaction-recovery");
    fs::create_dir_all(task_dir.join("transcript")).expect("create transcript dir");
    let transcript = task_dir.join("transcript").join("transcript.txt");
    fs::write(&transcript, b"mixed but untouched\n").expect("write transcript");
    fs::write(
        task_dir.join(JOURNAL_FILE_NAME),
        br#"{"schema_version":1,"transaction_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","state":"prepared","entries":[{"destination":"../review-secret.txt","staging":null,"rollback":null,"existed_before":false}]}"#,
    )
    .expect("write invalid journal");

    let error = recover_task_artifacts(&task_dir).expect_err("unsafe journal must fail");

    assert_eq!(error, "Task artifacts could not be recovered safely.");
    assert!(!error.contains("review-secret"));
    assert_eq!(
        fs::read(&transcript).expect("read untouched transcript"),
        b"mixed but untouched\n"
    );
    assert!(task_dir.join(JOURNAL_FILE_NAME).exists());
}

#[test]
fn rust_atomic_replace_failure_preserves_previous_destination() {
    let directory = temp_dir("atomic-replace-failure");
    let destination = directory.join("StudyMind-task.json");
    fs::write(&destination, b"previous manifest\n").expect("write previous manifest");

    let result = crate::atomic_files::atomic_write_with_replace_for_test(
        &destination,
        b"next manifest\n",
        |_staging, _destination| Err(io::Error::other("replace failed")),
    );

    assert!(result.is_err());
    assert_eq!(
        fs::read(&destination).expect("read preserved manifest"),
        b"previous manifest\n"
    );
    assert_eq!(
        fs::read_dir(&directory)
            .expect("read directory")
            .filter_map(Result::ok)
            .filter(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with(".StudyMind-task."))
            .count(),
        0
    );
}

#[cfg(windows)]
#[test]
fn rust_atomic_windows_sharing_violation_preserves_previous_destination() {
    use std::os::windows::fs::OpenOptionsExt;

    let directory = temp_dir("atomic-sharing-violation");
    let destination = directory.join("StudyMind-task.json");
    fs::write(&destination, b"previous manifest\n").expect("write previous manifest");
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&destination)
        .expect("lock destination without delete sharing");

    let result = crate::atomic_files::atomic_write(&destination, b"next manifest\n");

    assert!(result.is_err());
    drop(locked);
    assert_eq!(
        fs::read(&destination).expect("read preserved manifest"),
        b"previous manifest\n"
    );
}

#[cfg(unix)]
#[test]
fn rust_atomic_unix_permission_failure_preserves_previous_destination() {
    use std::os::unix::fs::PermissionsExt;

    let directory = temp_dir("atomic-permission-failure");
    let destination = directory.join("StudyMind-task.json");
    fs::write(&destination, b"previous manifest\n").expect("write previous manifest");
    let original_permissions = fs::metadata(&directory)
        .expect("read directory metadata")
        .permissions();
    let mut restricted_permissions = original_permissions.clone();
    restricted_permissions.set_mode(0o500);
    fs::set_permissions(&directory, restricted_permissions).expect("restrict directory writes");

    let result = crate::atomic_files::atomic_write(&destination, b"next manifest\n");

    fs::set_permissions(&directory, original_permissions).expect("restore directory permissions");
    assert!(result.is_err());
    assert_eq!(
        fs::read(&destination).expect("read preserved manifest"),
        b"previous manifest\n"
    );
}

#[test]
fn task_error_code_and_message_never_echo_source_credentials() {
    let error = TaskManifestError {
        code: "xsec_token=review-secret".to_string(),
        message: "failed https://example.test/?xsec_token=review-secret".to_string(),
        stage: "video_extracting".to_string(),
    };

    assert_eq!(error.safe_code(), "TASK_FAILED");
    let message = error.safe_message();
    assert!(!message.contains("review-secret"));
    assert!(!message.contains("xsec_token"));
}

#[test]
fn safe_source_identity_requires_current_schema_marker_and_matching_source_url() {
    let base = json!({
        "schema_version": 3,
        "source_privacy_migration_version": 2,
        "task_id": "task",
        "created_at": "2026-07-10T12:00:00Z",
        "source_url": "https://www.youtube.com/watch?v=abcDEF_123-",
        "source_identity": {
            "version": 1,
            "platform": "youtube",
            "stable_id": "abcDEF_123-",
            "effective_part": null,
            "canonical_url": "https://www.youtube.com/watch?v=abcDEF_123-"
        },
        "status": "completed"
    });
    let ready: TaskManifest = serde_json::from_value(base.clone()).expect("ready manifest");
    assert!(ready.safe_source_identity().is_some());

    let mut null_local_source = base.clone();
    null_local_source["local_source"] = serde_json::Value::Null;
    assert!(
        serde_json::from_value::<TaskManifest>(null_local_source).is_err(),
        "URL manifests must reject even a null local_source field"
    );

    let mut missing_marker = base.clone();
    missing_marker["source_privacy_migration_version"] = json!(0);
    let missing_marker: TaskManifest =
        serde_json::from_value(missing_marker).expect("manifest without marker");
    assert!(missing_marker.safe_source_identity().is_none());

    let mut legacy_schema = base.clone();
    legacy_schema["schema_version"] = json!(2);
    let legacy_schema: TaskManifest =
        serde_json::from_value(legacy_schema).expect("legacy manifest");
    assert!(legacy_schema.safe_source_identity().is_none());
    assert!(!legacy_schema.source_privacy_ready());

    let mut mismatched = base;
    mismatched["source_url"] =
        json!("https://www.youtube.com/watch?v=abcDEF_123-&signature=review-secret");
    let mismatched: TaskManifest = serde_json::from_value(mismatched).expect("mismatched manifest");
    assert!(mismatched.safe_source_identity().is_none());
}

#[test]
fn local_task_source_projects_only_valid_video_and_audio_metadata() {
    for (display_name, media_kind, extension) in [
        ("Interview.wmv", LocalMediaKind::Video, "wmv"),
        ("Field recording.MP3", LocalMediaKind::Audio, "mp3"),
    ] {
        let manifest: TaskManifest =
            serde_json::from_value(local_manifest_value(display_name, media_kind, extension))
                .expect("parse local manifest");

        assert!(manifest.source_privacy_ready());
        assert_eq!(
            manifest.safe_source_summary(),
            Some(TaskSourceSummary::LocalFile {
                display_name: display_name.to_string(),
                media_kind,
            })
        );
        assert!(manifest.safe_source_identity().is_none());
    }
}

#[test]
fn local_task_source_fails_closed_for_incomplete_or_conflicting_boundaries() {
    let base = local_manifest_value("Interview.wmv", LocalMediaKind::Video, "wmv");
    let unsafe_identity = json!({
        "version": 1,
        "platform": "youtube",
        "stable_id": "abcDEF_123-",
        "effective_part": null,
        "canonical_url": "https://www.youtube.com/watch?v=abcDEF_123-"
    });
    let mut invalid_values = Vec::new();
    for (label, pointer, replacement) in [
        (
            "nonempty URL",
            "/source_url",
            json!("https://example.test/review-secret"),
        ),
        ("non-null identity", "/source_identity", unsafe_identity),
        ("non-local platform", "/platform", json!("youtube")),
        (
            "Windows path",
            "/local_source/display_name",
            json!("C:\\private\\Interview.wmv"),
        ),
        (
            "control character",
            "/local_source/display_name",
            json!("Interview\u{0000}.wmv"),
        ),
        (
            "bidi character",
            "/local_source/display_name",
            json!("Interview\u{202e}.wmv"),
        ),
        ("wrong extension", "/local_source/extension", json!("mp3")),
        (
            "wrong media kind",
            "/local_source/media_kind",
            json!("audio"),
        ),
    ] {
        let mut value = base.clone();
        *value
            .pointer_mut(pointer)
            .expect("local manifest pointer must exist") = replacement;
        invalid_values.push((label, value));
    }
    let mut missing_local_source = base.clone();
    missing_local_source
        .as_object_mut()
        .expect("manifest object")
        .remove("local_source");
    invalid_values.push(("missing local_source", missing_local_source));
    for required_field in ["source_url", "source_identity"] {
        let mut value = base.clone();
        value
            .as_object_mut()
            .expect("manifest object")
            .remove(required_field);
        invalid_values.push((required_field, value));
    }

    for (label, value) in invalid_values {
        if let Ok(manifest) = serde_json::from_value::<TaskManifest>(value) {
            assert!(
                !manifest.source_privacy_ready(),
                "{label} must not be accepted"
            );
            assert_eq!(
                manifest.safe_source_summary(),
                None,
                "{label} must not be projected"
            );
        }
    }
}

#[test]
fn local_task_source_rejects_unknown_kinds_and_extra_local_metadata() {
    let mut unknown_kind = local_manifest_value("Interview.wmv", LocalMediaKind::Video, "wmv");
    unknown_kind["source_kind"] = json!("filesystem");
    assert!(serde_json::from_value::<TaskManifest>(unknown_kind).is_err());

    let mut extra_metadata = local_manifest_value("Interview.wmv", LocalMediaKind::Video, "wmv");
    extra_metadata["local_source"]["path"] = json!("C:\\private\\Interview.wmv");
    let error = serde_json::from_value::<TaskManifest>(extra_metadata)
        .expect_err("extra local metadata must fail");
    assert!(!error.to_string().contains("Interview.wmv"));
    assert!(!error.to_string().contains("C:\\private"));
}

#[test]
fn source_identity_accepts_only_canonical_query_contract() {
    let identity = SourceIdentity {
        version: 1,
        platform: "youtube".to_string(),
        stable_id: "abcDEF_123-".to_string(),
        effective_part: None,
        canonical_url: "https://www.youtube.com/watch?v=abcDEF_123-".to_string(),
    };
    assert!(identity.is_safe());

    let noncanonical_path = SourceIdentity {
        canonical_url: "https://www.youtube.com/shorts/abcDEF_123-".to_string(),
        ..identity.clone()
    };
    assert!(!noncanonical_path.is_safe());

    let extra_query = SourceIdentity {
        canonical_url: "https://www.youtube.com/watch?v=abcDEF_123-&feature=share".to_string(),
        ..identity.clone()
    };
    assert!(!extra_query.is_safe());

    let youtube_with_part = SourceIdentity {
        effective_part: Some(2),
        ..identity.clone()
    };
    assert!(!youtube_with_part.is_safe());

    let sensitive = SourceIdentity {
        canonical_url: "https://www.youtube.com/watch?v=abcDEF_123-&signature=review-secret"
            .to_string(),
        ..identity.clone()
    };
    assert!(!sensitive.is_safe());

    let abbreviated_signature = SourceIdentity {
        canonical_url: "https://www.youtube.com/shorts/abcDEF_123-?s=review-secret".to_string(),
        ..identity.clone()
    };
    assert!(!abbreviated_signature.is_safe());

    let suspicious_value = SourceIdentity {
        canonical_url: "https://www.youtube.com/shorts/abcDEF_123-?source=review-secret"
            .to_string(),
        ..identity.clone()
    };
    assert!(!suspicious_value.is_safe());

    let wrong_host = SourceIdentity {
        canonical_url: "https://youtube.example/shorts/abcDEF_123-".to_string(),
        ..identity
    };
    assert!(!wrong_host.is_safe());

    let forged_xhs = SourceIdentity {
        version: 1,
        platform: "xiaohongshu".to_string(),
        stable_id: "xsec_token-review-secret".to_string(),
        effective_part: None,
        canonical_url: ("https://www.xiaohongshu.com/explore/xsec_token-review-secret").to_string(),
    };
    assert!(!forged_xhs.is_safe());

    let bilibili_part = SourceIdentity {
        version: 1,
        platform: "bilibili".to_string(),
        stable_id: "BV1Aa411c7mD".to_string(),
        effective_part: Some(2),
        canonical_url: "https://www.bilibili.com/video/BV1Aa411c7mD?p=2".to_string(),
    };
    assert!(bilibili_part.is_safe());

    let mismatched_part = SourceIdentity {
        effective_part: Some(3),
        ..bilibili_part.clone()
    };
    assert!(!mismatched_part.is_safe());

    let part_one_query = SourceIdentity {
        effective_part: Some(1),
        canonical_url: "https://www.bilibili.com/video/BV1Aa411c7mD?p=1".to_string(),
        ..bilibili_part.clone()
    };
    assert!(!part_one_query.is_safe());

    let xiaohongshu_query = SourceIdentity {
        version: 1,
        platform: "xiaohongshu".to_string(),
        stable_id: "64a1b2c3d4e5f67890123456".to_string(),
        effective_part: None,
        canonical_url: "https://www.xiaohongshu.com/explore/64a1b2c3d4e5f67890123456?foo=bar"
            .to_string(),
    };
    assert!(!xiaohongshu_query.is_safe());
}

#[test]
fn manifest_round_trip_preserves_unknown_fields() {
    let value = json!({
        "schema_version": 3,
        "source_privacy_migration_version": 2,
        "task_id": "task",
        "created_at": "2026-07-10T12:00:00Z",
        "source_url": "",
        "source_identity": null,
        "status": "completed",
        "future_worker_field": {"enabled": true}
    });
    let manifest: TaskManifest = serde_json::from_value(value).expect("manifest");
    let encoded = serde_json::to_value(manifest).expect("encoded manifest");
    assert_eq!(encoded["future_worker_field"]["enabled"], true);
}

#[test]
fn edit_session_preserves_unknown_fields_and_rejects_unsafe_paths_without_echo() {
    let output_root = temp_dir("task-edit-session-characterization");
    let task_id = "20260721-120000-youtube-dQw4w9WgXcQ";
    let task_dir = write_supported_task(&output_root, task_id, "dQw4w9WgXcQ");
    let manifest_path = task_dir.join(super::TASK_MANIFEST_FILE_NAME);
    let mut payload: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&manifest_path).expect("read manifest"))
            .expect("parse manifest");
    payload["future_worker_field"] = json!({"enabled": true});
    fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&payload).expect("encode manifest") + "\n",
    )
    .expect("write manifest");

    let task = SupportedTask::open(&output_root, task_id).expect("open supported task");
    let mut edit = task.into_edit_session();
    let error = edit
        .set_artifact(TaskArtifact::TranscriptMd, "../xsec_token=review-secret.md")
        .expect_err("escaping artifact must fail");
    assert!(!error.contains("review-secret"));
    assert!(!error.contains("xsec_token"));

    edit.set_artifact(TaskArtifact::TranscriptMd, "transcript/transcript.md")
        .expect("set safe artifact");
    edit.set_text_preview("updated preview".to_string());
    edit.save().expect("save edit session");

    let bytes = fs::read(&manifest_path).expect("read saved manifest");
    assert!(bytes.ends_with(b"\n"));
    let saved: serde_json::Value = serde_json::from_slice(&bytes).expect("parse saved manifest");
    assert_eq!(saved["future_worker_field"]["enabled"], true);
    assert_eq!(
        saved["artifacts"]["transcript_md"],
        "transcript/transcript.md"
    );
    assert_eq!(saved["text_preview"], "updated preview");
}

#[test]
fn artifact_resolution_errors_never_echo_untrusted_field_or_path_material() {
    let task_dir = temp_dir("safe-artifact-resolution-error");
    let missing = task_dir.join("review-secret").join("missing.txt");

    let error = validate_task_artifact_path(&task_dir, &missing, "xsec_token=review-secret")
        .expect_err("missing artifact must fail");

    assert!(!error.contains("review-secret"));
    assert!(!error.contains("xsec_token"));
    assert!(!error.contains("missing.txt"));
}

#[test]
fn supported_task_opens_only_current_tasks_and_reads_validated_artifacts() {
    let output_root = temp_dir("supported-task-facade");
    let task_id = "20260718-120000-youtube-dQw4w9WgXcQ";
    write_supported_task(&output_root, task_id, "dQw4w9WgXcQ");

    let task = SupportedTask::open(&output_root, task_id).expect("open supported task");

    assert_eq!(task.task_id(), task_id);
    assert_eq!(
        task.safe_source_url(),
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    );
    assert_eq!(
        task.read_text_artifact(TaskArtifact::TranscriptTxt)
            .expect("read transcript")
            .as_deref(),
        Some("facade transcript")
    );
    assert_eq!(
        task.existing_artifacts()["transcript_txt"],
        "transcript/transcript.txt"
    );
}

#[test]
fn supported_task_open_recovers_prepared_transaction_before_reading_artifacts() {
    let output_root = temp_dir("supported-task-recovers-transaction");
    let task_id = "20260722-120000-youtube-dQw4w9WgXcQ";
    let task_dir = write_supported_task(&output_root, task_id, "dQw4w9WgXcQ");
    let transcript = task_dir.join("transcript").join("transcript.txt");
    fs::write(&transcript, b"mixed new text\n").expect("write mixed transcript");
    let transaction_id = "dddddddddddddddddddddddddddddddd";
    let rollback = task_dir
        .join("transcript")
        .join(format!(".StudyMind-artifact-{transaction_id}-0.rollback"));
    fs::write(&rollback, b"facade transcript\n").expect("write rollback");
    fs::write(
        task_dir.join(JOURNAL_FILE_NAME),
        serde_json::to_vec(&json!({
            "schema_version": 1,
            "transaction_id": transaction_id,
            "state": "prepared",
            "entries": [{
                "destination": "transcript/transcript.txt",
                "staging": format!("transcript/.StudyMind-artifact-{transaction_id}-0.staging"),
                "rollback": format!("transcript/.StudyMind-artifact-{transaction_id}-0.rollback"),
                "existed_before": true
            }]
        }))
        .expect("encode journal"),
    )
    .expect("write journal");

    let task = SupportedTask::open(&output_root, task_id).expect("open recovered task");

    assert_eq!(
        task.read_text_artifact(TaskArtifact::TranscriptTxt)
            .expect("read recovered transcript")
            .as_deref(),
        Some("facade transcript")
    );
    assert!(!task_dir.join(JOURNAL_FILE_NAME).exists());
}

#[test]
fn supported_task_scan_isolates_corrupt_and_unsupported_manifests() {
    let output_root = temp_dir("supported-task-scan");
    write_supported_task(
        &output_root,
        "20260718-120000-youtube-dQw4w9WgXcQ",
        "dQw4w9WgXcQ",
    );
    let corrupt_dir = output_root.join("tasks").join("corrupt-task");
    fs::create_dir_all(&corrupt_dir).expect("create corrupt task");
    fs::write(corrupt_dir.join("StudyMind-task.json"), b"{not-json").expect("write corrupt manifest");
    let legacy_dir = output_root.join("tasks").join("legacy-task");
    fs::create_dir_all(&legacy_dir).expect("create legacy task");
    fs::write(
        legacy_dir.join("StudyMind-task.json"),
        r#"{"schema_version":2,"task_id":"legacy-task","created_at":"2026-07-18T12:00:00Z","status":"completed"}"#,
    )
    .expect("write legacy manifest");

    let scan = SupportedTask::scan(&output_root).expect("scan tasks");

    let ignored_count = scan.ignored_count();
    assert_eq!(scan.into_tasks().len(), 1);
    assert_eq!(ignored_count, 2);
}

#[test]
fn supported_task_coordinator_rejects_overlapping_direct_access_and_releases_on_drop() {
    let output_root = temp_dir("supported-task-coordinator");
    let task_id = "20260722-120000-youtube-dQw4w9WgXcQ";
    write_supported_task(&output_root, task_id, "dQw4w9WgXcQ");

    let first = SupportedTask::open(&output_root, task_id).expect("open first lease");
    let error = SupportedTask::open(&output_root, task_id).expect_err("second access must be busy");

    assert_eq!(error, "Task is busy. Try again shortly.");
    drop(first);
    SupportedTask::open(&output_root, task_id).expect("lease released after drop");
}

#[test]
fn supported_task_scan_skips_busy_task_without_counting_it_as_corrupt() {
    let output_root = temp_dir("supported-task-scan-busy");
    let task_id = "20260722-120000-youtube-dQw4w9WgXcQ";
    write_supported_task(&output_root, task_id, "dQw4w9WgXcQ");
    let held = SupportedTask::open(&output_root, task_id).expect("hold task lease");

    let scan = SupportedTask::scan(&output_root).expect("scan tasks");

    assert_eq!(scan.ignored_count(), 0);
    assert_eq!(scan.into_tasks().len(), 0);
    drop(held);
}

#[test]
fn supported_task_artifact_errors_do_not_echo_manifest_path_material() {
    let output_root = temp_dir("supported-task-safe-artifact-error");
    let task_id = "20260718-120000-youtube-dQw4w9WgXcQ";
    let task_dir = write_supported_task(&output_root, task_id, "dQw4w9WgXcQ");
    let manifest_path = task_dir.join("StudyMind-task.json");
    let manifest = fs::read_to_string(&manifest_path).expect("read manifest");
    fs::write(
        &manifest_path,
        manifest.replace(
            "transcript/transcript.txt",
            "../xsec_token=review-secret.txt",
        ),
    )
    .expect("write unsafe artifact");

    let task = SupportedTask::open(&output_root, task_id).expect("open supported task");
    let error = task
        .read_text_artifact(TaskArtifact::TranscriptTxt)
        .expect_err("unsafe artifact must fail");

    assert!(!error.contains("review-secret"));
    assert!(!error.contains("xsec_token"));
}

#[test]
fn parse_insight_view_rejects_missing_required_fields() {
    let value = json!({
        "id": 1,
        "topic": "topic",
        "followUpQuestions": ["next"],
        "suitableUse": "content planning",
        "sourceChunkId": 7
    });

    assert!(parse_insight_view(&value).is_none());
}

#[test]
fn parse_insight_view_rejects_blank_required_fields() {
    let value = json!({
        "id": 1,
        "topic": "topic",
        "matchReason": " ",
        "followUpQuestions": ["next"],
        "suitableUse": "content planning",
        "sourceChunkId": 7
    });

    assert!(parse_insight_view(&value).is_none());
}

#[test]
fn parse_insight_view_requires_source_chunk_id_key() {
    let value = json!({
        "id": 1,
        "topic": "topic",
        "matchReason": "matched",
        "followUpQuestions": ["next"],
        "suitableUse": "content planning"
    });

    assert!(parse_insight_view(&value).is_none());
}

#[test]
fn parse_insight_view_accepts_explicit_null_source_chunk_id() {
    let value = json!({
        "id": 1,
        "topic": "topic",
        "matchReason": "matched",
        "followUpQuestions": ["next"],
        "suitableUse": "content planning",
        "sourceChunkId": null
    });

    let insight = parse_insight_view(&value).expect("parse insight");

    assert_eq!(insight.source_chunk_id, None);
}

#[test]
fn task_manifest_module_boundary_matches_approved_private_owners() {
    use std::path::Path;

    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let module_dir = src.join("task_manifest");
    let root = fs::read_to_string(src.join("task_manifest.rs")).expect("read root");
    let source_identity =
        fs::read_to_string(module_dir.join("source_identity.rs")).expect("read source owner");
    let schema = fs::read_to_string(module_dir.join("schema.rs")).expect("read schema owner");
    let storage = fs::read_to_string(module_dir.join("storage.rs")).expect("read storage owner");
    let access = fs::read_to_string(module_dir.join("access.rs")).expect("read access owner");
    let coordinator =
        fs::read_to_string(module_dir.join("coordinator.rs")).expect("read coordinator owner");
    let transaction =
        fs::read_to_string(module_dir.join("transaction.rs")).expect("read transaction owner");
    let tests = fs::read_to_string(module_dir.join("tests.rs")).expect("read tests owner");

    assert!(
        root.lines().count() <= 100,
        "root must remain a narrow surface"
    );
    for declaration in [
        "mod access;",
        "mod coordinator;",
        "mod dissection;",
        "mod schema;",
        "mod source_identity;",
        "mod storage;",
        "mod transaction;",
        "mod tests;",
    ] {
        assert!(root.contains(declaration), "missing {declaration}");
    }
    assert!(!root.contains("pub mod "));
    for forbidden in [
        "struct TaskManifest",
        "impl SupportedTask",
        "impl TaskEditSession",
        "Url::parse",
        "fs::read_to_string",
        "fs::write",
    ] {
        assert!(!root.contains(forbidden), "root owns {forbidden}");
    }

    assert!(source_identity.contains("pub(crate) struct SourceIdentity"));
    assert!(source_identity.contains("impl SourceIdentity"));
    assert!(schema.contains("struct TaskManifest"));
    assert!(schema.contains("pub(crate) enum TaskArtifact"));
    assert!(schema.contains("pub(crate) fn parse_insights_payload"));
    assert!(storage.contains("fn load_task_manifest"));
    assert!(storage.contains("pub(crate) fn configured_output_root"));
    assert!(storage.contains("pub(crate) fn is_link_or_reparse_point"));
    assert!(access.contains("pub(crate) struct SupportedTask"));
    assert!(access.contains("pub(crate) struct TaskEditSession"));
    assert!(coordinator.contains("pub(crate) struct TaskLease"));
    assert!(coordinator.contains("pub(crate) fn acquire_task"));
    assert!(transaction.contains("pub(crate) fn commit_task_artifacts"));
    assert!(transaction.contains("pub(crate) fn recover_task_artifacts"));
    assert!(tests.contains("edit_session_preserves_unknown_fields"));

    for pure_owner in [&source_identity, &schema] {
        assert!(!pure_owner.contains("std::fs"));
        assert!(!pure_owner.contains("RuntimePaths"));
        assert!(!pure_owner.contains("settings::"));
    }
    assert!(!access.contains("RuntimePaths"));
    assert!(!access.contains("settings::"));
    for child in [
        &source_identity,
        &schema,
        &storage,
        &access,
        &coordinator,
        &transaction,
    ] {
        for forbidden in [
            "tauri::",
            "crate::history",
            "crate::history_deletion",
            "crate::transcript_detail",
            "crate::video_processing",
            "crate::worker_runtime",
            "crate::diagnostics",
        ] {
            assert!(!child.contains(forbidden), "child imports {forbidden}");
        }
    }

    let stable_root = src.join("task_manifest.rs");
    let mut rust_sources = Vec::new();
    collect_rust_sources(&src, &mut rust_sources);
    for path in rust_sources {
        if path == stable_root || path.starts_with(&module_dir) {
            continue;
        }
        let production_source = fs::read_to_string(&path).expect("read production Rust source");
        for forbidden in [
            "task_manifest::source_identity",
            "task_manifest::schema",
            "task_manifest::storage",
            "task_manifest::access",
            "task_manifest::coordinator",
            "task_manifest::transaction",
        ] {
            assert!(
                !production_source.contains(forbidden),
                "{} bypasses the stable root through {forbidden}",
                path.display()
            );
        }
    }
}

#[test]
fn dissection_artifacts_use_only_their_fixed_relative_paths() {
    assert_eq!(TaskArtifact::Dissection.as_str(), "dissection");
    assert_eq!(TaskArtifact::DissectionMd.as_str(), "dissection_md");
    assert!(
        super::schema::validate_relative_artifact_path("ai/dissection.json", "dissection").is_ok()
    );
    assert!(super::schema::validate_relative_artifact_path("ai/other.json", "dissection").is_err());
}

fn collect_rust_sources(dir: &std::path::Path, sources: &mut Vec<std::path::PathBuf>) {
    for entry in fs::read_dir(dir).expect("read Rust source directory") {
        let path = entry.expect("read Rust source entry").path();
        if path.is_dir() {
            collect_rust_sources(&path, sources);
        } else if path.extension().and_then(|value| value.to_str()) == Some("rs") {
            sources.push(path);
        }
    }
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("StudyMind-{name}-{unique}"));
    fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

fn write_supported_task(
    output_root: &std::path::Path,
    task_id: &str,
    stable_id: &str,
) -> std::path::PathBuf {
    let task_dir = output_root.join("tasks").join(task_id);
    fs::create_dir_all(task_dir.join("transcript")).expect("create transcript dir");
    fs::write(
        task_dir.join("transcript").join("transcript.txt"),
        "facade transcript\n",
    )
    .expect("write transcript");
    fs::write(
        task_dir.join("StudyMind-task.json"),
        format!(
            r#"{{
  "schema_version": 3,
  "source_privacy_migration_version": 2,
  "source_privacy_quarantined": false,
  "task_id": "{task_id}",
  "created_at": "2026-07-18T12:00:00Z",
  "source_url": "https://www.youtube.com/watch?v={stable_id}",
  "source_identity": {{
"version": 1,
"platform": "youtube",
"stable_id": "{stable_id}",
"effective_part": null,
"canonical_url": "https://www.youtube.com/watch?v={stable_id}"
  }},
  "platform": "youtube",
  "status": "completed",
  "model": "iic/SenseVoiceSmall",
  "artifacts": {{"transcript_txt": "transcript/transcript.txt"}},
  "error": null,
  "text_preview": "facade transcript",
  "insights_count": 0
}}"#
        ),
    )
    .expect("write manifest");
    task_dir
}

fn local_manifest_value(
    display_name: &str,
    media_kind: LocalMediaKind,
    extension: &str,
) -> serde_json::Value {
    json!({
        "schema_version": 3,
        "source_privacy_migration_version": 2,
        "source_privacy_quarantined": false,
        "task_id": "20260723-120000-local-abcdef123456",
        "created_at": "2026-07-23T12:00:00Z",
        "source_kind": "local_file",
        "source_url": "",
        "source_identity": null,
        "local_source": {
            "display_name": display_name,
            "media_kind": media_kind,
            "extension": extension
        },
        "platform": "local",
        "status": "completed",
        "model": "iic/SenseVoiceSmall",
        "artifacts": {},
        "error": null,
        "text_preview": "",
        "insights_count": 0
    })
}
