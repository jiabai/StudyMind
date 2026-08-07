use crate::local_media_contract::{
    parse_process_local_media_ipc_request, serialize_process_local_media_worker_request,
    LocalMediaKind, LocalMediaSelectionView, AUDIO_EXTENSIONS, INVALID_LOCAL_MEDIA_SELECTION_CODE,
    INVALID_LOCAL_MEDIA_WORKER_REQUEST_MESSAGE, LOCAL_MEDIA_CONTRACT_VERSION, VIDEO_EXTENSIONS,
};
use serde_json::json;
use std::path::PathBuf;

const SELECTION_TOKEN: &str = "01234567-89ab-4def-8abc-0123456789ab";

fn sensitive_source(extension: &str) -> PathBuf {
    std::env::temp_dir()
        .join("review-secret")
        .join(format!("访谈.{extension}"))
}

fn expect_fixed_error<T>(result: Result<T, &'static str>) -> &'static str {
    match result {
        Ok(_) => panic!("unsafe contract value must be rejected"),
        Err(error) => error,
    }
}

#[test]
fn local_media_types_lock_v4_kinds_extensions_and_safe_selection_view() {
    assert_eq!(LOCAL_MEDIA_CONTRACT_VERSION, 4);
    assert_eq!(
        VIDEO_EXTENSIONS,
        ["mp4", "m4v", "mov", "mkv", "avi", "wmv", "webm"]
    );
    assert_eq!(
        AUDIO_EXTENSIONS,
        ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "wma"]
    );

    let view = LocalMediaSelectionView::try_new(
        SELECTION_TOKEN,
        "访谈.wmv",
        LocalMediaKind::Video,
        "wmv",
        1_024,
    )
    .expect("valid frontend-safe selection view");
    assert_eq!(
        serde_json::to_value(view).expect("serialize selection view"),
        json!({
            "selectionToken": SELECTION_TOKEN,
            "displayName": "访谈.wmv",
            "mediaKind": "video",
            "extension": "wmv",
            "sizeBytes": 1_024,
        })
    );
    assert!(LocalMediaSelectionView::try_new(
        SELECTION_TOKEN,
        "访谈.wmv",
        LocalMediaKind::Video,
        "wmv",
        u64::MAX,
    )
    .is_ok());
}

#[test]
fn local_media_selection_view_rejects_wrong_kind_and_path_without_echoing() {
    let sensitive_name = r"C:\Users\review-secret\访谈.wmv";
    for result in [
        LocalMediaSelectionView::try_new(
            SELECTION_TOKEN,
            "访谈.mp3",
            LocalMediaKind::Video,
            "mp3",
            1_024,
        ),
        LocalMediaSelectionView::try_new(
            SELECTION_TOKEN,
            sensitive_name,
            LocalMediaKind::Video,
            "wmv",
            1_024,
        ),
        LocalMediaSelectionView::try_new(
            SELECTION_TOKEN,
            "访谈.wmv",
            LocalMediaKind::Video,
            "wmv",
            0,
        ),
    ] {
        let error = expect_fixed_error(result);
        assert_eq!(error, INVALID_LOCAL_MEDIA_SELECTION_CODE);
        assert!(!error.contains("review-secret"));
        assert!(!error.contains("C:\\Users"));
    }
}

#[test]
fn local_media_ipc_parser_accepts_only_one_canonical_uuid_token() {
    let request = parse_process_local_media_ipc_request(json!({
        "selectionToken": SELECTION_TOKEN,
        "asrModel": "iic/SenseVoiceSmall-onnx",
    }))
    .expect("valid token-only request");

    assert_eq!(request.selection_token, SELECTION_TOKEN);
    assert_eq!(request.asr_model, "iic/SenseVoiceSmall-onnx");
}

#[test]
fn local_media_ipc_parser_rejects_missing_unknown_wrong_type_and_path_echoes() {
    for value in [
        json!(null),
        json!({}),
        json!({"selectionToken": 42}),
        json!({"selectionToken": "not-a-uuid"}),
        json!({"selectionToken": SELECTION_TOKEN, "extra": true}),
        json!({
            "selectionToken": SELECTION_TOKEN,
            "sourcePath": r"C:\Users\review-secret\recording.mp3",
        }),
    ] {
        let error = expect_fixed_error(parse_process_local_media_ipc_request(value));
        assert_eq!(error, INVALID_LOCAL_MEDIA_SELECTION_CODE);
        assert!(!error.contains("review-secret"));
        assert!(!error.contains("C:\\Users"));
    }
}

#[test]
fn local_media_worker_request_serializes_the_exact_closed_stdin_shape() {
    let source_path = sensitive_source("wmv");
    let encoded = serialize_process_local_media_worker_request(
        &source_path,
        LocalMediaKind::Video,
        "访谈.wmv",
        "wmv",
        "iic/SenseVoiceSmall",
    )
    .expect("valid local-media worker request");

    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&encoded).expect("request JSON"),
        json!({
            "contract_version": 4,
            "source_path": source_path.to_string_lossy(),
            "media_kind": "video",
            "safe_display_name": "访谈.wmv",
            "source_extension": "wmv",
            "asr_model": "iic/SenseVoiceSmall",
        })
    );
}

#[test]
fn local_media_worker_request_rejects_wrong_kind_and_malformed_values_without_echoing() {
    let sensitive_path = sensitive_source("wmv");
    let relative_path = PathBuf::from("private/review-secret/访谈.wmv");
    let cases = [
        serialize_process_local_media_worker_request(
            &sensitive_path,
            LocalMediaKind::Audio,
            "访谈.wmv",
            "wmv",
            "iic/SenseVoiceSmall",
        ),
        serialize_process_local_media_worker_request(
            &sensitive_path,
            LocalMediaKind::Video,
            r"C:\Users\review-secret\访谈.wmv",
            "wmv",
            "iic/SenseVoiceSmall",
        ),
        serialize_process_local_media_worker_request(
            &relative_path,
            LocalMediaKind::Video,
            "访谈.wmv",
            "wmv",
            "iic/SenseVoiceSmall",
        ),
        serialize_process_local_media_worker_request(
            &sensitive_path,
            LocalMediaKind::Video,
            "访谈.wmv",
            "mp4",
            "iic/SenseVoiceSmall",
        ),
        serialize_process_local_media_worker_request(
            &sensitive_path,
            LocalMediaKind::Video,
            "访谈.wmv",
            "wmv",
            "private/review-secret-model",
        ),
    ];

    for result in cases {
        let error = expect_fixed_error(result);
        assert_eq!(error, INVALID_LOCAL_MEDIA_WORKER_REQUEST_MESSAGE);
        assert!(!error.contains("review-secret"));
        assert!(!error.contains("C:\\Users"));
    }
}
