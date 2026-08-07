mod process_io;
mod progress;
mod terminal;
mod watchdog;

use process_io::{
    cleanup_registered_child, deliver_worker_stdin, read_worker_stdout, spawn_worker_process,
    terminate_and_reap,
};
pub(crate) use progress::ProgressRoute;
use progress::{read_stderr, StderrSummary};
pub(crate) use terminal::WorkerExitSummary;
use terminal::{classify_terminal, safe_exit_log_detail, safe_start_log_detail};
use watchdog::start_watchdog;
pub(super) use watchdog::WatchdogPolicy;

use super::command::WorkerCommandSpec;
use super::result_protocol::{ValidatedWorkerResult, WORKER_PROTOCOL_MESSAGE};
use super::supervisor::{
    request_process_cancellation, CancelProcessResult, ProcessInstance, ProcessPhase,
    ProcessSupervisor,
};
use crate::{append_desktop_log, RuntimePaths};
use std::process::Output;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorkerOperation {
    ProcessVideo,
    ProcessLocalMedia,
    RetryInsights,
    ResolveSourceIdentity,
    DownloadAsrModel,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorkerTimeoutKind {
    Idle,
    Absolute,
}

impl WorkerTimeoutKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Absolute => "absolute",
        }
    }
}

impl WorkerOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::ProcessVideo => "process_video",
            Self::ProcessLocalMedia => "process_local_media",
            Self::RetryInsights => "retry_insights",
            Self::ResolveSourceIdentity => "resolve_source_identity",
            Self::DownloadAsrModel => "download_asr_model",
        }
    }

    fn event(self, phase: &str) -> String {
        format!("worker.{}.{}", self.as_str(), phase)
    }
}

pub(in crate::worker_runtime) struct WorkerRunRequest {
    pub(in crate::worker_runtime) operation: WorkerOperation,
    pub(in crate::worker_runtime) command: WorkerCommandSpec,
    pub(in crate::worker_runtime) progress: ProgressRoute,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorkerRunErrorKind {
    AlreadyRunning,
    SpawnFailed,
    WatchdogStartFailed,
    RequestDeliveryFailed,
    PipeUnavailable,
    WaitFailed,
    ProtocolViolation,
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct WorkerRunError {
    pub(crate) kind: WorkerRunErrorKind,
    pub(crate) detail: &'static str,
}

impl WorkerRunError {
    fn new(kind: WorkerRunErrorKind, detail: &'static str) -> Self {
        Self { kind, detail }
    }

    fn protocol_violation() -> Self {
        Self::new(
            WorkerRunErrorKind::ProtocolViolation,
            WORKER_PROTOCOL_MESSAGE,
        )
    }
}

#[derive(Debug, PartialEq)]
pub(crate) enum WorkerRunOutcome {
    Structured(ValidatedWorkerResult),
    Cancelled,
    TimedOut(WorkerTimeoutKind),
    UnstructuredFailure(WorkerExitSummary),
}

#[derive(Default)]
pub(crate) struct WorkerLane {
    supervisor: Arc<ProcessSupervisor>,
}

impl WorkerLane {
    pub(crate) fn run(
        &self,
        paths: &RuntimePaths,
        request: WorkerRunRequest,
    ) -> Result<WorkerRunOutcome, WorkerRunError> {
        self.run_inner(paths, request, RunnerHooks::default())
    }

    pub(crate) fn cancel(&self) -> CancelProcessResult {
        request_process_cancellation(&self.supervisor)
    }

    pub(crate) fn is_active(&self) -> bool {
        self.supervisor.is_active()
    }

    #[cfg(test)]
    pub(crate) fn activate_for_test(&self, pid: u32) -> u64 {
        self.supervisor
            .start(pid)
            .expect("test worker lane must be idle")
            .instance_id
    }

    #[cfg(test)]
    pub(crate) fn finish_for_test(&self, instance_id: u64) {
        self.supervisor.finish(instance_id);
    }

    #[cfg(test)]
    fn run_with_hooks(
        &self,
        paths: &RuntimePaths,
        request: WorkerRunRequest,
        hooks: RunnerHooks,
    ) -> Result<WorkerRunOutcome, WorkerRunError> {
        self.run_inner(paths, request, hooks)
    }

    fn run_inner(
        &self,
        paths: &RuntimePaths,
        request: WorkerRunRequest,
        hooks: RunnerHooks,
    ) -> Result<WorkerRunOutcome, WorkerRunError> {
        let WorkerRunRequest {
            operation,
            command,
            progress,
        } = request;
        let _ = append_desktop_log(
            paths,
            &operation.event("start"),
            &safe_start_log_detail(operation, &command),
        );

        let (mut child, stdin_payload) = spawn_worker_process(command).map_err(|_| {
            WorkerRunError::new(
                WorkerRunErrorKind::SpawnFailed,
                "Worker process failed to start.",
            )
        })?;
        let Some(instance) = self.supervisor.start(child.id()) else {
            let pid = child.id();
            terminate_and_reap(&mut child, pid);
            return Err(WorkerRunError::new(
                WorkerRunErrorKind::AlreadyRunning,
                "Another worker operation is already running.",
            ));
        };
        let mut instance_guard = InstanceGuard::new(self.supervisor.as_ref(), instance);
        let watchdog = match start_watchdog(
            paths.clone(),
            operation,
            Arc::clone(&self.supervisor),
            instance,
            hooks.watchdog_policy(operation),
            hooks.watchdog_retry_backoff(),
            hooks.force_watchdog_start_failure(),
        ) {
            Ok(watchdog) => watchdog,
            Err(error) => {
                cleanup_registered_child(&mut child, self.supervisor.as_ref(), instance);
                instance_guard.finish();
                return Err(error);
            }
        };

        if deliver_worker_stdin(&mut child, stdin_payload).is_err() {
            watchdog.stop_and_join();
            cleanup_registered_child(&mut child, self.supervisor.as_ref(), instance);
            let phase = instance_guard.finish();
            if phase == Some(ProcessPhase::Cancelling) {
                return Ok(WorkerRunOutcome::Cancelled);
            }
            if let Some(ProcessPhase::TimingOut(kind)) = phase {
                return Ok(WorkerRunOutcome::TimedOut(kind));
            }
            return Err(WorkerRunError::new(
                WorkerRunErrorKind::RequestDeliveryFailed,
                "Worker request delivery failed.",
            ));
        }

        if hooks.force_missing_stderr {
            drop(child.stderr.take());
        }
        let Some(stdout) = child.stdout.take() else {
            watchdog.stop_and_join();
            cleanup_registered_child(&mut child, self.supervisor.as_ref(), instance);
            instance_guard.finish();
            return Err(WorkerRunError::new(
                WorkerRunErrorKind::PipeUnavailable,
                "Worker stdout pipe was unavailable.",
            ));
        };
        let Some(stderr) = child.stderr.take() else {
            watchdog.stop_and_join();
            cleanup_registered_child(&mut child, self.supervisor.as_ref(), instance);
            instance_guard.finish();
            return Err(WorkerRunError::new(
                WorkerRunErrorKind::PipeUnavailable,
                "Worker stderr pipe was unavailable.",
            ));
        };

        let panic_stdout_reader = hooks.panic_stdout_reader;
        let stdout_reader = std::thread::spawn(move || {
            if panic_stdout_reader {
                panic!("forced stdout reader failure");
            }
            read_worker_stdout(stdout)
        });
        let progress_paths = paths.clone();
        let reader_hooks = hooks.clone();
        let watchdog_activity = watchdog.activity();
        let stderr_reader = std::thread::spawn(move || {
            read_stderr(
                stderr,
                progress,
                progress_paths,
                reader_hooks,
                watchdog_activity,
            )
        });

        if hooks.force_wait_failure {
            watchdog.stop_and_join();
            cleanup_registered_child(&mut child, self.supervisor.as_ref(), instance);
            instance_guard.finish();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(WorkerRunError::new(
                WorkerRunErrorKind::WaitFailed,
                "Worker process wait failed.",
            ));
        }

        let status = match child.wait() {
            Ok(status) => status,
            Err(_) => {
                watchdog.stop_and_join();
                cleanup_registered_child(&mut child, self.supervisor.as_ref(), instance);
                instance_guard.finish();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(WorkerRunError::new(
                    WorkerRunErrorKind::WaitFailed,
                    "Worker process wait failed.",
                ));
            }
        };
        watchdog.stop_and_join();
        let terminal_phase = instance_guard.finish();
        let stdout = stdout_reader
            .join()
            .ok()
            .and_then(Result::ok)
            .ok_or_else(|| {
                WorkerRunError::new(
                    WorkerRunErrorKind::ProtocolViolation,
                    "Worker stdout reader failed.",
                )
            })?;
        let stderr = stderr_reader.join().unwrap_or(StderrSummary {
            had_diagnostic_output: false,
            reader_failed: true,
        });
        let output = Output {
            status,
            stdout,
            stderr: Vec::new(),
        };
        let _ = append_desktop_log(
            paths,
            &operation.event("exit"),
            &safe_exit_log_detail(operation, instance.pid, &output, stderr),
        );

        let outcome = classify_terminal(operation, &output, terminal_phase, stderr)?;
        let terminal = match &outcome {
            WorkerRunOutcome::Structured(_) => "structured",
            WorkerRunOutcome::Cancelled => "cancelled",
            WorkerRunOutcome::TimedOut(WorkerTimeoutKind::Idle) => "idle_timeout",
            WorkerRunOutcome::TimedOut(WorkerTimeoutKind::Absolute) => "absolute_timeout",
            WorkerRunOutcome::UnstructuredFailure(_) => "unstructured_failure",
        };
        let _ = append_desktop_log(
            paths,
            &operation.event("result"),
            &format!("operation={} outcome={terminal}", operation.as_str()),
        );
        Ok(outcome)
    }
}

struct InstanceGuard<'a> {
    supervisor: &'a ProcessSupervisor,
    instance_id: u64,
    finished: bool,
}

impl<'a> InstanceGuard<'a> {
    fn new(supervisor: &'a ProcessSupervisor, instance: ProcessInstance) -> Self {
        Self {
            supervisor,
            instance_id: instance.instance_id,
            finished: false,
        }
    }

    fn finish(&mut self) -> Option<ProcessPhase> {
        if self.finished {
            return None;
        }
        self.finished = true;
        self.supervisor.finish(self.instance_id)
    }
}

impl Drop for InstanceGuard<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.supervisor.finish(self.instance_id);
            self.finished = true;
        }
    }
}

#[derive(Clone, Default)]
struct RunnerHooks {
    force_missing_stderr: bool,
    force_wait_failure: bool,
    panic_stdout_reader: bool,
    panic_stderr_reader: bool,
    reader_join_gate: Option<ReaderJoinGate>,
    #[cfg(test)]
    watchdog_policy: Option<WatchdogPolicy>,
    #[cfg(test)]
    watchdog_retry_backoff: Option<Duration>,
    #[cfg(test)]
    force_watchdog_start_failure: bool,
}

impl RunnerHooks {
    fn watchdog_policy(&self, operation: WorkerOperation) -> WatchdogPolicy {
        #[cfg(test)]
        if let Some(policy) = self.watchdog_policy {
            return policy;
        }
        operation.watchdog_policy()
    }

    fn watchdog_retry_backoff(&self) -> Duration {
        #[cfg(test)]
        if let Some(backoff) = self.watchdog_retry_backoff {
            return backoff;
        }
        Duration::from_secs(1)
    }

    fn force_watchdog_start_failure(&self) -> bool {
        #[cfg(test)]
        {
            return self.force_watchdog_start_failure;
        }
        #[cfg(not(test))]
        false
    }
}

#[derive(Clone, Default)]
struct ReaderJoinGate {
    waiting: Arc<AtomicBool>,
    release: Arc<AtomicBool>,
}

#[cfg(test)]
mod tests;
