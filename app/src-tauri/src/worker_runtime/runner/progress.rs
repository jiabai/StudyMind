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

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) struct StderrSummary {
    pub(super) had_diagnostic_output: bool,
    pub(super) reader_failed: bool,
}

impl StderrSummary {
    pub(super) fn marker(self) -> &'static str {
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
            ProgressRecord::Diagnostic => summary.had_diagnostic_output = true,
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
