use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Instant;
use tauri::{Emitter, State};
use uuid::Uuid;

mod mixer;
mod mixed;
mod failure_supervisor;
use failure_supervisor::{
    recording_failure_channel, RecordingFailureMonitor, RecordingFailureReporter,
};
mod system_audio_recovery;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(all(test, not(target_os = "macos")))]
#[path = "macos.rs"]
mod macos_test;
#[cfg(windows)]
mod wasapi;
mod wav_writer;

pub(crate) const RECORDING_ALREADY_ACTIVE: RecordingErrorCode = RecordingErrorCode::AlreadyActive;
pub(crate) const RECORDING_PLATFORM_UNSUPPORTED: RecordingErrorCode =
    RecordingErrorCode::PlatformUnsupported;
pub(crate) const RECORDING_MIC_INIT_FAILED: RecordingErrorCode = RecordingErrorCode::MicInitFailed;
pub(crate) const RECORDING_MIC_ACCESS_DENIED: RecordingErrorCode = RecordingErrorCode::MicAccessDenied;
pub(crate) const RECORDING_SYSTEM_LOOPBACK_INIT_FAILED: RecordingErrorCode =
    RecordingErrorCode::SystemLoopbackInitFailed;
pub(crate) const RECORDING_SYSTEM_AUDIO_UNAVAILABLE: RecordingErrorCode =
    RecordingErrorCode::SystemAudioUnavailable;
pub(crate) const RECORDING_SYSTEM_AUDIO_RECOVERED: RecordingErrorCode =
    RecordingErrorCode::SystemAudioRecovered;
pub(crate) const RECORDING_STREAM_ERROR: RecordingErrorCode = RecordingErrorCode::StreamError;
pub(crate) const RECORDING_MIX_FAILED: RecordingErrorCode = RecordingErrorCode::MixFailed;
pub(crate) const RECORDING_WRITE_FAILED: RecordingErrorCode = RecordingErrorCode::WriteFailed;
pub(crate) const RECORDING_EMPTY: RecordingErrorCode = RecordingErrorCode::Empty;
pub(crate) const RECORDING_SESSION_INVALID: RecordingErrorCode = RecordingErrorCode::SessionInvalid;
pub(crate) const RECORDING_FINALIZE_FAILED: RecordingErrorCode = RecordingErrorCode::FinalizeFailed;
pub(crate) const RECORDING_STATE_UNAVAILABLE: RecordingErrorCode =
    RecordingErrorCode::StateUnavailable;
pub(crate) const RECORDING_CLEANUP_IN_PROGRESS: RecordingErrorCode =
    RecordingErrorCode::CleanupInProgress;

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) enum RecordingErrorCode {
    #[serde(rename = "RECORDING_ALREADY_ACTIVE")]
    AlreadyActive,
    #[serde(rename = "RECORDING_PLATFORM_UNSUPPORTED")]
    PlatformUnsupported,
    #[serde(rename = "RECORDING_CAPABILITY_PROBE_FAILED")]
    CapabilityProbeFailed,
    #[serde(rename = "RECORDING_MIC_INIT_FAILED")]
    MicInitFailed,
    #[serde(rename = "RECORDING_MIC_ACCESS_DENIED")]
    MicAccessDenied,
    #[serde(rename = "RECORDING_SYSTEM_LOOPBACK_INIT_FAILED")]
    SystemLoopbackInitFailed,
    #[serde(rename = "RECORDING_SYSTEM_AUDIO_UNAVAILABLE")]
    SystemAudioUnavailable,
    #[serde(rename = "RECORDING_SYSTEM_AUDIO_RECOVERED")]
    SystemAudioRecovered,
    #[serde(rename = "RECORDING_STREAM_ERROR")]
    StreamError,
    #[serde(rename = "RECORDING_MIX_FAILED")]
    MixFailed,
    #[serde(rename = "RECORDING_WRITE_FAILED")]
    WriteFailed,
    #[serde(rename = "RECORDING_DISK_SPACE_LOW")]
    DiskSpaceLow,
    #[serde(rename = "RECORDING_EMPTY")]
    Empty,
    #[serde(rename = "RECORDING_SESSION_INVALID")]
    SessionInvalid,
    #[serde(rename = "RECORDING_FINALIZE_FAILED")]
    FinalizeFailed,
    #[serde(rename = "RECORDING_STATE_UNAVAILABLE")]
    StateUnavailable,
    #[serde(rename = "RECORDING_CLEANUP_IN_PROGRESS")]
    CleanupInProgress,
}

impl RecordingErrorCode {
    fn message(self) -> &'static str {
        match self {
            Self::AlreadyActive => "A recording session is already active.",
            Self::PlatformUnsupported => "Recording is not supported on this platform.",
            Self::CapabilityProbeFailed => "Recording capabilities could not be determined.",
            Self::MicInitFailed => "The microphone could not be initialized.",
            Self::MicAccessDenied => "Microphone access was denied.",
            Self::SystemLoopbackInitFailed => "System audio could not be initialized.",
            Self::SystemAudioUnavailable => "System audio is unavailable.",
            Self::SystemAudioRecovered => "System audio recording recovered.",
            Self::StreamError => "The recording stream was interrupted.",
            Self::MixFailed => "The recording sources could not be mixed.",
            Self::WriteFailed => "The recording could not be written.",
            Self::DiskSpaceLow => "There is not enough disk space for recording.",
            Self::Empty => "The recording did not contain any valid audio frames.",
            Self::SessionInvalid => "The recording session is no longer valid.",
            Self::FinalizeFailed => "The recording could not be finalized.",
            Self::StateUnavailable => "The recording state is temporarily unavailable.",
            Self::CleanupInProgress => "The recording is still being cleaned up.",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RecordingSource {
    Microphone,
    SystemAudio,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct RecordingError {
    pub(crate) code: RecordingErrorCode,
    pub(crate) message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) source: Option<RecordingSource>,
}

impl RecordingError {
    pub(crate) fn new(code: RecordingErrorCode) -> Self {
        Self {
            code,
            message: code.message(),
            source: None,
        }
    }

    pub(crate) fn for_source(mut self, source: RecordingSource) -> Self {
        if self.source.is_none() {
            self.source = Some(source);
        }
        self
    }
}

impl fmt::Display for RecordingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.message.fmt(formatter)
    }
}

impl std::error::Error for RecordingError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RecordingWarningSource {
    SystemAudio,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordingWarningView {
    pub(crate) warning_code: RecordingErrorCode,
    pub(crate) source: Option<RecordingWarningSource>,
    pub(crate) count: u32,
    pub(crate) total_gap_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordingWarningEvent {
    pub(crate) session_id: String,
    pub(crate) warning_code: RecordingErrorCode,
    pub(crate) source: Option<RecordingWarningSource>,
    pub(crate) count: u32,
    pub(crate) total_gap_ms: u64,
}

impl RecordingWarningEvent {
    fn from_warning(session_id: &str, warning: &RecordingWarningView) -> Self {
        Self {
            session_id: session_id.to_string(),
            warning_code: warning.warning_code,
            source: warning.source,
            count: warning.count,
            total_gap_ms: warning.total_gap_ms,
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct WarningAccumulator {
    warnings: Arc<Mutex<Vec<RecordingWarningView>>>,
}

impl WarningAccumulator {
    pub(crate) fn record(
        &self,
        warning_code: RecordingErrorCode,
        source: Option<RecordingWarningSource>,
        gap_ms: u64,
    ) -> RecordingWarningView {
        let mut warnings = self
            .warnings
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(existing) = warnings
            .iter_mut()
            .find(|warning| warning.warning_code == warning_code && warning.source == source)
        {
            existing.count = existing.count.saturating_add(1);
            existing.total_gap_ms = existing.total_gap_ms.saturating_add(gap_ms);
            return existing.clone();
        }

        let warning = RecordingWarningView {
            warning_code,
            source,
            count: 1,
            total_gap_ms: gap_ms,
        };
        warnings.push(warning.clone());
        warning
    }

    pub(crate) fn snapshot(&self) -> Vec<RecordingWarningView> {
        self.warnings
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

pub(crate) trait RecordingWarningSink: Send + Sync {
    fn emit(
        &self,
        session_id: &str,
        warning: &RecordingWarningView,
    ) -> Result<(), RecordingError>;
}

struct NoopRecordingWarningSink;

impl RecordingWarningSink for NoopRecordingWarningSink {
    fn emit(
        &self,
        _session_id: &str,
        _warning: &RecordingWarningView,
    ) -> Result<(), RecordingError> {
        Ok(())
    }
}

struct TauriRecordingWarningSink {
    app: tauri::AppHandle,
}

impl TauriRecordingWarningSink {
    fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl RecordingWarningSink for TauriRecordingWarningSink {
    fn emit(
        &self,
        session_id: &str,
        warning: &RecordingWarningView,
    ) -> Result<(), RecordingError> {
        self.app
            .emit(
                "recording-warning",
                RecordingWarningEvent::from_warning(session_id, warning),
            )
            .map_err(|_| RecordingError::new(RECORDING_STREAM_ERROR))
    }
}

#[derive(Clone)]
pub(crate) struct RecordingWarningReporter {
    session_id: String,
    accumulator: WarningAccumulator,
    sink: Arc<dyn RecordingWarningSink>,
}

impl RecordingWarningReporter {
    fn new(
        session_id: String,
        accumulator: WarningAccumulator,
        sink: Arc<dyn RecordingWarningSink>,
    ) -> Self {
        Self {
            session_id,
            accumulator,
            sink,
        }
    }

    #[cfg(test)]
    #[allow(dead_code)]
    pub(crate) fn no_op() -> Self {
        Self {
            session_id: String::new(),
            accumulator: WarningAccumulator::default(),
            sink: Arc::new(NoopRecordingWarningSink),
        }
    }

    pub(crate) fn record_recovery(&self, gap_ms: u64) {
        let warning = self.accumulator.record(
            RECORDING_SYSTEM_AUDIO_RECOVERED,
            Some(RecordingWarningSource::SystemAudio),
            gap_ms,
        );
        let _ = self.sink.emit(&self.session_id, &warning);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RecordingMode {
    Mic,
    System,
    Mixed,
}

impl RecordingMode {
    fn needs_microphone(self) -> bool {
        matches!(self, Self::Mic | Self::Mixed)
    }

    fn needs_system_audio(self) -> bool {
        matches!(self, Self::System | Self::Mixed)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RecordingPlatform {
    Windows,
    Macos,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordingSourceCapability {
    pub(crate) available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason_code: Option<RecordingErrorCode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordingCapabilities {
    pub(crate) platform: RecordingPlatform,
    pub(crate) microphone: RecordingSourceCapability,
    pub(crate) system_audio: RecordingSourceCapability,
    pub(crate) mixed: RecordingSourceCapability,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartRecordingResponse {
    pub(crate) session_id: String,
    #[serde(default)]
    pub(crate) warnings: Vec<RecordingErrorCode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordingFailureView {
    pub(crate) session_id: String,
    pub(crate) mode: RecordingMode,
    pub(crate) elapsed_ms: u64,
    pub(crate) error_code: RecordingErrorCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) source: Option<RecordingSource>,
    pub(crate) cleanup_pending: bool,
    pub(crate) warnings: Vec<RecordingWarningView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum RecordingStateView {
    Recording {
        session_id: String,
        mode: RecordingMode,
        elapsed_ms: u64,
        warnings: Vec<RecordingWarningView>,
    },
    Failed {
        #[serde(flatten)]
        failure: RecordingFailureView,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordingResult {
    pub(crate) path: String,
    pub(crate) display_name: String,
    pub(crate) duration_ms: u64,
    pub(crate) size_bytes: u64,
    pub(crate) warnings: Vec<RecordingWarningView>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CaptureWorkspace {
    pub(crate) session_id: String,
    pub(crate) temp_dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CapturedRecording {
    pub(crate) source_paths: Vec<PathBuf>,
    pub(crate) valid_frame_count: u64,
    pub(crate) silent: bool,
    pub(crate) duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FinalizedRecording {
    pub(crate) path: PathBuf,
    pub(crate) display_name: String,
    pub(crate) duration_ms: u64,
    pub(crate) size_bytes: u64,
}

pub(crate) trait RecordingClock: Send + Sync {
    fn now_ms(&self) -> u64;
}

const LOW_DISK_WARNING_BYTES: u64 = 500 * 1024 * 1024;

pub(crate) trait RecordingDiskSpace: Send + Sync {
    fn free_bytes(&self) -> Option<u64>;
}

struct NoDiskSpaceProbe;

impl RecordingDiskSpace for NoDiskSpaceProbe {
    fn free_bytes(&self) -> Option<u64> {
        None
    }
}

#[cfg(windows)]
struct WindowsDiskSpaceProbe {
    path: std::path::PathBuf,
}

#[cfg(windows)]
impl RecordingDiskSpace for WindowsDiskSpaceProbe {
    fn free_bytes(&self) -> Option<u64> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

        let mut wide = self.path.as_os_str().encode_wide().collect::<Vec<_>>();
        wide.push(0);
        let mut available: u64 = 0;
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut available,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if ok != 0 {
            Some(available)
        } else {
            None
        }
    }
}

pub(crate) trait RecordingFileStore: Send + Sync {
    fn prepare(&self, session_id: &str) -> Result<CaptureWorkspace, RecordingError>;
    fn cleanup(&self, workspace: &CaptureWorkspace) -> Result<(), RecordingError>;
}

#[derive(Clone)]
pub(crate) struct CaptureCancelHandle(Arc<dyn Fn() + Send + Sync>);

impl CaptureCancelHandle {
    pub(crate) fn new(request: impl Fn() + Send + Sync + 'static) -> Self {
        Self(Arc::new(request))
    }

    pub(crate) fn request(&self) {
        (self.0)();
    }
}

pub(crate) trait RecordingFailureSink: Send + Sync {
    fn emit(&self, failure: &RecordingFailureView) -> Result<(), RecordingError>;
}

struct NoopRecordingFailureSink;

impl RecordingFailureSink for NoopRecordingFailureSink {
    fn emit(&self, _failure: &RecordingFailureView) -> Result<(), RecordingError> {
        Ok(())
    }
}

struct TauriRecordingFailureSink {
    app: tauri::AppHandle,
}

impl TauriRecordingFailureSink {
    fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl RecordingFailureSink for TauriRecordingFailureSink {
    fn emit(&self, failure: &RecordingFailureView) -> Result<(), RecordingError> {
        self.app
            .emit("recording-failed", failure)
            .map_err(|_| RecordingError::new(RECORDING_STREAM_ERROR))
    }
}

pub(crate) trait ActiveCapture: Send {
    fn stop(self: Box<Self>) -> Result<CapturedRecording, RecordingError>;
    fn cancel(self: Box<Self>) -> Result<(), RecordingError>;
    fn cancel_for_cleanup(self: Box<Self>) -> Result<(), RecordingError> {
        self.cancel()
    }
    fn cancel_handle(&self) -> Option<CaptureCancelHandle> {
        None
    }
}

pub(crate) trait RecordingBackend: Send + Sync {
    fn capabilities(&self) -> Result<RecordingCapabilities, RecordingError>;
    fn start(
        &self,
        mode: RecordingMode,
        workspace: &CaptureWorkspace,
        reporter: RecordingWarningReporter,
        failure_reporter: RecordingFailureReporter,
    ) -> Result<Box<dyn ActiveCapture>, RecordingError>;
}

pub(crate) trait RecordingFinalizer: Send + Sync {
    fn finalize(
        &self,
        workspace: &CaptureWorkspace,
        capture: CapturedRecording,
        mode: RecordingMode,
    ) -> Result<FinalizedRecording, RecordingError>;
}

struct RecordingSession {
    session_id: String,
    mode: RecordingMode,
    started_at_ms: u64,
    workspace: CaptureWorkspace,
    capture: Box<dyn ActiveCapture>,
    warnings: WarningAccumulator,
    failure_reporter: RecordingFailureReporter,
}

enum ControllerState {
    Idle,
    Starting,
    Recording(RecordingSession),
    Stopping {
        session_id: String,
        cancel: Option<CaptureCancelHandle>,
        cancel_requested: bool,
    },
    Finalizing,
    Failed(RecordingFailureView),
}

pub(crate) struct RecordingController {
    backend: Arc<dyn RecordingBackend>,
    finalizer: Arc<dyn RecordingFinalizer>,
    file_store: Arc<dyn RecordingFileStore>,
    clock: Arc<dyn RecordingClock>,
    disk_space: Arc<dyn RecordingDiskSpace>,
    warning_sink: Arc<dyn RecordingWarningSink>,
    failure_sink: Arc<dyn RecordingFailureSink>,
    state: Arc<Mutex<ControllerState>>,
    acknowledged_failure: Mutex<Option<String>>,
}

impl RecordingController {
    pub(crate) fn from_runtime_paths(
        paths: &crate::RuntimePaths,
        app: tauri::AppHandle,
    ) -> Self {
        #[cfg(windows)]
        {
            let recordings_dir = paths.user_data_dir.join(crate::RECORDINGS_DIR_NAME);
            return Self::new(
                Arc::new(wasapi::WasapiRecordingBackend::default()),
                Arc::new(mixer::FfmpegRecordingFinalizer::new(
                    paths.resource_dir.clone(),
                    recordings_dir.clone(),
                )),
                Arc::new(LocalRecordingFileStore::new(recordings_dir.clone())),
                Arc::new(SystemRecordingClock::new()),
            )
            .with_disk_space(Arc::new(WindowsDiskSpaceProbe { path: recordings_dir }))
            .with_warning_sink(Arc::new(TauriRecordingWarningSink::new(app.clone())))
            .with_failure_sink(Arc::new(TauriRecordingFailureSink::new(app)));
        }

        #[cfg(target_os = "macos")]
        {
            let recordings_dir = paths.user_data_dir.join(crate::RECORDINGS_DIR_NAME);
            return Self::new(
                Arc::new(macos::MacosRecordingBackend::default()),
                Arc::new(mixer::FfmpegRecordingFinalizer::new(
                    paths.resource_dir.clone(),
                    recordings_dir.clone(),
                )),
                Arc::new(LocalRecordingFileStore::new(recordings_dir)),
                Arc::new(SystemRecordingClock::new()),
            )
            .with_warning_sink(Arc::new(TauriRecordingWarningSink::new(app.clone())))
            .with_failure_sink(Arc::new(TauriRecordingFailureSink::new(app)));
        }

        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = paths;
            Self::default()
                .with_warning_sink(Arc::new(TauriRecordingWarningSink::new(app.clone())))
                .with_failure_sink(Arc::new(TauriRecordingFailureSink::new(app)))
        }
    }

    pub(crate) fn new(
        backend: Arc<dyn RecordingBackend>,
        finalizer: Arc<dyn RecordingFinalizer>,
        file_store: Arc<dyn RecordingFileStore>,
        clock: Arc<dyn RecordingClock>,
    ) -> Self {
        Self {
            backend,
            finalizer,
            file_store,
            clock,
            disk_space: Arc::new(NoDiskSpaceProbe),
            warning_sink: Arc::new(NoopRecordingWarningSink),
            failure_sink: Arc::new(NoopRecordingFailureSink),
            state: Arc::new(Mutex::new(ControllerState::Idle)),
            acknowledged_failure: Mutex::new(None),
        }
    }

    #[cfg(any(windows, test))]
    pub(crate) fn with_disk_space(mut self, disk_space: Arc<dyn RecordingDiskSpace>) -> Self {
        self.disk_space = disk_space;
        self
    }

    pub(crate) fn with_warning_sink(
        mut self,
        warning_sink: Arc<dyn RecordingWarningSink>,
    ) -> Self {
        self.warning_sink = warning_sink;
        self
    }

    #[cfg(any(windows, test))]
    pub(crate) fn with_failure_sink(mut self, failure_sink: Arc<dyn RecordingFailureSink>) -> Self {
        self.failure_sink = failure_sink;
        self
    }

    pub(crate) fn capabilities(&self) -> Result<RecordingCapabilities, RecordingError> {
        self.backend.capabilities()
    }

    pub(crate) fn start(
        &self,
        mode: RecordingMode,
    ) -> Result<StartRecordingResponse, RecordingError> {
        let mut state = self.lock_state()?;
        if matches!(
            &*state,
            ControllerState::Starting
                | ControllerState::Recording(_)
                | ControllerState::Stopping { .. }
                | ControllerState::Finalizing
        ) {
            return Err(RecordingError::new(RECORDING_ALREADY_ACTIVE));
        }
        if matches!(
            &*state,
            ControllerState::Failed(RecordingFailureView {
                cleanup_pending: true,
                ..
            })
        ) {
            return Err(RecordingError::new(RECORDING_ALREADY_ACTIVE));
        }

        *state = ControllerState::Starting;

        let capabilities = match self.backend.capabilities() {
            Ok(capabilities) => capabilities,
            Err(error) => {
                *state = ControllerState::Idle;
                return Err(error);
            }
        };

        if let Err(error) = validate_mode(mode, &capabilities) {
            *state = ControllerState::Idle;
            return Err(error);
        }

        let session_id = Uuid::new_v4().to_string();
        let workspace = match self.file_store.prepare(&session_id) {
            Ok(workspace) => workspace,
            Err(error) => {
                *state = ControllerState::Idle;
                return Err(error);
            }
        };

        let warnings = WarningAccumulator::default();
        let reporter = RecordingWarningReporter::new(
            session_id.clone(),
            warnings.clone(),
            self.warning_sink.clone(),
        );
        let (failure_reporter, mut failure_monitor) = recording_failure_channel();
        let session_failure_reporter = failure_reporter.clone();
        let capture = match self
            .backend
            .start(mode, &workspace, reporter, failure_reporter)
        {
            Ok(capture) => capture,
            Err(error) => {
                let _ = self.file_store.cleanup(&workspace);
                *state = ControllerState::Idle;
                return Err(error);
            }
        };

        if let Err(error) = failure_monitor.accept() {
            let _ = capture.cancel();
            let _ = self.file_store.cleanup(&workspace);
            *state = ControllerState::Idle;
            return Err(error);
        }

        let started_at_ms = self.clock.now_ms();
        self.acknowledged_failure
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();

        *state = ControllerState::Recording(RecordingSession {
            session_id: session_id.clone(),
            mode,
            started_at_ms,
            workspace,
            capture,
            warnings,
            failure_reporter: session_failure_reporter,
        });
        drop(state);
        self.spawn_failure_monitor(failure_monitor);

        let mut warnings = Vec::new();
        if let Some(free_bytes) = self.disk_space.free_bytes() {
            if free_bytes < LOW_DISK_WARNING_BYTES {
                warnings.push(RecordingErrorCode::DiskSpaceLow);
            }
        }

        Ok(StartRecordingResponse {
            session_id,
            warnings,
        })
    }

    pub(crate) fn state(&self) -> Result<Option<RecordingStateView>, RecordingError> {
        let state = self.lock_state()?;
        Ok(match &*state {
            ControllerState::Recording(session) => Some(RecordingStateView::Recording {
                session_id: session.session_id.clone(),
                mode: session.mode,
                elapsed_ms: self.clock.now_ms().saturating_sub(session.started_at_ms),
                warnings: session.warnings.snapshot(),
            }),
            ControllerState::Failed(failure) => {
                Some(RecordingStateView::Failed {
                    failure: failure.clone(),
                })
            }
            ControllerState::Idle
            | ControllerState::Starting
            | ControllerState::Stopping { .. }
            | ControllerState::Finalizing
            => None,
        })
    }

    pub(crate) fn stop(&self, session_id: &str) -> Result<RecordingResult, RecordingError> {
        if let Some(error) = self.failed_session_error(session_id)? {
            return Err(error);
        }

        let active = self.take_active_session_for_stop(session_id)?;
        let RecordingSession {
            session_id: active_session_id,
            mode,
            workspace,
            capture,
            warnings,
            failure_reporter,
            ..
        } = active;

        let operation_result = capture.stop().and_then(|captured| {
            if let Some(error) = failure_reporter.snapshot() {
                return Err(error);
            }
            if captured.valid_frame_count == 0 {
                let error = RecordingError::new(RECORDING_EMPTY);
                return Err(match mode {
                    RecordingMode::Mic => error.for_source(RecordingSource::Microphone),
                    RecordingMode::System => error.for_source(RecordingSource::SystemAudio),
                    RecordingMode::Mixed => error,
                });
            }

            self.mark_finalizing(&active_session_id)?;
            self.finalizer.finalize(&workspace, captured, mode)
        });
        let cleanup_result = self.file_store.cleanup(&workspace);
        let warning_snapshot = warnings.snapshot();
        if self.cancel_was_requested(&active_session_id)? {
            let cleanup_error = cleanup_result.err();
            if let Some(error) = cleanup_error {
                let failure = self.failure_view(
                    &active_session_id,
                    mode,
                    self.clock.now_ms(),
                    error.clone(),
                    false,
                    warning_snapshot,
                );
                self.store_failure(failure);
                return Err(error);
            }
            *self.lock_state()? = ControllerState::Idle;
            return Err(RecordingError::new(RECORDING_SESSION_INVALID));
        }

        let result = match operation_result {
            Err(error) => {
                let failure = self.failure_view(
                    &active_session_id,
                    mode,
                    self.clock.now_ms(),
                    error.clone(),
                    false,
                    warning_snapshot,
                );
                self.store_failure(failure);
                Err(error)
            }
            Ok(finalized) => cleanup_result.map(|()| {
                let mut result: RecordingResult = finalized.into();
                result.warnings = warning_snapshot;
                result
            }).map_err(|error| {
                let failure = self.failure_view(
                    &active_session_id,
                    mode,
                    self.clock.now_ms(),
                    error.clone(),
                    false,
                    Vec::new(),
                );
                self.store_failure(failure);
                error
            }),
        };

        match result {
            Ok(finalized) => {
                *self.lock_state()? = ControllerState::Idle;
                Ok(finalized)
            }
            Err(error) => Err(error),
        }
    }

    pub(crate) fn close(&self) -> Result<(), RecordingError> {
        let active_session_id = {
            let state = self.lock_state()?;
            match &*state {
                ControllerState::Recording(active) => Some(active.session_id.clone()),
                ControllerState::Starting
                | ControllerState::Stopping { .. }
                | ControllerState::Finalizing => {
                    return Err(RecordingError::new(RECORDING_STATE_UNAVAILABLE));
                }
                ControllerState::Idle | ControllerState::Failed(_) => None,
            }
        };

        if let Some(session_id) = active_session_id {
            self.stop(&session_id)?;
        }
        Ok(())
    }

    pub(crate) fn cancel(&self, session_id: &str) -> Result<(), RecordingError> {
        let (active, cancel_handle) = {
            let mut state = self.lock_state()?;
            match &mut *state {
                ControllerState::Failed(failure) if failure.session_id == session_id => return Ok(()),
                ControllerState::Failed(_) => {
                    return Err(RecordingError::new(RECORDING_SESSION_INVALID))
                }
                ControllerState::Stopping {
                    session_id: active_session_id,
                    cancel,
                    cancel_requested,
                } if active_session_id == session_id => {
                    *cancel_requested = true;
                    return if let Some(cancel) = cancel.clone() {
                        cancel.request();
                        Ok(())
                    } else {
                        Ok(())
                    };
                }
                ControllerState::Finalizing => {
                    return Err(RecordingError::new(RECORDING_SESSION_INVALID))
                }
                ControllerState::Recording(active) if active.session_id == session_id => {
                    let active = match std::mem::replace(&mut *state, ControllerState::Idle) {
                        ControllerState::Recording(active) => active,
                        _ => unreachable!("recording state changed while locked"),
                    };
                    let cancel_handle = active.capture.cancel_handle();
                    *state = ControllerState::Stopping {
                        session_id: session_id.to_string(),
                        cancel: cancel_handle.clone(),
                        cancel_requested: true,
                    };
                    (active, cancel_handle)
                }
                _ => return Err(RecordingError::new(RECORDING_SESSION_INVALID)),
            }
        };

        if let Some(cancel) = cancel_handle {
            cancel.request();
        }
        let RecordingSession {
            session_id: active_session_id,
            mode,
            workspace,
            capture,
            failure_reporter,
            ..
        } = active;

        let cancel_result = capture.cancel();
        let cleanup_result = self.file_store.cleanup(&workspace);
        let result = match failure_reporter.snapshot() {
            Some(error) => Err(error),
            None => cancel_result.and(cleanup_result),
        };

        match result {
            Ok(()) => {
                *self.lock_state()? = ControllerState::Idle;
                Ok(())
            }
            Err(error) => {
                let failure = self.failure_view(
                    &active_session_id,
                    mode,
                    self.clock.now_ms(),
                    error.clone(),
                    false,
                    Vec::new(),
                );
                self.store_failure(failure);
                Err(error)
            }
        }
    }

    pub(crate) fn acknowledge_failure(&self, session_id: &str) -> Result<(), RecordingError> {
        let mut state = self.lock_state()?;
        match &*state {
            ControllerState::Failed(failure) if failure.session_id == session_id => {
                if failure.cleanup_pending {
                    return Err(RecordingError::new(RECORDING_CLEANUP_IN_PROGRESS));
                }
                *state = ControllerState::Idle;
                *self
                    .acknowledged_failure
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(session_id.to_string());
                Ok(())
            }
            ControllerState::Failed(_) => Err(RecordingError::new(RECORDING_SESSION_INVALID)),
            ControllerState::Idle
                if self
                    .acknowledged_failure
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .as_deref()
                    == Some(session_id) => Ok(()),
            _ => Err(RecordingError::new(RECORDING_SESSION_INVALID)),
        }
    }

    fn take_active_session_for_stop(&self, session_id: &str) -> Result<RecordingSession, RecordingError> {
        let mut state = self.lock_state()?;
        let previous = std::mem::replace(&mut *state, ControllerState::Idle);

        match previous {
            ControllerState::Recording(active) if active.session_id == session_id => {
                let cancel = active.capture.cancel_handle();
                *state = ControllerState::Stopping {
                    session_id: session_id.to_string(),
                    cancel,
                    cancel_requested: false,
                };
                Ok(active)
            }
            previous => {
                *state = previous;
                Err(RecordingError::new(RECORDING_SESSION_INVALID))
            }
        }
    }

    fn failed_session_error(&self, session_id: &str) -> Result<Option<RecordingError>, RecordingError> {
        let state = self.lock_state()?;
        Ok(match &*state {
            ControllerState::Failed(failure) if failure.session_id == session_id => {
                Some(RecordingError {
                    code: failure.error_code,
                    message: failure.error_code.message(),
                    source: failure.source,
                })
            }
            ControllerState::Failed(_) => Some(RecordingError::new(RECORDING_SESSION_INVALID)),
            _ => None,
        })
    }

    fn mark_finalizing(&self, session_id: &str) -> Result<(), RecordingError> {
        let mut state = self.lock_state()?;
        match &*state {
            ControllerState::Stopping {
                session_id: active_session_id,
                cancel_requested: false,
                ..
            } if active_session_id == session_id => {
                *state = ControllerState::Finalizing;
                Ok(())
            }
            _ => Err(RecordingError::new(RECORDING_SESSION_INVALID)),
        }
    }

    fn cancel_was_requested(&self, session_id: &str) -> Result<bool, RecordingError> {
        let state = self.lock_state()?;
        Ok(matches!(
            &*state,
            ControllerState::Stopping {
                session_id: active_session_id,
                cancel_requested: true,
                ..
            } if active_session_id == session_id
        ))
    }

    fn failure_view(
        &self,
        session_id: &str,
        mode: RecordingMode,
        elapsed_ms: u64,
        error: RecordingError,
        cleanup_pending: bool,
        warnings: Vec<RecordingWarningView>,
    ) -> RecordingFailureView {
        RecordingFailureView {
            session_id: session_id.to_string(),
            mode,
            elapsed_ms,
            error_code: error.code,
            source: error.source,
            cleanup_pending,
            warnings,
        }
    }

    fn store_failure(&self, failure: RecordingFailureView) {
        if let Ok(mut state) = self.state.lock() {
            *state = ControllerState::Failed(failure.clone());
        }
        let _ = self.failure_sink.emit(&failure);
    }

    fn spawn_failure_monitor(&self, monitor: RecordingFailureMonitor) {
        let state = Arc::clone(&self.state);
        let clock = Arc::clone(&self.clock);
        let file_store = Arc::clone(&self.file_store);
        let failure_sink = Arc::clone(&self.failure_sink);
        let _ = thread::Builder::new()
            .name("recording-failure-supervisor".to_string())
            .spawn(move || supervise_runtime_failure(monitor, state, clock, file_store, failure_sink));
    }

    fn lock_state(&self) -> Result<MutexGuard<'_, ControllerState>, RecordingError> {
        self.state
            .lock()
            .map_err(|_| RecordingError::new(RECORDING_STATE_UNAVAILABLE))
    }
}

fn supervise_runtime_failure(
    monitor: RecordingFailureMonitor,
    state: Arc<Mutex<ControllerState>>,
    clock: Arc<dyn RecordingClock>,
    file_store: Arc<dyn RecordingFileStore>,
    failure_sink: Arc<dyn RecordingFailureSink>,
) {
    if monitor.wait().is_err() {
        return;
    }
    let Some(error) = monitor.snapshot() else {
        return;
    };

    let (session_id, capture, workspace, failure) = {
        let mut state = match state.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        let previous = std::mem::replace(&mut *state, ControllerState::Idle);
        match previous {
            ControllerState::Recording(active) => {
                let failure = RecordingFailureView {
                    session_id: active.session_id.clone(),
                    mode: active.mode,
                    elapsed_ms: clock.now_ms().saturating_sub(active.started_at_ms),
                    error_code: error.code,
                    source: error.source,
                    cleanup_pending: true,
                    warnings: active.warnings.snapshot(),
                };
                let session_id = active.session_id.clone();
                let capture = active.capture;
                let workspace = active.workspace;
                *state = ControllerState::Failed(failure.clone());
                (session_id, capture, workspace, failure)
            }
            previous => {
                *state = previous;
                return;
            }
        }
    };

    let _ = failure_sink.emit(&failure);
    let cancel_result = capture.cancel_for_cleanup();
    let cleanup_confirmed = if cancel_result.is_ok() {
        let _ = file_store.cleanup(&workspace);
        true
    } else {
        false
    };

    if cleanup_confirmed {
        let completed = {
            let mut state = match state.lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            let ControllerState::Failed(current) = &mut *state else {
                return;
            };
            if current.session_id != session_id {
                return;
            }
            current.cleanup_pending = false;
            current.clone()
        };
        let _ = failure_sink.emit(&completed);
    }
}

impl Default for RecordingController {
    fn default() -> Self {
        Self::new(
            Arc::new(UnavailableRecordingBackend),
            Arc::new(UnavailableRecordingFinalizer),
            Arc::new(UnavailableRecordingFileStore),
            Arc::new(SystemRecordingClock::new()),
        )
    }
}

fn validate_mode(
    mode: RecordingMode,
    capabilities: &RecordingCapabilities,
) -> Result<(), RecordingError> {
    if capabilities.platform == RecordingPlatform::Unsupported {
        return Err(RecordingError::new(RECORDING_PLATFORM_UNSUPPORTED));
    }

    if mode.needs_microphone() && !capabilities.microphone.available {
        return Err(
            RecordingError::new(
                capabilities
                    .microphone
                    .reason_code
                    .unwrap_or(RECORDING_MIC_INIT_FAILED),
            )
            .for_source(RecordingSource::Microphone),
        );
    }

    if mode.needs_system_audio() && !capabilities.system_audio.available {
        return Err(
            RecordingError::new(
                capabilities
                    .system_audio
                    .reason_code
                    .unwrap_or(RECORDING_SYSTEM_AUDIO_UNAVAILABLE),
            )
            .for_source(RecordingSource::SystemAudio),
        );
    }

    if mode == RecordingMode::Mixed && !capabilities.mixed.available {
        return Err(RecordingError::new(
            capabilities
                .mixed
                .reason_code
                .unwrap_or(RECORDING_MIX_FAILED),
        ));
    }

    Ok(())
}

impl From<FinalizedRecording> for RecordingResult {
    fn from(finalized: FinalizedRecording) -> Self {
        Self {
            path: finalized.path.to_string_lossy().into_owned(),
            display_name: finalized.display_name,
            duration_ms: finalized.duration_ms,
            size_bytes: finalized.size_bytes,
            warnings: Vec::new(),
        }
    }
}

struct SystemRecordingClock {
    origin: Instant,
}

impl SystemRecordingClock {
    fn new() -> Self {
        Self {
            origin: Instant::now(),
        }
    }
}

impl RecordingClock for SystemRecordingClock {
    fn now_ms(&self) -> u64 {
        self.origin
            .elapsed()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX)
    }
}

struct UnavailableRecordingBackend;

impl RecordingBackend for UnavailableRecordingBackend {
    fn capabilities(&self) -> Result<RecordingCapabilities, RecordingError> {
        let platform = if cfg!(windows) {
            RecordingPlatform::Windows
        } else {
            RecordingPlatform::Unsupported
        };
        let unavailable = RecordingSourceCapability {
            available: false,
            reason_code: Some(RECORDING_PLATFORM_UNSUPPORTED),
        };

        Ok(RecordingCapabilities {
            platform,
            microphone: unavailable.clone(),
            system_audio: unavailable.clone(),
            mixed: unavailable,
        })
    }

    fn start(
        &self,
        _mode: RecordingMode,
        _workspace: &CaptureWorkspace,
        _reporter: RecordingWarningReporter,
        _failure_reporter: RecordingFailureReporter,
    ) -> Result<Box<dyn ActiveCapture>, RecordingError> {
        Err(RecordingError::new(RECORDING_PLATFORM_UNSUPPORTED))
    }
}

struct UnavailableRecordingFinalizer;

impl RecordingFinalizer for UnavailableRecordingFinalizer {
    fn finalize(
        &self,
        _workspace: &CaptureWorkspace,
        _capture: CapturedRecording,
        _mode: RecordingMode,
    ) -> Result<FinalizedRecording, RecordingError> {
        Err(RecordingError::new(RECORDING_FINALIZE_FAILED))
    }
}

struct UnavailableRecordingFileStore;

impl RecordingFileStore for UnavailableRecordingFileStore {
    fn prepare(&self, _session_id: &str) -> Result<CaptureWorkspace, RecordingError> {
        Err(RecordingError::new(RECORDING_PLATFORM_UNSUPPORTED))
    }

    fn cleanup(&self, _workspace: &CaptureWorkspace) -> Result<(), RecordingError> {
        Ok(())
    }
}

struct LocalRecordingFileStore {
    recordings_dir: PathBuf,
}

impl LocalRecordingFileStore {
    fn new(recordings_dir: PathBuf) -> Self {
        Self { recordings_dir }
    }
}

impl RecordingFileStore for LocalRecordingFileStore {
    fn prepare(&self, session_id: &str) -> Result<CaptureWorkspace, RecordingError> {
        let temp_dir = self
            .recordings_dir
            .join(crate::RECORDING_TEMP_DIR_NAME)
            .join(session_id);
        std::fs::create_dir_all(&temp_dir)
            .map_err(|_| RecordingError::new(RECORDING_WRITE_FAILED))?;
        Ok(CaptureWorkspace {
            session_id: session_id.to_string(),
            temp_dir,
        })
    }

    fn cleanup(&self, workspace: &CaptureWorkspace) -> Result<(), RecordingError> {
        let temp_root = self.recordings_dir.join(crate::RECORDING_TEMP_DIR_NAME);
        let canonical_root = temp_root
            .canonicalize()
            .map_err(|_| RecordingError::new(RECORDING_WRITE_FAILED))?;
        let canonical_workspace = workspace
            .temp_dir
            .canonicalize()
            .map_err(|_| RecordingError::new(RECORDING_WRITE_FAILED))?;
        if canonical_workspace == canonical_root
            || !canonical_workspace.starts_with(&canonical_root)
        {
            return Err(RecordingError::new(RECORDING_WRITE_FAILED));
        }
        if workspace.temp_dir.exists() {
            std::fs::remove_dir_all(&workspace.temp_dir)
                .map_err(|_| RecordingError::new(RECORDING_WRITE_FAILED))?;
        }
        Ok(())
    }
}

#[tauri::command]
pub(crate) fn get_recording_capabilities(
    state: State<'_, RecordingController>,
) -> Result<RecordingCapabilities, RecordingError> {
    state.capabilities()
}

#[tauri::command]
pub(crate) fn start_recording(
    state: State<'_, RecordingController>,
    mode: RecordingMode,
) -> Result<StartRecordingResponse, RecordingError> {
    state.start(mode)
}

#[tauri::command]
pub(crate) fn stop_recording(
    state: State<'_, RecordingController>,
    session_id: String,
) -> Result<RecordingResult, RecordingError> {
    state.stop(&session_id)
}

#[tauri::command]
pub(crate) fn cancel_recording(
    state: State<'_, RecordingController>,
    session_id: String,
) -> Result<(), RecordingError> {
    state.cancel(&session_id)
}

#[tauri::command]
pub(crate) fn get_recording_state(
    state: State<'_, RecordingController>,
) -> Result<Option<RecordingStateView>, RecordingError> {
    state.state()
}

#[tauri::command]
pub(crate) fn acknowledge_recording_failure(
    state: State<'_, RecordingController>,
    session_id: String,
) -> Result<(), RecordingError> {
    state.acknowledge_failure(&session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::sync::Condvar;
    use std::time::Duration;

    struct FakeClock {
        now_ms: AtomicU64,
    }

    impl FakeClock {
        fn new(now_ms: u64) -> Self {
            Self {
                now_ms: AtomicU64::new(now_ms),
            }
        }
    }

    impl RecordingClock for FakeClock {
        fn now_ms(&self) -> u64 {
            self.now_ms.load(Ordering::SeqCst)
        }
    }

    struct FakeFileStore;

    impl RecordingFileStore for FakeFileStore {
        fn prepare(&self, session_id: &str) -> Result<CaptureWorkspace, RecordingError> {
            Ok(CaptureWorkspace {
                session_id: session_id.to_string(),
                temp_dir: PathBuf::from(format!("temp-{session_id}")),
            })
        }

        fn cleanup(&self, _workspace: &CaptureWorkspace) -> Result<(), RecordingError> {
            Ok(())
        }
    }

    struct FakeCapture {
        stop_result: Result<CapturedRecording, RecordingError>,
        cancel_result: Result<(), RecordingError>,
        cancel_started: Option<Sender<()>>,
        cancel_release: Option<Arc<(Mutex<bool>, Condvar)>>,
    }

    impl ActiveCapture for FakeCapture {
        fn stop(self: Box<Self>) -> Result<CapturedRecording, RecordingError> {
            self.stop_result
        }

        fn cancel(self: Box<Self>) -> Result<(), RecordingError> {
            if let Some(started) = self.cancel_started {
                let _ = started.send(());
            }
            if let Some(release) = self.cancel_release {
                let (released, condition) = &*release;
                let mut released = released.lock().expect("cancel release lock");
                while !*released {
                    released = condition
                        .wait(released)
                        .expect("cancel release wait");
                }
            }
            self.cancel_result
        }
    }

    struct FakeBackend {
        capabilities: RecordingCapabilities,
        start_error: Option<RecordingError>,
        stop_error: Option<RecordingError>,
        cancel_error: Option<RecordingError>,
        captured: CapturedRecording,
        warning_gaps_ms: Vec<u64>,
        terminal_reporter: Arc<Mutex<Option<RecordingFailureReporter>>>,
        start_reporter_error: Option<RecordingError>,
        cancel_started: Arc<Mutex<Option<Sender<()>>>>,
        cancel_release: Option<Arc<(Mutex<bool>, Condvar)>>,
    }

    impl FakeBackend {
        fn available(captured: CapturedRecording) -> Self {
            Self {
                capabilities: RecordingCapabilities {
                    platform: RecordingPlatform::Windows,
                    microphone: RecordingSourceCapability {
                        available: true,
                        reason_code: None,
                    },
                    system_audio: RecordingSourceCapability {
                        available: true,
                        reason_code: None,
                    },
                    mixed: RecordingSourceCapability {
                        available: true,
                        reason_code: None,
                    },
                },
                start_error: None,
                stop_error: None,
                cancel_error: None,
                captured,
                warning_gaps_ms: Vec::new(),
                terminal_reporter: Arc::new(Mutex::new(None)),
                start_reporter_error: None,
                cancel_started: Arc::new(Mutex::new(None)),
                cancel_release: None,
            }
        }
    }

    impl RecordingBackend for FakeBackend {
        fn capabilities(&self) -> Result<RecordingCapabilities, RecordingError> {
            Ok(self.capabilities.clone())
        }

        fn start(
            &self,
            _mode: RecordingMode,
            _workspace: &CaptureWorkspace,
            reporter: RecordingWarningReporter,
            terminal_reporter: RecordingFailureReporter,
        ) -> Result<Box<dyn ActiveCapture>, RecordingError> {
            if let Some(error) = &self.start_error {
                return Err(error.clone());
            }

            if let Some(error) = &self.start_reporter_error {
                terminal_reporter.report(error.clone());
            }

            *self
                .terminal_reporter
                .lock()
                .expect("terminal reporter lock") = Some(terminal_reporter);

            for gap_ms in &self.warning_gaps_ms {
                reporter.record_recovery(*gap_ms);
            }

            Ok(Box::new(FakeCapture {
                stop_result: self
                    .stop_error
                    .clone()
                    .map_or_else(|| Ok(self.captured.clone()), Err),
                cancel_result: self.cancel_error.clone().map_or(Ok(()), Err),
                cancel_started: self
                    .cancel_started
                    .lock()
                    .expect("cancel started lock")
                    .take(),
                cancel_release: self.cancel_release.clone(),
            }))
        }
    }

    struct FakeFinalizer;

    impl RecordingFinalizer for FakeFinalizer {
        fn finalize(
            &self,
            _workspace: &CaptureWorkspace,
            capture: CapturedRecording,
            _mode: RecordingMode,
        ) -> Result<FinalizedRecording, RecordingError> {
            Ok(FinalizedRecording {
                path: PathBuf::from("final.wav"),
                display_name: "final.wav".to_string(),
                duration_ms: capture.duration_ms,
                size_bytes: 4,
            })
        }
    }

    struct FailingFinalizer;

    impl RecordingFinalizer for FailingFinalizer {
        fn finalize(
            &self,
            _workspace: &CaptureWorkspace,
            _capture: CapturedRecording,
            _mode: RecordingMode,
        ) -> Result<FinalizedRecording, RecordingError> {
            Err(RecordingError::new(RECORDING_FINALIZE_FAILED))
        }
    }

    fn controller() -> RecordingController {
        RecordingController::new(
            Arc::new(FakeBackend::available(CapturedRecording {
                source_paths: Vec::new(),
                valid_frame_count: 1,
                silent: false,
                duration_ms: 100,
            })),
            Arc::new(FakeFinalizer),
            Arc::new(FakeFileStore),
            Arc::new(FakeClock::new(1_000)),
        )
    }

    struct FailingWarningSink;

    impl RecordingWarningSink for FailingWarningSink {
        fn emit(
            &self,
            _session_id: &str,
            _warning: &RecordingWarningView,
        ) -> Result<(), RecordingError> {
            Err(RecordingError::new(RECORDING_STREAM_ERROR))
        }
    }

    struct CapturingWarningSink {
        events: Arc<Mutex<Vec<RecordingWarningEvent>>>,
    }

    impl RecordingWarningSink for CapturingWarningSink {
        fn emit(
            &self,
            session_id: &str,
            warning: &RecordingWarningView,
        ) -> Result<(), RecordingError> {
            self.events
                .lock()
                .expect("warning event lock")
                .push(RecordingWarningEvent::from_warning(session_id, warning));
            Ok(())
        }
    }

    struct CapturingFailureSink {
        events: Arc<Mutex<Vec<RecordingFailureView>>>,
        notifications: Sender<()>,
    }

    impl RecordingFailureSink for CapturingFailureSink {
        fn emit(&self, failure: &RecordingFailureView) -> Result<(), RecordingError> {
            self.events
                .lock()
                .expect("failure event lock")
                .push(failure.clone());
            self.notifications
                .send(())
                .expect("failure notification receiver");
            Ok(())
        }
    }

    fn release_cancel(release: &Arc<(Mutex<bool>, Condvar)>) {
        let (released, condition) = &**release;
        *released.lock().expect("cancel release lock") = true;
        condition.notify_all();
    }

    fn runtime_failure_controller(
        release: Option<Arc<(Mutex<bool>, Condvar)>>,
    ) -> (
        RecordingController,
        Arc<Mutex<Option<RecordingFailureReporter>>>,
        Arc<Mutex<Vec<PathBuf>>>,
        Receiver<()>,
        Receiver<()>,
    ) {
        let mut backend = FakeBackend::available(CapturedRecording {
            source_paths: Vec::new(),
            valid_frame_count: 1,
            silent: false,
            duration_ms: 100,
        });
        let terminal_reporter = Arc::clone(&backend.terminal_reporter);
        let (cancel_started, cancel_started_receiver) = mpsc::channel();
        *backend
            .cancel_started
            .lock()
            .expect("cancel started lock") = Some(cancel_started);
        backend.cancel_release = release;
        let file_store = TrackingFileStore::new();
        let cleaned = Arc::clone(&file_store.cleaned);
        let events = Arc::new(Mutex::new(Vec::new()));
        let (notifications, notification_receiver) = mpsc::channel();
        let controller = RecordingController::new(
            Arc::new(backend),
            Arc::new(FakeFinalizer),
            Arc::new(file_store),
            Arc::new(FakeClock::new(1_000)),
        )
        .with_failure_sink(Arc::new(CapturingFailureSink {
            events,
            notifications,
        }));
        (
            controller,
            terminal_reporter,
            cleaned,
            cancel_started_receiver,
            notification_receiver,
        )
    }

    #[test]
    fn accepted_runtime_failure_emits_before_blocked_capture_cleanup_finishes() {
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let (controller, reporter, cleaned, cancel_started, notifications) =
            runtime_failure_controller(Some(Arc::clone(&release)));
        let started = controller
            .start(RecordingMode::Mixed)
            .expect("start recording");
        reporter
            .lock()
            .expect("terminal reporter lock")
            .as_ref()
            .expect("terminal reporter")
            .report(
                RecordingError::new(RECORDING_STREAM_ERROR)
                    .for_source(RecordingSource::SystemAudio),
            );

        notifications
            .recv()
            .expect("failure event before cleanup");
        cancel_started.recv().expect("capture cancellation started");
        let state = controller
            .state()
            .expect("read failed state")
            .expect("failed state");
        assert!(matches!(state, RecordingStateView::Failed { ref failure } if
            failure.session_id == started.session_id && failure.cleanup_pending));
        assert!(cleaned.lock().expect("cleaned lock").is_empty());

        release_cancel(&release);
        notifications
            .recv()
            .expect("failure event after cleanup");
        assert_eq!(cleaned.lock().expect("cleaned lock").len(), 1);
    }

    #[test]
    fn runtime_failure_state_hydrates_with_same_failure_view() {
        let (controller, reporter, _cleaned, _cancel_started, notifications) =
            runtime_failure_controller(None);
        controller
            .start(RecordingMode::System)
            .expect("start recording");
        reporter
            .lock()
            .expect("terminal reporter lock")
            .as_ref()
            .expect("terminal reporter")
            .report(RecordingError::new(RECORDING_STREAM_ERROR));

        notifications
            .recv()
            .expect("initial failure event");
        let state = controller
            .state()
            .expect("read failed state")
            .expect("failed state");
        let payload = serde_json::to_value(&state).expect("serialize state");
        notifications
            .recv()
            .expect("completed failure event");
        let completed = controller
            .state()
            .expect("read completed failed state")
            .expect("completed failed state");
        assert_eq!(payload["status"], "failed");
        assert_eq!(payload["sessionId"], serde_json::to_value(completed).unwrap()["sessionId"]);
    }

    #[test]
    fn runtime_failure_cancels_capture_and_cleans_workspace_in_background() {
        let (controller, reporter, cleaned, cancel_started, notifications) =
            runtime_failure_controller(None);
        let started = controller
            .start(RecordingMode::Mic)
            .expect("start recording");
        reporter
            .lock()
            .expect("terminal reporter lock")
            .as_ref()
            .expect("terminal reporter")
            .report(RecordingError::new(RECORDING_STREAM_ERROR));

        notifications.recv().expect("failure event");
        cancel_started.recv().expect("capture cancellation");
        notifications.recv().expect("cleanup completion event");
        assert_eq!(cleaned.lock().expect("cleaned lock").len(), 1);
        assert!(matches!(
            controller
                .state()
                .expect("read failed state")
                .expect("failed state"),
            RecordingStateView::Failed { ref failure }
                if failure.session_id == started.session_id && !failure.cleanup_pending
        ));
    }

    #[test]
    fn runtime_failure_keeps_workspace_when_capture_cleanup_fails() {
        let mut backend = FakeBackend::available(CapturedRecording {
            source_paths: Vec::new(),
            valid_frame_count: 1,
            silent: false,
            duration_ms: 100,
        });
        backend.cancel_error = Some(RecordingError::new(RECORDING_STREAM_ERROR));
        let terminal_reporter = Arc::clone(&backend.terminal_reporter);
        let file_store = TrackingFileStore::new();
        let cleaned = Arc::clone(&file_store.cleaned);
        let events = Arc::new(Mutex::new(Vec::new()));
        let (notifications, notification_receiver) = mpsc::channel();
        let controller = RecordingController::new(
            Arc::new(backend),
            Arc::new(FakeFinalizer),
            Arc::new(file_store),
            Arc::new(FakeClock::new(1_000)),
        )
        .with_failure_sink(Arc::new(CapturingFailureSink {
            events,
            notifications,
        }));
        let started = controller
            .start(RecordingMode::Mic)
            .expect("start recording");
        terminal_reporter
            .lock()
            .expect("terminal reporter lock")
            .as_ref()
            .expect("terminal reporter")
            .report(RecordingError::new(RECORDING_STREAM_ERROR));

        notification_receiver
            .recv()
            .expect("initial failure event");
        assert!(notification_receiver
            .recv_timeout(Duration::from_millis(100))
            .is_err());
        assert!(cleaned.lock().expect("cleaned lock").is_empty());
        assert!(matches!(
            controller
                .state()
                .expect("read failed state")
                .expect("failed state"),
            RecordingStateView::Failed { ref failure }
                if failure.session_id == started.session_id && failure.cleanup_pending
        ));
    }

    #[test]
    fn runtime_failure_allows_recovery_when_workspace_cleanup_fails_after_capture_teardown() {
        let backend = FakeBackend::available(CapturedRecording {
            source_paths: Vec::new(),
            valid_frame_count: 1,
            silent: false,
            duration_ms: 100,
        });
        let terminal_reporter = Arc::clone(&backend.terminal_reporter);
        let file_store = TrackingFileStore::with_cleanup_error(RecordingError::new(
            RECORDING_WRITE_FAILED,
        ));
        let cleaned = Arc::clone(&file_store.cleaned);
        let events = Arc::new(Mutex::new(Vec::new()));
        let (notifications, notification_receiver) = mpsc::channel();
        let controller = RecordingController::new(
            Arc::new(backend),
            Arc::new(FakeFinalizer),
            Arc::new(file_store),
            Arc::new(FakeClock::new(1_000)),
        )
        .with_failure_sink(Arc::new(CapturingFailureSink {
            events: Arc::clone(&events),
            notifications,
        }));
        let started = controller
            .start(RecordingMode::Mic)
            .expect("start recording");
        terminal_reporter
            .lock()
            .expect("terminal reporter lock")
            .as_ref()
            .expect("terminal reporter")
            .report(RecordingError::new(RECORDING_STREAM_ERROR));

        notification_receiver
            .recv()
            .expect("initial failure event");
        notification_receiver
            .recv()
            .expect("cleanup completion event");

        assert_eq!(cleaned.lock().expect("cleaned lock").len(), 1);
        assert!(matches!(
            controller
                .state()
                .expect("read failed state")
                .expect("failed state"),
            RecordingStateView::Failed { ref failure }
                if failure.session_id == started.session_id && !failure.cleanup_pending
        ));
        let events = events.lock().expect("failure events lock");
        assert_eq!(events.len(), 2);
        assert!(events[0].cleanup_pending);
        assert!(!events[1].cleanup_pending);
        assert_eq!(events[0].error_code, events[1].error_code);
        assert_eq!(events[0].source, events[1].source);
    }

    #[test]
    fn duplicate_runtime_failure_does_not_replace_identity_or_emit_a_second_user_failure() {
        let (controller, reporter, _cleaned, _cancel_started, notifications) =
            runtime_failure_controller(None);
        controller
            .start(RecordingMode::Mic)
            .expect("start recording");
        let reporter = reporter
            .lock()
            .expect("terminal reporter lock")
            .as_ref()
            .expect("terminal reporter")
            .clone();
        reporter.report(
            RecordingError::new(RECORDING_STREAM_ERROR).for_source(RecordingSource::SystemAudio),
        );
        reporter.report(
            RecordingError::new(RECORDING_WRITE_FAILED).for_source(RecordingSource::Microphone),
        );

        notifications.recv().expect("first failure event");
        notifications.recv().expect("cleanup completion event");
        assert!(notifications.try_recv().is_err());
        let state = controller
            .state()
            .expect("read failed state")
            .expect("failed state");
        assert!(matches!(state, RecordingStateView::Failed { ref failure }
            if failure.error_code == RECORDING_STREAM_ERROR
                && failure.source == Some(RecordingSource::SystemAudio)));
    }

    #[test]
    fn pre_acceptance_failure_is_returned_as_startup_error_without_runtime_event() {
        let mut backend = FakeBackend::available(CapturedRecording {
            source_paths: Vec::new(),
            valid_frame_count: 1,
            silent: false,
            duration_ms: 100,
        });
        backend.start_reporter_error = Some(
            RecordingError::new(RECORDING_STREAM_ERROR)
                .for_source(RecordingSource::Microphone),
        );
        let file_store = TrackingFileStore::new();
        let cleaned = Arc::clone(&file_store.cleaned);
        let (notifications, notification_receiver) = mpsc::channel();
        let controller = RecordingController::new(
            Arc::new(backend),
            Arc::new(FakeFinalizer),
            Arc::new(file_store),
            Arc::new(FakeClock::new(1_000)),
        )
        .with_failure_sink(Arc::new(CapturingFailureSink {
            events: Arc::new(Mutex::new(Vec::new())),
            notifications,
        }));

        let error = controller
            .start(RecordingMode::Mic)
            .expect_err("pre-acceptance failure must fail start");

        assert_eq!(error.code, RECORDING_STREAM_ERROR);
        assert_eq!(error.source, Some(RecordingSource::Microphone));
        assert_eq!(cleaned.lock().expect("cleaned lock").len(), 1);
        assert!(controller.state().expect("read state").is_none());
        assert!(notification_receiver.try_recv().is_err());
    }

    #[test]
    fn stop_after_runtime_failure_returns_the_latched_error() {
        let (controller, reporter, _cleaned, _cancel_started, notifications) =
            runtime_failure_controller(None);
        let started = controller
            .start(RecordingMode::Mic)
            .expect("start recording");
        reporter
            .lock()
            .expect("terminal reporter lock")
            .as_ref()
            .expect("terminal reporter")
            .report(
                RecordingError::new(RECORDING_STREAM_ERROR)
                    .for_source(RecordingSource::SystemAudio),
            );
        notifications.recv().expect("failure event");
        notifications.recv().expect("cleanup completion event");

        let error = controller
            .stop(&started.session_id)
            .expect_err("failed session must retain the latched error");
        assert_eq!(error.code, RECORDING_STREAM_ERROR);
        assert_eq!(error.source, Some(RecordingSource::SystemAudio));
    }

    #[test]
    fn cancel_after_runtime_failure_is_idempotent_and_preserves_snapshot() {
        let (controller, reporter, _cleaned, _cancel_started, notifications) =
            runtime_failure_controller(None);
        let started = controller
            .start(RecordingMode::Mic)
            .expect("start recording");
        reporter
            .lock()
            .expect("terminal reporter lock")
            .as_ref()
            .expect("terminal reporter")
            .report(RecordingError::new(RECORDING_STREAM_ERROR));
        notifications.recv().expect("failure event");
        notifications.recv().expect("cleanup completion event");
        let before = controller.state().expect("read state");

        controller
            .cancel(&started.session_id)
            .expect("cancel after failed cleanup is idempotent");

        assert_eq!(controller.state().expect("read state"), before);
    }

    #[test]
    fn cleanup_pending_rejects_acknowledgement_and_new_start() {
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let (controller, reporter, _cleaned, cancel_started, notifications) =
            runtime_failure_controller(Some(Arc::clone(&release)));
        let started = controller
            .start(RecordingMode::Mic)
            .expect("start recording");
        reporter
            .lock()
            .expect("terminal reporter lock")
            .as_ref()
            .expect("terminal reporter")
            .report(RecordingError::new(RECORDING_STREAM_ERROR));
        notifications.recv().expect("failure event");
        cancel_started.recv().expect("capture cancellation started");

        assert_eq!(
            controller
                .acknowledge_failure(&started.session_id)
                .expect_err("pending cleanup must not be acknowledged")
                .code,
            RECORDING_CLEANUP_IN_PROGRESS
        );
        assert_eq!(
            controller
                .start(RecordingMode::Mic)
                .expect_err("pending failed session owns the controller")
                .code,
            RECORDING_ALREADY_ACTIVE
        );

        release_cancel(&release);
        notifications.recv().expect("cleanup completion event");
        controller
            .acknowledge_failure(&started.session_id)
            .expect("completed failure can be acknowledged");
        controller
            .acknowledge_failure(&started.session_id)
            .expect("duplicate acknowledgement is idempotent");
        assert!(controller.state().expect("read state").is_none());
    }

    #[test]
    fn completed_failure_can_be_replaced_by_a_new_session_without_acknowledgement() {
        let (controller, reporter, _cleaned, _cancel_started, notifications) =
            runtime_failure_controller(None);
        let first = controller
            .start(RecordingMode::Mic)
            .expect("start first recording");
        reporter
            .lock()
            .expect("terminal reporter lock")
            .as_ref()
            .expect("terminal reporter")
            .report(RecordingError::new(RECORDING_STREAM_ERROR));
        notifications.recv().expect("failure event");
        notifications.recv().expect("cleanup completion event");

        let second = controller
            .start(RecordingMode::System)
            .expect("completed failure can be replaced atomically");
        assert_ne!(first.session_id, second.session_id);
        assert!(matches!(
            controller.state().expect("read active state"),
            Some(RecordingStateView::Recording { ref session_id, mode, .. })
                if session_id == &second.session_id && mode == RecordingMode::System
        ));
        assert_eq!(
            controller
                .acknowledge_failure(&first.session_id)
                .expect_err("old failed session is no longer owned")
                .code,
            RECORDING_SESSION_INVALID
        );
    }

    #[test]
    fn new_session_ownership_atomically_clears_the_old_failure_acknowledgement() {
        let (controller, reporter, _cleaned, _cancel_started, notifications) =
            runtime_failure_controller(None);
        let first = controller
            .start(RecordingMode::Mic)
            .expect("start first recording");
        reporter
            .lock()
            .expect("terminal reporter lock")
            .as_ref()
            .expect("terminal reporter")
            .report(RecordingError::new(RECORDING_STREAM_ERROR));
        notifications.recv().expect("failure event");
        notifications.recv().expect("cleanup completion event");
        controller
            .acknowledge_failure(&first.session_id)
            .expect("acknowledge first failure");

        let second = controller
            .start(RecordingMode::Mic)
            .expect("start second recording");
        assert_ne!(first.session_id, second.session_id);
        assert_eq!(
            controller
                .acknowledge_failure(&first.session_id)
                .expect_err("old acknowledgement must not clear new session")
                .code,
            RECORDING_SESSION_INVALID
        );
    }

    fn warning_controller(
        gaps_ms: &[u64],
        sink: Arc<dyn RecordingWarningSink>,
    ) -> RecordingController {
        let mut backend = FakeBackend::available(CapturedRecording {
            source_paths: Vec::new(),
            valid_frame_count: 1,
            silent: false,
            duration_ms: 100,
        });
        backend.warning_gaps_ms = gaps_ms.to_vec();
        RecordingController::new(
            Arc::new(backend),
            Arc::new(FakeFinalizer),
            Arc::new(FakeFileStore),
            Arc::new(FakeClock::new(1_000)),
        )
        .with_warning_sink(sink)
    }

    #[test]
    fn warnings_accumulate_by_code_and_source() {
        let accumulator = WarningAccumulator::default();

        accumulator.record(
            RECORDING_SYSTEM_AUDIO_RECOVERED,
            Some(RecordingWarningSource::SystemAudio),
            400,
        );
        accumulator.record(
            RECORDING_SYSTEM_AUDIO_RECOVERED,
            Some(RecordingWarningSource::SystemAudio),
            400,
        );

        assert_eq!(
            accumulator.snapshot(),
            vec![RecordingWarningView {
                warning_code: RECORDING_SYSTEM_AUDIO_RECOVERED,
                source: Some(RecordingWarningSource::SystemAudio),
                count: 2,
                total_gap_ms: 800,
            }]
        );
        let json = serde_json::to_value(accumulator.snapshot()[0].clone()).expect("serialize warning");
        assert_eq!(json["warningCode"], "RECORDING_SYSTEM_AUDIO_RECOVERED");
        assert_eq!(json["source"], "systemAudio");
        assert_eq!(json["count"], 2);
        assert_eq!(json["totalGapMs"], 800);
    }

    #[test]
    fn warning_event_payload_is_stable() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let controller = warning_controller(
            &[1_040],
            Arc::new(CapturingWarningSink {
                events: Arc::clone(&events),
            }),
        );
        controller
            .start(RecordingMode::System)
            .expect("start recording");

        let event = events
            .lock()
            .expect("warning event lock")
            .first()
            .cloned()
            .expect("one warning event");
        assert!(!event.session_id.is_empty());
        assert_eq!(event.warning_code, RecordingErrorCode::SystemAudioRecovered);
        assert_eq!(event.source, Some(RecordingWarningSource::SystemAudio));
        assert_eq!(event.count, 1);
        assert_eq!(event.total_gap_ms, 1_040);
        let payload = serde_json::to_value(event).expect("serialize warning event");
        assert!(payload["sessionId"].is_string());
        assert_eq!(payload["warningCode"], "RECORDING_SYSTEM_AUDIO_RECOVERED");
        assert_eq!(payload["source"], "systemAudio");
        assert_eq!(payload["count"], 1);
        assert_eq!(payload["totalGapMs"], 1_040);
    }

    #[test]
    fn warning_emitter_failure_does_not_drop_accumulator() {
        let controller = warning_controller(&[400], Arc::new(FailingWarningSink));
        let started = controller
            .start(RecordingMode::System)
            .expect("warning sink failure must not fail start");

        let state = controller
            .state()
            .expect("read recording state")
            .expect("active recording state");
        let state_warnings = match &state {
            RecordingStateView::Recording { warnings, .. } => warnings.clone(),
            _ => panic!("expected recording state"),
        };
        assert_eq!(state_warnings.len(), 1);
        assert_eq!(state_warnings[0].count, 1);
        assert_eq!(state_warnings[0].total_gap_ms, 400);

        let result = controller.stop(&started.session_id).expect("stop recording");
        assert_eq!(result.warnings, state_warnings);
    }

    #[test]
    fn state_and_stop_return_recovery_warnings() {
        let controller = warning_controller(&[400, 400], Arc::new(NoopRecordingWarningSink));
        let started = controller
            .start(RecordingMode::System)
            .expect("start recording");

        let state = controller
            .state()
            .expect("read recording state")
            .expect("active recording state");
        let result = controller.stop(&started.session_id).expect("stop recording");

        let state_warnings = match state {
            RecordingStateView::Recording { warnings, .. } => warnings,
            _ => panic!("expected recording state"),
        };
        assert_eq!(state_warnings, result.warnings);
        assert_eq!(result.warnings[0].warning_code, RECORDING_SYSTEM_AUDIO_RECOVERED);
        assert_eq!(result.warnings[0].source, Some(RecordingWarningSource::SystemAudio));
        assert_eq!(result.warnings[0].count, 2);
        assert_eq!(result.warnings[0].total_gap_ms, 800);
    }

    struct TrackingFileStore {
        prepared: Arc<Mutex<Vec<PathBuf>>>,
        cleaned: Arc<Mutex<Vec<PathBuf>>>,
        cleanup_error: Option<RecordingError>,
    }

    impl TrackingFileStore {
        fn new() -> Self {
            Self {
                prepared: Arc::new(Mutex::new(Vec::new())),
                cleaned: Arc::new(Mutex::new(Vec::new())),
                cleanup_error: None,
            }
        }

        fn with_cleanup_error(error: RecordingError) -> Self {
            Self {
                cleanup_error: Some(error),
                ..Self::new()
            }
        }
    }

    impl RecordingFileStore for TrackingFileStore {
        fn prepare(&self, session_id: &str) -> Result<CaptureWorkspace, RecordingError> {
            let workspace = CaptureWorkspace {
                session_id: session_id.to_string(),
                temp_dir: PathBuf::from(format!("temp-{session_id}")),
            };
            self.prepared
                .lock()
                .expect("prepared lock")
                .push(workspace.temp_dir.clone());
            Ok(workspace)
        }

        fn cleanup(&self, workspace: &CaptureWorkspace) -> Result<(), RecordingError> {
            self.cleaned
                .lock()
                .expect("cleaned lock")
                .push(workspace.temp_dir.clone());
            self.cleanup_error.clone().map_or(Ok(()), Err)
        }
    }

    #[test]
    fn start_binds_mode_and_exposes_active_state() {
        let controller = controller();

        let started = controller
            .start(RecordingMode::Mic)
            .expect("start recording");
        let state = controller
            .state()
            .expect("read recording state")
            .expect("active recording state");

        match state {
            RecordingStateView::Recording {
                session_id,
                mode,
                elapsed_ms,
                ..
            } => {
                assert_eq!(session_id, started.session_id);
                assert_eq!(mode, RecordingMode::Mic);
                assert_eq!(elapsed_ms, 0);
            }
            _ => panic!("expected recording state"),
        }
    }

    struct FakeDiskSpace {
        free_bytes: Option<u64>,
    }

    impl RecordingDiskSpace for FakeDiskSpace {
        fn free_bytes(&self) -> Option<u64> {
            self.free_bytes
        }
    }

    #[test]
    fn low_disk_space_warns_without_blocking_start() {
        let controller = controller().with_disk_space(Arc::new(FakeDiskSpace {
            free_bytes: Some(100 * 1024 * 1024),
        }));

        let started = controller
            .start(RecordingMode::Mic)
            .expect("start must succeed with a low-disk warning");

        assert_eq!(started.warnings, vec![RecordingErrorCode::DiskSpaceLow]);
        let state = controller
            .state()
            .expect("read state")
            .expect("active state after warned start");
        assert!(matches!(state, RecordingStateView::Recording { session_id, .. } if !session_id.is_empty()));
    }

    #[test]
    fn sufficient_disk_space_starts_without_warnings() {
        let controller = controller().with_disk_space(Arc::new(FakeDiskSpace {
            free_bytes: Some(10 * 1024 * 1024 * 1024),
        }));

        let started = controller
            .start(RecordingMode::Mic)
            .expect("start recording");

        assert!(started.warnings.is_empty());
    }

    #[test]
    fn unknown_disk_space_starts_without_warnings() {
        let controller = controller().with_disk_space(Arc::new(FakeDiskSpace {
            free_bytes: None,
        }));

        let started = controller
            .start(RecordingMode::Mic)
            .expect("start recording");

        assert!(started.warnings.is_empty());
    }

    #[test]
    fn second_start_is_rejected_without_changing_the_active_mode() {
        let controller = controller();
        controller
            .start(RecordingMode::Mic)
            .expect("start first recording");

        let error = controller
            .start(RecordingMode::System)
            .expect_err("second recording must be rejected");

        assert_eq!(error.code, RECORDING_ALREADY_ACTIVE);
        assert!(matches!(
            controller
                .state()
                .expect("read state")
                .expect("active state"),
            RecordingStateView::Recording { mode: RecordingMode::Mic, .. }
        ));
    }

    #[test]
    fn invalid_session_does_not_take_the_active_capture() {
        let controller = controller();
        controller
            .start(RecordingMode::Mic)
            .expect("start recording");

        let error = controller
            .stop("not-the-active-session")
            .expect_err("wrong session must be rejected");

        assert_eq!(error.code, RECORDING_SESSION_INVALID);
        assert!(
            controller.state().expect("read state").is_some(),
            "active session must remain available"
        );
    }

    #[test]
    fn successful_stop_returns_finalized_metadata_and_returns_to_idle() {
        let controller = controller();
        let started = controller
            .start(RecordingMode::Mic)
            .expect("start recording");

        let result = controller
            .stop(&started.session_id)
            .expect("stop recording");

        assert_eq!(result.path, "final.wav");
        assert_eq!(result.display_name, "final.wav");
        assert_eq!(result.duration_ms, 100);
        assert_eq!(result.size_bytes, 4);
        assert!(controller.state().expect("read state").is_none());
        assert_eq!(
            controller
                .stop(&started.session_id)
                .expect_err("repeated stop must be rejected")
                .code,
            RECORDING_SESSION_INVALID
        );
    }

    #[test]
    fn close_rejects_starting_or_finalizing_sessions_without_closing_them() {
        let controller = controller();
        for busy_state in [ControllerState::Starting, ControllerState::Finalizing] {
            *controller.state.lock().expect("state lock") = busy_state;

            let error = controller
                .close()
                .expect_err("busy recording must keep the window open");
            assert_eq!(error.code, RECORDING_STATE_UNAVAILABLE);
        }
    }

    #[test]
    fn unavailable_mode_is_rejected_before_preparing_capture_workspace() {
        let mut backend = FakeBackend::available(CapturedRecording {
            source_paths: Vec::new(),
            valid_frame_count: 1,
            silent: false,
            duration_ms: 100,
        });
        backend.capabilities.microphone = RecordingSourceCapability {
            available: false,
            reason_code: Some(RECORDING_MIC_INIT_FAILED),
        };
        let file_store = TrackingFileStore::new();
        let prepared = file_store.prepared.clone();
        let controller = RecordingController::new(
            Arc::new(backend),
            Arc::new(FakeFinalizer),
            Arc::new(file_store),
            Arc::new(FakeClock::new(1_000)),
        );

        let error = controller
            .start(RecordingMode::Mic)
            .expect_err("unavailable microphone must be rejected");

        assert_eq!(error.code, RECORDING_MIC_INIT_FAILED);
        assert!(prepared.lock().expect("prepared lock").is_empty());
    }

    #[test]
    fn mixed_mode_requires_its_explicit_capability_after_sources_are_available() {
        let mut capabilities = FakeBackend::available(CapturedRecording {
            source_paths: Vec::new(),
            valid_frame_count: 1,
            silent: false,
            duration_ms: 100,
        })
        .capabilities;
        capabilities.mixed = RecordingSourceCapability {
            available: false,
            reason_code: Some(RECORDING_MIX_FAILED),
        };

        let error = validate_mode(RecordingMode::Mixed, &capabilities)
            .expect_err("mixed must remain unavailable until its implementation lands");

        assert_eq!(error.code, RECORDING_MIX_FAILED);
    }

    #[test]
    fn failed_backend_start_cleans_the_prepared_workspace() {
        let mut backend = FakeBackend::available(CapturedRecording {
            source_paths: Vec::new(),
            valid_frame_count: 1,
            silent: false,
            duration_ms: 100,
        });
        backend.start_error = Some(RecordingError::new(RECORDING_MIC_INIT_FAILED));
        let file_store = TrackingFileStore::new();
        let cleaned = file_store.cleaned.clone();
        let controller = RecordingController::new(
            Arc::new(backend),
            Arc::new(FakeFinalizer),
            Arc::new(file_store),
            Arc::new(FakeClock::new(1_000)),
        );

        let error = controller
            .start(RecordingMode::Mic)
            .expect_err("backend start must fail");

        assert_eq!(error.code, RECORDING_MIC_INIT_FAILED);
        assert_eq!(cleaned.lock().expect("cleaned lock").len(), 1);
        assert!(controller.state().expect("read state").is_none());
    }

    #[test]
    fn failed_backend_start_returns_start_error_when_cleanup_also_fails() {
        let mut backend = FakeBackend::available(CapturedRecording {
            source_paths: Vec::new(),
            valid_frame_count: 1,
            silent: false,
            duration_ms: 100,
        });
        backend.start_error = Some(RecordingError::new(RECORDING_STREAM_ERROR));
        let file_store = TrackingFileStore::with_cleanup_error(RecordingError::new(
            RECORDING_WRITE_FAILED,
        ));
        let cleaned = file_store.cleaned.clone();
        let controller = RecordingController::new(
            Arc::new(backend),
            Arc::new(FakeFinalizer),
            Arc::new(file_store),
            Arc::new(FakeClock::new(1_000)),
        );

        let error = controller
            .start(RecordingMode::Mic)
            .expect_err("backend start must fail");

        assert_eq!(error.code, RECORDING_STREAM_ERROR);
        assert_eq!(cleaned.lock().expect("cleaned lock").len(), 1);
        assert!(controller.state().expect("read state").is_none());
    }

    #[test]
    fn empty_capture_is_rejected_but_valid_silent_capture_is_finalized() {
        let file_store = TrackingFileStore::new();
        let cleaned = file_store.cleaned.clone();
        let empty_controller = RecordingController::new(
            Arc::new(FakeBackend::available(CapturedRecording {
                source_paths: Vec::new(),
                valid_frame_count: 0,
                silent: false,
                duration_ms: 0,
            })),
            Arc::new(FakeFinalizer),
            Arc::new(file_store),
            Arc::new(FakeClock::new(1_000)),
        );
        let empty_session = empty_controller
            .start(RecordingMode::Mic)
            .expect("start empty capture");
        assert_eq!(
            empty_controller
                .stop(&empty_session.session_id)
                .expect_err("empty capture must fail")
                .code,
            RECORDING_EMPTY
        );
        assert_eq!(cleaned.lock().expect("cleaned lock").len(), 1);

        let silent_controller = RecordingController::new(
            Arc::new(FakeBackend::available(CapturedRecording {
                source_paths: Vec::new(),
                valid_frame_count: 1,
                silent: true,
                duration_ms: 100,
            })),
            Arc::new(FakeFinalizer),
            Arc::new(FakeFileStore),
            Arc::new(FakeClock::new(1_000)),
        );
        let silent_session = silent_controller
            .start(RecordingMode::Mic)
            .expect("start silent capture");
        assert!(silent_controller.stop(&silent_session.session_id).is_ok());
    }

    #[test]
    fn cancel_cleans_the_workspace_and_returns_to_idle() {
        let file_store = TrackingFileStore::new();
        let cleaned = file_store.cleaned.clone();
        let controller = RecordingController::new(
            Arc::new(FakeBackend::available(CapturedRecording {
                source_paths: Vec::new(),
                valid_frame_count: 1,
                silent: false,
                duration_ms: 100,
            })),
            Arc::new(FakeFinalizer),
            Arc::new(file_store),
            Arc::new(FakeClock::new(1_000)),
        );
        let started = controller
            .start(RecordingMode::Mic)
            .expect("start recording");

        controller
            .cancel(&started.session_id)
            .expect("cancel recording");

        assert_eq!(cleaned.lock().expect("cleaned lock").len(), 1);
        assert!(controller.state().expect("read state").is_none());
        assert_eq!(
            controller
                .cancel(&started.session_id)
                .expect_err("repeated cancel must be rejected")
                .code,
            RECORDING_SESSION_INVALID
        );
    }

    #[test]
    fn cancel_failure_cleans_the_workspace_and_returns_the_capture_error() {
        let mut backend = FakeBackend::available(CapturedRecording {
            source_paths: Vec::new(),
            valid_frame_count: 1,
            silent: false,
            duration_ms: 100,
        });
        backend.cancel_error = Some(RecordingError::new(RECORDING_STREAM_ERROR));
        let file_store = TrackingFileStore::new();
        let cleaned = file_store.cleaned.clone();
        let controller = RecordingController::new(
            Arc::new(backend),
            Arc::new(FakeFinalizer),
            Arc::new(file_store),
            Arc::new(FakeClock::new(1_000)),
        );
        let started = controller
            .start(RecordingMode::Mic)
            .expect("start recording");

        let error = controller
            .cancel(&started.session_id)
            .expect_err("capture cancellation must fail");

        assert_eq!(error.code, RECORDING_STREAM_ERROR);
        assert_eq!(cleaned.lock().expect("cleaned lock").len(), 1);
        assert!(matches!(
            *controller.state.lock().expect("state lock"),
            ControllerState::Failed(_)
        ));
    }

    #[test]
    fn stream_failure_cleans_the_workspace_and_returns_a_stable_error() {
        let mut backend = FakeBackend::available(CapturedRecording {
            source_paths: Vec::new(),
            valid_frame_count: 1,
            silent: false,
            duration_ms: 100,
        });
        backend.stop_error = Some(RecordingError::new(RecordingErrorCode::StreamError));
        let file_store = TrackingFileStore::new();
        let cleaned = file_store.cleaned.clone();
        let controller = RecordingController::new(
            Arc::new(backend),
            Arc::new(FakeFinalizer),
            Arc::new(file_store),
            Arc::new(FakeClock::new(1_000)),
        );
        let started = controller
            .start(RecordingMode::Mic)
            .expect("start recording");

        let error = controller
            .stop(&started.session_id)
            .expect_err("stream interruption must fail");

        assert_eq!(error.code, RecordingErrorCode::StreamError);
        assert_eq!(cleaned.lock().expect("cleaned lock").len(), 1);
        assert!(matches!(
            *controller.state.lock().expect("state lock"),
            ControllerState::Failed(_)
        ));
    }

    #[test]
    fn finalization_failure_cleans_the_workspace_and_returns_a_stable_error() {
        let file_store = TrackingFileStore::new();
        let cleaned = file_store.cleaned.clone();
        let controller = RecordingController::new(
            Arc::new(FakeBackend::available(CapturedRecording {
                source_paths: Vec::new(),
                valid_frame_count: 1,
                silent: false,
                duration_ms: 100,
            })),
            Arc::new(FailingFinalizer),
            Arc::new(file_store),
            Arc::new(FakeClock::new(1_000)),
        );
        let started = controller
            .start(RecordingMode::Mic)
            .expect("start recording");

        let error = controller
            .stop(&started.session_id)
            .expect_err("finalization must fail");

        assert_eq!(error.code, RECORDING_FINALIZE_FAILED);
        assert_eq!(cleaned.lock().expect("cleaned lock").len(), 1);
        assert!(matches!(
            *controller.state.lock().expect("state lock"),
            ControllerState::Failed(_)
        ));
    }

    #[test]
    fn cleanup_failure_after_successful_stop_is_returned_and_sets_error_state() {
        let file_store =
            TrackingFileStore::with_cleanup_error(RecordingError::new(RECORDING_WRITE_FAILED));
        let cleaned = file_store.cleaned.clone();
        let controller = RecordingController::new(
            Arc::new(FakeBackend::available(CapturedRecording {
                source_paths: Vec::new(),
                valid_frame_count: 1,
                silent: false,
                duration_ms: 100,
            })),
            Arc::new(FakeFinalizer),
            Arc::new(file_store),
            Arc::new(FakeClock::new(1_000)),
        );
        let started = controller
            .start(RecordingMode::Mic)
            .expect("start recording");

        let error = controller
            .stop(&started.session_id)
            .expect_err("cleanup must fail");

        assert_eq!(error.code, RECORDING_WRITE_FAILED);
        assert_eq!(cleaned.lock().expect("cleaned lock").len(), 1);
        assert!(matches!(
            *controller.state.lock().expect("state lock"),
            ControllerState::Failed(_)
        ));
    }

    #[test]
    fn cleanup_failure_after_successful_cancel_is_returned_and_sets_error_state() {
        let file_store =
            TrackingFileStore::with_cleanup_error(RecordingError::new(RECORDING_WRITE_FAILED));
        let cleaned = file_store.cleaned.clone();
        let controller = RecordingController::new(
            Arc::new(FakeBackend::available(CapturedRecording {
                source_paths: Vec::new(),
                valid_frame_count: 1,
                silent: false,
                duration_ms: 100,
            })),
            Arc::new(FakeFinalizer),
            Arc::new(file_store),
            Arc::new(FakeClock::new(1_000)),
        );
        let started = controller
            .start(RecordingMode::Mic)
            .expect("start recording");

        let error = controller
            .cancel(&started.session_id)
            .expect_err("cleanup must fail");

        assert_eq!(error.code, RECORDING_WRITE_FAILED);
        assert_eq!(cleaned.lock().expect("cleaned lock").len(), 1);
        assert!(matches!(
            *controller.state.lock().expect("state lock"),
            ControllerState::Failed(_)
        ));
    }

    #[test]
    fn cancel_error_wins_when_cleanup_also_fails() {
        let mut backend = FakeBackend::available(CapturedRecording {
            source_paths: Vec::new(),
            valid_frame_count: 1,
            silent: false,
            duration_ms: 100,
        });
        backend.cancel_error = Some(RecordingError::new(RECORDING_STREAM_ERROR));
        let file_store =
            TrackingFileStore::with_cleanup_error(RecordingError::new(RECORDING_WRITE_FAILED));
        let cleaned = file_store.cleaned.clone();
        let controller = RecordingController::new(
            Arc::new(backend),
            Arc::new(FakeFinalizer),
            Arc::new(file_store),
            Arc::new(FakeClock::new(1_000)),
        );
        let started = controller
            .start(RecordingMode::Mic)
            .expect("start recording");

        let error = controller
            .cancel(&started.session_id)
            .expect_err("cancellation and cleanup must fail");

        assert_eq!(error.code, RECORDING_STREAM_ERROR);
        assert_eq!(cleaned.lock().expect("cleaned lock").len(), 1);
        assert!(matches!(
            *controller.state.lock().expect("state lock"),
            ControllerState::Failed(_)
        ));
    }

    #[test]
    fn capture_error_wins_when_cleanup_also_fails() {
        let mut backend = FakeBackend::available(CapturedRecording {
            source_paths: Vec::new(),
            valid_frame_count: 1,
            silent: false,
            duration_ms: 100,
        });
        backend.stop_error = Some(RecordingError::new(RECORDING_STREAM_ERROR));
        let file_store =
            TrackingFileStore::with_cleanup_error(RecordingError::new(RECORDING_WRITE_FAILED));
        let cleaned = file_store.cleaned.clone();
        let controller = RecordingController::new(
            Arc::new(backend),
            Arc::new(FakeFinalizer),
            Arc::new(file_store),
            Arc::new(FakeClock::new(1_000)),
        );
        let started = controller
            .start(RecordingMode::Mic)
            .expect("start recording");

        let error = controller
            .stop(&started.session_id)
            .expect_err("capture and cleanup must fail");

        assert_eq!(error.code, RECORDING_STREAM_ERROR);
        assert_eq!(cleaned.lock().expect("cleaned lock").len(), 1);
    }

    #[test]
    fn finalizer_error_wins_when_cleanup_also_fails() {
        let file_store =
            TrackingFileStore::with_cleanup_error(RecordingError::new(RECORDING_WRITE_FAILED));
        let cleaned = file_store.cleaned.clone();
        let controller = RecordingController::new(
            Arc::new(FakeBackend::available(CapturedRecording {
                source_paths: Vec::new(),
                valid_frame_count: 1,
                silent: false,
                duration_ms: 100,
            })),
            Arc::new(FailingFinalizer),
            Arc::new(file_store),
            Arc::new(FakeClock::new(1_000)),
        );
        let started = controller
            .start(RecordingMode::Mic)
            .expect("start recording");

        let error = controller
            .stop(&started.session_id)
            .expect_err("finalization and cleanup must fail");

        assert_eq!(error.code, RECORDING_FINALIZE_FAILED);
        assert_eq!(cleaned.lock().expect("cleaned lock").len(), 1);
    }

    #[test]
    fn public_mode_and_error_payloads_are_stable_and_redacted() {
        let mode: RecordingMode = serde_json::from_str("\"mixed\"").expect("parse mode");
        assert_eq!(mode, RecordingMode::Mixed);

        let platform = serde_json::to_string(&RecordingPlatform::Macos)
            .expect("serialize macOS platform");
        assert_eq!(platform, "\"macos\"");

        let error = RecordingError::new(RECORDING_MIC_INIT_FAILED);
        let serialized = serde_json::to_string(&error).expect("serialize error");
        assert!(serialized.contains("RECORDING_MIC_INIT_FAILED"));
        assert_eq!(error.message, "The microphone could not be initialized.");
        assert!(!serialized.contains("C:\\\\Users"));
    }

    #[test]
    fn recording_error_serializes_system_audio_source_with_stable_payload() {
        let error =
            RecordingError::new(RECORDING_STREAM_ERROR).for_source(RecordingSource::SystemAudio);

        assert_eq!(
            serde_json::to_string(&error).expect("serialize recording error"),
            r#"{"code":"RECORDING_STREAM_ERROR","message":"The recording stream was interrupted.","source":"systemAudio"}"#
        );
    }

    #[test]
    fn recording_error_without_source_omits_source_key() {
        let error = RecordingError::new(RECORDING_MIX_FAILED);
        let payload = serde_json::to_value(error).expect("serialize recording error");

        assert_eq!(
            payload,
            serde_json::json!({
                "code": "RECORDING_MIX_FAILED",
                "message": "The recording sources could not be mixed."
            })
        );
    }

    #[test]
    fn recording_error_preserves_first_source() {
        let error = RecordingError::new(RECORDING_STREAM_ERROR)
            .for_source(RecordingSource::Microphone)
            .for_source(RecordingSource::SystemAudio);

        assert_eq!(error.source, Some(RecordingSource::Microphone));
    }

    #[test]
    fn recording_error_source_payload_contains_only_stable_fields() {
        let error =
            RecordingError::new(RECORDING_STREAM_ERROR).for_source(RecordingSource::SystemAudio);
        let payload = serde_json::to_value(error).expect("serialize recording error");

        let object = payload.as_object().expect("recording error object");
        assert_eq!(object.len(), 3);
        assert!(object.contains_key("code"));
        assert!(object.contains_key("message"));
        assert!(object.contains_key("source"));
        assert_eq!(payload["code"], "RECORDING_STREAM_ERROR");
        assert_eq!(payload["message"], "The recording stream was interrupted.");
        assert_eq!(payload["source"], "systemAudio");
        assert!(!serde_json::to_string(&payload).unwrap().contains("native"));
    }

    #[test]
    fn local_file_store_contains_and_cleans_only_session_temp_paths() {
        let root = std::env::temp_dir().join(format!("StudyMind-recordings-{}", Uuid::new_v4()));
        let recordings_dir = root.join("recordings");
        std::fs::create_dir_all(recordings_dir.join(crate::RECORDING_TEMP_DIR_NAME))
            .expect("create recording temp root");
        let store = LocalRecordingFileStore::new(recordings_dir.clone());
        let workspace = store.prepare("session-1").expect("prepare workspace");

        assert!(workspace.temp_dir.starts_with(
            recordings_dir
                .join(crate::RECORDING_TEMP_DIR_NAME)
                .join("session-1")
        ));
        std::fs::write(workspace.temp_dir.join("mic.wav"), b"capture")
            .expect("write capture fixture");
        store
            .cleanup(&workspace)
            .expect("cleanup session workspace");
        assert!(!workspace.temp_dir.exists());

        let outside = CaptureWorkspace {
            session_id: "outside".to_string(),
            temp_dir: root.join("outside"),
        };
        std::fs::create_dir_all(&outside.temp_dir).expect("create outside directory");
        assert_eq!(
            store
                .cleanup(&outside)
                .expect_err("outside path must be rejected")
                .code,
            RECORDING_WRITE_FAILED
        );
        assert!(outside.temp_dir.is_dir());

        std::fs::remove_dir_all(root).expect("remove recording temp root");
    }
}
