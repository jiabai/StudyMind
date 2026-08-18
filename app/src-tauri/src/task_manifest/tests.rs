use super::{
    parse_insight_view,
    schema::{TaskManifest, TaskManifestError},
    storage::validate_task_artifact_path,
    transaction::{
        recover_task_artifacts, validate_journal_value_for_test, RecoveryOutcome, JOURNAL_FILE_NAME,
    },
    SupportedTask, TaskArtifact, TaskSourceSummary,
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
fn no_journal_recovery_rejects_reparse_task_parent_without_cleaning_backing_orphans() {
    let output_root = temp_dir("orphan-recovery-reparse-task-parent");
    let backing_root = temp_dir("orphan-recovery-reparse-task-parent-backing");
    let task_id = "20260724-120000-local-abcdef123456";
    let backing_task_dir = write_supported_task(&backing_root, task_id, "abcdef123456");
    let ai_dir = backing_task_dir.join("ai");
    fs::create_dir_all(&ai_dir).expect("create ai dir");
    let transaction_id = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    let transcript_orphan = backing_task_dir
        .join("transcript")
        .join(format!(".StudyMind-artifact-{transaction_id}-0.staging"));
    let ai_orphan = ai_dir.join(format!(".StudyMind-artifact-{transaction_id}-1.rollback"));
    fs::write(&transcript_orphan, b"keep transcript orphan\n").expect("write transcript orphan");
    fs::write(&ai_orphan, b"keep ai orphan\n").expect("write ai orphan");

    let tasks_path = output_root.join("tasks");
    if let Err(error) = create_directory_reparse(&backing_root.join("tasks"), &tasks_path) {
        eprintln!(
            "skipping orphan recovery reparse task-parent regression; junction or symlink creation unavailable: {error}"
        );
        return;
    }

    let error = recover_task_artifacts(&tasks_path.join(task_id))
        .expect_err("reparse task parent must reject orphan cleanup");

    assert_eq!(error, "Task artifacts could not be recovered safely.");
    assert!(transcript_orphan.exists());
    assert!(ai_orphan.exists());
}

#[test]
fn no_journal_recovery_rejects_reparse_task_ancestor_without_cleaning_backing_orphans() {
    let backing_root = temp_dir("orphan-recovery-reparse-task-ancestor-backing");
    let linked_parent = temp_dir("orphan-recovery-reparse-task-ancestor-link");
    let linked_root = linked_parent.join("linked-root");
    let backing_output_root = backing_root.join("output");
    let task_id = "20260724-120001-local-abcdef123456";
    let backing_task_dir = write_supported_task(&backing_output_root, task_id, "abcdef123456");
    let orphan = backing_task_dir
        .join("transcript")
        .join(".StudyMind-artifact-ffffffffffffffffffffffffffffffff-0.staging");
    fs::write(&orphan, b"keep ancestor orphan\n").expect("write ancestor orphan");

    if let Err(error) = create_directory_reparse(&backing_root, &linked_root) {
        eprintln!(
            "skipping orphan recovery reparse task-ancestor regression; junction or symlink creation unavailable: {error}"
        );
        return;
    }

    let task_dir = linked_root.join("output").join("tasks").join(task_id);
    let error = recover_task_artifacts(&task_dir)
        .expect_err("reparse task ancestor must reject orphan cleanup");

    assert_eq!(error, "Task artifacts could not be recovered safely.");
    assert!(orphan.exists());
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
    }
}

#[test]
fn local_task_source_fails_closed_for_incomplete_or_conflicting_boundaries() {
    let base = local_manifest_value("Interview.wmv", LocalMediaKind::Video, "wmv");
    let mut invalid_values = Vec::new();
    for (label, pointer, replacement) in [
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
fn local_task_source_rejects_extra_local_metadata() {
    let mut extra_metadata = local_manifest_value("Interview.wmv", LocalMediaKind::Video, "wmv");
    extra_metadata["local_source"]["path"] = json!("C:\\private\\Interview.wmv");
    let error = serde_json::from_value::<TaskManifest>(extra_metadata)
        .expect_err("extra local metadata must fail");
    assert!(!error.to_string().contains("Interview.wmv"));
    assert!(!error.to_string().contains("C:\\private"));
}

#[test]
fn manifest_round_trip_preserves_unknown_fields() {
    let value = local_manifest_value("Interview.wmv", LocalMediaKind::Video, "wmv");
    let manifest: TaskManifest = serde_json::from_value(value).expect("manifest");
    let mut encoded = serde_json::to_value(manifest).expect("encoded manifest");
    encoded["future_worker_field"] = json!({"enabled": true});
    let round_tripped: TaskManifest = serde_json::from_value(encoded).expect("round-trip manifest");
    let re_encoded = serde_json::to_value(round_tripped).expect("re-encoded manifest");
    assert_eq!(re_encoded["future_worker_field"]["enabled"], true);
}

#[test]
fn edit_session_preserves_unknown_fields_and_rejects_unsafe_paths_without_echo() {
    let output_root = temp_dir("task-edit-session-characterization");
    let task_id = "20260721-120000-local-abcdef123456";
    let task_dir = write_supported_task(&output_root, task_id, "abcdef123456");
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
    let task_id = "20260718-120000-local-abcdef123456";
    write_supported_task(&output_root, task_id, "abcdef123456");

    let task = SupportedTask::open(&output_root, task_id).expect("open supported task");

    assert_eq!(task.task_id(), task_id);
    assert_eq!(
        task.source(),
        TaskSourceSummary::LocalFile {
            display_name: "Interview-abcdef123456.wmv".to_string(),
            media_kind: LocalMediaKind::Video,
        }
    );
    assert_eq!(
        task.read_text_artifact(TaskArtifact::TranscriptTxt)
            .expect("read transcript")
            .as_deref(),
        Some("facade transcript")
    );
    assert_eq!(
        task.declared_artifacts()["transcript_txt"],
        "transcript/transcript.txt"
    );
}

#[test]
fn supported_task_open_recovers_prepared_transaction_before_reading_artifacts() {
    let output_root = temp_dir("supported-task-recovers-transaction");
    let task_id = "20260722-120000-local-abcdef123456";
    let task_dir = write_supported_task(&output_root, task_id, "abcdef123456");
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
        "20260718-120000-local-abcdef123456",
        "abcdef123456",
    );
    let corrupt_dir = output_root.join("tasks").join("corrupt-task");
    fs::create_dir_all(&corrupt_dir).expect("create corrupt task");
    fs::write(corrupt_dir.join("StudyMind-task.json"), b"{not-json")
        .expect("write corrupt manifest");
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
    let task_id = "20260722-120000-local-abcdef123456";
    write_supported_task(&output_root, task_id, "abcdef123456");

    let first = SupportedTask::open(&output_root, task_id).expect("open first lease");
    let error = SupportedTask::open(&output_root, task_id).expect_err("second access must be busy");

    assert_eq!(error, "Task is busy. Try again shortly.");
    drop(first);
    SupportedTask::open(&output_root, task_id).expect("lease released after drop");
}

#[test]
fn supported_task_scan_skips_busy_task_without_counting_it_as_corrupt() {
    let output_root = temp_dir("supported-task-scan-busy");
    let task_id = "20260722-120000-local-abcdef123456";
    write_supported_task(&output_root, task_id, "abcdef123456");
    let held = SupportedTask::open(&output_root, task_id).expect("hold task lease");

    let scan = SupportedTask::scan(&output_root).expect("scan tasks");

    assert_eq!(scan.ignored_count(), 0);
    assert_eq!(scan.into_tasks().len(), 0);
    drop(held);
}

#[test]
fn supported_task_artifact_errors_do_not_echo_manifest_path_material() {
    let output_root = temp_dir("supported-task-safe-artifact-error");
    let task_id = "20260718-120000-local-abcdef123456";
    let task_dir = write_supported_task(&output_root, task_id, "abcdef123456");
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

    assert!(!schema.contains("std::fs"));
    assert!(!schema.contains("RuntimePaths"));
    assert!(!schema.contains("settings::"));
    assert!(!access.contains("RuntimePaths"));
    assert!(!access.contains("settings::"));
    for child in [&schema, &storage, &access, &coordinator, &transaction] {
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

#[cfg(windows)]
fn create_directory_reparse(
    source: &std::path::Path,
    link: &std::path::Path,
) -> std::io::Result<()> {
    let output = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(source)
        .output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(format!(
            "mklink /J failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )))
    }
}

#[cfg(unix)]
fn create_directory_reparse(
    source: &std::path::Path,
    link: &std::path::Path,
) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, link)
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
  "schema_version": 4,
  "task_id": "{task_id}",
  "created_at": "2026-07-18T12:00:00Z",
  "local_source": {{
    "display_name": "Interview-{stable_id}.wmv",
    "media_kind": "video",
    "extension": "wmv"
  }},
  "platform": "local",
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
        "schema_version": 4,
        "task_id": "20260723-120000-local-abcdef123456",
        "created_at": "2026-07-23T12:00:00Z",
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

#[test]
fn finalize_processing_tombstones_rewrites_only_processing_manifests() {
    let output_root = temp_dir("finalize-tombstones");
    fs::create_dir_all(output_root.join("tasks")).expect("create tasks dir");

    // processing tombstone：模拟 worker 原生崩溃后的磁盘状态
    let processing_dir = output_root
        .join("tasks")
        .join("20260818-234000-local-crashabc");
    fs::create_dir_all(&processing_dir).expect("create processing task dir");
    fs::write(
        processing_dir.join("StudyMind-task.json"),
        r#"{
  "schema_version": 4,
  "task_id": "20260818-234000-local-crashabc",
  "created_at": "2026-08-18T23:40:00Z",
  "local_source": {
    "display_name": "recording.wav",
    "media_kind": "audio",
    "extension": "wav"
  },
  "platform": "local",
  "status": "processing",
  "model": "iic/SenseVoiceSmall",
  "artifacts": {},
  "error": null,
  "text_preview": "",
  "insights_count": 0
}"#,
    )
    .expect("write processing tombstone");

    // completed 任务：不应被改写
    let completed_dir = output_root
        .join("tasks")
        .join("20260818-230000-local-okabc");
    fs::create_dir_all(&completed_dir).expect("create completed task dir");
    fs::write(
        completed_dir.join("StudyMind-task.json"),
        r#"{
  "schema_version": 4,
  "task_id": "20260818-230000-local-okabc",
  "created_at": "2026-08-18T23:00:00Z",
  "local_source": {
    "display_name": "recording2.wav",
    "media_kind": "audio",
    "extension": "wav"
  },
  "platform": "local",
  "status": "completed",
  "model": "iic/SenseVoiceSmall",
  "artifacts": {},
  "error": null,
  "text_preview": "",
  "insights_count": 0
}"#,
    )
    .expect("write completed manifest");

    let count = super::finalize_processing_tombstones(
        &output_root,
        "WORKER_PROCESS_FAILED",
        "Local media worker failed before returning a structured result.",
        "video_extracting",
    )
    .expect("finalize tombstones");

    assert_eq!(
        count, 1,
        "only the processing tombstone should be rewritten"
    );

    let rewritten: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(processing_dir.join("StudyMind-task.json"))
            .expect("read rewritten"),
    )
    .expect("parse rewritten");
    assert_eq!(rewritten["status"], "interrupted");
    assert_eq!(rewritten["error"]["code"], "WORKER_PROCESS_FAILED");
    assert_eq!(rewritten["error"]["stage"], "video_extracting");
    assert_eq!(rewritten["local_source"]["display_name"], "recording.wav");

    let untouched: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(completed_dir.join("StudyMind-task.json"))
            .expect("read untouched"),
    )
    .expect("parse untouched");
    assert_eq!(untouched["status"], "completed");
    assert!(untouched["error"].is_null());
}

#[test]
fn finalize_processing_tombstones_handles_missing_tasks_dir() {
    let output_root = temp_dir("finalize-empty");
    let count = super::finalize_processing_tombstones(
        &output_root,
        "WORKER_PROCESS_FAILED",
        "msg",
        "video_extracting",
    )
    .expect("finalize on empty");
    assert_eq!(count, 0);
}
