use super::super::progress::{inspect_progress_line, ProgressProtocol, ProgressRecord};

#[test]
fn progress_protocols_validate_before_routing_and_drop_invalid_payloads() {
    let worker = inspect_progress_line(
        ProgressProtocol::Worker,
        r#"STUDYMIND_PROGRESS {"stage":"video_extracting","progress":22,"message_code":"audio.extract.running"}"#,
    );
    let model = inspect_progress_line(
        ProgressProtocol::AsrModelDownload,
        r#"STUDYMIND_MODEL_DOWNLOAD {"status":"started","progress":0,"message_code":"model.download.preparing","message_args":{"model":"iic/SenseVoiceSmall"}}"#,
    );
    let invalid = inspect_progress_line(
        ProgressProtocol::Worker,
        r#"STUDYMIND_PROGRESS {"stage":"video_extracting","progress":22,"message_code":"unknown.action.state"}"#,
    );
    let ignored_by_none = inspect_progress_line(
        ProgressProtocol::None,
        r#"STUDYMIND_PROGRESS {"stage":"video_extracting","progress":22,"message_code":"audio.extract.running"}"#,
    );

    assert!(matches!(
        worker,
        ProgressRecord::Validated(value) if value["message_code"] == "audio.extract.running"
    ));
    assert!(matches!(
        model,
        ProgressRecord::Validated(value) if value["status"] == "started"
    ));
    assert_eq!(
        invalid,
        ProgressRecord::Invalid("message_code=unknown.action.state".to_string())
    );
    assert_eq!(ignored_by_none, ProgressRecord::Diagnostic);
}
