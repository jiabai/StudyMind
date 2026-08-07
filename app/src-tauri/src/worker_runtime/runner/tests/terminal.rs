use super::super::progress::StderrSummary;
use super::super::terminal::{classify_terminal, safe_exit_log_detail, safe_start_log_detail};
use super::super::{WorkerOperation, WorkerRunErrorKind, WorkerRunOutcome, WorkerTimeoutKind};
use super::fixtures::{exit_status, valid_task_stdout};
use crate::worker_runtime::command::WorkerCommandSpec;
use crate::worker_runtime::result_protocol::{TaskTerminalStatus, ValidatedWorkerResult};
use crate::worker_runtime::supervisor::ProcessPhase;
use std::path::PathBuf;
use std::process::Output;

#[test]
fn structured_result_wins_a_concurrent_cancellation_claim() {
    let output = Output {
        status: exit_status(1),
        stdout: valid_task_stdout().as_bytes().to_vec(),
        stderr: Vec::new(),
    };

    let outcome = classify_terminal(
        WorkerOperation::ProcessVideo,
        &output,
        Some(ProcessPhase::Cancelling),
        StderrSummary::default(),
    )
    .expect("structured result remains authoritative");

    assert!(matches!(
        outcome,
        WorkerRunOutcome::Structured(ValidatedWorkerResult::Task(value))
            if value.status == TaskTerminalStatus::Completed
    ));
}

#[test]
fn structured_result_wins_a_concurrent_timeout_claim() {
    let output = Output {
        status: exit_status(1),
        stdout: valid_task_stdout().as_bytes().to_vec(),
        stderr: Vec::new(),
    };

    let outcome = classify_terminal(
        WorkerOperation::ProcessVideo,
        &output,
        Some(ProcessPhase::TimingOut(WorkerTimeoutKind::Idle)),
        StderrSummary::default(),
    )
    .expect("structured result remains authoritative");

    assert!(matches!(
        outcome,
        WorkerRunOutcome::Structured(ValidatedWorkerResult::Task(value))
            if value.status == TaskTerminalStatus::Completed
    ));
}

#[test]
fn timeout_phase_is_classified_only_when_no_structured_result_exists() {
    let output = Output {
        status: exit_status(1),
        stdout: Vec::new(),
        stderr: Vec::new(),
    };

    assert_eq!(
        classify_terminal(
            WorkerOperation::ProcessVideo,
            &output,
            Some(ProcessPhase::TimingOut(WorkerTimeoutKind::Absolute)),
            StderrSummary::default(),
        ),
        Ok(WorkerRunOutcome::TimedOut(WorkerTimeoutKind::Absolute))
    );
}

#[test]
fn terminal_matrix_is_closed_and_deterministic() {
    let malformed_success = Output {
        status: exit_status(0),
        stdout: b"not-json".to_vec(),
        stderr: Vec::new(),
    };
    let malformed_failure = Output {
        status: exit_status(1),
        stdout: b"not-json".to_vec(),
        stderr: Vec::new(),
    };
    let missing_failure = Output {
        status: exit_status(1),
        stdout: Vec::new(),
        stderr: Vec::new(),
    };

    assert!(matches!(
        classify_terminal(
            WorkerOperation::ProcessVideo,
            &malformed_failure,
            Some(ProcessPhase::Cancelling),
            StderrSummary::default(),
        ),
        Ok(WorkerRunOutcome::Cancelled)
    ));
    assert!(matches!(
        classify_terminal(
            WorkerOperation::ProcessVideo,
            &malformed_success,
            Some(ProcessPhase::Running),
            StderrSummary::default(),
        ),
        Err(error) if error.kind == WorkerRunErrorKind::ProtocolViolation
    ));
    assert!(matches!(
        classify_terminal(
            WorkerOperation::ProcessVideo,
            &missing_failure,
            Some(ProcessPhase::Running),
            StderrSummary {
                had_diagnostic_output: true,
                reader_failed: false,
            },
        ),
        Ok(WorkerRunOutcome::UnstructuredFailure(summary))
            if summary.exit_code == Some(1) && summary.stderr == "present"
    ));
    assert!(matches!(
        classify_terminal(
            WorkerOperation::ProcessVideo,
            &malformed_failure,
            Some(ProcessPhase::Running),
            StderrSummary::default(),
        ),
        Err(error)
            if error.kind == WorkerRunErrorKind::ProtocolViolation
                && error.detail == "Worker result violated the terminal protocol."
    ));
}

#[test]
fn lifecycle_log_details_exclude_command_request_paths_and_worker_content() {
    let secret = "RUNNER_PRIVACY_SENTINEL";
    let spec = WorkerCommandSpec {
        program: PathBuf::from(format!("C:/private/{secret}/python.exe")),
        args: vec![format!("--prompt={secret}")],
        stdin_payload: Some(format!(r#"{{"transcript":"{secret}"}}"#)),
        env: vec![("STUDYMIND_LLM_SESSION_TOKEN".to_string(), secret.to_string())],
        env_remove: Vec::new(),
        current_dir: PathBuf::from(format!("C:/private/{secret}/data")),
    };
    let output = Output {
        status: exit_status(1),
        stdout: format!(r#"{{"generated_content":"{secret}"}}"#).into_bytes(),
        stderr: secret.as_bytes().to_vec(),
    };

    let start = safe_start_log_detail(WorkerOperation::ProcessVideo, &spec);
    let exit = safe_exit_log_detail(
        WorkerOperation::ProcessVideo,
        404,
        &output,
        StderrSummary {
            had_diagnostic_output: true,
            reader_failed: false,
        },
    );

    assert!(!start.contains(secret));
    assert!(!start.contains("private"));
    assert!(!start.contains("--prompt"));
    assert!(!exit.contains(secret));
    assert_eq!(
        exit,
        "operation=process_video pid=404 exit=1 stderr=present"
    );
}
