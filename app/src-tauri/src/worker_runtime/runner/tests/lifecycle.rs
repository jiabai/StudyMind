use super::super::{
    ProgressRoute, ReaderJoinGate, RunnerHooks, WorkerLane, WorkerOperation, WorkerRunErrorKind,
    WorkerRunOutcome, WorkerRunRequest,
};
use super::fixtures::{fixture_request, terminal_fixture_request, test_paths, wait_until_active};
use crate::worker_runtime::command::WorkerCommandSpec;
use crate::worker_runtime::result_protocol::{TaskTerminalStatus, ValidatedWorkerResult};
use crate::worker_runtime::supervisor::CancelProcessStatus;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[test]
fn spawn_failure_is_typed_and_never_activates_the_lane() {
    let lane = WorkerLane::default();
    let paths = test_paths("spawn-failure");
    let request = WorkerRunRequest {
        operation: WorkerOperation::ProcessLocalMedia,
        command: WorkerCommandSpec {
            program: paths.user_data_dir.join("missing-worker-executable"),
            args: Vec::new(),
            stdin_payload: None,
            env: Vec::new(),
            env_remove: Vec::new(),
            current_dir: paths.user_data_dir.clone(),
        },
        progress: ProgressRoute::None,
    };

    let error = lane
        .run(&paths, request)
        .expect_err("missing executable must fail to spawn");

    assert_eq!(error.kind, WorkerRunErrorKind::SpawnFailed);
    assert!(!lane.is_active());
}

#[test]
fn missing_required_pipe_terminates_reaps_and_clears_the_lane() {
    const PROBE_ENV: &str = "STUDYMIND_RUNNER_MISSING_PIPE_PROBE";
    const TEST_NAME: &str = "worker_runtime::runner::tests::lifecycle::missing_required_pipe_terminates_reaps_and_clears_the_lane";
    if std::env::var_os(PROBE_ENV).is_some() {
        std::thread::sleep(Duration::from_secs(30));
        return;
    }

    let lane = WorkerLane::default();
    let paths = test_paths("missing-pipe");
    let error = lane
        .run_with_hooks(
            &paths,
            fixture_request(TEST_NAME, PROBE_ENV, None),
            RunnerHooks {
                force_missing_stderr: true,
                ..RunnerHooks::default()
            },
        )
        .expect_err("missing stderr must fail setup");

    assert_eq!(error.kind, WorkerRunErrorKind::PipeUnavailable);
    assert!(!lane.is_active());
}

#[test]
fn wait_failure_terminates_reaps_and_clears_the_lane() {
    const PROBE_ENV: &str = "STUDYMIND_RUNNER_WAIT_FAILURE_PROBE";
    const TEST_NAME: &str =
        "worker_runtime::runner::tests::lifecycle::wait_failure_terminates_reaps_and_clears_the_lane";
    if std::env::var_os(PROBE_ENV).is_some() {
        std::thread::sleep(Duration::from_secs(30));
        return;
    }

    let lane = WorkerLane::default();
    let paths = test_paths("wait-failure");
    let error = lane
        .run_with_hooks(
            &paths,
            fixture_request(TEST_NAME, PROBE_ENV, None),
            RunnerHooks {
                force_wait_failure: true,
                ..RunnerHooks::default()
            },
        )
        .expect_err("forced wait failure must be typed");

    assert_eq!(error.kind, WorkerRunErrorKind::WaitFailed);
    assert!(!lane.is_active());
}

#[test]
fn sensitive_request_is_delivered_only_through_stdin() {
    const SECRET: &str = "runner-review-secret";

    let lane = WorkerLane::default();
    let paths = test_paths("stdin-privacy");
    let payload = format!(r#"{{"url":"https://example.invalid/video?token={SECRET}"}}"#);
    let request = terminal_fixture_request(Some(payload), true);

    assert!(!request
        .command
        .args
        .iter()
        .any(|value| value.contains(SECRET)));
    assert!(!request
        .command
        .env
        .iter()
        .any(|(_, value)| value.contains(SECRET)));
    let outcome = lane
        .run(&paths, request)
        .expect("stdin privacy probe succeeds");
    let log = std::fs::read_to_string(crate::diagnostics::desktop_log_path(&paths))
        .expect("read runner log");

    assert!(matches!(
        outcome,
        WorkerRunOutcome::Structured(ValidatedWorkerResult::Task(value))
            if value.status == TaskTerminalStatus::Completed
    ));
    assert!(!log.contains(SECRET));
    assert!(!lane.is_active());
}

#[test]
fn stdin_delivery_failure_is_typed_sanitized_and_clears_the_lane() {
    const PROBE_ENV: &str = "STUDYMIND_RUNNER_STDIN_FAILURE_PROBE";
    const TEST_NAME: &str = "worker_runtime::runner::tests::lifecycle::stdin_delivery_failure_is_typed_sanitized_and_clears_the_lane";
    const SECRET: &str = "runner-review-secret";
    if std::env::var_os(PROBE_ENV).is_some() {
        return;
    }

    let lane = WorkerLane::default();
    let paths = test_paths("stdin-failure");
    let error = lane
        .run(
            &paths,
            fixture_request(TEST_NAME, PROBE_ENV, Some(SECRET.repeat(256 * 1024))),
        )
        .expect_err("closed child stdin must fail request delivery");
    let log = std::fs::read_to_string(crate::diagnostics::desktop_log_path(&paths))
        .expect("read runner log");

    assert_eq!(error.kind, WorkerRunErrorKind::RequestDeliveryFailed);
    assert_eq!(error.detail, "Worker request delivery failed.");
    assert!(!error.detail.contains(SECRET));
    assert!(!log.contains(SECRET));
    assert!(!lane.is_active());
}

#[test]
fn blocked_stdin_delivery_remains_cancellable() {
    const PROBE_ENV: &str = "STUDYMIND_RUNNER_BLOCKED_STDIN_PROBE";
    const TEST_NAME: &str =
        "worker_runtime::runner::tests::lifecycle::blocked_stdin_delivery_remains_cancellable";
    if std::env::var_os(PROBE_ENV).is_some() {
        std::thread::sleep(Duration::from_secs(30));
        return;
    }

    let lane = Arc::new(WorkerLane::default());
    let operation_lane = Arc::clone(&lane);
    let paths = test_paths("blocked-stdin");
    let operation_paths = paths.clone();
    let operation = std::thread::spawn(move || {
        operation_lane.run(
            &operation_paths,
            fixture_request(TEST_NAME, PROBE_ENV, Some("x".repeat(256 * 1024))),
        )
    });
    wait_until_active(&lane);

    let cancellation = lane.cancel();
    let outcome = operation
        .join()
        .expect("runner thread completes")
        .expect("cancellation is an outcome");

    assert_eq!(cancellation.status, CancelProcessStatus::Cancelling);
    assert_eq!(outcome, WorkerRunOutcome::Cancelled);
    assert!(!lane.is_active());
}

#[test]
fn terminal_observation_finishes_lane_before_stderr_reader_join() {
    let lane = Arc::new(WorkerLane::default());
    let gate = ReaderJoinGate::default();
    let operation_gate = gate.clone();
    let operation_lane = Arc::clone(&lane);
    let paths = test_paths("reader-gate");
    let operation_paths = paths.clone();
    let operation = std::thread::spawn(move || {
        operation_lane.run_with_hooks(
            &operation_paths,
            terminal_fixture_request(None, false),
            RunnerHooks {
                reader_join_gate: Some(operation_gate),
                ..RunnerHooks::default()
            },
        )
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    while !gate.waiting.load(Ordering::SeqCst) && Instant::now() < deadline {
        std::thread::yield_now();
    }

    assert!(gate.waiting.load(Ordering::SeqCst));
    let finish_deadline = Instant::now() + Duration::from_secs(5);
    while lane.is_active() && Instant::now() < finish_deadline {
        std::thread::yield_now();
    }
    assert!(!lane.is_active());
    assert_eq!(lane.cancel().status, CancelProcessStatus::NotRunning);
    gate.release.store(true, Ordering::SeqCst);
    assert!(matches!(
        operation
            .join()
            .expect("runner thread completes")
            .expect("structured fixture succeeds"),
        WorkerRunOutcome::Structured(ValidatedWorkerResult::Task(value))
            if value.status == TaskTerminalStatus::Completed
    ));
}

#[test]
fn stderr_reader_panic_keeps_terminal_outcome_and_uses_fixed_marker() {
    let lane = WorkerLane::default();
    let paths = test_paths("reader-panic");
    let outcome = lane
        .run_with_hooks(
            &paths,
            terminal_fixture_request(None, false),
            RunnerHooks {
                panic_stderr_reader: true,
                ..RunnerHooks::default()
            },
        )
        .expect("reader panic must not replace child outcome");
    let log = std::fs::read_to_string(crate::diagnostics::desktop_log_path(&paths))
        .expect("read runner log");

    assert!(matches!(
        outcome,
        WorkerRunOutcome::Structured(ValidatedWorkerResult::Task(value))
            if value.status == TaskTerminalStatus::Completed
    ));
    assert!(log.contains("stderr=reader_failed"));
}

#[test]
fn stdout_reader_panic_finishes_lane_and_returns_fixed_protocol_error() {
    let lane = WorkerLane::default();
    let paths = test_paths("stdout-reader-panic");
    let error = lane
        .run_with_hooks(
            &paths,
            terminal_fixture_request(None, false),
            RunnerHooks {
                panic_stdout_reader: true,
                ..RunnerHooks::default()
            },
        )
        .expect_err("stdout reader panic must remain a protocol error");

    assert_eq!(error.kind, WorkerRunErrorKind::ProtocolViolation);
    assert_eq!(error.detail, "Worker stdout reader failed.");
    assert!(!lane.is_active());
}
