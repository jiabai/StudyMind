use super::{WorkerOperation, WorkerRunError, WorkerRunErrorKind, WorkerTimeoutKind};
use crate::worker_runtime::supervisor::{
    terminate_process_tree, ProcessInstance, ProcessSupervisor, TimeoutRequestOutcome,
};
use crate::{append_desktop_log, RuntimePaths};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::worker_runtime) struct WatchdogPolicy {
    pub(super) idle_timeout: Option<Duration>,
    pub(super) absolute_timeout: Duration,
}

#[allow(dead_code)]
impl WatchdogPolicy {
    pub(in crate::worker_runtime) fn idle_timeout(self) -> Option<Duration> {
        self.idle_timeout
    }

    pub(in crate::worker_runtime) fn absolute_timeout(self) -> Duration {
        self.absolute_timeout
    }
}

impl WorkerOperation {
    #[allow(dead_code)]
    pub(in crate::worker_runtime) fn watchdog_policy(self) -> WatchdogPolicy {
        match self {
            Self::ProcessVideo | Self::ProcessLocalMedia => WatchdogPolicy {
                idle_timeout: Some(Duration::from_secs(45 * 60)),
                absolute_timeout: Duration::from_secs(8 * 60 * 60),
            },
            Self::RetryInsights => WatchdogPolicy {
                idle_timeout: Some(Duration::from_secs(30 * 60)),
                absolute_timeout: Duration::from_secs(90 * 60),
            },
            Self::ResolveSourceIdentity => WatchdogPolicy {
                idle_timeout: None,
                absolute_timeout: Duration::from_secs(3 * 60),
            },
            Self::DownloadAsrModel => WatchdogPolicy {
                idle_timeout: Some(Duration::from_secs(10 * 60)),
                absolute_timeout: Duration::from_secs(4 * 60 * 60),
            },
        }
    }
}

#[allow(dead_code)]
pub(super) fn select_watchdog_deadline(
    idle_deadline: Option<Instant>,
    absolute_deadline: Instant,
) -> (Instant, WorkerTimeoutKind) {
    match idle_deadline {
        Some(idle_deadline) if idle_deadline < absolute_deadline => {
            (idle_deadline, WorkerTimeoutKind::Idle)
        }
        _ => (absolute_deadline, WorkerTimeoutKind::Absolute),
    }
}

struct WatchdogTiming {
    stopped: bool,
    last_validated_progress: Instant,
}

pub(super) struct WatchdogControl {
    started_at: Instant,
    timing: Mutex<WatchdogTiming>,
    wake: Condvar,
}

impl WatchdogControl {
    pub(super) fn new() -> Self {
        let started_at = Instant::now();
        Self {
            started_at,
            timing: Mutex::new(WatchdogTiming {
                stopped: false,
                last_validated_progress: started_at,
            }),
            wake: Condvar::new(),
        }
    }

    pub(super) fn record_validated_progress(&self) {
        let mut timing = self
            .timing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !timing.stopped {
            timing.last_validated_progress = Instant::now();
            self.wake.notify_all();
        }
    }

    fn wait_for_expiration(&self, policy: WatchdogPolicy) -> Option<WorkerTimeoutKind> {
        let absolute_deadline = self.started_at + policy.absolute_timeout;
        let mut timing = self
            .timing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        loop {
            if timing.stopped {
                return None;
            }
            let idle_deadline = policy
                .idle_timeout
                .map(|timeout| timing.last_validated_progress + timeout);
            let (deadline, kind) = select_watchdog_deadline(idle_deadline, absolute_deadline);
            let now = Instant::now();
            if now >= deadline {
                return Some(kind);
            }
            let wait = deadline.saturating_duration_since(now);
            timing = self
                .wake
                .wait_timeout(timing, wait)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
    }

    fn wait_backoff_or_stop(&self, backoff: Duration) -> bool {
        let deadline = Instant::now() + backoff;
        let mut timing = self
            .timing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        loop {
            if timing.stopped {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            timing = self
                .wake
                .wait_timeout(timing, deadline.saturating_duration_since(now))
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
    }

    fn wait_until_stopped(&self) {
        let mut timing = self
            .timing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while !timing.stopped {
            timing = self
                .wake
                .wait(timing)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    pub(super) fn stop(&self) {
        let mut timing = self
            .timing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        timing.stopped = true;
        self.wake.notify_all();
    }
}

pub(super) struct WatchdogHandle {
    control: Arc<WatchdogControl>,
    thread: Option<JoinHandle<()>>,
}

impl WatchdogHandle {
    pub(super) fn activity(&self) -> Arc<WatchdogControl> {
        Arc::clone(&self.control)
    }

    pub(super) fn stop_and_join(mut self) {
        self.control.stop();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub(super) fn start_watchdog(
    paths: RuntimePaths,
    operation: WorkerOperation,
    supervisor: Arc<ProcessSupervisor>,
    instance: ProcessInstance,
    policy: WatchdogPolicy,
    retry_backoff: Duration,
    force_start_failure: bool,
) -> Result<WatchdogHandle, WorkerRunError> {
    let control = Arc::new(WatchdogControl::new());
    let thread_control = Arc::clone(&control);
    let builder = std::thread::Builder::new().name("StudyMind-worker-watchdog".to_string());
    if force_start_failure {
        return Err(WorkerRunError::new(
            WorkerRunErrorKind::WatchdogStartFailed,
            "Worker watchdog failed to start.",
        ));
    }
    let thread = builder
        .spawn(move || {
            run_watchdog_with_terminator(
                &paths,
                operation,
                &supervisor,
                instance,
                policy,
                retry_backoff,
                &thread_control,
                |claimed| terminate_process_tree(claimed.process_group_id.unwrap_or(claimed.pid)),
            );
        })
        .map_err(|_| {
            WorkerRunError::new(
                WorkerRunErrorKind::WatchdogStartFailed,
                "Worker watchdog failed to start.",
            )
        })?;
    Ok(WatchdogHandle {
        control,
        thread: Some(thread),
    })
}

pub(super) fn run_watchdog_with_terminator<F>(
    paths: &RuntimePaths,
    operation: WorkerOperation,
    supervisor: &ProcessSupervisor,
    instance: ProcessInstance,
    policy: WatchdogPolicy,
    retry_backoff: Duration,
    control: &WatchdogControl,
    terminate: F,
) where
    F: Fn(ProcessInstance) -> Result<(), String>,
{
    loop {
        let Some(kind) = control.wait_for_expiration(policy) else {
            return;
        };
        let outcome = supervisor.request_timeout(instance.instance_id, kind, &terminate);
        match outcome {
            TimeoutRequestOutcome::Signalled(_) => {
                control.wait_until_stopped();
                return;
            }
            TimeoutRequestOutcome::Failed { .. } => {
                let _ = append_desktop_log(
                    paths,
                    &operation.event("watchdog_signal_failed"),
                    &format!(
                        "operation={} timeout={} signal=failed",
                        operation.as_str(),
                        kind.as_str()
                    ),
                );
            }
            TimeoutRequestOutcome::AlreadyTerminating(_) => {}
            TimeoutRequestOutcome::NotRunning => return,
        }
        if control.wait_backoff_or_stop(retry_backoff) {
            return;
        }
    }
}
