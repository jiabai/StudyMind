use crate::worker_runtime::{
    TaskTerminalResult, ValidatedWorkerResult, WorkerRunError, WorkerRunErrorKind,
    WorkerRunOutcome, WorkerTimeoutKind, WORKER_PROTOCOL_VIOLATION,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum TaskCommandContext {
    ProcessLocalMedia,
    RetryInsights,
}

struct TaskFailurePolicy {
    status: &'static str,
    stage: &'static str,
    unstructured_message: &'static str,
}

impl TaskCommandContext {
    fn failure_policy(self) -> TaskFailurePolicy {
        match self {
            Self::ProcessLocalMedia => TaskFailurePolicy {
                status: "failed",
                stage: "video_extracting",
                unstructured_message:
                    "Local media worker failed before returning a structured result.",
            },
            Self::RetryInsights => TaskFailurePolicy {
                status: "partial_completed",
                stage: "insights_generating",
                unstructured_message:
                    "AI generation worker failed before returning a structured result.",
            },
        }
    }
}

pub(super) fn map_task_worker_result(
    result: Result<WorkerRunOutcome, WorkerRunError>,
    context: TaskCommandContext,
) -> Result<TaskTerminalResult, String> {
    match result {
        Ok(WorkerRunOutcome::Structured(ValidatedWorkerResult::Task(value))) => Ok(value),
        Ok(WorkerRunOutcome::Structured(_)) => Ok(worker_protocol_failure_result(context)),
        Ok(WorkerRunOutcome::Cancelled) => Ok(worker_failure_result(
            context,
            "WORKER_CANCELLED",
            "Worker process was cancelled.",
        )),
        Ok(WorkerRunOutcome::TimedOut(kind)) => {
            let (code, message) = match kind {
                WorkerTimeoutKind::Idle => (
                    "WORKER_IDLE_TIMEOUT",
                    "Worker process made no progress for too long.",
                ),
                WorkerTimeoutKind::Absolute => (
                    "WORKER_EXECUTION_TIMEOUT",
                    "Worker process exceeded the maximum execution time.",
                ),
            };
            Ok(worker_failure_result(context, code, message))
        }
        Ok(WorkerRunOutcome::UnstructuredFailure(summary)) => {
            let policy = context.failure_policy();
            let message = match summary.exit_code {
                Some(code) => {
                    format!("{} exit code: {code}", policy.unstructured_message)
                }
                None => policy.unstructured_message.to_string(),
            };
            Ok(worker_failure_result(
                context,
                "WORKER_PROCESS_FAILED",
                message,
            ))
        }
        Err(error) => match error.kind {
            WorkerRunErrorKind::AlreadyRunning => Ok(worker_failure_result(
                context,
                "WORKER_ALREADY_RUNNING",
                "Another worker process is already running.",
            )),
            WorkerRunErrorKind::SpawnFailed
            | WorkerRunErrorKind::RequestDeliveryFailed
            | WorkerRunErrorKind::WatchdogStartFailed => Ok(worker_failure_result(
                context,
                "WORKER_REQUEST_TRANSPORT_FAILED",
                "Worker request could not be delivered.",
            )),
            WorkerRunErrorKind::ProtocolViolation => Ok(worker_protocol_failure_result(context)),
            WorkerRunErrorKind::PipeUnavailable | WorkerRunErrorKind::WaitFailed => {
                Err(error.detail.to_string())
            }
        },
    }
}

fn worker_failure_result(
    context: TaskCommandContext,
    code: &'static str,
    message: impl Into<String>,
) -> TaskTerminalResult {
    let policy = context.failure_policy();
    TaskTerminalResult::from_value(serde_json::json!({
        "status": policy.status,
        "task_id": null,
        "task_dir": null,
        "artifacts": {},
        "text": "",
        "summary": "",
        "insights": [],
        "transcript": null,
        "dissection": null,
        "error": {
            "code": code,
            "message": message.into(),
            "stage": policy.stage
        }
    }))
    .expect("trusted desktop task result must satisfy the terminal contract")
}

fn worker_protocol_failure_result(context: TaskCommandContext) -> TaskTerminalResult {
    worker_failure_result(context, WORKER_PROTOCOL_VIOLATION, "")
}

#[cfg(test)]
mod tests {
    use super::{map_task_worker_result, TaskCommandContext};
    use crate::worker_runtime::{
        ModelDownloadTerminalResult, TaskTerminalResult, ValidatedWorkerResult, WorkerExitSummary,
        WorkerRunError, WorkerRunErrorKind, WorkerRunOutcome, WorkerTimeoutKind,
    };

    fn task_value(result: &TaskTerminalResult) -> serde_json::Value {
        serde_json::to_value(result).expect("serialize closed task result")
    }

    fn completed_task_result() -> TaskTerminalResult {
        TaskTerminalResult::from_value(serde_json::json!({
            "status": "completed",
            "task_id": "task-1",
            "task_dir": "C:/StudyMind/task-1",
            "artifacts": {},
            "text": "private transcript",
            "summary": "private summary",
            "insights": [],
            "transcript": null,
            "dissection": null,
            "error": null
        }))
        .expect("valid task result")
    }

    #[test]
    fn structured_task_result_passes_through_unchanged() {
        let expected = completed_task_result();
        let actual = map_task_worker_result(
            Ok(WorkerRunOutcome::Structured(ValidatedWorkerResult::Task(
                expected.clone(),
            ))),
            TaskCommandContext::ProcessLocalMedia,
        )
        .expect("map task result");

        assert_eq!(actual, expected);
    }

    #[test]
    fn process_and_retry_contexts_keep_fixed_cancellation_and_unstructured_shapes() {
        for (context, status, stage, message) in [
            (
                TaskCommandContext::ProcessLocalMedia,
                "failed",
                "video_extracting",
                "Local media worker failed before returning a structured result.",
            ),
            (
                TaskCommandContext::RetryInsights,
                "partial_completed",
                "insights_generating",
                "AI generation worker failed before returning a structured result.",
            ),
        ] {
            let cancelled = map_task_worker_result(Ok(WorkerRunOutcome::Cancelled), context)
                .expect("map cancellation");
            let cancelled = task_value(&cancelled);
            assert_eq!(cancelled["status"], status);
            assert_eq!(cancelled["error"]["stage"], stage);
            assert_eq!(cancelled["error"]["code"], "WORKER_CANCELLED");

            let unstructured = map_task_worker_result(
                Ok(WorkerRunOutcome::UnstructuredFailure(WorkerExitSummary {
                    exit_code: Some(1),
                    stderr: "review-secret https://secret.example",
                })),
                context,
            )
            .expect("map unstructured failure");
            let unstructured = task_value(&unstructured);
            assert_eq!(unstructured["status"], status);
            assert_eq!(unstructured["error"]["stage"], stage);
            assert_eq!(unstructured["error"]["code"], "WORKER_PROCESS_FAILED");
            assert_eq!(
                unstructured["error"]["message"],
                format!("{message} exit code: 1")
            );
            assert!(!unstructured.to_string().contains("review-secret"));
            assert!(!unstructured.to_string().contains("https://"));
        }
    }

    #[test]
    fn process_and_retry_timeouts_keep_context_shape_and_closed_safe_codes() {
        for (context, status, stage) in [
            (
                TaskCommandContext::ProcessLocalMedia,
                "failed",
                "video_extracting",
            ),
            (
                TaskCommandContext::RetryInsights,
                "partial_completed",
                "insights_generating",
            ),
        ] {
            for (kind, code, message) in [
                (
                    WorkerTimeoutKind::Idle,
                    "WORKER_IDLE_TIMEOUT",
                    "Worker process made no progress for too long.",
                ),
                (
                    WorkerTimeoutKind::Absolute,
                    "WORKER_EXECUTION_TIMEOUT",
                    "Worker process exceeded the maximum execution time.",
                ),
            ] {
                let result = map_task_worker_result(Ok(WorkerRunOutcome::TimedOut(kind)), context)
                    .expect("map timeout");
                let result = task_value(&result);

                assert_eq!(result["status"], status);
                assert_eq!(result["error"]["stage"], stage);
                assert_eq!(result["error"]["code"], code);
                assert_eq!(result["error"]["message"], message);
                assert!(!result.to_string().contains("https://"));
            }
        }
    }

    #[test]
    fn mismatched_family_and_runtime_failures_use_fixed_safe_task_errors() {
        let mismatched = map_task_worker_result(
            Ok(WorkerRunOutcome::Structured(
                ValidatedWorkerResult::ModelDownload(ModelDownloadTerminalResult::Completed {
                    model: "iic/SenseVoiceSmall".to_string(),
                }),
            )),
            TaskCommandContext::ProcessLocalMedia,
        )
        .expect("map mismatched family");
        let mismatched = task_value(&mismatched);
        assert_eq!(mismatched["error"]["code"], "WORKER_PROTOCOL_VIOLATION");
        assert_eq!(mismatched["error"]["message"], "");

        for (kind, expected_code) in [
            (WorkerRunErrorKind::AlreadyRunning, "WORKER_ALREADY_RUNNING"),
            (
                WorkerRunErrorKind::SpawnFailed,
                "WORKER_REQUEST_TRANSPORT_FAILED",
            ),
            (
                WorkerRunErrorKind::RequestDeliveryFailed,
                "WORKER_REQUEST_TRANSPORT_FAILED",
            ),
            (
                WorkerRunErrorKind::WatchdogStartFailed,
                "WORKER_REQUEST_TRANSPORT_FAILED",
            ),
            (
                WorkerRunErrorKind::ProtocolViolation,
                "WORKER_PROTOCOL_VIOLATION",
            ),
        ] {
            let result = map_task_worker_result(
                Err(WorkerRunError {
                    kind,
                    detail: "review-secret https://secret.example",
                }),
                TaskCommandContext::ProcessLocalMedia,
            )
            .expect("map runtime error");
            let result = task_value(&result);
            assert_eq!(result["error"]["code"], expected_code);
            assert!(!result.to_string().contains("review-secret"));
            assert!(!result.to_string().contains("https://"));
        }
    }

    #[test]
    fn pipe_and_wait_failures_preserve_fixed_command_errors() {
        for (kind, detail) in [
            (WorkerRunErrorKind::PipeUnavailable, "fixed pipe failure"),
            (WorkerRunErrorKind::WaitFailed, "fixed wait failure"),
        ] {
            let error = map_task_worker_result(
                Err(WorkerRunError { kind, detail }),
                TaskCommandContext::RetryInsights,
            )
            .expect_err("pipe/wait failures remain command errors");

            assert_eq!(error, detail);
        }
    }
}
