use super::progress::StderrSummary;
use super::{WorkerOperation, WorkerRunError, WorkerRunOutcome};
use crate::worker_runtime::command::{js_runtime_diagnostics, WorkerCommandSpec};
use crate::worker_runtime::result_protocol::{parse_terminal_result, TerminalResultError};
use crate::worker_runtime::supervisor::ProcessPhase;
use std::process::Output;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkerExitSummary {
    pub(crate) exit_code: Option<i32>,
    pub(crate) stderr: &'static str,
}

pub(super) fn safe_start_log_detail(
    operation: WorkerOperation,
    spec: &WorkerCommandSpec,
) -> String {
    format!(
        "operation={} {}",
        operation.as_str(),
        js_runtime_diagnostics(spec)
    )
}

pub(super) fn safe_exit_log_detail(
    operation: WorkerOperation,
    pid: u32,
    output: &Output,
    stderr: StderrSummary,
) -> String {
    format!(
        "operation={} pid={pid} exit={} stderr={}",
        operation.as_str(),
        output
            .status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "signal".to_string()),
        stderr.marker()
    )
}

pub(super) fn classify_terminal(
    operation: WorkerOperation,
    output: &Output,
    terminal_phase: Option<ProcessPhase>,
    stderr: StderrSummary,
) -> Result<WorkerRunOutcome, WorkerRunError> {
    let parse_error = match parse_terminal_result(operation, &output.stdout) {
        Ok(value) => return Ok(WorkerRunOutcome::Structured(value)),
        Err(error) => error,
    };
    if terminal_phase == Some(ProcessPhase::Cancelling) {
        return Ok(WorkerRunOutcome::Cancelled);
    }
    if let Some(ProcessPhase::TimingOut(kind)) = terminal_phase {
        return Ok(WorkerRunOutcome::TimedOut(kind));
    }
    match parse_error {
        TerminalResultError::Invalid => Err(WorkerRunError::protocol_violation()),
        TerminalResultError::Missing if output.status.success() => {
            Err(WorkerRunError::protocol_violation())
        }
        TerminalResultError::Missing => {
            Ok(WorkerRunOutcome::UnstructuredFailure(WorkerExitSummary {
                exit_code: output.status.code(),
                stderr: stderr.marker(),
            }))
        }
    }
}
