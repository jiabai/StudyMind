use super::super::watchdog::{
    run_watchdog_with_terminator, select_watchdog_deadline, WatchdogControl,
};
use super::super::{
    ProgressRoute, RunnerHooks, WatchdogPolicy, WorkerLane, WorkerOperation, WorkerRunErrorKind,
    WorkerRunOutcome, WorkerTimeoutKind,
};
use super::fixtures::{
    endless_progress_fixture_script, fixture_process_is_alive, progress_then_result_fixture_script,
    result_then_stall_fixture_script, silent_fixture_script, terminal_fixture_request, test_paths,
    untrusted_spam_fixture_script, wait_for_numeric_fixture_pid,
    wait_until_fixture_process_is_gone, watchdog_fixture_request, watchdog_hooks,
    watchdog_tree_fixture_request,
};
use crate::worker_runtime::result_protocol::{TaskTerminalStatus, ValidatedWorkerResult};
use crate::worker_runtime::supervisor::ProcessPhase;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[test]
fn worker_operations_own_exact_closed_production_watchdog_policies() {
    let cases = [
        (
            WorkerOperation::ProcessLocalMedia,
            WatchdogPolicy {
                idle_timeout: Some(Duration::from_secs(45 * 60)),
                absolute_timeout: Duration::from_secs(8 * 60 * 60),
            },
        ),
        (
            WorkerOperation::RetryInsights,
            WatchdogPolicy {
                idle_timeout: Some(Duration::from_secs(30 * 60)),
                absolute_timeout: Duration::from_secs(90 * 60),
            },
        ),
        (
            WorkerOperation::DownloadAsrModel,
            WatchdogPolicy {
                idle_timeout: Some(Duration::from_secs(10 * 60)),
                absolute_timeout: Duration::from_secs(4 * 60 * 60),
            },
        ),
    ];

    for (operation, expected) in cases {
        assert_eq!(operation.watchdog_policy(), expected);
    }
}

#[test]
fn watchdog_deadline_selection_prefers_absolute_on_an_exact_tie() {
    let origin = Instant::now();
    let idle_first = origin + Duration::from_secs(1);
    let absolute_later = origin + Duration::from_secs(2);

    assert_eq!(
        select_watchdog_deadline(Some(idle_first), absolute_later),
        (idle_first, WorkerTimeoutKind::Idle)
    );
    assert_eq!(
        select_watchdog_deadline(Some(absolute_later), idle_first),
        (idle_first, WorkerTimeoutKind::Absolute)
    );
    assert_eq!(
        select_watchdog_deadline(Some(idle_first), idle_first),
        (idle_first, WorkerTimeoutKind::Absolute)
    );
    assert_eq!(
        select_watchdog_deadline(None, absolute_later),
        (absolute_later, WorkerTimeoutKind::Absolute)
    );
}

#[test]
fn failed_timeout_signal_rolls_back_logs_safely_and_retries_with_backoff() {
    const RAW_FAILURE: &str = "WATCHDOG_RAW_FAILURE_SENTINEL";
    let supervisor = Arc::new(crate::worker_runtime::supervisor::ProcessSupervisor::default());
    let instance = supervisor.start(404).expect("worker starts");
    let control = Arc::new(WatchdogControl::new());
    let attempts = Arc::new(AtomicUsize::new(0));
    let paths = test_paths("watchdog-signal-retry");
    let thread_supervisor = Arc::clone(&supervisor);
    let thread_control = Arc::clone(&control);
    let thread_attempts = Arc::clone(&attempts);
    let thread_paths = paths.clone();
    let watchdog = std::thread::spawn(move || {
        run_watchdog_with_terminator(
            &thread_paths,
            WorkerOperation::ProcessLocalMedia,
            &thread_supervisor,
            instance,
            WatchdogPolicy {
                idle_timeout: None,
                absolute_timeout: Duration::from_millis(5),
            },
            Duration::from_millis(15),
            &thread_control,
            |_| {
                thread_attempts.fetch_add(1, Ordering::SeqCst);
                Err(RAW_FAILURE.to_string())
            },
        );
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    while attempts.load(Ordering::SeqCst) < 3 && Instant::now() < deadline {
        std::thread::yield_now();
    }
    control.stop();
    watchdog.join().expect("watchdog exits after stop");

    assert!(attempts.load(Ordering::SeqCst) >= 3);
    assert_eq!(
        supervisor.phase_for(instance.instance_id),
        Some(ProcessPhase::Running)
    );
    let log = std::fs::read_to_string(crate::diagnostics::desktop_log_path(&paths))
        .expect("read watchdog log");
    assert!(log.contains("timeout=absolute signal=failed"));
    assert!(!log.contains(RAW_FAILURE));
    assert_eq!(
        supervisor.finish(instance.instance_id),
        Some(ProcessPhase::Running)
    );
}

#[test]
fn silent_fixture_hits_the_idle_deadline_and_clears_the_lane() {
    let lane = WorkerLane::default();
    let paths = test_paths("watchdog-silent-idle");

    let outcome = lane
        .run_with_hooks(
            &paths,
            watchdog_fixture_request(
                WorkerOperation::ProcessLocalMedia,
                ProgressRoute::Worker,
                silent_fixture_script(),
                None,
            ),
            watchdog_hooks(Some(1_500), 8_000),
        )
        .expect("silent worker is a timeout outcome");

    assert_eq!(outcome, WorkerRunOutcome::TimedOut(WorkerTimeoutKind::Idle));
    assert!(!lane.is_active());
    assert!(matches!(
        lane.run(&paths, terminal_fixture_request(None, false))
            .expect("timeout cleanup admits a second task"),
        WorkerRunOutcome::Structured(ValidatedWorkerResult::Task(value))
            if value.status == TaskTerminalStatus::Completed
    ));
    assert!(!lane.is_active());
}

#[test]
fn validated_progress_resets_idle_activity_until_normal_completion() {
    let lane = WorkerLane::default();
    let paths = test_paths("watchdog-valid-progress");

    let outcome = lane
        .run_with_hooks(
            &paths,
            watchdog_fixture_request(
                WorkerOperation::ProcessLocalMedia,
                ProgressRoute::Worker,
                progress_then_result_fixture_script(),
                None,
            ),
            watchdog_hooks(Some(1_500), 8_000),
        )
        .expect("validated progress keeps the idle deadline alive");

    assert!(matches!(
        outcome,
        WorkerRunOutcome::Structured(ValidatedWorkerResult::Task(value))
            if value.status == TaskTerminalStatus::Completed
    ));
    assert!(!lane.is_active());
}

#[test]
fn endless_validated_progress_cannot_extend_the_absolute_deadline() {
    let lane = WorkerLane::default();
    let paths = test_paths("watchdog-absolute");

    let outcome = lane
        .run_with_hooks(
            &paths,
            watchdog_fixture_request(
                WorkerOperation::ProcessLocalMedia,
                ProgressRoute::Worker,
                endless_progress_fixture_script(),
                None,
            ),
            watchdog_hooks(Some(1_500), 2_500),
        )
        .expect("absolute timeout is a typed outcome");

    assert_eq!(
        outcome,
        WorkerRunOutcome::TimedOut(WorkerTimeoutKind::Absolute)
    );
    assert!(!lane.is_active());
}

#[test]
fn malformed_diagnostic_empty_and_stdout_spam_do_not_reset_idle_activity() {
    let lane = WorkerLane::default();
    let paths = test_paths("watchdog-untrusted-spam");

    let outcome = lane
        .run_with_hooks(
            &paths,
            watchdog_fixture_request(
                WorkerOperation::ProcessLocalMedia,
                ProgressRoute::Worker,
                untrusted_spam_fixture_script(),
                None,
            ),
            watchdog_hooks(Some(1_500), 8_000),
        )
        .expect("untrusted output cannot keep the worker alive");

    assert_eq!(outcome, WorkerRunOutcome::TimedOut(WorkerTimeoutKind::Idle));
    assert!(!lane.is_active());
}

#[test]
fn watchdog_times_out_while_stdin_delivery_is_blocked() {
    let lane = WorkerLane::default();
    let paths = test_paths("watchdog-blocked-stdin");

    let outcome = lane
        .run_with_hooks(
            &paths,
            watchdog_fixture_request(
                WorkerOperation::ProcessLocalMedia,
                ProgressRoute::Worker,
                silent_fixture_script(),
                Some("x".repeat(4 * 1024 * 1024)),
            ),
            watchdog_hooks(Some(1_500), 8_000),
        )
        .expect("watchdog must act while stdin delivery blocks");

    assert_eq!(outcome, WorkerRunOutcome::TimedOut(WorkerTimeoutKind::Idle));
    assert!(!lane.is_active());
}

#[test]
fn watchdog_timeout_terminates_parent_and_descendant_then_admits_second_task() {
    let lane = Arc::new(WorkerLane::default());
    let paths = test_paths("watchdog-native-tree");
    let pid_file = paths.user_data_dir.join("descendant.pid");
    std::fs::create_dir_all(&paths.user_data_dir).expect("create fixture directory");

    let runner_lane = Arc::clone(&lane);
    let runner_paths = paths.clone();
    let runner_pid_file = pid_file.clone();
    let runner = std::thread::spawn(move || {
        runner_lane.run_with_hooks(
            &runner_paths,
            watchdog_tree_fixture_request(&runner_pid_file),
            watchdog_hooks(Some(4_000), 12_000),
        )
    });

    let descendant_pid = match wait_for_numeric_fixture_pid(&pid_file, Duration::from_secs(3)) {
        Some(pid) => pid,
        None => {
            let _ = runner.join();
            panic!("fixture descendant did not publish a numeric PID");
        }
    };
    assert!(fixture_process_is_alive(descendant_pid));
    assert!(lane.is_active());

    let outcome = runner
        .join()
        .expect("watchdog fixture runner joins")
        .expect("watchdog timeout is a typed outcome");
    assert_eq!(outcome, WorkerRunOutcome::TimedOut(WorkerTimeoutKind::Idle));
    assert!(!lane.is_active());
    wait_until_fixture_process_is_gone(descendant_pid);

    assert!(matches!(
        lane.run(&paths, terminal_fixture_request(None, false))
            .expect("joined watchdog admits a second task on the same lane"),
        WorkerRunOutcome::Structured(ValidatedWorkerResult::Task(value))
            if value.status == TaskTerminalStatus::Completed
    ));
    assert!(!lane.is_active());
}

#[test]
fn structured_result_written_before_timeout_remains_authoritative() {
    let lane = WorkerLane::default();
    let paths = test_paths("watchdog-structured-first");

    let outcome = lane
        .run_with_hooks(
            &paths,
            watchdog_fixture_request(
                WorkerOperation::ProcessLocalMedia,
                ProgressRoute::Worker,
                result_then_stall_fixture_script(),
                None,
            ),
            watchdog_hooks(Some(1_500), 8_000),
        )
        .expect("valid stdout wins a concurrent timeout claim");

    assert!(matches!(
        outcome,
        WorkerRunOutcome::Structured(ValidatedWorkerResult::Task(value))
            if value.status == TaskTerminalStatus::Completed
    ));
    assert!(!lane.is_active());
}

#[test]
fn watchdog_start_failure_reaps_clears_and_admits_a_second_task() {
    let lane = WorkerLane::default();
    let paths = test_paths("watchdog-start-failure");
    let error = lane
        .run_with_hooks(
            &paths,
            watchdog_fixture_request(
                WorkerOperation::ProcessLocalMedia,
                ProgressRoute::Worker,
                silent_fixture_script(),
                None,
            ),
            RunnerHooks {
                watchdog_policy: Some(WatchdogPolicy {
                    idle_timeout: Some(Duration::from_millis(1_500)),
                    absolute_timeout: Duration::from_millis(8_000),
                }),
                force_watchdog_start_failure: true,
                ..RunnerHooks::default()
            },
        )
        .expect_err("forced watchdog startup failure is typed");

    assert_eq!(error.kind, WorkerRunErrorKind::WatchdogStartFailed);
    assert_eq!(error.detail, "Worker watchdog failed to start.");
    assert!(!lane.is_active());

    assert!(matches!(
        lane.run(&paths, terminal_fixture_request(None, false))
            .expect("a second task starts only after cleanup"),
        WorkerRunOutcome::Structured(ValidatedWorkerResult::Task(value))
            if value.status == TaskTerminalStatus::Completed
    ));
    assert!(!lane.is_active());
}
