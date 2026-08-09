use super::runner::WorkerOperation;
use crate::task_manifest;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;

pub(crate) const WORKER_PROTOCOL_VIOLATION: &str = "WORKER_PROTOCOL_VIOLATION";
pub(crate) const WORKER_PROTOCOL_MESSAGE: &str = "Worker result violated the terminal protocol.";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const DEFAULT_ASR_MODEL: &str = "iic/SenseVoiceSmall";
const MODEL_DOWNLOAD_FAILED_MESSAGE: &str = "ASR model download failed.";
const MODEL_ARCHIVE_INVALID_MESSAGE: &str = "Downloaded ASR model archive was invalid.";

#[cfg(test)]
pub(crate) const TASK_RESULT_FIELDS: &[&str] = &[
    "status",
    "task_id",
    "task_dir",
    "artifacts",
    "text",
    "summary",
    "insights",
    "transcript",
    "dissection",
    "error",
];
pub(crate) const TASK_ARTIFACT_KEYS: &[&str] = &[
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
#[cfg(test)]
pub(crate) const TASK_INSIGHT_FIELDS: &[&str] = &[
    "id",
    "topic",
    "matchReason",
    "followUpQuestions",
    "suitableUse",
    "sourceChunkId",
];
#[cfg(test)]
pub(crate) const TASK_TERMINAL_STATUSES: &[&str] = &["completed", "partial_completed", "failed"];

#[cfg(test)]
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct TerminalOperationFamilies {
    process_local_media: &'static str,
    retry_insights: &'static str,
    download_asr_model: &'static str,
}

#[cfg(test)]
pub(crate) const TERMINAL_OPERATION_FAMILIES: TerminalOperationFamilies =
    TerminalOperationFamilies {
        process_local_media: "task",
        retry_insights: "task",
        download_asr_model: "modelDownload",
    };

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TaskTerminalStatus {
    Completed,
    PartialCompleted,
    Failed,
}

impl TaskTerminalStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::PartialCompleted => "partial_completed",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TaskErrorStage {
    WaitingInput,
    VideoExtracting,
    VideoTranscribing,
    InsightsGenerating,
    Completed,
    PartialCompleted,
    Failed,
}

impl TaskErrorStage {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::WaitingInput => "waiting_input",
            Self::VideoExtracting => "video_extracting",
            Self::VideoTranscribing => "video_transcribing",
            Self::InsightsGenerating => "insights_generating",
            Self::Completed => "completed",
            Self::PartialCompleted => "partial_completed",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct TaskInsight {
    pub(crate) id: u64,
    pub(crate) topic: String,
    pub(crate) match_reason: String,
    pub(crate) follow_up_questions: Vec<String>,
    pub(crate) suitable_use: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub(crate) source_chunk_id: Option<u64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TaskTranscriptSource {
    Asr,
    Subtitle,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TaskTranscript {
    pub(crate) source: TaskTranscriptSource,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub(crate) language: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub(crate) engine: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct TaskDissectionSourceChunk {
    pub(crate) id: u64,
    pub(crate) start_byte: u64,
    pub(crate) end_byte: u64,
    pub(crate) sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct TaskDissectionNarrative {
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub(crate) opening_hook: Option<String>,
    pub(crate) structure_type: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub(crate) turning_point: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub(crate) closing_type: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct TaskDissectionSegment {
    pub(crate) id: u64,
    pub(crate) title: String,
    pub(crate) source_chunk_ids: Vec<u64>,
    pub(crate) core_claim: String,
    pub(crate) supporting_points: Vec<String>,
    pub(crate) rhetorical_devices: Vec<String>,
    pub(crate) rhythm_note: String,
    pub(crate) reusable_pattern: String,
    pub(crate) risk_flags: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TaskDissectionTemplate {
    pub(crate) name: String,
    pub(crate) skeleton: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TaskDissectionAudienceFitLevel {
    High,
    Medium,
    Low,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TaskDissectionAudienceFit {
    pub(crate) audience: String,
    pub(crate) fit: TaskDissectionAudienceFitLevel,
    pub(crate) note: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct TaskDissection {
    pub(crate) schema_version: u32,
    pub(crate) source_transcript_sha256: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub(crate) source_language: Option<String>,
    pub(crate) source_chunks: Vec<TaskDissectionSourceChunk>,
    pub(crate) overall_narrative: TaskDissectionNarrative,
    pub(crate) segments: Vec<TaskDissectionSegment>,
    pub(crate) highlights: Vec<String>,
    pub(crate) reusable_template: TaskDissectionTemplate,
    pub(crate) audience_fit: Vec<TaskDissectionAudienceFit>,
    pub(crate) strengths: Vec<String>,
    pub(crate) weaknesses: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TaskError {
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) stage: TaskErrorStage,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TaskTerminalResult {
    pub(crate) status: TaskTerminalStatus,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub(crate) task_id: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub(crate) task_dir: Option<String>,
    pub(crate) artifacts: HashMap<String, String>,
    pub(crate) text: String,
    pub(crate) summary: String,
    pub(crate) insights: Vec<TaskInsight>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub(crate) transcript: Option<TaskTranscript>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub(crate) dissection: Option<TaskDissection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) dissection_source_status: Option<task_manifest::DissectionSourceStatus>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub(crate) error: Option<TaskError>,
}

impl TaskTerminalResult {
    pub(crate) fn from_value(value: serde_json::Value) -> Result<Self, TerminalResultError> {
        let result = serde_json::from_value(value).map_err(|_| TerminalResultError::Invalid)?;
        validate_task_result(result)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ModelDownloadTerminalResult {
    Completed { model: String },
    Failed { code: String, message: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ValidatedWorkerResult {
    Task(TaskTerminalResult),
    ModelDownload(ModelDownloadTerminalResult),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TerminalResultError {
    Missing,
    Invalid,
}

pub(crate) fn parse_terminal_result(
    operation: WorkerOperation,
    stdout: &[u8],
) -> Result<ValidatedWorkerResult, TerminalResultError> {
    let text = std::str::from_utf8(stdout).map_err(|_| TerminalResultError::Invalid)?;
    let mut lines = text.lines().map(str::trim).filter(|line| !line.is_empty());
    let line = lines.next().ok_or(TerminalResultError::Missing)?;
    if lines.next().is_some() {
        return Err(TerminalResultError::Invalid);
    }

    match operation {
        WorkerOperation::ProcessLocalMedia | WorkerOperation::RetryInsights => {
            let result = serde_json::from_str(line).map_err(|_| TerminalResultError::Invalid)?;
            validate_task_result(result).map(ValidatedWorkerResult::Task)
        }
        WorkerOperation::DownloadAsrModel => {
            parse_model_download_result(line).map(ValidatedWorkerResult::ModelDownload)
        }
    }
}

fn validate_task_result(
    result: TaskTerminalResult,
) -> Result<TaskTerminalResult, TerminalResultError> {
    let error_is_coherent = match result.status {
        TaskTerminalStatus::Completed => result.error.is_none(),
        TaskTerminalStatus::PartialCompleted | TaskTerminalStatus::Failed => result.error.is_some(),
    };
    let artifacts_are_known = result
        .artifacts
        .keys()
        .all(|key| TASK_ARTIFACT_KEYS.contains(&key.as_str()));
    let insights_are_safe = result.insights.iter().all(|insight| {
        insight.id <= MAX_SAFE_INTEGER
            && insight
                .source_chunk_id
                .is_none_or(|source_chunk_id| source_chunk_id <= MAX_SAFE_INTEGER)
    });
    let error_is_safe = result
        .error
        .as_ref()
        .is_none_or(|error| is_safe_error_code(&error.code));
    let dissection_is_safe = result
        .dissection
        .as_ref()
        .is_none_or(validate_task_dissection);

    if error_is_coherent
        && artifacts_are_known
        && insights_are_safe
        && error_is_safe
        && dissection_is_safe
    {
        Ok(result)
    } else {
        Err(TerminalResultError::Invalid)
    }
}

pub(crate) fn validate_task_dissection(dissection: &TaskDissection) -> bool {
    if dissection.schema_version != 1
        || !is_sha256(&dissection.source_transcript_sha256)
        || dissection
            .source_language
            .as_ref()
            .is_some_and(|language| !is_source_language(language))
        || dissection.source_chunks.is_empty()
        || dissection.segments.is_empty()
        || dissection.highlights.len() > 8
        || dissection.strengths.len() > 6
        || dissection.weaknesses.len() > 6
        || !(3..=7).contains(&dissection.reusable_template.skeleton.len())
        || !is_non_blank(&dissection.overall_narrative.structure_type)
        || !optional_is_non_blank(&dissection.overall_narrative.opening_hook)
        || !optional_is_non_blank(&dissection.overall_narrative.turning_point)
        || !optional_is_non_blank(&dissection.overall_narrative.closing_type)
        || !is_non_blank(&dissection.reusable_template.name)
        || !all_non_blank(&dissection.reusable_template.skeleton)
        || !all_non_blank(&dissection.highlights)
        || !all_non_blank(&dissection.strengths)
        || !all_non_blank(&dissection.weaknesses)
        || dissection
            .audience_fit
            .iter()
            .any(|fit| !is_non_blank(&fit.audience) || !is_non_blank(&fit.note))
    {
        return false;
    }

    let mut previous_end = 0;
    for (index, chunk) in dissection.source_chunks.iter().enumerate() {
        if chunk.id != (index + 1) as u64
            || chunk.start_byte < previous_end
            || chunk.end_byte <= chunk.start_byte
            || !is_sha256(&chunk.sha256)
        {
            return false;
        }
        previous_end = chunk.end_byte;
    }

    for (index, segment) in dissection.segments.iter().enumerate() {
        if segment.id != (index + 1) as u64
            || !is_non_blank(&segment.title)
            || !is_non_blank(&segment.core_claim)
            || !is_non_blank(&segment.rhythm_note)
            || !is_non_blank(&segment.reusable_pattern)
            || !all_non_blank(&segment.supporting_points)
            || !all_non_blank(&segment.rhetorical_devices)
            || !all_non_blank(&segment.risk_flags)
            || segment.source_chunk_ids.is_empty()
        {
            return false;
        }
        let mut previous_id = 0;
        for source_id in &segment.source_chunk_ids {
            if *source_id <= previous_id || *source_id as usize > dissection.source_chunks.len() {
                return false;
            }
            previous_id = *source_id;
        }
    }
    true
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn is_source_language(value: &str) -> bool {
    (2..=35).contains(&value.len())
        && value.split('-').all(|part| {
            !part.is_empty()
                && part.len() <= 8
                && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
}

fn is_non_blank(value: &str) -> bool {
    !value.trim().is_empty()
}

fn optional_is_non_blank(value: &Option<String>) -> bool {
    value.as_ref().is_none_or(|text| is_non_blank(text))
}

fn all_non_blank(values: &[String]) -> bool {
    values.iter().all(|value| is_non_blank(value))
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawModelDownloadTerminalResult {
    Completed(RawModelDownloadCompleted),
    Failed(RawModelDownloadFailed),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawModelDownloadCompleted {
    status: String,
    model: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawModelDownloadFailed {
    status: String,
    code: String,
    message: String,
}

fn parse_model_download_result(
    line: &str,
) -> Result<ModelDownloadTerminalResult, TerminalResultError> {
    let raw: RawModelDownloadTerminalResult =
        serde_json::from_str(line).map_err(|_| TerminalResultError::Invalid)?;
    match raw {
        RawModelDownloadTerminalResult::Completed(completed) => {
            if completed.status != "completed" || completed.model != DEFAULT_ASR_MODEL {
                return Err(TerminalResultError::Invalid);
            }
            Ok(ModelDownloadTerminalResult::Completed {
                model: completed.model,
            })
        }
        RawModelDownloadTerminalResult::Failed(failed) => {
            if failed.status != "failed"
                || !is_safe_error_code(&failed.code)
                || !matches!(
                    failed.message.as_str(),
                    MODEL_DOWNLOAD_FAILED_MESSAGE | MODEL_ARCHIVE_INVALID_MESSAGE
                )
            {
                return Err(TerminalResultError::Invalid);
            }
            Ok(ModelDownloadTerminalResult::Failed {
                code: failed.code,
                message: failed.message,
            })
        }
    }
}

fn is_safe_error_code(code: &str) -> bool {
    let bytes = code.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_uppercase()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_')
}

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[cfg(test)]
mod tests {
    use super::{
        parse_terminal_result, ModelDownloadTerminalResult, TerminalResultError,
        ValidatedWorkerResult, TASK_ARTIFACT_KEYS, TASK_INSIGHT_FIELDS, TASK_RESULT_FIELDS,
        TASK_TERMINAL_STATUSES, TERMINAL_OPERATION_FAMILIES,
    };
    use crate::task_manifest;
    use crate::worker_runtime::runner::WorkerOperation;
    use serde_json::{json, Value};
    use std::collections::BTreeSet;

    #[test]
    fn task_operations_accept_only_complete_closed_task_results() {
        for operation in [
            WorkerOperation::ProcessLocalMedia,
            WorkerOperation::RetryInsights,
        ] {
            let stdout = serde_json::to_vec(&valid_task_value()).expect("serialize task fixture");
            let parsed = parse_terminal_result(operation, &stdout).expect("valid task result");

            assert!(matches!(parsed, ValidatedWorkerResult::Task(_)));
        }

        let mut safe_unknown_code = valid_task_value();
        safe_unknown_code["status"] = json!("partial_completed");
        safe_unknown_code["error"] = json!({
            "code": "FUTURE_SAFE_CODE_2",
            "message": "A safe future failure.",
            "stage": "insights_generating"
        });
        assert!(matches!(
            parse_terminal_result(
                WorkerOperation::RetryInsights,
                &serde_json::to_vec(&safe_unknown_code).expect("serialize partial fixture"),
            ),
            Ok(ValidatedWorkerResult::Task(_))
        ));

        let mut dissection = valid_task_value();
        dissection["dissection"] = valid_dissection_value();
        assert!(matches!(
            parse_terminal_result(
                WorkerOperation::RetryInsights,
                &serde_json::to_vec(&dissection).expect("serialize dissection fixture"),
            ),
            Ok(ValidatedWorkerResult::Task(_))
        ));
    }

    #[test]
    fn task_results_reject_unknown_nested_fields_and_wrong_types() {
        let invalid_values = [
            mutate_task(|value| value["extra"] = json!("secret")),
            mutate_task(|value| value["artifacts"]["unknown"] = json!("secret")),
            mutate_task(|value| value["transcript"]["extra"] = json!(true)),
            mutate_task(|value| value["insights"][0]["extra"] = json!(true)),
            mutate_task(|value| {
                value["error"] = json!({
                    "code": "SAFE_CODE",
                    "message": "safe",
                    "stage": "video_extracting",
                    "extra": true
                })
            }),
            mutate_task(|value| value["artifacts"]["audio"] = json!(7)),
            mutate_task(|value| value["insights"][0]["id"] = json!("1")),
            mutate_task(|value| value["insights"][0]["id"] = json!(9_007_199_254_740_992_u64)),
            mutate_task(|value| value["insights"][0]["followUpQuestions"] = json!([1])),
            mutate_task(|value| value["insights"][0]["sourceChunkId"] = json!(-1)),
            mutate_task(|value| value["transcript"]["source"] = json!("generated")),
            mutate_task(|value| value["dissection"] = valid_dissection_value_with_extra()),
            mutate_task(|value| value["status"] = json!("running")),
        ];

        for value in invalid_values {
            assert_eq!(
                parse_terminal_result(
                    WorkerOperation::ProcessLocalMedia,
                    &serde_json::to_vec(&value).expect("serialize invalid task"),
                ),
                Err(TerminalResultError::Invalid),
            );
        }
    }

    #[test]
    fn task_results_reject_unsafe_codes_and_incoherent_status_errors() {
        let invalid_values = [
            mutate_task(|value| {
                value["status"] = json!("failed");
                value["error"] = json!({
                    "code": "unsafe.code",
                    "message": "unsafe",
                    "stage": "video_extracting"
                });
            }),
            mutate_task(|value| {
                value["status"] = json!("failed");
                value["error"] = Value::Null;
            }),
            mutate_task(|value| {
                value["error"] = json!({
                    "code": "UNEXPECTED_ERROR",
                    "message": "unexpected",
                    "stage": "video_extracting"
                });
            }),
            mutate_task(|value| {
                value["status"] = json!("partial_completed");
                value["error"] = json!({
                    "code": "SAFE_CODE",
                    "message": "safe",
                    "stage": "cancelling"
                });
            }),
        ];

        for value in invalid_values {
            assert_eq!(
                parse_terminal_result(
                    WorkerOperation::ProcessLocalMedia,
                    &serde_json::to_vec(&value).expect("serialize incoherent task"),
                ),
                Err(TerminalResultError::Invalid),
            );
        }
    }

    #[test]
    fn stdout_framing_requires_one_nonempty_utf8_json_line() {
        assert_eq!(
            parse_terminal_result(WorkerOperation::ProcessLocalMedia, b" \r\n\t"),
            Err(TerminalResultError::Missing),
        );
        assert_eq!(
            parse_terminal_result(WorkerOperation::ProcessLocalMedia, &[0xff, 0xfe]),
            Err(TerminalResultError::Invalid),
        );
        assert_eq!(
            parse_terminal_result(WorkerOperation::ProcessLocalMedia, b"not-json"),
            Err(TerminalResultError::Invalid),
        );
        let line = serde_json::to_string(&valid_task_value()).expect("serialize task line");
        let multiple = format!("{line}\n{line}\n");
        assert_eq!(
            parse_terminal_result(WorkerOperation::ProcessLocalMedia, multiple.as_bytes()),
            Err(TerminalResultError::Invalid),
        );
    }

    #[test]
    fn model_download_results_are_closed_and_use_fixed_messages() {
        let completed = json!({"status": "completed", "model": "iic/SenseVoiceSmall"});
        assert!(matches!(
            parse_terminal_result(
                WorkerOperation::DownloadAsrModel,
                &serde_json::to_vec(&completed).expect("serialize model success"),
            ),
            Ok(ValidatedWorkerResult::ModelDownload(
                ModelDownloadTerminalResult::Completed { .. }
            ))
        ));

        for message in [
            "ASR model download failed.",
            "Downloaded ASR model archive was invalid.",
        ] {
            let failed = json!({
                "status": "failed",
                "code": "FUTURE_SAFE_MODEL_CODE",
                "message": message
            });
            assert!(matches!(
                parse_terminal_result(
                    WorkerOperation::DownloadAsrModel,
                    &serde_json::to_vec(&failed).expect("serialize model failure"),
                ),
                Ok(ValidatedWorkerResult::ModelDownload(
                    ModelDownloadTerminalResult::Failed { .. }
                ))
            ));
        }

        let invalid_values = [
            json!({
                "status": "completed",
                "model": "iic/SenseVoiceSmall",
                "model_dir": "C:/review-secret"
            }),
            json!({"status": "completed", "model": "other/model"}),
            json!({
                "status": "failed",
                "code": "ASR_MODEL_DOWNLOAD_FAILED",
                "message": "raw review-secret exception"
            }),
            json!({
                "status": "failed",
                "code": "unsafe.code",
                "message": "ASR model download failed."
            }),
        ];
        for value in invalid_values {
            assert_eq!(
                parse_terminal_result(
                    WorkerOperation::DownloadAsrModel,
                    &serde_json::to_vec(&value).expect("serialize invalid model"),
                ),
                Err(TerminalResultError::Invalid),
            );
        }
    }

    #[test]
    fn rust_registry_matches_the_canonical_terminal_contract() {
        let contract: Value = serde_json::from_str(include_str!(
            "../../../../contracts/desktop-worker-contract.json"
        ))
        .expect("parse desktop worker contract");
        let terminal = &contract["terminalResults"];

        assert_eq!(terminal["operations"], json!(TERMINAL_OPERATION_FAMILIES));
        assert_eq!(
            terminal["schemas"]["task"]["required"],
            json!(TASK_RESULT_FIELDS)
        );
        assert_eq!(
            terminal["schemas"]["task"]["properties"]["status"]["enum"],
            json!(TASK_TERMINAL_STATUSES)
        );
        let contract_artifacts = terminal["schemas"]["task"]["properties"]["artifacts"]
            ["properties"]
            .as_object()
            .expect("artifact properties")
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        assert_eq!(
            contract_artifacts,
            TASK_ARTIFACT_KEYS.iter().copied().collect::<BTreeSet<_>>()
        );
        let contract_insights = terminal["schemas"]["task"]["properties"]["insights"]["items"]
            ["properties"]
            .as_object()
            .expect("insight properties")
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        assert_eq!(
            contract_insights,
            TASK_INSIGHT_FIELDS.iter().copied().collect::<BTreeSet<_>>()
        );
    }

    fn valid_task_value() -> Value {
        json!({
            "status": "completed",
            "task_id": "safe-task",
            "task_dir": "C:/safe/tasks/safe-task",
            "artifacts": {
                "audio": "media/audio.wav",
                "transcript_txt": "transcript/transcript.txt"
            },
            "text": "transcript",
            "summary": "summary",
            "insights": [{
                "id": 1,
                "topic": "topic",
                "matchReason": "match",
                "followUpQuestions": ["next"],
                "suitableUse": "notes",
                "sourceChunkId": 2
            }],
            "transcript": {
                "source": "asr",
                "language": "zh",
                "engine": "SenseVoice"
            },
            "dissection": null,
            "error": null
        })
    }

    fn valid_dissection_value() -> Value {
        json!({
            "schemaVersion": 1,
            "sourceTranscriptSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "sourceLanguage": "zh-CN",
            "sourceChunks": [{
                "id": 1,
                "startByte": 0,
                "endByte": 6,
                "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            }],
            "overallNarrative": {
                "openingHook": "question",
                "structureType": "problem-solution",
                "turningPoint": null,
                "closingType": "call-to-action"
            },
            "segments": [{
                "id": 1,
                "title": "Opening",
                "sourceChunkIds": [1],
                "coreClaim": "A claim",
                "supportingPoints": ["Evidence"],
                "rhetoricalDevices": ["Question"],
                "rhythmNote": "Fast",
                "reusablePattern": "Question then answer",
                "riskFlags": []
            }],
            "highlights": ["Source quote"],
            "reusableTemplate": {
                "name": "Template",
                "skeleton": ["One", "Two", "Three"]
            },
            "audienceFit": [{
                "audience": "Beginners",
                "fit": "high",
                "note": "Accessible"
            }],
            "strengths": ["Clear"],
            "weaknesses": ["Brief"]
        })
    }

    fn valid_dissection_value_with_extra() -> Value {
        let mut value = valid_dissection_value();
        value["secret"] = json!("hidden");
        value
    }

    fn mutate_task(mutate: impl FnOnce(&mut Value)) -> Value {
        let mut value = valid_task_value();
        mutate(&mut value);
        value
    }

    fn task_with_dissection_source_status(status: &str) -> Value {
        let mut value = valid_task_value();
        value["dissection"] = valid_dissection_value();
        value["dissection_source_status"] = json!(status);
        value
    }

    #[test]
    fn task_result_accepts_optional_dissection_source_status() {
        // Worker stdout omits the field: parses as None (cache path not taken).
        let stdout = serde_json::to_vec(&valid_task_value()).expect("serialize worker stdout");
        let parsed = parse_terminal_result(WorkerOperation::ProcessLocalMedia, &stdout)
            .expect("worker stdout without dissection_source_status is valid");
        match parsed {
            ValidatedWorkerResult::Task(result) => {
                assert_eq!(result.dissection_source_status, None);
            }
            other => panic!("expected Task variant, got {:?}", other),
        }

        // Cache path propagates "stale".
        let stale = serde_json::to_vec(&task_with_dissection_source_status("stale"))
            .expect("serialize stale cache result");
        match parse_terminal_result(WorkerOperation::ProcessLocalMedia, &stale)
            .expect("stale dissection_source_status is valid")
        {
            ValidatedWorkerResult::Task(result) => {
                assert_eq!(
                    result.dissection_source_status,
                    Some(task_manifest::DissectionSourceStatus::Stale)
                );
            }
            other => panic!("expected Task variant, got {:?}", other),
        }

        // Cache path propagates "current".
        let current = serde_json::to_vec(&task_with_dissection_source_status("current"))
            .expect("serialize current cache result");
        match parse_terminal_result(WorkerOperation::ProcessLocalMedia, &current)
            .expect("current dissection_source_status is valid")
        {
            ValidatedWorkerResult::Task(result) => {
                assert_eq!(
                    result.dissection_source_status,
                    Some(task_manifest::DissectionSourceStatus::Current)
                );
            }
            other => panic!("expected Task variant, got {:?}", other),
        }
    }

    #[test]
    fn task_result_rejects_unknown_dissection_source_status() {
        let invalid = task_with_dissection_source_status("unknown");
        assert_eq!(
            parse_terminal_result(
                WorkerOperation::ProcessLocalMedia,
                &serde_json::to_vec(&invalid).expect("serialize invalid status"),
            ),
            Err(TerminalResultError::Invalid),
        );
    }
}
