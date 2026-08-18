use super::watchdog::WatchdogControl;
use super::RunnerHooks;
#[cfg(not(test))]
use crate::progress_event::ASR_MODEL_DOWNLOAD_EVENT_NAME;
use crate::progress_event::{
    invalid_progress_log_detail, validate_model_download_event, validate_worker_progress_event,
    MODEL_DOWNLOAD_EVENT_PREFIX,
};
use crate::{append_desktop_log, RuntimePaths};
use std::io::{BufRead, BufReader};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
#[cfg(not(test))]
use tauri::{Emitter, Window};

#[cfg(not(test))]
pub(crate) enum ProgressRoute {
    #[allow(dead_code)] // reserved for window-less / background runs without progress events
    None,
    Worker(Window),
    AsrModelDownload(Window),
}

#[cfg(test)]
pub(crate) enum ProgressRoute {
    None,
    Worker,
    AsrModelDownload,
}

impl ProgressRoute {
    #[cfg(not(test))]
    pub(crate) fn worker(window: Window) -> Self {
        Self::Worker(window)
    }

    #[cfg(not(test))]
    pub(crate) fn asr_model_download(window: Window) -> Self {
        Self::AsrModelDownload(window)
    }

    #[cfg(test)]
    pub(crate) fn worker<T>(_window: T) -> Self {
        Self::Worker
    }

    #[cfg(test)]
    pub(crate) fn asr_model_download<T>(_window: T) -> Self {
        Self::AsrModelDownload
    }

    fn protocol(&self) -> ProgressProtocol {
        #[cfg(not(test))]
        match self {
            Self::None => ProgressProtocol::None,
            Self::Worker(_) => ProgressProtocol::Worker,
            Self::AsrModelDownload(_) => ProgressProtocol::AsrModelDownload,
        }

        #[cfg(test)]
        match self {
            Self::None => ProgressProtocol::None,
            Self::Worker => ProgressProtocol::Worker,
            Self::AsrModelDownload => ProgressProtocol::AsrModelDownload,
        }
    }

    fn emit(&self, payload: serde_json::Value) {
        #[cfg(not(test))]
        match self {
            Self::None => {}
            Self::Worker(window) => {
                let _ = window.emit(crate::PROGRESS_EVENT_NAME, payload);
            }
            Self::AsrModelDownload(window) => {
                let _ = window.emit(ASR_MODEL_DOWNLOAD_EVENT_NAME, payload);
            }
        }

        #[cfg(test)]
        let _ = (self, payload);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ProgressProtocol {
    None,
    Worker,
    AsrModelDownload,
}

#[derive(Debug, PartialEq)]
pub(super) enum ProgressRecord {
    Validated(serde_json::Value),
    Invalid(String),
    Diagnostic,
    Empty,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(super) struct StderrSummary {
    pub(super) had_diagnostic_output: bool,
    pub(super) reader_failed: bool,
    /// Non-protocol stderr lines (tracebacks, warnings, tool output) collected
    /// for desktop diagnostics. Capped to bound log growth.
    pub(super) diagnostic: String,
}

const MAX_DIAGNOSTIC_BYTES: usize = 16 * 1024;

fn append_diagnostic_line(buffer: &mut String, line: &str) {
    if buffer.len() >= MAX_DIAGNOSTIC_BYTES {
        return;
    }
    if !buffer.is_empty() {
        buffer.push('\n');
    }
    buffer.push_str(line);
    // `String::truncate` panics unless the cut point is a char boundary. The budget
    // is measured in bytes, so after pushing a multi-byte (e.g. CJK) line the buffer
    // length can land mid-character. Walk back to the nearest char boundary instead
    // of assuming byte `MAX_DIAGNOSTIC_BYTES` is a safe cut.
    if buffer.len() > MAX_DIAGNOSTIC_BYTES {
        let mut cut = MAX_DIAGNOSTIC_BYTES;
        while cut > 0 && !buffer.is_char_boundary(cut) {
            cut -= 1;
        }
        buffer.truncate(cut);
    }
}

impl StderrSummary {
    pub(super) fn marker(&self) -> &'static str {
        if self.reader_failed {
            "reader_failed"
        } else if self.had_diagnostic_output {
            "present"
        } else {
            "empty"
        }
    }
}

pub(super) fn read_stderr(
    stderr: std::process::ChildStderr,
    progress: ProgressRoute,
    paths: RuntimePaths,
    hooks: RunnerHooks,
    watchdog: Arc<WatchdogControl>,
) -> StderrSummary {
    let protocol = progress.protocol();
    let mut summary = StderrSummary::default();
    for line in BufReader::new(stderr).lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => {
                summary.reader_failed = true;
                break;
            }
        };
        match inspect_progress_line(protocol, &line) {
            ProgressRecord::Validated(payload) => {
                watchdog.record_validated_progress();
                progress.emit(payload);
            }
            ProgressRecord::Invalid(detail) => {
                let event = match protocol {
                    ProgressProtocol::AsrModelDownload => "worker.model_progress.invalid",
                    ProgressProtocol::Worker | ProgressProtocol::None => "worker.progress.invalid",
                };
                let _ = append_desktop_log(&paths, event, &detail);
            }
            ProgressRecord::Diagnostic => {
                summary.had_diagnostic_output = true;
                append_diagnostic_line(&mut summary.diagnostic, &line);
            }
            ProgressRecord::Empty => {}
        }
    }

    if hooks.panic_stderr_reader {
        panic!("forced stderr reader failure");
    }
    if let Some(gate) = hooks.reader_join_gate {
        gate.waiting.store(true, Ordering::SeqCst);
        let deadline = Instant::now() + Duration::from_secs(10);
        while !gate.release.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::yield_now();
        }
    }
    summary
}

pub(super) fn inspect_progress_line(protocol: ProgressProtocol, line: &str) -> ProgressRecord {
    if line.trim().is_empty() {
        return ProgressRecord::Empty;
    }
    let (prefix, validator): (
        &str,
        fn(
            &serde_json::Value,
        ) -> Result<serde_json::Value, crate::progress_event::InvalidProgressEvent>,
    ) = match protocol {
        ProgressProtocol::None => return ProgressRecord::Diagnostic,
        ProgressProtocol::Worker => (crate::PROGRESS_EVENT_PREFIX, validate_worker_progress_event),
        ProgressProtocol::AsrModelDownload => {
            (MODEL_DOWNLOAD_EVENT_PREFIX, validate_model_download_event)
        }
    };
    let Some(raw_event) = line.strip_prefix(prefix) else {
        return ProgressRecord::Diagnostic;
    };
    let parsed = serde_json::from_str::<serde_json::Value>(raw_event).ok();
    if let Some(payload) = parsed.as_ref().and_then(|value| validator(value).ok()) {
        ProgressRecord::Validated(payload)
    } else {
        ProgressRecord::Invalid(
            parsed
                .as_ref()
                .map(invalid_progress_log_detail)
                .unwrap_or_else(|| "message_code=invalid".to_string()),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multibyte_line_truncates_at_char_boundary_without_panic() {
        let mut buffer = String::new();
        // 5461 CJK chars = 16383 bytes, just under the budget.
        append_diagnostic_line(&mut buffer, &"中".repeat(5461));
        assert_eq!(buffer.len(), 16383);
        // One more multi-byte char pushes the byte length to 16386, crossing the budget
        // mid-character (the trailing char spans bytes 16383..16386).
        append_diagnostic_line(&mut buffer, "中");
        // Old code called `buffer.truncate(16384)` here and panicked on the
        // is_char_boundary assertion. New code walks back to a char boundary.
        assert!(buffer.len() <= MAX_DIAGNOSTIC_BYTES);
        assert!(buffer.is_char_boundary(buffer.len()));
    }

    #[test]
    fn append_diagnostic_line_stops_at_ascii_budget() {
        let mut buffer = String::new();
        append_diagnostic_line(&mut buffer, &"a".repeat(MAX_DIAGNOSTIC_BYTES));
        assert_eq!(buffer.len(), MAX_DIAGNOSTIC_BYTES);
        // Early-return path: further appends are ignored, no panic.
        append_diagnostic_line(&mut buffer, "more");
        assert_eq!(buffer.len(), MAX_DIAGNOSTIC_BYTES);
    }

    #[test]
    fn appended_multibyte_buffer_stays_char_valid_under_repeated_pushes() {
        let mut buffer = String::new();
        for _ in 0..2000 {
            append_diagnostic_line(&mut buffer, "诊断信息：下载进度更新");
        }
        assert!(buffer.len() <= MAX_DIAGNOSTIC_BYTES);
        assert!(buffer.is_char_boundary(buffer.len()));
    }
}
