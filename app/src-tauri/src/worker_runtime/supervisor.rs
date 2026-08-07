use super::WorkerTimeoutKind;
use serde::Serialize;
use std::process::{Command, Output};
use std::sync::{Condvar, Mutex};
#[cfg(unix)]
use std::time::Duration;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const WINDOWS_CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
fn windows_subprocess_creation_flags() -> u32 {
    WINDOWS_CREATE_NO_WINDOW
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ProcessPhase {
    Running,
    Cancelling,
    CleaningUp,
    #[allow(dead_code)]
    TimingOut(WorkerTimeoutKind),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct ProcessInstance {
    pub(super) instance_id: u64,
    pub(super) pid: u32,
    pub(super) process_group_id: Option<u32>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum CancelClaim {
    Claimed(ProcessInstance),
    AlreadyCancelling(ProcessInstance),
    NotRunning,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum CancelRequestOutcome {
    Signalled(ProcessInstance),
    AlreadyCancelling(ProcessInstance),
    NotRunning,
    Failed {
        instance: ProcessInstance,
        error: String,
    },
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum TimeoutClaim {
    Claimed(ProcessInstance),
    AlreadyTerminating(ProcessInstance),
    NotRunning,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum TimeoutRequestOutcome {
    Signalled(ProcessInstance),
    AlreadyTerminating(ProcessInstance),
    NotRunning,
    Failed {
        instance: ProcessInstance,
        error: String,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum CleanupClaim {
    Claimed(ProcessInstance),
    AlreadyTerminating(ProcessInstance),
    NotRunning,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum CancelProcessStatus {
    Cancelling,
    AlreadyCancelling,
    NotRunning,
    Failed,
}

#[derive(Debug, Serialize)]
pub(crate) struct CancelProcessResult {
    pub(super) status: CancelProcessStatus,
    pub(super) error: Option<String>,
}

#[derive(Default)]
pub(super) struct ProcessSupervisor {
    state: Mutex<ProcessSupervisorState>,
    termination_finished: Condvar,
}

#[derive(Default)]
struct ProcessSupervisorState {
    next_instance_id: u64,
    current: Option<(ProcessInstance, ProcessPhase)>,
    termination_in_flight: Option<TerminationLease>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TerminationLease {
    Cancellation {
        instance_id: u64,
    },
    Timeout {
        instance_id: u64,
        kind: WorkerTimeoutKind,
    },
}

impl TerminationLease {
    fn instance_id(self) -> u64 {
        match self {
            Self::Cancellation { instance_id } | Self::Timeout { instance_id, .. } => instance_id,
        }
    }

    fn phase(self) -> ProcessPhase {
        match self {
            Self::Cancellation { .. } => ProcessPhase::Cancelling,
            Self::Timeout { kind, .. } => ProcessPhase::TimingOut(kind),
        }
    }
}

impl ProcessSupervisor {
    pub(super) fn is_active(&self) -> bool {
        self.state
            .lock()
            .expect("process supervisor lock poisoned")
            .current
            .is_some()
    }

    pub(super) fn start(&self, pid: u32) -> Option<ProcessInstance> {
        let mut state = self.state.lock().expect("process supervisor lock poisoned");
        if state.current.is_some() || state.termination_in_flight.is_some() {
            return None;
        }

        state.next_instance_id += 1;
        let instance = ProcessInstance {
            instance_id: state.next_instance_id,
            pid,
            process_group_id: cfg!(unix).then_some(pid),
        };
        state.current = Some((instance, ProcessPhase::Running));
        Some(instance)
    }

    #[cfg(test)]
    fn current(&self) -> Option<ProcessInstance> {
        self.state
            .lock()
            .expect("process supervisor lock poisoned")
            .current
            .map(|(instance, _)| instance)
    }

    #[cfg(test)]
    fn phase(&self) -> Option<ProcessPhase> {
        self.state
            .lock()
            .expect("process supervisor lock poisoned")
            .current
            .map(|(_, phase)| phase)
    }

    #[cfg(test)]
    pub(super) fn phase_for(&self, instance_id: u64) -> Option<ProcessPhase> {
        self.state
            .lock()
            .expect("process supervisor lock poisoned")
            .current
            .and_then(|(instance, phase)| (instance.instance_id == instance_id).then_some(phase))
    }

    #[cfg(test)]
    fn claim_cancel(&self) -> CancelClaim {
        let mut state = self.state.lock().expect("process supervisor lock poisoned");
        Self::claim_cancel_locked(&mut state, false)
    }

    fn claim_cancel_termination(&self) -> CancelClaim {
        let mut state = self.state.lock().expect("process supervisor lock poisoned");
        Self::claim_cancel_locked(&mut state, true)
    }

    fn claim_cancel_locked(
        state: &mut ProcessSupervisorState,
        lease_termination: bool,
    ) -> CancelClaim {
        match state.current.as_mut() {
            Some((instance, phase @ ProcessPhase::Running)) => {
                *phase = ProcessPhase::Cancelling;
                if lease_termination {
                    debug_assert!(state.termination_in_flight.is_none());
                    state.termination_in_flight = Some(TerminationLease::Cancellation {
                        instance_id: instance.instance_id,
                    });
                }
                CancelClaim::Claimed(*instance)
            }
            Some((
                instance,
                ProcessPhase::Cancelling | ProcessPhase::CleaningUp | ProcessPhase::TimingOut(_),
            )) => CancelClaim::AlreadyCancelling(*instance),
            None => CancelClaim::NotRunning,
        }
    }

    #[allow(dead_code)]
    pub(super) fn claim_timeout(&self, instance_id: u64, kind: WorkerTimeoutKind) -> TimeoutClaim {
        let mut state = self.state.lock().expect("process supervisor lock poisoned");
        Self::claim_timeout_locked(&mut state, instance_id, kind, false)
    }

    fn claim_timeout_termination(&self, instance_id: u64, kind: WorkerTimeoutKind) -> TimeoutClaim {
        let mut state = self.state.lock().expect("process supervisor lock poisoned");
        Self::claim_timeout_locked(&mut state, instance_id, kind, true)
    }

    fn claim_timeout_locked(
        state: &mut ProcessSupervisorState,
        instance_id: u64,
        kind: WorkerTimeoutKind,
        lease_termination: bool,
    ) -> TimeoutClaim {
        match state.current.as_mut() {
            Some((instance, _)) if instance.instance_id != instance_id => TimeoutClaim::NotRunning,
            Some((instance, phase @ ProcessPhase::Running)) => {
                *phase = ProcessPhase::TimingOut(kind);
                if lease_termination {
                    debug_assert!(state.termination_in_flight.is_none());
                    state.termination_in_flight = Some(TerminationLease::Timeout {
                        instance_id: instance.instance_id,
                        kind,
                    });
                }
                TimeoutClaim::Claimed(*instance)
            }
            Some((
                instance,
                ProcessPhase::Cancelling | ProcessPhase::CleaningUp | ProcessPhase::TimingOut(_),
            )) => TimeoutClaim::AlreadyTerminating(*instance),
            None => TimeoutClaim::NotRunning,
        }
    }

    #[cfg(test)]
    fn restore_running(&self, instance_id: u64) -> bool {
        let mut state = self.state.lock().expect("process supervisor lock poisoned");
        if state.termination_in_flight.is_some() {
            return false;
        }
        match state.current.as_mut() {
            Some((instance, phase @ ProcessPhase::Cancelling))
                if instance.instance_id == instance_id =>
            {
                *phase = ProcessPhase::Running;
                true
            }
            _ => false,
        }
    }

    #[allow(dead_code)]
    pub(super) fn restore_running_after_timeout(
        &self,
        instance_id: u64,
        kind: WorkerTimeoutKind,
    ) -> bool {
        let mut state = self.state.lock().expect("process supervisor lock poisoned");
        if state.termination_in_flight.is_some() {
            return false;
        }
        match state.current.as_mut() {
            Some((instance, phase))
                if instance.instance_id == instance_id
                    && *phase == ProcessPhase::TimingOut(kind) =>
            {
                *phase = ProcessPhase::Running;
                true
            }
            _ => false,
        }
    }

    pub(super) fn claim_cleanup(&self, instance_id: u64) -> CleanupClaim {
        let mut state = self.state.lock().expect("process supervisor lock poisoned");
        match state.current.as_mut() {
            Some((instance, _)) if instance.instance_id != instance_id => CleanupClaim::NotRunning,
            Some((instance, phase @ ProcessPhase::Running)) => {
                *phase = ProcessPhase::CleaningUp;
                CleanupClaim::Claimed(*instance)
            }
            Some((
                instance,
                ProcessPhase::Cancelling | ProcessPhase::CleaningUp | ProcessPhase::TimingOut(_),
            )) => CleanupClaim::AlreadyTerminating(*instance),
            None => CleanupClaim::NotRunning,
        }
    }

    pub(super) fn finish(&self, instance_id: u64) -> Option<ProcessPhase> {
        let mut state = self.state.lock().expect("process supervisor lock poisoned");
        loop {
            let (instance, phase) = state.current?;
            if instance.instance_id != instance_id {
                return None;
            }
            if state
                .termination_in_flight
                .is_some_and(|lease| lease.instance_id() == instance_id)
            {
                state = self
                    .termination_finished
                    .wait(state)
                    .expect("process supervisor lock poisoned");
                continue;
            }
            state.current = None;
            return Some(phase);
        }
    }

    fn complete_termination(&self, lease: TerminationLease, succeeded: bool) -> bool {
        let mut state = self.state.lock().expect("process supervisor lock poisoned");
        if state.termination_in_flight != Some(lease) {
            return false;
        }
        let Some((instance, phase)) = state.current else {
            return false;
        };
        if instance.instance_id != lease.instance_id() || phase != lease.phase() {
            return false;
        }

        if !succeeded {
            state.current = Some((instance, ProcessPhase::Running));
        }
        state.termination_in_flight = None;
        self.termination_finished.notify_all();
        true
    }

    fn request_cancel<F>(&self, terminate: F) -> CancelRequestOutcome
    where
        F: FnOnce(ProcessInstance) -> Result<(), String>,
    {
        match self.claim_cancel_termination() {
            CancelClaim::Claimed(instance) => {
                let result = terminate(instance);
                let completed = self.complete_termination(
                    TerminationLease::Cancellation {
                        instance_id: instance.instance_id,
                    },
                    result.is_ok(),
                );
                debug_assert!(completed);
                match result {
                    Ok(()) => CancelRequestOutcome::Signalled(instance),
                    Err(error) => CancelRequestOutcome::Failed { instance, error },
                }
            }
            CancelClaim::AlreadyCancelling(instance) => {
                CancelRequestOutcome::AlreadyCancelling(instance)
            }
            CancelClaim::NotRunning => CancelRequestOutcome::NotRunning,
        }
    }

    #[allow(dead_code)]
    pub(super) fn request_timeout<F>(
        &self,
        instance_id: u64,
        kind: WorkerTimeoutKind,
        terminate: F,
    ) -> TimeoutRequestOutcome
    where
        F: FnOnce(ProcessInstance) -> Result<(), String>,
    {
        match self.claim_timeout_termination(instance_id, kind) {
            TimeoutClaim::Claimed(instance) => {
                let result = terminate(instance);
                let completed = self.complete_termination(
                    TerminationLease::Timeout {
                        instance_id: instance.instance_id,
                        kind,
                    },
                    result.is_ok(),
                );
                debug_assert!(completed);
                match result {
                    Ok(()) => TimeoutRequestOutcome::Signalled(instance),
                    Err(error) => TimeoutRequestOutcome::Failed { instance, error },
                }
            }
            TimeoutClaim::AlreadyTerminating(instance) => {
                TimeoutRequestOutcome::AlreadyTerminating(instance)
            }
            TimeoutClaim::NotRunning => TimeoutRequestOutcome::NotRunning,
        }
    }
}

pub(super) fn request_process_cancellation(supervisor: &ProcessSupervisor) -> CancelProcessResult {
    match supervisor.request_cancel(|instance| {
        terminate_process_tree(instance.process_group_id.unwrap_or(instance.pid))
    }) {
        CancelRequestOutcome::Signalled(_) => CancelProcessResult {
            status: CancelProcessStatus::Cancelling,
            error: None,
        },
        CancelRequestOutcome::AlreadyCancelling(_) => CancelProcessResult {
            status: CancelProcessStatus::AlreadyCancelling,
            error: None,
        },
        CancelRequestOutcome::NotRunning => CancelProcessResult {
            status: CancelProcessStatus::NotRunning,
            error: None,
        },
        CancelRequestOutcome::Failed { error, .. } => CancelProcessResult {
            status: CancelProcessStatus::Failed,
            error: Some(error),
        },
    }
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProcessPlatform {
    Windows,
    Unix,
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProcessSignal {
    Term,
    Kill,
}

fn termination_command_spec(
    platform: ProcessPlatform,
    pid: u32,
    signal: ProcessSignal,
) -> (String, Vec<String>) {
    match platform {
        ProcessPlatform::Windows => (
            "taskkill".to_string(),
            vec![
                "/PID".to_string(),
                pid.to_string(),
                "/T".to_string(),
                "/F".to_string(),
            ],
        ),
        ProcessPlatform::Unix => (
            "kill".to_string(),
            vec![
                match signal {
                    ProcessSignal::Term => "-TERM".to_string(),
                    ProcessSignal::Kill => "-KILL".to_string(),
                },
                "--".to_string(),
                format!("-{pid}"),
            ],
        ),
    }
}

pub(super) fn hide_child_console_window(command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(windows_subprocess_creation_flags());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = command;
    }
}

fn termination_failure_detail(output: &Output, fallback: &str) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        fallback.to_string()
    } else {
        stderr
    }
}

#[cfg(target_os = "windows")]
pub(super) fn terminate_process_tree(pid: u32) -> Result<(), String> {
    let (program, args) =
        termination_command_spec(ProcessPlatform::Windows, pid, ProcessSignal::Term);
    let mut command = Command::new(program);
    hide_child_console_window(&mut command);
    let output = command
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;

    if output.status.success() {
        return Ok(());
    }

    Err(termination_failure_detail(
        &output,
        "taskkill failed to terminate the worker process.",
    ))
}

#[cfg(unix)]
pub(super) fn terminate_process_tree(pid: u32) -> Result<(), String> {
    send_process_group_signal(pid, ProcessSignal::Term)?;
    std::thread::sleep(Duration::from_millis(500));
    if process_group_exists(pid)? {
        send_process_group_signal(pid, ProcessSignal::Kill)?;
    }
    Ok(())
}

#[cfg(unix)]
fn send_process_group_signal(pid: u32, signal: ProcessSignal) -> Result<(), String> {
    let (program, args) = termination_command_spec(ProcessPlatform::Unix, pid, signal);
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(termination_failure_detail(
            &output,
            "Unable to signal the worker process group.",
        ))
    }
}

#[cfg(unix)]
fn process_group_exists(pid: u32) -> Result<bool, String> {
    let (_, args) = termination_command_spec(ProcessPlatform::Unix, pid, ProcessSignal::Term);
    let output = Command::new("kill")
        .args(["-0", "--", &args[2]])
        .output()
        .map_err(|error| error.to_string())?;
    Ok(output.status.success())
}

#[cfg(test)]
mod tests {
    use super::{
        termination_command_spec, CancelClaim, CancelRequestOutcome, CleanupClaim, ProcessPhase,
        ProcessPlatform, ProcessSignal, ProcessSupervisor, TimeoutClaim, TimeoutRequestOutcome,
    };
    use crate::worker_runtime::WorkerTimeoutKind;
    #[cfg(unix)]
    use std::os::unix::process::CommandExt;
    #[cfg(unix)]
    use std::process::Command;
    use std::sync::{mpsc, Arc, Barrier};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn process_supervisor_claims_cancellation_once_and_rolls_back_only_matching_instance() {
        let supervisor = ProcessSupervisor::default();
        assert!(!supervisor.is_active());
        let first = supervisor.start(101).expect("first worker starts");
        assert!(supervisor.is_active());

        assert_eq!(first.instance_id, 1);
        assert_eq!(first.pid, 101);
        assert_eq!(first.process_group_id, cfg!(unix).then_some(101));
        assert_eq!(supervisor.phase(), Some(ProcessPhase::Running));
        assert!(matches!(
            supervisor.claim_cancel(),
            CancelClaim::Claimed(instance) if instance == first
        ));
        assert!(matches!(
            supervisor.claim_cancel(),
            CancelClaim::AlreadyCancelling(instance) if instance == first
        ));
        assert!(!supervisor.restore_running(999));
        assert!(supervisor.restore_running(first.instance_id));
        assert_eq!(supervisor.phase(), Some(ProcessPhase::Running));

        assert_eq!(
            supervisor.finish(first.instance_id),
            Some(ProcessPhase::Running)
        );
        assert!(!supervisor.is_active());
        let second = supervisor.start(202).expect("second worker starts");
        assert_eq!(second.instance_id, 2);
        assert_eq!(supervisor.phase(), Some(ProcessPhase::Running));
        assert_eq!(supervisor.finish(first.instance_id), None);
        assert_eq!(supervisor.current(), Some(second));
    }

    #[test]
    fn process_supervisor_preserves_real_completion_after_cancellation_claim() {
        let supervisor = ProcessSupervisor::default();
        let instance = supervisor.start(303).expect("worker starts");

        assert!(matches!(
            supervisor.claim_cancel(),
            CancelClaim::Claimed(current) if current == instance
        ));
        assert_eq!(
            supervisor.finish(instance.instance_id),
            Some(ProcessPhase::Cancelling)
        );
        assert_eq!(supervisor.phase(), None);
    }

    #[test]
    fn process_supervisor_restores_running_when_process_termination_fails() {
        let supervisor = ProcessSupervisor::default();
        let instance = supervisor.start(404).expect("worker starts");

        assert!(matches!(
            supervisor.request_cancel(|current| {
                assert_eq!(current, instance);
                Err("tree termination failed".to_string())
            }),
            CancelRequestOutcome::Failed { instance: current, .. } if current == instance
        ));
        assert_eq!(supervisor.phase(), Some(ProcessPhase::Running));
        assert_eq!(
            supervisor.finish(instance.instance_id),
            Some(ProcessPhase::Running)
        );
    }

    #[test]
    fn finish_waits_for_cancellation_termination_before_admitting_a_new_instance() {
        let supervisor = Arc::new(ProcessSupervisor::default());
        let instance = supervisor.start(405).expect("worker starts");
        let (termination_entered_tx, termination_entered_rx) = mpsc::channel();
        let (release_termination_tx, release_termination_rx) = mpsc::channel();
        let termination_supervisor = Arc::clone(&supervisor);
        let termination_thread = thread::spawn(move || {
            termination_supervisor.request_cancel(|claimed| {
                assert_eq!(claimed, instance);
                termination_entered_tx
                    .send(())
                    .expect("announce termination claim");
                release_termination_rx
                    .recv()
                    .expect("release termination closure");
                Ok(())
            })
        });

        termination_entered_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("termination closure starts after claiming cancellation");
        assert_eq!(supervisor.phase(), Some(ProcessPhase::Cancelling));

        let finish_barrier = Arc::new(Barrier::new(2));
        let finish_thread_barrier = Arc::clone(&finish_barrier);
        let finish_supervisor = Arc::clone(&supervisor);
        let (finish_tx, finish_rx) = mpsc::channel();
        let finish_thread = thread::spawn(move || {
            finish_thread_barrier.wait();
            let phase = finish_supervisor.finish(instance.instance_id);
            let next = finish_supervisor.start(406);
            finish_tx
                .send((phase, next))
                .expect("report finish and next start");
        });
        finish_barrier.wait();

        let before_release = finish_rx.recv_timeout(Duration::from_millis(200));
        let start_before_release = supervisor.start(407);
        release_termination_tx
            .send(())
            .expect("release termination closure");
        let termination_outcome = termination_thread.join().expect("termination thread joins");
        let (finished_phase, next) = match before_release {
            Ok(value) => value,
            Err(mpsc::RecvTimeoutError::Timeout) => finish_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("finish completes after termination closure"),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                panic!("finish thread disconnected before reporting")
            }
        };
        finish_thread.join().expect("finish thread joins");

        assert!(matches!(
            termination_outcome,
            CancelRequestOutcome::Signalled(claimed) if claimed == instance
        ));
        assert!(matches!(
            before_release,
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        assert!(start_before_release.is_none());
        assert_eq!(finished_phase, Some(ProcessPhase::Cancelling));
        let next = next.expect("new worker starts only after termination finishes");
        assert_eq!(next.instance_id, instance.instance_id + 1);
        assert_eq!(supervisor.current(), Some(next));
        assert_eq!(supervisor.phase(), Some(ProcessPhase::Running));
    }

    #[test]
    fn finish_waits_for_timeout_failure_rollback_without_deadlocking() {
        let supervisor = Arc::new(ProcessSupervisor::default());
        let instance = supervisor.start(408).expect("worker starts");
        let (termination_entered_tx, termination_entered_rx) = mpsc::channel();
        let (release_termination_tx, release_termination_rx) = mpsc::channel();
        let termination_supervisor = Arc::clone(&supervisor);
        let termination_thread = thread::spawn(move || {
            termination_supervisor.request_timeout(
                instance.instance_id,
                WorkerTimeoutKind::Idle,
                |claimed| {
                    assert_eq!(claimed, instance);
                    termination_entered_tx
                        .send(())
                        .expect("announce termination claim");
                    release_termination_rx
                        .recv()
                        .expect("release termination closure");
                    Err("tree termination failed".to_string())
                },
            )
        });

        termination_entered_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("termination closure starts after claiming timeout");
        assert_eq!(
            supervisor.phase(),
            Some(ProcessPhase::TimingOut(WorkerTimeoutKind::Idle))
        );

        let finish_barrier = Arc::new(Barrier::new(2));
        let finish_thread_barrier = Arc::clone(&finish_barrier);
        let finish_supervisor = Arc::clone(&supervisor);
        let (finish_tx, finish_rx) = mpsc::channel();
        let finish_thread = thread::spawn(move || {
            finish_thread_barrier.wait();
            let phase = finish_supervisor.finish(instance.instance_id);
            let next = finish_supervisor.start(409);
            finish_tx
                .send((phase, next))
                .expect("report finish and next start");
        });
        finish_barrier.wait();

        let before_release = finish_rx.recv_timeout(Duration::from_millis(200));
        let start_before_release = supervisor.start(410);
        release_termination_tx
            .send(())
            .expect("release termination closure");
        let termination_outcome = termination_thread.join().expect("termination thread joins");
        let (finished_phase, next) = match before_release {
            Ok(value) => value,
            Err(mpsc::RecvTimeoutError::Timeout) => finish_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("finish completes after timeout rollback"),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                panic!("finish thread disconnected before reporting")
            }
        };
        finish_thread.join().expect("finish thread joins");

        assert!(matches!(
            termination_outcome,
            TimeoutRequestOutcome::Failed { instance: claimed, .. } if claimed == instance
        ));
        assert!(matches!(
            before_release,
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        assert!(start_before_release.is_none());
        assert_eq!(finished_phase, Some(ProcessPhase::Running));
        let next = next.expect("new worker starts only after rollback and finish");
        assert_eq!(next.instance_id, instance.instance_id + 1);
        assert_eq!(supervisor.current(), Some(next));
        assert_eq!(supervisor.phase(), Some(ProcessPhase::Running));
    }

    #[test]
    fn timeout_claim_is_instance_safe_and_keeps_the_first_terminal_kind() {
        let supervisor = ProcessSupervisor::default();
        let first = supervisor.start(405).expect("first worker starts");

        assert!(matches!(
            supervisor.claim_timeout(first.instance_id, WorkerTimeoutKind::Idle),
            TimeoutClaim::Claimed(instance) if instance == first
        ));
        assert_eq!(
            supervisor.phase(),
            Some(ProcessPhase::TimingOut(WorkerTimeoutKind::Idle))
        );
        assert!(matches!(
            supervisor.claim_timeout(first.instance_id, WorkerTimeoutKind::Absolute),
            TimeoutClaim::AlreadyTerminating(instance) if instance == first
        ));
        assert_eq!(
            supervisor.phase(),
            Some(ProcessPhase::TimingOut(WorkerTimeoutKind::Idle))
        );
        assert!(matches!(
            supervisor.claim_cancel(),
            CancelClaim::AlreadyCancelling(instance) if instance == first
        ));

        assert_eq!(
            supervisor.finish(first.instance_id),
            Some(ProcessPhase::TimingOut(WorkerTimeoutKind::Idle))
        );
        let second = supervisor.start(406).expect("second worker starts");
        assert_eq!(
            supervisor.claim_timeout(first.instance_id, WorkerTimeoutKind::Absolute),
            TimeoutClaim::NotRunning
        );
        assert!(
            !supervisor.restore_running_after_timeout(first.instance_id, WorkerTimeoutKind::Idle)
        );
        assert!(!supervisor.restore_running(first.instance_id));
        assert_eq!(supervisor.finish(first.instance_id), None);
        assert_eq!(supervisor.current(), Some(second));
        assert_eq!(supervisor.phase(), Some(ProcessPhase::Running));
    }

    #[test]
    fn cancellation_claim_prevents_timeout_signal_and_relabel() {
        let supervisor = ProcessSupervisor::default();
        let instance = supervisor.start(407).expect("worker starts");
        let mut cancel_signals = 0;

        assert!(matches!(
            supervisor.request_cancel(|current| {
                assert_eq!(current, instance);
                cancel_signals += 1;
                Ok(())
            }),
            CancelRequestOutcome::Signalled(current) if current == instance
        ));
        assert_eq!(cancel_signals, 1);
        assert!(matches!(
            supervisor.request_timeout(
                instance.instance_id,
                WorkerTimeoutKind::Absolute,
                |_| panic!("timeout must not signal after cancellation owns termination")
            ),
            TimeoutRequestOutcome::AlreadyTerminating(current) if current == instance
        ));
        assert_eq!(supervisor.phase(), Some(ProcessPhase::Cancelling));
    }

    #[test]
    fn timeout_request_signals_once_and_rolls_back_only_the_expected_claim() {
        let supervisor = ProcessSupervisor::default();
        let instance = supervisor.start(408).expect("worker starts");
        let mut timeout_signals = 0;

        assert!(matches!(
            supervisor.request_timeout(
                instance.instance_id,
                WorkerTimeoutKind::Idle,
                |current| {
                    assert_eq!(current, instance);
                    timeout_signals += 1;
                    Ok(())
                }
            ),
            TimeoutRequestOutcome::Signalled(current) if current == instance
        ));
        assert_eq!(timeout_signals, 1);
        assert!(matches!(
            supervisor.request_timeout(
                instance.instance_id,
                WorkerTimeoutKind::Idle,
                |_| panic!("a repeated timeout must not signal")
            ),
            TimeoutRequestOutcome::AlreadyTerminating(current) if current == instance
        ));
        assert!(matches!(
            supervisor.request_cancel(|_| panic!("cancel must not signal during timeout")),
            CancelRequestOutcome::AlreadyCancelling(current) if current == instance
        ));

        assert!(!supervisor
            .restore_running_after_timeout(instance.instance_id, WorkerTimeoutKind::Absolute));
        assert_eq!(
            supervisor.phase(),
            Some(ProcessPhase::TimingOut(WorkerTimeoutKind::Idle))
        );
        assert!(
            supervisor.restore_running_after_timeout(instance.instance_id, WorkerTimeoutKind::Idle)
        );
        assert_eq!(supervisor.phase(), Some(ProcessPhase::Running));

        assert!(matches!(
            supervisor.request_timeout(
                instance.instance_id,
                WorkerTimeoutKind::Absolute,
                |_| Err("tree termination failed".to_string())
            ),
            TimeoutRequestOutcome::Failed { instance: current, .. } if current == instance
        ));
        assert_eq!(supervisor.phase(), Some(ProcessPhase::Running));
    }

    #[test]
    fn cleanup_claim_closes_the_check_then_signal_race_without_stealing_terminal_ownership() {
        let supervisor = ProcessSupervisor::default();
        let instance = supervisor.start(412).expect("worker starts");

        assert!(matches!(
            supervisor.claim_cleanup(instance.instance_id),
            CleanupClaim::Claimed(claimed) if claimed == instance
        ));
        assert_eq!(
            supervisor.phase_for(instance.instance_id),
            Some(ProcessPhase::CleaningUp)
        );
        assert!(matches!(
            supervisor.claim_cancel(),
            CancelClaim::AlreadyCancelling(claimed) if claimed == instance
        ));
        assert!(matches!(
            supervisor.claim_timeout(instance.instance_id, WorkerTimeoutKind::Idle),
            TimeoutClaim::AlreadyTerminating(claimed) if claimed == instance
        ));
        assert_eq!(
            supervisor.finish(instance.instance_id),
            Some(ProcessPhase::CleaningUp)
        );

        let next = supervisor.start(413).expect("next worker starts");
        assert!(matches!(
            supervisor.claim_cancel(),
            CancelClaim::Claimed(claimed) if claimed == next
        ));
        assert!(matches!(
            supervisor.claim_cleanup(next.instance_id),
            CleanupClaim::AlreadyTerminating(claimed) if claimed == next
        ));
    }

    #[test]
    fn independent_lanes_use_the_same_instance_safe_supervisor_semantics() {
        let video = ProcessSupervisor::default();
        let model_download = ProcessSupervisor::default();
        let video_instance = video.start(505).expect("video worker starts");
        let model_instance = model_download.start(606).expect("model download starts");

        assert!(matches!(
            video.claim_cancel(),
            CancelClaim::Claimed(instance) if instance == video_instance
        ));
        assert_eq!(
            video.finish(video_instance.instance_id),
            Some(ProcessPhase::Cancelling)
        );
        assert_eq!(
            model_download.finish(model_instance.instance_id),
            Some(ProcessPhase::Running)
        );
    }

    #[test]
    fn termination_command_specs_cover_windows_tree_and_unix_process_group_signals() {
        assert_eq!(
            termination_command_spec(ProcessPlatform::Windows, 404, ProcessSignal::Term),
            (
                "taskkill".to_string(),
                vec!["/PID", "404", "/T", "/F"]
                    .into_iter()
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            )
        );
        assert_eq!(
            termination_command_spec(ProcessPlatform::Unix, 505, ProcessSignal::Term),
            (
                "kill".to_string(),
                vec!["-TERM", "--", "-505"]
                    .into_iter()
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            )
        );
        assert_eq!(
            termination_command_spec(ProcessPlatform::Unix, 505, ProcessSignal::Kill),
            (
                "kill".to_string(),
                vec!["-KILL", "--", "-505"]
                    .into_iter()
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            )
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_termination_stops_a_parent_and_child_in_the_managed_process_group() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30 & wait"]);
        command.process_group(0);
        let mut child = command.spawn().expect("fixture parent starts");
        let process_group_id = child.id();

        assert!(super::process_group_exists(process_group_id).expect("group probe succeeds"));
        super::terminate_process_tree(process_group_id).expect("group termination succeeds");
        child.wait().expect("fixture parent is reaped");
        assert!(
            !super::process_group_exists(process_group_id).expect("group probe after termination")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_worker_subprocesses_suppress_console_window() {
        assert_eq!(
            super::windows_subprocess_creation_flags() & 0x08000000,
            0x08000000
        );
    }
}
