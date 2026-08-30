use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "macos")]
use std::sync::mpsc;
use std::sync::mpsc::{Receiver, SyncSender, TrySendError};
use std::thread::JoinHandle;

use super::wav_writer::{WavCaptureSummary, WaveFormat, WaveWriter};
use super::{
    CapturedRecording, RecordingCapabilities, RecordingError, RecordingErrorCode,
    RecordingMode, RecordingPlatform, RecordingSourceCapability, RecordingSource,
    RECORDING_MIC_ACCESS_DENIED,
    RECORDING_MIC_INIT_FAILED, RECORDING_MIX_FAILED, RECORDING_STREAM_ERROR,
    RECORDING_SYSTEM_AUDIO_UNAVAILABLE, RECORDING_SYSTEM_LOOPBACK_INIT_FAILED,
};
use super::failure_supervisor::RecordingFailureReporter;
use super::mixed::{CaptureGate, FirstSourceFailure, PreparedSource, ReadySender};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PermissionStatus {
    Authorized,
    NotDetermined,
    Denied,
    Restricted,
}

// Variants other than `Available`/`NoShareableDisplay` are reserved domain
// states (macOS 13 gate, Screen Recording permission, init failure) that the
// native probe will construct as those checks land. They are matched by the
// production `system_capability_for`, so they must stay, but are not all
// constructed yet in the current implementation or test suite.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SystemAudioAvailability {
    Available,
    PermissionNotDetermined,
    Denied,
    NoShareableDisplay,
    Unsupported,
    InitializationFailed,
}

trait SystemAudioProbe: Send + Sync {
    fn probe(&self) -> Result<SystemAudioAvailability, RecordingError>;
}

#[allow(dead_code)]
trait SystemAudioRuntime: Send + Sync {
    fn prepare(
        &self,
        workspace: &super::CaptureWorkspace,
        reporter: super::RecordingWarningReporter,
        gate: CaptureGate,
        ready: ReadySender,
        failures: FirstSourceFailure,
        terminal: RecordingFailureReporter,
    ) -> Result<PreparedSource, RecordingError>;
}

#[cfg(test)]
struct UnavailableSystemAudioProbe;

#[cfg(test)]
impl SystemAudioProbe for UnavailableSystemAudioProbe {
    fn probe(&self) -> Result<SystemAudioAvailability, RecordingError> {
        Ok(SystemAudioAvailability::PermissionNotDetermined)
    }
}

fn system_capability_for(
    result: Result<SystemAudioAvailability, RecordingError>,
) -> RecordingSourceCapability {
    match result {
        Ok(SystemAudioAvailability::Available) => RecordingSourceCapability {
            available: true,
            reason_code: None,
        },
        Ok(
            SystemAudioAvailability::PermissionNotDetermined
            | SystemAudioAvailability::Denied
            | SystemAudioAvailability::NoShareableDisplay
            | SystemAudioAvailability::Unsupported,
        ) => RecordingSourceCapability {
            available: false,
            reason_code: Some(RECORDING_SYSTEM_AUDIO_UNAVAILABLE),
        },
        Ok(SystemAudioAvailability::InitializationFailed) | Err(_) => RecordingSourceCapability {
            available: false,
            reason_code: Some(RECORDING_SYSTEM_LOOPBACK_INIT_FAILED),
        },
    }
}

#[cfg(test)]
fn capabilities_for(
    permission: PermissionStatus,
    probe_input: impl FnOnce() -> bool,
) -> RecordingCapabilities {
    capabilities_for_with_system(permission, probe_input, &UnavailableSystemAudioProbe)
}

fn capabilities_for_with_system(
    permission: PermissionStatus,
    probe_input: impl FnOnce() -> bool,
    system_probe: &dyn SystemAudioProbe,
) -> RecordingCapabilities {
    let microphone = match permission {
        PermissionStatus::Denied | PermissionStatus::Restricted => RecordingSourceCapability {
            available: false,
            reason_code: Some(RECORDING_MIC_ACCESS_DENIED),
        },
        PermissionStatus::Authorized | PermissionStatus::NotDetermined => {
            if probe_input() {
                RecordingSourceCapability {
                    available: true,
                    reason_code: None,
                }
            } else {
                RecordingSourceCapability {
                    available: false,
                    reason_code: Some(RECORDING_MIC_INIT_FAILED),
                }
            }
        }
    };

    let system_audio = system_capability_for(system_probe.probe());
    let mixed_available = microphone.available && system_audio.available;
    RecordingCapabilities {
        platform: RecordingPlatform::Macos,
        microphone,
        system_audio,
        mixed: RecordingSourceCapability {
            available: mixed_available,
            reason_code: (!mixed_available).then_some(RECORDING_MIX_FAILED),
        },
    }
}

fn authorize_microphone_for_mode(
    mode: RecordingMode,
    permission: PermissionStatus,
    request_access: impl FnOnce() -> bool,
) -> Result<(), RecordingError> {
    if !matches!(mode, RecordingMode::Mic | RecordingMode::Mixed) {
        return Ok(());
    }

    match permission {
        PermissionStatus::Authorized => Ok(()),
        PermissionStatus::NotDetermined if request_access() => Ok(()),
        PermissionStatus::NotDetermined
        | PermissionStatus::Denied
        | PermissionStatus::Restricted => Err(
            RecordingError::new(RECORDING_MIC_ACCESS_DENIED)
                .for_source(super::RecordingSource::Microphone),
        ),
    }
}

fn authorize_start(
    mode: RecordingMode,
    permission: PermissionStatus,
    request_access: impl FnOnce() -> bool,
) -> Result<(), RecordingError> {
    if !matches!(mode, RecordingMode::Mic) {
        return Err(RecordingError::new(RECORDING_SYSTEM_AUDIO_UNAVAILABLE));
    }

    match permission {
        PermissionStatus::Authorized => Ok(()),
        PermissionStatus::NotDetermined if request_access() => Ok(()),
        PermissionStatus::NotDetermined
        | PermissionStatus::Denied
        | PermissionStatus::Restricted => Err(RecordingError::new(RECORDING_MIC_ACCESS_DENIED)),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AudioBlock {
    bytes: Vec<u8>,
    frame_count: u64,
    silent: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SystemStreamOutput {
    Audio,
    Screen,
    Microphone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SystemStreamConfigSpec {
    captures_audio: bool,
    excludes_current_process_audio: bool,
    registered_outputs: [SystemStreamOutput; 1],
    display_is_user_visible_source: bool,
    sample_rate: u32,
    channel_count: u16,
}

fn system_stream_config_spec() -> SystemStreamConfigSpec {
    SystemStreamConfigSpec {
        captures_audio: true,
        excludes_current_process_audio: true,
        registered_outputs: [SystemStreamOutput::Audio],
        display_is_user_visible_source: false,
        sample_rate: 48_000,
        channel_count: 2,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AudioSampleEncoding {
    F32,
    I16,
    U16,
}

#[cfg_attr(not(test), allow(dead_code))]
fn accept_system_sample(
    output: SystemStreamOutput,
    block: Result<AudioBlock, RecordingError>,
) -> Result<AudioBlock, RecordingError> {
    if output != SystemStreamOutput::Audio {
        return Err(RecordingError::new(RECORDING_STREAM_ERROR));
    }
    block
}

fn system_audio_block_from_bytes(
    encoding: AudioSampleEncoding,
    bytes: &[u8],
    channels: u16,
) -> Result<AudioBlock, RecordingError> {
    match encoding {
        AudioSampleEncoding::F32 => {
            let mut samples = Vec::with_capacity(bytes.len() / 4);
            for chunk in bytes.chunks_exact(4) {
                samples.push(f32::from_ne_bytes(
                    chunk
                        .try_into()
                        .expect("chunks_exact guarantees four bytes"),
                ));
            }
            if !bytes.chunks_exact(4).remainder().is_empty() {
                return Err(RecordingError::new(RECORDING_STREAM_ERROR));
            }
            pcm16_from_f32(&samples, channels)
        }
        AudioSampleEncoding::I16 => {
            let mut samples = Vec::with_capacity(bytes.len() / 2);
            for chunk in bytes.chunks_exact(2) {
                samples.push(i16::from_ne_bytes(
                    chunk.try_into().expect("chunks_exact guarantees two bytes"),
                ));
            }
            if !bytes.chunks_exact(2).remainder().is_empty() {
                return Err(RecordingError::new(RECORDING_STREAM_ERROR));
            }
            pcm16_from_i16(&samples, channels)
        }
        AudioSampleEncoding::U16 => {
            let mut samples = Vec::with_capacity(bytes.len() / 2);
            for chunk in bytes.chunks_exact(2) {
                samples.push(u16::from_ne_bytes(
                    chunk.try_into().expect("chunks_exact guarantees two bytes"),
                ));
            }
            if !bytes.chunks_exact(2).remainder().is_empty() {
                return Err(RecordingError::new(RECORDING_STREAM_ERROR));
            }
            pcm16_from_u16(&samples, channels)
        }
    }
}

impl AudioBlock {
    #[cfg(test)]
    fn silence(frame_count: u64, channels: u16) -> Self {
        Self {
            bytes: vec![0; frame_count as usize * usize::from(channels) * 2],
            frame_count,
            silent: true,
        }
    }
}

fn pcm16_from_f32(samples: &[f32], channels: u16) -> Result<AudioBlock, RecordingError> {
    convert_samples(samples, channels, |sample| {
        let sample = sample.clamp(-1.0, 1.0);
        if sample >= 0.0 {
            (sample * f32::from(i16::MAX)).round() as i16
        } else {
            (sample * 32768.0).round() as i16
        }
    })
}

fn pcm16_from_i16(samples: &[i16], channels: u16) -> Result<AudioBlock, RecordingError> {
    convert_samples(samples, channels, |sample| sample)
}

fn pcm16_from_u16(samples: &[u16], channels: u16) -> Result<AudioBlock, RecordingError> {
    convert_samples(samples, channels, |sample| {
        (i32::from(sample) - 32_768) as i16
    })
}

fn convert_samples<T: Copy>(
    samples: &[T],
    channels: u16,
    convert: impl Fn(T) -> i16,
) -> Result<AudioBlock, RecordingError> {
    let channels = usize::from(channels);
    if channels == 0 || samples.len() % channels != 0 {
        return Err(RecordingError::new(RECORDING_STREAM_ERROR));
    }

    let mut bytes = Vec::with_capacity(samples.len().saturating_mul(2));
    let mut silent = true;
    for sample in samples.iter().copied() {
        let sample = convert(sample);
        silent &= sample == 0;
        bytes.extend_from_slice(&sample.to_le_bytes());
    }

    Ok(AudioBlock {
        bytes,
        frame_count: (samples.len() / channels) as u64,
        silent,
    })
}

fn map_stream_play_error<E>(result: Result<(), E>) -> Result<(), RecordingError> {
    result.map_err(|_| RecordingError::new(RECORDING_MIC_INIT_FAILED))
}

fn map_system_start_error<E>(result: Result<(), E>) -> Result<(), RecordingError> {
    result.map_err(|_| RecordingError::new(RECORDING_SYSTEM_LOOPBACK_INIT_FAILED))
}

fn receive_startup_signal(
    receiver: &Receiver<Result<(), RecordingError>>,
) -> Result<(), RecordingError> {
    receive_startup_signal_with(receiver, RECORDING_MIC_INIT_FAILED)
}

fn receive_startup_signal_with(
    receiver: &Receiver<Result<(), RecordingError>>,
    fallback: RecordingErrorCode,
) -> Result<(), RecordingError> {
    receiver.recv().map_err(|_| RecordingError::new(fallback))?
}

struct FirstStreamError {
    failed: AtomicBool,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    gate: Option<CaptureGate>,
}

impl Default for FirstStreamError {
    fn default() -> Self {
        Self {
            failed: AtomicBool::new(false),
            gate: None,
        }
    }
}

impl FirstStreamError {
    fn with_gate(gate: CaptureGate) -> Self {
        Self {
            failed: AtomicBool::new(false),
            gate: Some(gate),
        }
    }

    fn store(&self) {
        let _ = self
            .failed
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst);
    }

    fn is_set(&self) -> bool {
        self.failed.load(Ordering::SeqCst)
    }

    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn gate_is_open(&self) -> bool {
        self.gate.as_ref().map_or(true, CaptureGate::is_open)
    }
}

fn submit_block(
    sender: &SyncSender<AudioBlock>,
    block: AudioBlock,
    first_error: &FirstStreamError,
) -> Result<(), RecordingError> {
    match sender.try_send(block) {
        Ok(()) => Ok(()),
        Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
            first_error.store();
            Err(RecordingError::new(RECORDING_STREAM_ERROR))
        }
    }
}

fn submit_gated_block(
    gate: &CaptureGate,
    sender: &SyncSender<AudioBlock>,
    block: AudioBlock,
    first_error: &FirstStreamError,
) -> Result<(), RecordingError> {
    if !gate.is_open() {
        return Ok(());
    }
    submit_block(sender, block, first_error)
}

#[cfg(test)]
fn run_writer(
    path: PathBuf,
    format: WaveFormat,
    receiver: Receiver<AudioBlock>,
) -> Result<WavCaptureSummary, RecordingError> {
    let writer = WaveWriter::create(path, format)?;
    write_blocks(writer, receiver)
}

fn write_blocks(
    mut writer: WaveWriter,
    receiver: Receiver<AudioBlock>,
) -> Result<WavCaptureSummary, RecordingError> {
    while let Ok(block) = receiver.recv() {
        writer.write_frames(&block.bytes, block.frame_count, block.silent)?;
    }
    writer.finish()
}

struct WriterJoinGuard<T, M = AudioBlock> {
    writer: Option<JoinHandle<T>>,
    sender: Option<SyncSender<M>>,
}

impl<T, M> WriterJoinGuard<T, M> {
    fn new(writer: JoinHandle<T>, sender: SyncSender<M>) -> Self {
        Self {
            writer: Some(writer),
            sender: Some(sender),
        }
    }

    #[cfg(target_os = "macos")]
    fn sender(&self) -> SyncSender<M> {
        self.sender
            .as_ref()
            .expect("writer join guard sender is present")
            .clone()
    }

    #[cfg(target_os = "macos")]
    fn join(mut self) -> std::thread::Result<T> {
        drop(self.sender.take());
        self.writer
            .take()
            .expect("writer join guard handle is present")
            .join()
    }
}

impl<T, M> Drop for WriterJoinGuard<T, M> {
    fn drop(&mut self) {
        drop(self.sender.take());
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
    }
}

#[derive(Clone, Copy)]
enum CaptureControl {
    Stop,
    Cancel,
}

fn finish_capture(
    control: CaptureControl,
    source_failed: bool,
    writer_result: Result<WavCaptureSummary, RecordingError>,
) -> Result<Option<CapturedRecording>, RecordingError> {
    if source_failed {
        log::error!("[SYSDBG] capture finished with source failure");
        return Err(RecordingError::new(RECORDING_STREAM_ERROR));
    }
    let summary = writer_result?;
    if matches!(control, CaptureControl::Cancel) {
        return Ok(None);
    }

    Ok(Some(CapturedRecording {
        source_paths: vec![summary.path],
        valid_frame_count: summary.valid_frame_count,
        silent: summary.silent,
        duration_ms: summary.duration_ms,
    }))
}

#[cfg(target_os = "macos")]
mod platform {
    use std::sync::Arc;
    use std::thread::{self, JoinHandle};
    use std::time::Duration;

    use block2::RcBlock;
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
    use screencapturekit::prelude::*;

    use super::*;
    use crate::audio_capture::mixed::{self, CaptureCommand, CaptureSignal, SourceReady};
    use crate::audio_capture::CaptureWorkspace;
    use crate::audio_capture::system_audio_recovery::{
        AudioSampleTiming, SystemAudioRecovery, WriteAction,
    };
    use crate::audio_capture::{
        ActiveCapture, CaptureCancelHandle, RecordingBackend, RecordingWarningReporter,
    };

    const AUDIO_QUEUE_CAPACITY: usize = 32;
    const CONTROL_POLL_INTERVAL: Duration = Duration::from_millis(20);

    const AUDIO_FORMAT_FLAG_IS_SIGNED_INTEGER: u32 = 1 << 2;
    const AUDIO_FORMAT_FLAG_IS_NON_INTERLEAVED: u32 = 1 << 5;

    fn native_system_stream_configuration() -> SCStreamConfiguration {
        let spec = system_stream_config_spec();
        SCStreamConfiguration::new()
            .with_captures_audio(spec.captures_audio)
            .with_excludes_current_process_audio(spec.excludes_current_process_audio)
            .with_sample_rate(spec.sample_rate as i32)
            .with_channel_count(spec.channel_count)
    }

    fn native_system_stream_output(output: SCStreamOutputType) -> SystemStreamOutput {
        match output {
            SCStreamOutputType::Audio => SystemStreamOutput::Audio,
            SCStreamOutputType::Screen => SystemStreamOutput::Screen,
            SCStreamOutputType::Microphone => SystemStreamOutput::Microphone,
        }
    }

    fn interleave_non_interleaved_audio(
        channel_blocks: Vec<AudioBlock>,
    ) -> Result<AudioBlock, RecordingError> {
        let Some(first) = channel_blocks.first() else {
            return Err(RecordingError::new(RECORDING_STREAM_ERROR));
        };
        let frame_count = first.frame_count;
        if channel_blocks
            .iter()
            .any(|block| block.frame_count != frame_count)
        {
            return Err(RecordingError::new(RECORDING_STREAM_ERROR));
        }

        let channels = channel_blocks.len();
        let mut bytes = Vec::with_capacity(
            frame_count
                .saturating_mul(channels as u64)
                .saturating_mul(2) as usize,
        );
        let mut silent = true;
        for frame in 0..frame_count as usize {
            let byte_offset = frame.saturating_mul(2);
            for block in &channel_blocks {
                let sample = block
                    .bytes
                    .get(byte_offset..byte_offset.saturating_add(2))
                    .ok_or_else(|| RecordingError::new(RECORDING_STREAM_ERROR))?;
                silent &= sample == [0, 0];
                bytes.extend_from_slice(sample);
            }
        }

        Ok(AudioBlock {
            bytes,
            frame_count,
            silent,
        })
    }

    fn pcm16_from_screen_capture_sample(
        sample: CMSampleBuffer,
    ) -> Result<AudioBlock, RecordingError> {
        let format = sample
            .format_description()
            .ok_or_else(|| RecordingError::new(RECORDING_STREAM_ERROR))?;
        let bits_per_channel = format
            .audio_bits_per_channel()
            .ok_or_else(|| RecordingError::new(RECORDING_STREAM_ERROR))?;
        let flags = format
            .audio_format_flags()
            .ok_or_else(|| RecordingError::new(RECORDING_STREAM_ERROR))?;
        if format.audio_is_big_endian() {
            return Err(RecordingError::new(RECORDING_STREAM_ERROR));
        }

        let encoding = if format.audio_is_float() && bits_per_channel == 32 {
            AudioSampleEncoding::F32
        } else if flags & AUDIO_FORMAT_FLAG_IS_SIGNED_INTEGER != 0 && bits_per_channel == 16 {
            AudioSampleEncoding::I16
        } else if flags & AUDIO_FORMAT_FLAG_IS_SIGNED_INTEGER == 0 && bits_per_channel == 16 {
            AudioSampleEncoding::U16
        } else {
            return Err(RecordingError::new(RECORDING_STREAM_ERROR));
        };
        let channels = format
            .audio_channel_count()
            .and_then(|count| u16::try_from(count).ok())
            .filter(|count| *count > 0)
            .ok_or_else(|| RecordingError::new(RECORDING_STREAM_ERROR))?;
        let buffers = sample
            .audio_buffer_list()
            .ok_or_else(|| RecordingError::new(RECORDING_STREAM_ERROR))?;
        let non_interleaved = flags & AUDIO_FORMAT_FLAG_IS_NON_INTERLEAVED != 0;

        if non_interleaved {
            if buffers.num_buffers() != usize::from(channels) {
                return Err(RecordingError::new(RECORDING_STREAM_ERROR));
            }
            let channel_blocks = buffers
                .iter()
                .map(|buffer| system_audio_block_from_bytes(encoding, buffer.data(), 1))
                .collect::<Result<Vec<_>, _>>()?;
            interleave_non_interleaved_audio(channel_blocks)
        } else {
            if buffers.num_buffers() != 1 {
                return Err(RecordingError::new(RECORDING_STREAM_ERROR));
            }
            let buffer = buffers
                .get(0)
                .ok_or_else(|| RecordingError::new(RECORDING_STREAM_ERROR))?;
            system_audio_block_from_bytes(encoding, buffer.data(), channels)
        }
    }

    // ---- Task 3: native stream supervisor seam ----
    //
    // The display id is a ScreenCaptureKit *technical* anchor only: it never
    // becomes a user-visible recording source and never appears in warning or
    // error selection. The supervisor reconciles the stream by updating the
    // content filter first and rebuilding an audio-only stream only when the
    // update fails; rebuild failure maps to the stable RECORDING_STREAM_ERROR.

    pub(crate) type DisplayAnchor = u32;

    /// Messages flowing from the ScreenCaptureKit callbacks and the supervisor
    /// into the single system writer thread. Audio blocks carry CoreMedia
    /// timing so the recovery state machine can compute media-time gaps;
    /// control events drive the 2s recovery window and user stop/cancel.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(crate) enum SystemStreamEvent {
        Audio {
            block: AudioBlock,
            timing: AudioSampleTiming,
        },
        Interrupt {
            now_ms: u64,
        },
        DeadlineElapsed {
            now_ms: u64,
        },
        Stop,
        Cancel,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) enum ReconcileOutcome {
        FilterUpdated,
        StreamRebuilt,
    }

    /// A live capture stream the supervisor can reconcile. Updating the
    /// content filter is always attempted first; only its failure falls back
    /// to rebuilding the stream.
    pub(crate) trait SystemStream: Send + Sync {
        fn update_content_filter(&self, display: DisplayAnchor) -> Result<(), RecordingError>;
        fn start_capture(&self) -> Result<(), RecordingError>;
        fn stop_capture(&self) -> Result<(), RecordingError>;
    }

    /// Creates audio-only streams and probes the shareable display topology.
    /// The display id is the filter entry point; the caller must not expose it
    /// as a user source or embed it in warning/error selection.
    pub(crate) trait SystemStreamFactory: Send + Sync {
        fn probe_display_anchor(&self) -> Result<DisplayAnchor, RecordingError>;
        fn create_stream(
            &self,
            display: DisplayAnchor,
            events: SyncSender<SystemStreamEvent>,
            interrupt: SyncSender<()>,
            first_error: Arc<FirstStreamError>,
        ) -> Result<Box<dyn SystemStream>, RecordingError>;
        /// Notifies the factory that the worker consumed an interrupt. The real
        /// factory is a no-op; the test factory uses it to let the fake pump
        /// stop so the recovery deadline can elapse. Keeping it on the trait
        /// avoids special-casing the worker loop for tests.
        fn mark_interrupt_consumed(&self) {}
    }

    /// Owns the current stream and reconciles it on delegate interruption or
    /// display-anchor change. Recovery is bounded: the writer thread runs the
    /// portable SystemAudioRecovery state machine and either back-fills a gap
    /// <= 2s with silence (reporting RECORDING_SYSTEM_AUDIO_RECOVERED) or fails
    /// with RECORDING_STREAM_ERROR when the deadline elapses.
    pub(crate) struct SystemStreamSupervisor<'a> {
        factory: &'a dyn SystemStreamFactory,
        stream: Option<Box<dyn SystemStream>>,
        anchor: DisplayAnchor,
        events: SyncSender<SystemStreamEvent>,
        interrupt: SyncSender<()>,
        first_error: Arc<FirstStreamError>,
    }

    impl SystemStreamSupervisor<'_> {
        pub(crate) fn new(
            factory: &dyn SystemStreamFactory,
            stream: Option<Box<dyn SystemStream>>,
            anchor: DisplayAnchor,
            events: SyncSender<SystemStreamEvent>,
            interrupt: SyncSender<()>,
            first_error: Arc<FirstStreamError>,
        ) -> SystemStreamSupervisor<'_> {
            SystemStreamSupervisor {
                factory,
                stream,
                anchor,
                events,
                interrupt,
                first_error,
            }
        }

        fn anchor(&self) -> DisplayAnchor {
            self.anchor
        }

        pub(crate) fn handle_stream_interrupted(
            &mut self,
            now_ms: u64,
        ) -> Result<(), RecordingError> {
            // Best-effort: open the writer's 2s media-recovery window so a fully
            // dead stream (no samples at all) still fails within the window. A
            // full or disconnected writer channel here must NOT abort the
            // authoritative OS-stream rebuild below; a dead writer is
            // independently detected when the writer thread joins at finish.
            self.open_recovery_window(now_ms);
            // Authoritative recovery: filter-update first, then rebuild. This is
            // what actually restores audio and must never be skipped by transient
            // writer backpressure. Its error means the rebuild genuinely failed.
            match self.reconcile() {
                Ok(_) => Ok(()),
                Err(error) => {
                    log::error!("[SYSDBG] system stream reconcile failed: {error:?}");
                    Err(error)
                }
            }
        }

        pub(crate) fn handle_display_anchor_changed(
            &mut self,
            new_anchor: DisplayAnchor,
            now_ms: u64,
        ) -> Result<(), RecordingError> {
            self.anchor = new_anchor;
            self.open_recovery_window(now_ms);
            self.reconcile().map(|_| ())
        }

        fn open_recovery_window(&self, now_ms: u64) {
            // Best-effort mirror of the old start_recovery_window: signal the
            // writer to open its media-recovery window without touching
            // first_error, so a busy or gone writer channel cannot fail the
            // capture during an interrupt.
            let _ = self.events.try_send(SystemStreamEvent::Interrupt { now_ms });
        }

        fn reconcile(&mut self) -> Result<ReconcileOutcome, RecordingError> {
            if let Some(stream) = self.stream.as_ref() {
                if stream.update_content_filter(self.anchor).is_ok() {
                    return Ok(ReconcileOutcome::FilterUpdated);
                }
            }
            self.rebuild()
        }

        fn rebuild(&mut self) -> Result<ReconcileOutcome, RecordingError> {
            if let Some(stream) = self.stream.take() {
                let _ = stream.stop_capture();
            }
            let stream = self
                .factory
                .create_stream(
                    self.anchor,
                    self.events.clone(),
                    self.interrupt.clone(),
                    Arc::clone(&self.first_error),
                )
                .map_err(|_| RecordingError::new(RECORDING_STREAM_ERROR))?;
            stream
                .start_capture()
                .map_err(|_| RecordingError::new(RECORDING_STREAM_ERROR))?;
            self.stream = Some(stream);
            Ok(ReconcileOutcome::StreamRebuilt)
        }

        fn check_recovery_deadline(&self, now_ms: u64) {
            // Best-effort mirror of open_recovery_window: the deadline event only
            // tells the writer to fail the source if recovery genuinely exceeded
            // 2s. A busy or gone writer channel must not abort the capture here;
            // the next topology poll re-sends it, and a healthy writer enforces
            // the deadline when it catches up. (Mirrors the point-B fix that made
            // the interrupt-path recovery-window open best-effort.)
            let _ = self.events.try_send(SystemStreamEvent::DeadlineElapsed { now_ms });
        }

        fn shutdown(&mut self, control: CaptureControl) -> Result<(), RecordingError> {
            let event = match control {
                CaptureControl::Stop => SystemStreamEvent::Stop,
                CaptureControl::Cancel => SystemStreamEvent::Cancel,
            };
            submit_system_event(&self.events, event, &self.first_error)?;
            if let Some(stream) = self.stream.take() {
                let _ = stream.stop_capture();
            }
            Ok(())
        }
    }

    fn submit_system_event(
        sender: &SyncSender<SystemStreamEvent>,
        event: SystemStreamEvent,
        first_error: &FirstStreamError,
    ) -> Result<(), RecordingError> {
        if matches!(&event, SystemStreamEvent::Audio { .. }) && !first_error.gate_is_open() {
            return Ok(());
        }
        match sender.try_send(event) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                first_error.store();
                log::error!("[SYSDBG] system audio event queue FULL (capacity exceeded)");
                Err(RecordingError::new(RECORDING_STREAM_ERROR))
            }
            Err(TrySendError::Disconnected(_)) => {
                first_error.store();
                log::error!("[SYSDBG] system audio event queue DISCONNECTED (writer exited)");
                Err(RecordingError::new(RECORDING_STREAM_ERROR))
            }
        }
    }

    fn cm_time_to_ns(time: CMTime) -> Option<u64> {
        if !time.is_valid() || time.timescale <= 0 || time.value < 0 {
            return None;
        }
        let value = u128::try_from(time.value).ok()?;
        let scale = u128::try_from(time.timescale).ok()?;
        let ns = value.checked_mul(1_000_000_000)?.checked_div(scale)?;
        u64::try_from(ns).ok()
    }

    fn timing_from_cm_sample(sample: &CMSampleBuffer) -> AudioSampleTiming {
        let presentation_ns = cm_time_to_ns(sample.presentation_timestamp());
        let duration_ns = cm_time_to_ns(sample.duration());
        match (presentation_ns, duration_ns) {
            (Some(presentation_ns), Some(duration_ns)) if duration_ns > 0 => AudioSampleTiming {
                presentation_ns,
                duration_ns,
                valid: true,
            },
            _ => AudioSampleTiming::invalid(),
        }
    }

    fn write_system_blocks(
        mut writer: WaveWriter,
        receiver: Receiver<SystemStreamEvent>,
        reporter: RecordingWarningReporter,
        first_error: Arc<FirstStreamError>,
        sample_rate: u32,
        channels: u16,
    ) -> Result<WavCaptureSummary, RecordingError> {
        let mut recovery = SystemAudioRecovery::new(sample_rate, channels);
        while let Ok(event) = receiver.recv() {
            if !first_error.gate_is_open()
                && !matches!(event, SystemStreamEvent::Stop | SystemStreamEvent::Cancel)
            {
                continue;
            }
            match event {
                SystemStreamEvent::Audio { block, timing } => {
                    log::debug!(
                        "[SYSDBG] writer got Audio frames={} bytes={} valid={} pts={} dur={}",
                        block.frame_count,
                        block.bytes.len(),
                        timing.valid,
                        timing.presentation_ns,
                        timing.duration_ns,
                    );
                    for action in recovery.push(timing) {
                        match action {
                            WriteAction::Audio => {
                                let frames = block.frame_count;
                                let bytes_len = block.bytes.len();
                                if let Err(error) = writer.write_frames(
                                    &block.bytes,
                                    frames,
                                    block.silent,
                                ) {
                                    log::error!(
                                        "[SYSDBG] write_frames FAILED frames={} bytes={} => {error:?}",
                                        frames,
                                        bytes_len,
                                    );
                                    return Err(error);
                                }
                            }
                            WriteAction::Silence { frames } => writer.write_silence(frames)?,
                            WriteAction::Recovered { gap_ms } => reporter.record_recovery(gap_ms),
                            WriteAction::FailSource => {
                                log::error!("[SYSDBG] writer recovery FailSource");
                                return Err(RecordingError::new(RECORDING_STREAM_ERROR))
                            }
                            WriteAction::StopCleanly => {}
                            // RebuildStream is ignored here: the supervisor
                            // reconciles the OS stream (filter update first,
                            // then rebuild) inline when it handles the
                            // interrupt/anchor-change, so the writer only needs
                            // to open the media-recovery window via interrupt().
                            WriteAction::RebuildStream => {}
                        }
                    }
                }
                SystemStreamEvent::Interrupt { now_ms } => {
                    // Open (or refresh) the 2s media-recovery window. The
                    // rebuild decision lives in the supervisor; this worker
                    // only tracks the deadline and back-fills gaps.
                    let _ = recovery.interrupt(now_ms);
                }
                SystemStreamEvent::DeadlineElapsed { now_ms } => {
                    for action in recovery.deadline_elapsed(now_ms) {
                        if action == WriteAction::FailSource {
                            return Err(RecordingError::new(RECORDING_STREAM_ERROR));
                        }
                    }
                }
                SystemStreamEvent::Stop | SystemStreamEvent::Cancel => {
                    recovery.stop();
                    break;
                }
            }
        }
        writer.finish()
    }

    struct NativeSystemStream {
        stream: SCStream,
    }

    impl SystemStream for NativeSystemStream {
        fn update_content_filter(&self, display: DisplayAnchor) -> Result<(), RecordingError> {
            let content = SCShareableContent::get().map_err(|error| {
                log::error!("[SYSDBG] update_content_filter SCShareableContent::get failed: {error:?}");
                RecordingError::new(RECORDING_STREAM_ERROR)
            })?;
            let sc_display = content
                .displays()
                .into_iter()
                .find(|candidate| candidate.display_id() == display)
                .ok_or_else(|| RecordingError::new(RECORDING_STREAM_ERROR))?;
            let filter = SCContentFilter::create()
                .with_display(&sc_display)
                .with_excluding_windows(&[])
                .build();
            self.stream
                .update_content_filter(&filter)
                .map_err(|_| RecordingError::new(RECORDING_STREAM_ERROR))
        }

        fn start_capture(&self) -> Result<(), RecordingError> {
            map_system_start_error(self.stream.start_capture())
        }

        fn stop_capture(&self) -> Result<(), RecordingError> {
            self.stream
                .stop_capture()
                .map_err(|_| RecordingError::new(RECORDING_STREAM_ERROR))
        }
    }

    struct NativeSystemStreamFactory;

    impl SystemStreamFactory for NativeSystemStreamFactory {
        fn probe_display_anchor(&self) -> Result<DisplayAnchor, RecordingError> {
            let content = SCShareableContent::get().map_err(|error| {
                log::error!("[SYSDBG] probe_display_anchor SCShareableContent::get failed: {error:?}");
                RecordingError::new(RECORDING_SYSTEM_AUDIO_UNAVAILABLE)
            })?;
            content
                .displays()
                .into_iter()
                .next()
                .map(|display| display.display_id())
                .ok_or_else(|| RecordingError::new(RECORDING_SYSTEM_AUDIO_UNAVAILABLE))
        }

        fn create_stream(
            &self,
            display: DisplayAnchor,
            events: SyncSender<SystemStreamEvent>,
            interrupt: SyncSender<()>,
            first_error: Arc<FirstStreamError>,
        ) -> Result<Box<dyn SystemStream>, RecordingError> {
            let content = SCShareableContent::get().map_err(|error| {
                log::error!("[SYSDBG] create_stream SCShareableContent::get failed: {error:?}");
                RecordingError::new(RECORDING_SYSTEM_LOOPBACK_INIT_FAILED)
            })?;
            let sc_display = content
                .displays()
                .into_iter()
                .find(|candidate| candidate.display_id() == display)
                .ok_or_else(|| RecordingError::new(RECORDING_SYSTEM_LOOPBACK_INIT_FAILED))?;
            let filter = SCContentFilter::create()
                .with_display(&sc_display)
                .with_excluding_windows(&[])
                .build();
            let config = native_system_stream_configuration();
            let delegate = ErrorHandler::new(move |_error: SCError| {
                let _ = interrupt.try_send(());
            });
            let mut stream = SCStream::new_with_delegate(&filter, &config, delegate);
            let callback_events = events.clone();
            let callback_error = Arc::clone(&first_error);
            let format_logged = Arc::new(AtomicBool::new(false));
            let registered = stream.add_output_handler(
                move |sample: CMSampleBuffer, output: SCStreamOutputType| {
                    let output = native_system_stream_output(output);
                    let result = if output == SystemStreamOutput::Audio {
                        if !format_logged.swap(true, Ordering::SeqCst) {
                            match sample.format_description() {
                                Some(format) => log::debug!(
                                    "[SYSDBG] first system audio sample format bits={:?} flags={:?} float={} big_endian={} channels={:?}",
                                    format.audio_bits_per_channel(),
                                    format.audio_format_flags(),
                                    format.audio_is_float(),
                                    format.audio_is_big_endian(),
                                    format.audio_channel_count(),
                                ),
                                None => log::error!(
                                    "[SYSDBG] first system audio sample format_description() is None"
                                ),
                            }
                            let pts = sample.presentation_timestamp();
                            let dur = sample.duration();
                            let timing = timing_from_cm_sample(&sample);
                            log::debug!(
                                "[SYSDBG] first sample timing pts={:?} dur={:?} => valid={} presentation_ns={} duration_ns={}",
                                pts,
                                dur,
                                timing.valid,
                                timing.presentation_ns,
                                timing.duration_ns,
                            );
                        }
                        let timing = timing_from_cm_sample(&sample);
                        pcm16_from_screen_capture_sample(sample).map(|block| (block, timing))
                    } else {
                        log::error!("[SYSDBG] unexpected SCK output type: {output:?}");
                        Err(RecordingError::new(RECORDING_STREAM_ERROR))
                    };
                    match result {
                        Ok((block, timing)) => {
                            let _ = submit_system_event(
                                &callback_events,
                                SystemStreamEvent::Audio { block, timing },
                                &callback_error,
                            );
                        }
                        Err(error) => {
                            log::error!("[SYSDBG] system audio sample rejected: {error:?}");
                            callback_error.store();
                        }
                    }
                },
                SCStreamOutputType::Audio,
            );
            if registered.is_none() {
                return Err(RecordingError::new(RECORDING_SYSTEM_LOOPBACK_INIT_FAILED));
            }
            Ok(Box::new(NativeSystemStream { stream }))
        }
    }

    // Compile-only seam for the native system-audio path. It intentionally registers
    // only the Audio output type: the display is a ScreenCaptureKit filter entry point,
    // not a user-visible recording scope. Runtime permission/content checks and stream
    // lifecycle belong to the implementation task that follows this dependency gate.
    #[allow(dead_code)]
    fn screencapturekit_audio_only_stream_probe(display: &SCDisplay) -> SCStream {
        let filter = SCContentFilter::create()
            .with_display(display)
            .with_excluding_windows(&[])
            .build();
        let config = native_system_stream_configuration();
        let mut stream = SCStream::new(&filter, &config);
        stream.add_output_handler(
            |_sample: CMSampleBuffer, _of_type: SCStreamOutputType| {},
            SCStreamOutputType::Audio,
        );
        stream
    }

    pub(crate) struct MacosRecordingBackend {
        system_probe: Arc<dyn SystemAudioProbe>,
        system_runtime: Arc<dyn SystemAudioRuntime>,
    }

    impl Default for MacosRecordingBackend {
        fn default() -> Self {
            Self {
                system_probe: Arc::new(NativeSystemAudioProbe),
                system_runtime: Arc::new(NativeSystemAudioRuntime),
            }
        }
    }

    struct NativeSystemAudioProbe;

    impl SystemAudioProbe for NativeSystemAudioProbe {
        fn probe(&self) -> Result<SystemAudioAvailability, RecordingError> {
            let content = SCShareableContent::get().map_err(|error| {
                log::error!(
                    "[SYSDBG] system audio probe SCShareableContent::get failed: {error:?}"
                );
                RecordingError::new(RECORDING_SYSTEM_AUDIO_UNAVAILABLE)
            })?;
            let displays = content.displays();
            log::debug!(
                "[SYSDBG] system audio probe ok displays_count={}",
                displays.len()
            );
            if displays.is_empty() {
                Ok(SystemAudioAvailability::NoShareableDisplay)
            } else {
                Ok(SystemAudioAvailability::Available)
            }
        }
    }

    struct NativeSystemAudioRuntime;

    impl SystemAudioRuntime for NativeSystemAudioRuntime {
        fn prepare(
            &self,
            workspace: &CaptureWorkspace,
            reporter: RecordingWarningReporter,
            gate: CaptureGate,
            ready: ReadySender,
            failures: FirstSourceFailure,
            terminal: RecordingFailureReporter,
        ) -> Result<PreparedSource, RecordingError> {
            let signal = CaptureSignal::default();
            let worker_signal = signal.clone();
            let path = workspace.temp_dir.join("system.wav");
            let worker = thread::Builder::new()
                .name("studymind-macos-system-audio".to_string())
                .spawn(move || {
                    let (control_tx, control_rx) = mpsc::channel();
                    let (inner_ready_tx, inner_ready_rx) = mpsc::sync_channel(1);
                    let inner_path = path.clone();
                    let inner_factory = Arc::new(NativeSystemStreamFactory);
                    let inner_gate = gate.clone();
                    let inner_reporter = reporter.clone();
                    let inner_handle = thread::spawn(move || {
                        run_system_capture_worker_gated(
                            inner_factory,
                            inner_path,
                            control_rx,
                            inner_ready_tx,
                            inner_reporter,
                            inner_gate,
                        )
                    });
                    match inner_ready_rx.recv_timeout(Duration::from_secs(3)) {
                        Ok(Ok(())) => {
                            let _ = ready.send(SourceReady {
                                source: RecordingSource::SystemAudio,
                                result: Ok(()),
                            });
                            while worker_signal.current().is_none() {
                                thread::sleep(CONTROL_POLL_INTERVAL);
                            }
                            let control = if worker_signal.current()
                                == Some(CaptureCommand::Cancel)
                            {
                                CaptureControl::Cancel
                            } else {
                                CaptureControl::Stop
                            };
                            let _ = control_tx.send(control);
                        }
                        Ok(Err(error)) => {
                            let _ = ready.send(SourceReady {
                                source: RecordingSource::SystemAudio,
                                result: Err(error.clone()),
                            });
                        }
                        Err(_) => {
                            let error = RecordingError::new(RECORDING_STREAM_ERROR)
                                .for_source(RecordingSource::SystemAudio);
                            let _ = ready.send(SourceReady {
                                source: RecordingSource::SystemAudio,
                                result: Err(error.clone()),
                            });
                            let _ = control_tx.send(CaptureControl::Cancel);
                        }
                    }
                    let result = inner_handle
                        .join()
                        .map_err(|_| RecordingError::new(RECORDING_STREAM_ERROR))?;
                    match result {
                        Ok(Some(captured)) => Ok(WavCaptureSummary {
                            path: captured.source_paths.into_iter().next().unwrap_or(path),
                            valid_frame_count: captured.valid_frame_count,
                            silent: captured.silent,
                            duration_ms: captured.duration_ms,
                        }),
                        Ok(None) => Ok(WavCaptureSummary {
                            path,
                            valid_frame_count: 0,
                            silent: true,
                            duration_ms: 0,
                        }),
                        Err(error) => {
                            let error = error.for_source(RecordingSource::SystemAudio);
                            failures.record(error.clone(), RecordingSource::SystemAudio);
                            if gate.is_open() {
                                terminal.report(error.clone());
                            }
                            Err(error)
                        }
                    }
                })
                .map_err(|_| RecordingError::new(RECORDING_SYSTEM_LOOPBACK_INIT_FAILED))?;
            Ok(PreparedSource {
                source: RecordingSource::SystemAudio,
                signal,
                worker,
            })
        }
    }

    impl RecordingBackend for MacosRecordingBackend {
        fn capabilities(&self) -> Result<RecordingCapabilities, RecordingError> {
            Ok(capabilities_for_with_system(
                permission_status()?,
                probe_default_input,
                self.system_probe.as_ref(),
            ))
        }

        fn start(
            &self,
            mode: RecordingMode,
            workspace: &CaptureWorkspace,
            reporter: RecordingWarningReporter,
            failure_reporter: super::RecordingFailureReporter,
        ) -> Result<Box<dyn ActiveCapture>, RecordingError> {
            let gate = CaptureGate::default();
            let failures = FirstSourceFailure::default();
            let (ready_tx, ready_rx) = mixed::ready_channel();
            match mode {
                RecordingMode::Mic => {
                    authorize_microphone_for_mode(
                        mode,
                        permission_status().map_err(|error| {
                            error.for_source(RecordingSource::Microphone)
                        })?,
                        request_microphone_access,
                    )?;
                    let source = prepare_microphone_source(
                        workspace,
                        gate.clone(),
                        ready_tx,
                        failures.clone(),
                        failure_reporter,
                    )
                    .map_err(|error| error.for_source(RecordingSource::Microphone))?;
                    match ready_rx.recv_timeout(Duration::from_secs(3)) {
                        Ok(SourceReady { result: Ok(()), .. }) => {
                            gate.open();
                            Ok(Box::new(MacosPreparedCapture { source, failures }))
                        }
                        Ok(SourceReady { result: Err(error), .. }) => {
                            source.signal.request(CaptureCommand::Cancel);
                            let _ = source.worker.join();
                            Err(error.for_source(RecordingSource::Microphone))
                        }
                        Err(_) => {
                            source.signal.request(CaptureCommand::Cancel);
                            let _ = source.worker.join();
                            Err(RecordingError::new(RECORDING_MIC_INIT_FAILED)
                                .for_source(RecordingSource::Microphone))
                        }
                    }
                }
                RecordingMode::System => {
                    let source = self.system_runtime.prepare(
                        workspace,
                        reporter,
                        gate.clone(),
                        ready_tx,
                        failures.clone(),
                        failure_reporter,
                    )
                    .map_err(|error| error.for_source(RecordingSource::SystemAudio))?;
                    match ready_rx.recv_timeout(Duration::from_secs(3)) {
                        Ok(SourceReady { result: Ok(()), .. }) => {
                            gate.open();
                            Ok(Box::new(MacosPreparedCapture { source, failures }))
                        }
                        Ok(SourceReady { result: Err(error), .. }) => {
                            source.signal.request(CaptureCommand::Cancel);
                            let _ = source.worker.join();
                            Err(error.for_source(RecordingSource::SystemAudio))
                        }
                        Err(_) => {
                            source.signal.request(CaptureCommand::Cancel);
                            let _ = source.worker.join();
                            Err(RecordingError::new(RECORDING_SYSTEM_LOOPBACK_INIT_FAILED)
                                .for_source(RecordingSource::SystemAudio))
                        }
                    }
                }
                RecordingMode::Mixed => {
                    authorize_microphone_for_mode(
                        mode,
                        permission_status().map_err(|error| {
                            error.for_source(RecordingSource::Microphone)
                        })?,
                        request_microphone_access,
                    )?;
                    let microphone = prepare_microphone_source(
                        workspace,
                        gate.clone(),
                        ready_tx.clone(),
                        failures.clone(),
                        failure_reporter.clone(),
                    )
                    .map_err(|error| error.for_source(RecordingSource::Microphone))?;
                    let system = match self.system_runtime.prepare(
                        workspace,
                        reporter,
                        gate.clone(),
                        ready_tx,
                        failures.clone(),
                        failure_reporter,
                    ) {
                        Ok(system) => system,
                        Err(error) => {
                            microphone.signal.request(CaptureCommand::Cancel);
                            let _ = microphone.worker.join();
                            return Err(error.for_source(RecordingSource::SystemAudio));
                        }
                    };
                    mixed::start_mixed(
                        [microphone, system],
                        ready_rx,
                        gate,
                        failures,
                        Duration::from_secs(3),
                    )
                }
            }
        }
    }

    struct MacosPreparedCapture {
        source: PreparedSource,
        failures: FirstSourceFailure,
    }

    impl ActiveCapture for MacosPreparedCapture {
        fn stop(self: Box<Self>) -> Result<CapturedRecording, RecordingError> {
            let MacosPreparedCapture { source, failures } = *self;
            source.signal.request(CaptureCommand::Stop);
            let summary = source
                .worker
                .join()
                .map_err(|_| RecordingError::new(RECORDING_STREAM_ERROR))??;
            if let Some(error) = failures.snapshot() {
                return Err(error);
            }
            Ok(CapturedRecording {
                source_paths: vec![summary.path],
                valid_frame_count: summary.valid_frame_count,
                silent: summary.silent,
                duration_ms: summary.duration_ms,
            })
        }

        fn cancel(self: Box<Self>) -> Result<(), RecordingError> {
            let MacosPreparedCapture { source, failures } = *self;
            source.signal.request(CaptureCommand::Cancel);
            let _ = source.worker.join();
            failures.snapshot().map_or(Ok(()), Err)
        }

        fn cancel_for_cleanup(self: Box<Self>) -> Result<(), RecordingError> {
            let MacosPreparedCapture { source, failures } = *self;
            let failure_confirmed = failures.snapshot().is_some();
            let source_kind = source.source;
            source.signal.request(CaptureCommand::Cancel);
            match source.worker.join() {
                Ok(Ok(_)) | Ok(Err(_)) if failure_confirmed => Ok(()),
                Ok(Ok(_)) => Ok(()),
                Ok(Err(error)) => Err(error.for_source(source_kind)),
                Err(_) => Err(RecordingError::new(RECORDING_STREAM_ERROR)),
            }
        }

        fn cancel_handle(&self) -> Option<CaptureCancelHandle> {
            let signal = self.source.signal.clone();
            Some(CaptureCancelHandle::new(move || {
                signal.request(CaptureCommand::Cancel);
            }))
        }
    }

    fn permission_status() -> Result<PermissionStatus, RecordingError> {
        let media_type = unsafe { AVMediaTypeAudio }
            .ok_or_else(|| RecordingError::new(RECORDING_MIC_INIT_FAILED))?;
        let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) };
        Ok(match status {
            AVAuthorizationStatus::Authorized => PermissionStatus::Authorized,
            AVAuthorizationStatus::NotDetermined => PermissionStatus::NotDetermined,
            AVAuthorizationStatus::Denied => PermissionStatus::Denied,
            AVAuthorizationStatus::Restricted => PermissionStatus::Restricted,
            _ => PermissionStatus::Restricted,
        })
    }

    fn request_microphone_access() -> bool {
        let Some(media_type) = (unsafe { AVMediaTypeAudio }) else {
            return false;
        };
        let (sender, receiver) = mpsc::sync_channel(1);
        let block = RcBlock::new(move |granted: Bool| {
            let _ = sender.try_send(granted.as_bool());
        });
        unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(media_type, &block) };
        receiver.recv().unwrap_or(false)
    }

    fn probe_default_input() -> bool {
        let host = cpal::default_host();
        host.default_input_device()
            .and_then(|device| device.default_input_config().ok())
            .is_some()
    }

    pub(crate) fn run_system_capture_worker(
        factory: Arc<dyn SystemStreamFactory>,
        path: PathBuf,
        control_rx: mpsc::Receiver<CaptureControl>,
        ready_tx: SyncSender<Result<(), RecordingError>>,
        reporter: RecordingWarningReporter,
    ) -> Result<Option<CapturedRecording>, RecordingError> {
        let gate = CaptureGate::default();
        gate.open();
        run_system_capture_worker_gated(
            factory,
            path,
            control_rx,
            ready_tx,
            reporter,
            gate,
        )
    }

    fn run_system_capture_worker_gated(
        factory: Arc<dyn SystemStreamFactory>,
        path: PathBuf,
        control_rx: mpsc::Receiver<CaptureControl>,
        ready_tx: SyncSender<Result<(), RecordingError>>,
        reporter: RecordingWarningReporter,
        gate: CaptureGate,
    ) -> Result<Option<CapturedRecording>, RecordingError> {
        let factory = factory.as_ref();
        let anchor = match factory.probe_display_anchor() {
            Ok(anchor) => anchor,
            Err(error) => return notify_setup_error(ready_tx, error),
        };
        let spec = system_stream_config_spec();
        let format = match WaveFormat::pcm_s16le(spec.channel_count, spec.sample_rate) {
            Ok(format) => format,
            Err(_) => {
                return notify_setup_error(
                    ready_tx,
                    RecordingError::new(RECORDING_SYSTEM_LOOPBACK_INIT_FAILED),
                )
            }
        };
        let sample_rate = format.sample_rate;
        let channels = format.channels;

        let (events_tx, events_rx) = mpsc::sync_channel(AUDIO_QUEUE_CAPACITY);
        let (interrupt_tx, interrupt_rx) = mpsc::sync_channel(1);
        let (writer_ready_tx, writer_ready_rx) = mpsc::sync_channel(1);
        let first_error = Arc::new(FirstStreamError::with_gate(gate));
        let writer_first_error = Arc::clone(&first_error);
        let writer = thread::Builder::new()
            .name("studymind-macos-system-audio-writer".to_string())
            .spawn(move || {
                let wave_writer = WaveWriter::create(path, format);
                match wave_writer {
                    Ok(wave_writer) => {
                        if writer_ready_tx.send(Ok(())).is_err() {
                            return Err(RecordingError::new(RECORDING_STREAM_ERROR));
                        }
                        write_system_blocks(
                            wave_writer,
                            events_rx,
                            reporter,
                            writer_first_error,
                            sample_rate,
                            channels,
                        )
                    }
                    Err(error) => {
                        let _ = writer_ready_tx.send(Err(error.clone()));
                        Err(error)
                    }
                }
            })
            .map_err(|_| RecordingError::new(RECORDING_SYSTEM_LOOPBACK_INIT_FAILED));
        let writer = match writer {
            Ok(writer) => writer,
            Err(error) => return notify_setup_error(ready_tx, error),
        };
        let writer_guard = WriterJoinGuard::new(writer, events_tx);
        match receive_startup_signal_with(&writer_ready_rx, RECORDING_SYSTEM_LOOPBACK_INIT_FAILED) {
            Ok(()) => {}
            Err(error) => return notify_setup_error(ready_tx, error),
        }

        let stream = match factory.create_stream(
            anchor,
            writer_guard.sender(),
            interrupt_tx.clone(),
            Arc::clone(&first_error),
        ) {
            Ok(stream) => stream,
            Err(error) => return notify_setup_error(ready_tx, error),
        };
        if let Err(error) = map_system_start_error(stream.start_capture()) {
            log::error!("[SYSDBG] system stream start_capture failed: {error:?}");
            drop(stream);
            return notify_setup_error(ready_tx, error);
        }
        let mut supervisor = SystemStreamSupervisor::new(
            factory,
            Some(stream),
            anchor,
            writer_guard.sender(),
            interrupt_tx,
            Arc::clone(&first_error),
        );
        log::debug!("[SYSDBG] system audio stream started (anchor={anchor})");
        if ready_tx.send(Ok(())).is_err() {
            let _ = supervisor.shutdown(CaptureControl::Cancel);
            return Err(RecordingError::new(RECORDING_STREAM_ERROR));
        }

        let monotonic = std::time::Instant::now();
        let now_ms = || monotonic.elapsed().as_millis() as u64;
        let mut last_topology_poll = std::time::Instant::now();
        const TOPOLOGY_POLL_INTERVAL: Duration = Duration::from_millis(250);

        let mut control = None;
        let mut run_error = None;
        loop {
            match control_rx.recv_timeout(CONTROL_POLL_INTERVAL) {
                Ok(received) => {
                    control = Some(received);
                    break;
                }
                Err(mpsc::RecvTimeoutError::Timeout) if first_error.is_set() => {
                    control = Some(CaptureControl::Stop);
                    break;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if interrupt_rx.try_recv().is_ok() {
                        if let Err(error) = supervisor.handle_stream_interrupted(now_ms()) {
                            run_error = Some(error);
                            break;
                        }
                        factory.mark_interrupt_consumed();
                    }
                    if last_topology_poll.elapsed() >= TOPOLOGY_POLL_INTERVAL {
                        last_topology_poll = std::time::Instant::now();
                        match factory.probe_display_anchor() {
                            Ok(new_anchor) if new_anchor != supervisor.anchor() => {
                                if let Err(error) =
                                    supervisor.handle_display_anchor_changed(new_anchor, now_ms())
                                {
                                    run_error = Some(error);
                                    break;
                                }
                            }
                            Ok(_) => {}
                            // A transient topology probe failure must not kill an
                            // otherwise healthy capture; the audio deadline still
                            // protects the session if audio really stopped.
                            Err(_) => {}
                        }
                        supervisor.check_recovery_deadline(now_ms());
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    control = Some(CaptureControl::Cancel);
                    break;
                }
            }
        }

        let control = if run_error.is_some() {
            control.unwrap_or(CaptureControl::Stop)
        } else {
            control.unwrap_or(CaptureControl::Cancel)
        };
        if supervisor.shutdown(control).is_err() {
            first_error.store();
        }
        let source_failed = run_error.is_some() || first_error.is_set();
        let writer_result = writer_guard
            .join()
            .map_err(|_| RecordingError::new(RECORDING_STREAM_ERROR))?;
        finish_capture(control, source_failed, writer_result)
    }

    fn prepare_microphone_source(
        workspace: &CaptureWorkspace,
        gate: CaptureGate,
        ready: ReadySender,
        failures: FirstSourceFailure,
        terminal: RecordingFailureReporter,
    ) -> Result<PreparedSource, RecordingError> {
        let signal = CaptureSignal::default();
        let worker_signal = signal.clone();
        let path = workspace.temp_dir.join("mic.wav");
        let worker = thread::Builder::new()
            .name("studymind-macos-microphone".to_string())
            .spawn(move || {
                let (control_tx, control_rx) = mpsc::channel();
                let (inner_ready_tx, inner_ready_rx) = mpsc::sync_channel(1);
                let inner_path = path.clone();
                let inner_gate = gate.clone();
                let inner_handle = thread::spawn(move || {
                    run_capture_worker_gated(inner_path, control_rx, inner_ready_tx, inner_gate)
                });
                match inner_ready_rx.recv_timeout(Duration::from_secs(3)) {
                    Ok(Ok(())) => {
                        let _ = ready.send(SourceReady {
                            source: RecordingSource::Microphone,
                            result: Ok(()),
                        });
                        while worker_signal.current().is_none() {
                            thread::sleep(CONTROL_POLL_INTERVAL);
                        }
                        let control = if worker_signal.current() == Some(CaptureCommand::Cancel) {
                            CaptureControl::Cancel
                        } else {
                            CaptureControl::Stop
                        };
                        let _ = control_tx.send(control);
                    }
                    Ok(Err(error)) => {
                        let _ = ready.send(SourceReady {
                            source: RecordingSource::Microphone,
                            result: Err(error.clone()),
                        });
                    }
                    Err(_) => {
                        let error = RecordingError::new(RECORDING_STREAM_ERROR)
                            .for_source(RecordingSource::Microphone);
                        let _ = ready.send(SourceReady {
                            source: RecordingSource::Microphone,
                            result: Err(error.clone()),
                        });
                        let _ = control_tx.send(CaptureControl::Cancel);
                    }
                }
                let result = inner_handle
                    .join()
                    .map_err(|_| RecordingError::new(RECORDING_STREAM_ERROR))?;
                match result {
                    Ok(Some(captured)) => Ok(WavCaptureSummary {
                        path: captured.source_paths.into_iter().next().unwrap_or(path),
                        valid_frame_count: captured.valid_frame_count,
                        silent: captured.silent,
                        duration_ms: captured.duration_ms,
                    }),
                    Ok(None) => Ok(WavCaptureSummary {
                        path,
                        valid_frame_count: 0,
                        silent: true,
                        duration_ms: 0,
                    }),
                    Err(error) => {
                        let error = error.for_source(RecordingSource::Microphone);
                        failures.record(error.clone(), RecordingSource::Microphone);
                        if gate.is_open() {
                            terminal.report(error.clone());
                        }
                        Err(error)
                    }
                }
            })
            .map_err(|_| RecordingError::new(RECORDING_MIC_INIT_FAILED))?;
        Ok(PreparedSource {
            source: RecordingSource::Microphone,
            signal,
            worker,
        })
    }

    fn run_capture_worker(
        path: PathBuf,
        control_rx: mpsc::Receiver<CaptureControl>,
        ready_tx: SyncSender<Result<(), RecordingError>>,
    ) -> Result<Option<CapturedRecording>, RecordingError> {
        let gate = CaptureGate::default();
        gate.open();
        run_capture_worker_gated(path, control_rx, ready_tx, gate)
    }

    fn run_capture_worker_gated(
        path: PathBuf,
        control_rx: mpsc::Receiver<CaptureControl>,
        ready_tx: SyncSender<Result<(), RecordingError>>,
        gate: CaptureGate,
    ) -> Result<Option<CapturedRecording>, RecordingError> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| RecordingError::new(RECORDING_MIC_INIT_FAILED));
        let device = match device {
            Ok(device) => device,
            Err(error) => return notify_setup_error(ready_tx, error),
        };
        let supported_config = match device.default_input_config() {
            Ok(config) => config,
            Err(_) => {
                return notify_setup_error(ready_tx, RecordingError::new(RECORDING_MIC_INIT_FAILED))
            }
        };
        let channels = supported_config.channels();
        let sample_rate = supported_config.sample_rate().0;
        let format = match WaveFormat::pcm_s16le(channels, sample_rate) {
            Ok(format) => format,
            Err(_) => {
                return notify_setup_error(ready_tx, RecordingError::new(RECORDING_MIC_INIT_FAILED))
            }
        };
        let sample_format = supported_config.sample_format();
        if !matches!(
            sample_format,
            cpal::SampleFormat::F32 | cpal::SampleFormat::I16 | cpal::SampleFormat::U16
        ) {
            return notify_setup_error(ready_tx, RecordingError::new(RECORDING_MIC_INIT_FAILED));
        }

        let (audio_tx, audio_rx) = mpsc::sync_channel(AUDIO_QUEUE_CAPACITY);
        let (writer_ready_tx, writer_ready_rx) = mpsc::sync_channel(1);
        let writer = thread::Builder::new()
            .name("studymind-macos-microphone-writer".to_string())
            .spawn(move || {
                let wave_writer = WaveWriter::create(path, format);
                match wave_writer {
                    Ok(wave_writer) => {
                        if writer_ready_tx.send(Ok(())).is_err() {
                            return Err(RecordingError::new(RECORDING_STREAM_ERROR));
                        }
                        write_blocks(wave_writer, audio_rx)
                    }
                    Err(error) => {
                        let _ = writer_ready_tx.send(Err(error.clone()));
                        Err(error)
                    }
                }
            })
            .map_err(|_| RecordingError::new(RECORDING_MIC_INIT_FAILED));
        let writer = match writer {
            Ok(writer) => writer,
            Err(error) => return notify_setup_error(ready_tx, error),
        };
        let writer_guard = WriterJoinGuard::new(writer, audio_tx);
        match receive_startup_signal(&writer_ready_rx) {
            Ok(()) => {}
            Err(error) => return notify_setup_error(ready_tx, error),
        }

        let first_error = Arc::new(FirstStreamError::with_gate(gate.clone()));
        let stream_config: cpal::StreamConfig = supported_config.clone().into();
        let stream = match sample_format {
            cpal::SampleFormat::F32 => build_stream(
                &device,
                &stream_config,
                writer_guard.sender(),
                Arc::clone(&first_error),
                gate.clone(),
                channels,
                pcm16_from_f32,
            ),
            cpal::SampleFormat::I16 => build_stream(
                &device,
                &stream_config,
                writer_guard.sender(),
                Arc::clone(&first_error),
                gate.clone(),
                channels,
                pcm16_from_i16,
            ),
            cpal::SampleFormat::U16 => build_stream(
                &device,
                &stream_config,
                writer_guard.sender(),
                Arc::clone(&first_error),
                gate,
                channels,
                pcm16_from_u16,
            ),
            _ => unreachable!("sample format checked above"),
        };
        let stream = match stream {
            Ok(stream) => stream,
            Err(error) => return notify_setup_error(ready_tx, error),
        };
        if let Err(error) = map_stream_play_error(stream.play()) {
            drop(stream);
            return notify_setup_error(ready_tx, error);
        }
        if ready_tx.send(Ok(())).is_err() {
            drop(stream);
            return Err(RecordingError::new(RECORDING_STREAM_ERROR));
        }

        let control = loop {
            match control_rx.recv_timeout(CONTROL_POLL_INTERVAL) {
                Ok(control) => break control,
                Err(mpsc::RecvTimeoutError::Timeout) if first_error.is_set() => {
                    break CaptureControl::Stop
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break CaptureControl::Cancel,
            }
        };
        drop(stream);
        let source_failed = first_error.is_set();
        let writer_result = writer_guard
            .join()
            .map_err(|_| RecordingError::new(RECORDING_STREAM_ERROR))?;
        finish_capture(control, source_failed, writer_result)
    }

    fn build_stream<T: cpal::SizedSample + Copy + Send + 'static>(
        device: &cpal::Device,
        config: &cpal::StreamConfig,
        sender: SyncSender<AudioBlock>,
        first_error: Arc<FirstStreamError>,
        gate: CaptureGate,
        channels: u16,
        convert: fn(&[T], u16) -> Result<AudioBlock, RecordingError>,
    ) -> Result<cpal::Stream, RecordingError> {
        let callback_error = Arc::clone(&first_error);
        device
            .build_input_stream(
                config,
                move |samples: &[T], _| match convert(samples, channels) {
                    Ok(block) => {
                        let _ = submit_gated_block(&gate, &sender, block, &first_error);
                    }
                    Err(_) => first_error.store(),
                },
                move |_| callback_error.store(),
                None,
            )
            .map_err(|_| RecordingError::new(RECORDING_MIC_INIT_FAILED))
    }

    fn notify_setup_error<T>(
        ready_tx: SyncSender<Result<(), RecordingError>>,
        error: RecordingError,
    ) -> Result<T, RecordingError> {
        let _ = ready_tx.send(Err(error.clone()));
        Err(error)
    }
}

#[cfg(target_os = "macos")]
pub(crate) use platform::MacosRecordingBackend;

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::mpsc;

    use super::*;
    use crate::audio_capture::wav_writer::{WaveFormat, WaveWriter};
    use crate::audio_capture::{
        RecordingMode, RecordingPlatform, RECORDING_MIC_ACCESS_DENIED, RECORDING_MIC_INIT_FAILED,
        RECORDING_STREAM_ERROR, RECORDING_SYSTEM_AUDIO_UNAVAILABLE,
        RECORDING_SYSTEM_LOOPBACK_INIT_FAILED,
    };

    struct StubSystemAudioProbe {
        result: Result<SystemAudioAvailability, RecordingError>,
        calls: AtomicUsize,
    }

    impl SystemAudioProbe for StubSystemAudioProbe {
        fn probe(&self) -> Result<SystemAudioAvailability, RecordingError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.result.clone()
        }
    }

    #[test]
    fn capability_matrix_is_stable_and_probe_never_requests_permission() {
        let cases = [
            (PermissionStatus::Authorized, true, true, None),
            (PermissionStatus::NotDetermined, true, true, None),
            (
                PermissionStatus::Denied,
                true,
                false,
                Some(RECORDING_MIC_ACCESS_DENIED),
            ),
            (
                PermissionStatus::Restricted,
                true,
                false,
                Some(RECORDING_MIC_ACCESS_DENIED),
            ),
            (
                PermissionStatus::Authorized,
                false,
                false,
                Some(RECORDING_MIC_INIT_FAILED),
            ),
            (
                PermissionStatus::NotDetermined,
                false,
                false,
                Some(RECORDING_MIC_INIT_FAILED),
            ),
        ];

        for (permission, input_ready, available, reason_code) in cases {
            let capabilities = capabilities_for(permission, || input_ready);
            assert_eq!(capabilities.platform, RecordingPlatform::Macos);
            assert_eq!(capabilities.microphone.available, available);
            assert_eq!(capabilities.microphone.reason_code, reason_code);
            assert!(!capabilities.system_audio.available);
            assert_eq!(
                capabilities.system_audio.reason_code,
                Some(RECORDING_SYSTEM_AUDIO_UNAVAILABLE)
            );

            let payload = serde_json::to_value(&capabilities).expect("serialize capabilities");
            assert_eq!(payload["mixed"]["available"], false);
            assert_eq!(payload["mixed"]["reasonCode"], "RECORDING_MIX_FAILED");
        }

        // There is deliberately no request-access callback in the capability seam.
        // Supplying only the current status and a device/config probe makes prompting
        // impossible during capability evaluation.
    }

    #[test]
    fn system_capability_probe_never_requests_permission() {
        let probe = StubSystemAudioProbe {
            result: Ok(SystemAudioAvailability::Available),
            calls: AtomicUsize::new(0),
        };
        let capabilities =
            capabilities_for_with_system(PermissionStatus::NotDetermined, || true, &probe);

        assert!(capabilities.system_audio.available);
        assert_eq!(probe.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn system_capability_maps_screen_recording_denial_to_unavailable() {
        let probe = StubSystemAudioProbe {
            result: Ok(SystemAudioAvailability::Denied),
            calls: AtomicUsize::new(0),
        };
        let capabilities =
            capabilities_for_with_system(PermissionStatus::Authorized, || true, &probe);

        assert!(!capabilities.system_audio.available);
        assert_eq!(
            capabilities.system_audio.reason_code,
            Some(RECORDING_SYSTEM_AUDIO_UNAVAILABLE)
        );
    }

    #[test]
    fn system_capability_requires_macos_13_and_a_shareable_display() {
        for availability in [
            SystemAudioAvailability::Unsupported,
            SystemAudioAvailability::NoShareableDisplay,
        ] {
            let probe = StubSystemAudioProbe {
                result: Ok(availability),
                calls: AtomicUsize::new(0),
            };
            let capabilities =
                capabilities_for_with_system(PermissionStatus::Authorized, || true, &probe);

            assert!(!capabilities.system_audio.available);
            assert_eq!(
                capabilities.system_audio.reason_code,
                Some(RECORDING_SYSTEM_AUDIO_UNAVAILABLE)
            );
        }
    }

    #[test]
    fn macos_mixed_capability_requires_both_sources() {
        let available_probe = StubSystemAudioProbe {
            result: Ok(SystemAudioAvailability::Available),
            calls: AtomicUsize::new(0),
        };
        let available = capabilities_for_with_system(
            PermissionStatus::Authorized,
            || true,
            &available_probe,
        );
        assert!(available.microphone.available);
        assert!(available.system_audio.available);
        assert!(available.mixed.available);

        let denied_probe = StubSystemAudioProbe {
            result: Ok(SystemAudioAvailability::Denied),
            calls: AtomicUsize::new(0),
        };
        let denied = capabilities_for_with_system(
            PermissionStatus::Authorized,
            || true,
            &denied_probe,
        );
        assert!(!denied.mixed.available);
        assert_eq!(denied.mixed.reason_code, Some(RECORDING_MIX_FAILED));
    }

    #[test]
    fn mixed_requests_microphone_before_system_capture() {
        let prompt_count = AtomicUsize::new(0);
        authorize_microphone_for_mode(RecordingMode::Mixed, PermissionStatus::NotDetermined, || {
            prompt_count.fetch_add(1, Ordering::SeqCst);
            true
        })
        .expect("mixed microphone permission");
        assert_eq!(prompt_count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn mixed_microphone_denial_is_source_tagged() {
        let error = authorize_microphone_for_mode(
            RecordingMode::Mixed,
            PermissionStatus::Denied,
            || true,
        )
        .expect_err("denied microphone permission");
        assert_eq!(error.code, RECORDING_MIC_ACCESS_DENIED);
        assert_eq!(error.source, Some(RecordingSource::Microphone));
    }

    #[test]
    fn system_start_does_not_request_microphone_permission() {
        let prompt_count = AtomicUsize::new(0);
        let result = authorize_start(RecordingMode::System, PermissionStatus::Authorized, || {
            prompt_count.fetch_add(1, Ordering::SeqCst);
            true
        });

        assert_eq!(
            result
                .expect_err("system is not on the microphone path")
                .code,
            RECORDING_SYSTEM_AUDIO_UNAVAILABLE
        );
        assert_eq!(prompt_count.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn system_start_redacts_native_errors_to_stable_codes() {
        #[derive(Debug)]
        struct NativeError;

        let error = map_system_start_error::<NativeError>(Err(NativeError))
            .expect_err("native setup error must be returned");
        let serialized = serde_json::to_string(&error).expect("serialize stable error");

        assert_eq!(error.code, RECORDING_SYSTEM_LOOPBACK_INIT_FAILED);
        assert_eq!(error.message, "System audio could not be initialized.");
        assert!(!serialized.contains("NativeError"));
    }

    #[test]
    fn system_stream_config_is_audio_only_and_excludes_current_process() {
        let config = system_stream_config_spec();

        assert!(config.captures_audio);
        assert!(config.excludes_current_process_audio);
        assert_eq!(config.registered_outputs, [SystemStreamOutput::Audio]);
        assert!(config
            .registered_outputs
            .iter()
            .all(|output| *output != SystemStreamOutput::Screen));
    }

    #[test]
    fn main_display_filter_is_not_a_user_visible_source() {
        let config = system_stream_config_spec();

        assert!(!config.display_is_user_visible_source);
    }

    #[test]
    fn video_buffer_is_fail_closed_and_never_reaches_writer() {
        let error = accept_system_sample(SystemStreamOutput::Screen, Ok(AudioBlock::silence(1, 2)))
            .expect_err("video sample must fail closed");

        assert_eq!(error.code, RECORDING_STREAM_ERROR);
    }

    #[test]
    fn audio_sample_buffers_become_owned_pcm16_blocks() {
        let samples = [-1.0_f32, 0.0, 1.0, 0.5];
        let bytes = samples
            .into_iter()
            .flat_map(|sample| sample.to_ne_bytes())
            .collect::<Vec<_>>();
        let block = system_audio_block_from_bytes(AudioSampleEncoding::F32, &bytes, 2)
            .expect("audio sample conversion");

        assert_eq!(block.frame_count, 2);
        assert_eq!(decode_pcm16(&block.bytes), [-32768, 0, 32767, 16384]);
    }

    #[test]
    fn microphone_start_requests_only_when_not_determined_and_maps_allow_or_deny() {
        let prompt_count = AtomicUsize::new(0);
        authorize_start(RecordingMode::Mic, PermissionStatus::Authorized, || {
            prompt_count.fetch_add(1, Ordering::SeqCst);
            false
        })
        .expect("authorized start");
        assert_eq!(prompt_count.load(Ordering::SeqCst), 0);

        authorize_start(RecordingMode::Mic, PermissionStatus::NotDetermined, || {
            prompt_count.fetch_add(1, Ordering::SeqCst);
            true
        })
        .expect("newly authorized start");
        assert_eq!(prompt_count.load(Ordering::SeqCst), 1);

        let denied = authorize_start(RecordingMode::Mic, PermissionStatus::NotDetermined, || {
            prompt_count.fetch_add(1, Ordering::SeqCst);
            false
        })
        .expect_err("denied request");
        assert_eq!(denied.code, RECORDING_MIC_ACCESS_DENIED);
        assert_eq!(prompt_count.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn system_and_mixed_start_fail_without_prompting() {
        for mode in [RecordingMode::System, RecordingMode::Mixed] {
            let prompt_count = AtomicUsize::new(0);
            let error = authorize_start(mode, PermissionStatus::NotDetermined, || {
                prompt_count.fetch_add(1, Ordering::SeqCst);
                true
            })
            .expect_err("unsupported source");

            assert_eq!(error.code, RECORDING_SYSTEM_AUDIO_UNAVAILABLE);
            assert_eq!(prompt_count.load(Ordering::SeqCst), 0);
        }
    }

    #[test]
    fn converts_supported_interleaved_formats_to_pcm16_with_frame_counts() {
        let f32_block = pcm16_from_f32(&[-1.0, 0.0, 1.0, 0.5], 2).expect("F32 conversion");
        assert_eq!(f32_block.frame_count, 2);
        assert_eq!(decode_pcm16(&f32_block.bytes), [-32768, 0, 32767, 16384]);

        let i16_block = pcm16_from_i16(&[-32768, -1, 0, 32767], 2).expect("I16 conversion");
        assert_eq!(i16_block.frame_count, 2);
        assert_eq!(decode_pcm16(&i16_block.bytes), [-32768, -1, 0, 32767]);

        let u16_block = pcm16_from_u16(&[0, 32767, 32768, 65535], 2).expect("U16 conversion");
        assert_eq!(u16_block.frame_count, 2);
        assert_eq!(decode_pcm16(&u16_block.bytes), [-32768, -1, 0, 32767]);
    }

    #[test]
    fn bounded_queue_full_and_disconnect_store_stream_error_without_blocking() {
        let first_error = FirstStreamError::default();
        let (sender, _receiver) = mpsc::sync_channel(1);
        submit_block(&sender, AudioBlock::silence(1, 1), &first_error).expect("first block");
        let full =
            submit_block(&sender, AudioBlock::silence(1, 1), &first_error).expect_err("queue full");
        assert_eq!(full.code, RECORDING_STREAM_ERROR);
        assert!(first_error.is_set());

        let disconnected_error = FirstStreamError::default();
        let (sender, receiver) = mpsc::sync_channel(1);
        drop(receiver);
        let disconnected = submit_block(&sender, AudioBlock::silence(1, 1), &disconnected_error)
            .expect_err("queue disconnected");
        assert_eq!(disconnected.code, RECORDING_STREAM_ERROR);
        assert!(disconnected_error.is_set());
    }

    #[test]
    fn source_stream_error_wins_over_concurrent_normal_stop() {
        let root = temp_root();
        let path = root.join("mic.wav");
        let format = WaveFormat::pcm_s16le(1, 16_000).expect("format");
        let mut writer = WaveWriter::create(&path, format).expect("writer");
        writer.write_silence(2).expect("silence");
        let summary = writer.finish().expect("summary");

        let first_error = FirstStreamError::default();
        first_error.store();
        let error = finish_capture(CaptureControl::Stop, first_error.is_set(), Ok(summary))
            .expect_err("source error wins");
        assert_eq!(error.code, RECORDING_STREAM_ERROR);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn stop_drains_blocks_and_returns_valid_silent_or_non_silent_summary() {
        for (samples, expected_silent) in [(&[1i16, 0][..], false), (&[0i16, 0][..], true)] {
            let root = temp_root();
            let path = root.join("mic.wav");
            let format = WaveFormat::pcm_s16le(1, 16_000).expect("format");
            let (sender, receiver) = mpsc::sync_channel(2);
            let writer = std::thread::spawn({
                let path = path.clone();
                move || run_writer(path, format, receiver)
            });
            sender
                .send(pcm16_from_i16(samples, 1).expect("block"))
                .expect("queue block");
            drop(sender);

            let summary = writer.join().expect("join writer").expect("writer summary");
            let capture = finish_capture(CaptureControl::Stop, false, Ok(summary))
                .expect("stop capture")
                .expect("captured recording");
            assert_eq!(capture.valid_frame_count, 2);
            assert_eq!(capture.silent, expected_silent);
            assert_eq!(capture.source_paths, [path]);
            std::fs::remove_dir_all(root).expect("cleanup");
        }
    }

    #[test]
    fn system_start_stop_returns_one_captured_recording() {
        let root = temp_root();
        let path = root.join("system.wav");
        let format = WaveFormat::pcm_s16le(2, 48_000).expect("format");
        let (sender, receiver) = mpsc::sync_channel(2);
        let writer = std::thread::spawn({
            let path = path.clone();
            move || run_writer(path, format, receiver)
        });
        sender
            .send(pcm16_from_i16(&[1, 0, -1, 0], 2).expect("block"))
            .expect("queue block");
        drop(sender);

        let summary = writer.join().expect("join writer").expect("writer summary");
        let capture = finish_capture(CaptureControl::Stop, false, Ok(summary))
            .expect("stop capture")
            .expect("captured recording");

        assert_eq!(capture.valid_frame_count, 2);
        assert_eq!(capture.source_paths, [path]);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn system_stop_drains_blocks_and_preserves_silent_recordings() {
        let root = temp_root();
        let path = root.join("system.wav");
        let format = WaveFormat::pcm_s16le(2, 48_000).expect("format");
        let (sender, receiver) = mpsc::sync_channel(2);
        let writer = std::thread::spawn({
            let path = path.clone();
            move || run_writer(path, format, receiver)
        });
        sender.send(AudioBlock::silence(2, 2)).expect("first block");
        sender
            .send(AudioBlock::silence(3, 2))
            .expect("second block");
        drop(sender);

        let summary = writer.join().expect("join writer").expect("writer summary");
        let capture = finish_capture(CaptureControl::Stop, false, Ok(summary))
            .expect("stop capture")
            .expect("captured recording");

        assert_eq!(capture.valid_frame_count, 5);
        assert!(capture.silent);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn system_empty_capture_returns_recording_empty() {
        let root = temp_root();
        let path = root.join("system.wav");
        let format = WaveFormat::pcm_s16le(2, 48_000).expect("format");
        let (sender, receiver) = mpsc::sync_channel(1);
        drop(sender);
        let summary = run_writer(path.clone(), format, receiver).expect("empty summary");
        let capture = finish_capture(CaptureControl::Stop, false, Ok(summary))
            .expect("stop capture")
            .expect("captured recording");

        assert_eq!(capture.valid_frame_count, 0);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn system_cancel_leaves_no_temporary_wav() {
        let root = temp_root();
        let path = root.join("system.wav");
        let format = WaveFormat::pcm_s16le(2, 48_000).expect("format");
        let (sender, receiver) = mpsc::sync_channel(1);
        drop(sender);
        let summary = run_writer(path.clone(), format, receiver).expect("summary");
        assert!(finish_capture(CaptureControl::Cancel, false, Ok(summary))
            .expect("cancel")
            .is_none());

        assert!(path.exists());
        std::fs::remove_dir_all(root).expect("controller cleanup");
        assert!(!path.exists());
    }

    #[test]
    fn system_queue_overflow_maps_to_stream_error_without_blocking() {
        let first_error = FirstStreamError::default();
        let (sender, _receiver) = mpsc::sync_channel(1);
        submit_block(&sender, AudioBlock::silence(1, 2), &first_error).expect("first block");
        let error = submit_block(&sender, AudioBlock::silence(1, 2), &first_error)
            .expect_err("queue overflow");

        assert_eq!(error.code, RECORDING_STREAM_ERROR);
        assert!(first_error.is_set());
    }

    #[test]
    fn macos_callback_drops_pre_gate_block_and_writes_post_gate_block() {
        let gate = CaptureGate::default();
        let (sender, receiver) = mpsc::sync_channel(2);
        let first_error = FirstStreamError::with_gate(gate.clone());
        submit_gated_block(
            &gate,
            &sender,
            AudioBlock {
                bytes: vec![1, 0],
                frame_count: 1,
                silent: false,
            },
            &first_error,
        )
        .expect("drop pre-gate block");
        assert!(receiver.try_recv().is_err());

        gate.open();
        submit_gated_block(
            &gate,
            &sender,
            AudioBlock {
                bytes: vec![2, 0],
                frame_count: 1,
                silent: false,
            },
            &first_error,
        )
        .expect("submit post-gate block");
        assert_eq!(receiver.recv().expect("post-gate block").frame_count, 1);
    }

    #[test]
    fn system_runtime_error_wins_over_concurrent_stop() {
        let root = temp_root();
        let path = root.join("system.wav");
        let format = WaveFormat::pcm_s16le(2, 48_000).expect("format");
        let mut writer = WaveWriter::create(&path, format).expect("writer");
        writer.write_silence(2).expect("silence");
        let summary = writer.finish().expect("summary");
        let first_error = FirstStreamError::default();
        first_error.store();

        let error = finish_capture(CaptureControl::Stop, first_error.is_set(), Ok(summary))
            .expect_err("runtime error wins");
        assert_eq!(error.code, RECORDING_STREAM_ERROR);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn cancel_terminates_without_returning_a_capture_product() {
        let root = temp_root();
        let path = root.join("mic.wav");
        let format = WaveFormat::pcm_s16le(1, 16_000).expect("format");
        let (sender, receiver) = mpsc::sync_channel(1);
        let writer = std::thread::spawn(move || run_writer(path, format, receiver));
        sender
            .send(AudioBlock::silence(2, 1))
            .expect("queue silence");
        drop(sender);
        let summary = writer.join().expect("join writer").expect("writer summary");

        assert!(finish_capture(CaptureControl::Cancel, false, Ok(summary))
            .expect("cancel")
            .is_none());
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    // ---- Task 3: native stream supervisor fake-driver tests ----
    //
    // The supervisor decisions (filter update first, rebuild on update
    // failure, stable source error when no replacement stream survives) are
    // driven here through fake stream/display drivers so the recovery
    // behaviour is verified without a live ScreenCaptureKit stream.
    #[cfg(target_os = "macos")]
    mod supervisor {
        use std::sync::mpsc::{self, SyncSender};
        use std::sync::{Arc, Mutex};

        use super::super::platform::{
            DisplayAnchor, SystemStream, SystemStreamEvent, SystemStreamFactory,
            SystemStreamSupervisor,
        };
        use super::super::{
            FirstStreamError, RecordingError, SystemStreamOutput, RECORDING_STREAM_ERROR,
        };

        #[derive(Debug, Clone, PartialEq, Eq)]
        enum FakeStreamCall {
            UpdateFilter(DisplayAnchor),
            Start,
            Stop,
        }

        #[derive(Default)]
        struct FakeSystemStreamInner {
            update_error: Option<RecordingError>,
            start_error: Option<RecordingError>,
            calls: Vec<FakeStreamCall>,
        }

        struct FakeSystemStream {
            inner: Arc<Mutex<FakeSystemStreamInner>>,
        }

        impl FakeSystemStream {
            pub(crate) fn new() -> Self {
                Self {
                    inner: Arc::new(Mutex::new(FakeSystemStreamInner::default())),
                }
            }

            fn with_update_error(error: RecordingError) -> Self {
                let stream = Self::new();
                stream.inner.lock().unwrap().update_error = Some(error);
                stream
            }
        }

        impl SystemStream for FakeSystemStream {
            fn update_content_filter(&self, display: DisplayAnchor) -> Result<(), RecordingError> {
                let mut inner = self.inner.lock().unwrap();
                inner.calls.push(FakeStreamCall::UpdateFilter(display));
                match &inner.update_error {
                    Some(error) => Err(error.clone()),
                    None => Ok(()),
                }
            }

            fn start_capture(&self) -> Result<(), RecordingError> {
                let mut inner = self.inner.lock().unwrap();
                inner.calls.push(FakeStreamCall::Start);
                match &inner.start_error {
                    Some(error) => Err(error.clone()),
                    None => Ok(()),
                }
            }

            fn stop_capture(&self) -> Result<(), RecordingError> {
                self.inner.lock().unwrap().calls.push(FakeStreamCall::Stop);
                Ok(())
            }
        }

        struct FakeSystemStreamFactory {
            anchor: DisplayAnchor,
            create_error: Option<RecordingError>,
            created_anchors: Mutex<Vec<DisplayAnchor>>,
            registered_outputs: Mutex<Vec<SystemStreamOutput>>,
            streams: Mutex<Vec<Arc<Mutex<FakeSystemStreamInner>>>>,
        }

        impl FakeSystemStreamFactory {
            pub(crate) fn new(anchor: DisplayAnchor) -> Self {
                Self {
                    anchor,
                    create_error: None,
                    created_anchors: Mutex::new(Vec::new()),
                    registered_outputs: Mutex::new(Vec::new()),
                    streams: Mutex::new(Vec::new()),
                }
            }

            fn created_anchors(&self) -> Vec<DisplayAnchor> {
                self.created_anchors.lock().unwrap().clone()
            }

            fn registered_outputs(&self) -> Vec<SystemStreamOutput> {
                self.registered_outputs.lock().unwrap().clone()
            }

            fn last_stream(&self) -> Arc<Mutex<FakeSystemStreamInner>> {
                self.streams
                    .lock()
                    .unwrap()
                    .last()
                    .expect("a stream was created")
                    .clone()
            }

            fn stream_count(&self) -> usize {
                self.streams.lock().unwrap().len()
            }
        }

        impl SystemStreamFactory for FakeSystemStreamFactory {
            fn probe_display_anchor(&self) -> Result<DisplayAnchor, RecordingError> {
                Ok(self.anchor)
            }

            fn create_stream(
                &self,
                display: DisplayAnchor,
                _events: SyncSender<SystemStreamEvent>,
                _interrupt: SyncSender<()>,
                _first_error: Arc<FirstStreamError>,
            ) -> Result<Box<dyn SystemStream>, RecordingError> {
                if let Some(error) = &self.create_error {
                    return Err(error.clone());
                }
                self.created_anchors.lock().unwrap().push(display);
                self.registered_outputs
                    .lock()
                    .unwrap()
                    .push(SystemStreamOutput::Audio);
                let inner = Arc::new(Mutex::new(FakeSystemStreamInner::default()));
                self.streams.lock().unwrap().push(Arc::clone(&inner));
                Ok(Box::new(FakeSystemStream { inner }))
            }
        }

        fn supervisor_with(
            factory: &FakeSystemStreamFactory,
            stream: FakeSystemStream,
            events: SyncSender<SystemStreamEvent>,
        ) -> SystemStreamSupervisor<'_> {
            let (interrupt_tx, _interrupt_rx) = mpsc::sync_channel(1);
            SystemStreamSupervisor::new(
                factory,
                Some(Box::new(stream)),
                factory.anchor,
                events,
                interrupt_tx,
                Arc::new(FirstStreamError::default()),
            )
        }

        #[test]
        fn stream_delegate_error_starts_recovery() {
            let factory = FakeSystemStreamFactory::new(1);
            let stream = FakeSystemStream::new();
            let stream_inner = Arc::clone(&stream.inner);
            let (events_tx, events_rx) = mpsc::sync_channel(8);
            let mut supervisor = supervisor_with(&factory, stream, events_tx);

            supervisor
                .handle_stream_interrupted(10_000)
                .expect("delegate error starts recovery without failing");

            assert_eq!(
                events_rx.try_recv(),
                Ok(SystemStreamEvent::Interrupt { now_ms: 10_000 })
            );
            assert_eq!(
                stream_inner.lock().unwrap().calls,
                vec![FakeStreamCall::UpdateFilter(1)]
            );
            assert_eq!(
                factory.stream_count(),
                0,
                "filter update succeeds so no rebuild is requested"
            );
        }

        #[test]
        fn display_anchor_change_updates_filter_before_rebuild() {
            let factory = FakeSystemStreamFactory::new(1);
            let stream = FakeSystemStream::new();
            let stream_inner = Arc::clone(&stream.inner);
            let (events_tx, events_rx) = mpsc::sync_channel(8);
            let mut supervisor = supervisor_with(&factory, stream, events_tx);

            supervisor
                .handle_display_anchor_changed(2, 10_000)
                .expect("anchor change reconciles without failing");

            assert_eq!(
                events_rx.try_recv(),
                Ok(SystemStreamEvent::Interrupt { now_ms: 10_000 })
            );
            assert_eq!(
                stream_inner.lock().unwrap().calls,
                vec![FakeStreamCall::UpdateFilter(2)]
            );
            assert_eq!(factory.created_anchors(), Vec::<DisplayAnchor>::new());
        }

        #[test]
        fn filter_update_failure_rebuilds_audio_only_stream() {
            let factory = FakeSystemStreamFactory::new(1);
            let stream =
                FakeSystemStream::with_update_error(RecordingError::new(RECORDING_STREAM_ERROR));
            let old_inner = Arc::clone(&stream.inner);
            let (events_tx, _events_rx) = mpsc::sync_channel(8);
            let mut supervisor = supervisor_with(&factory, stream, events_tx);

            supervisor
                .handle_display_anchor_changed(2, 10_000)
                .expect("update failure rebuilds instead of failing");

            assert_eq!(
                old_inner.lock().unwrap().calls,
                vec![FakeStreamCall::UpdateFilter(2), FakeStreamCall::Stop]
            );
            assert_eq!(factory.created_anchors(), vec![2]);
            assert_eq!(
                factory.registered_outputs(),
                vec![SystemStreamOutput::Audio]
            );
            let rebuilt = factory.last_stream();
            assert_eq!(rebuilt.lock().unwrap().calls, vec![FakeStreamCall::Start]);
        }

        #[test]
        fn rebuild_failure_maps_to_system_stream_error() {
            let mut factory = FakeSystemStreamFactory::new(1);
            factory.create_error = Some(RecordingError::new(RECORDING_STREAM_ERROR));
            let stream =
                FakeSystemStream::with_update_error(RecordingError::new(RECORDING_STREAM_ERROR));
            let (events_tx, _events_rx) = mpsc::sync_channel(8);
            let mut supervisor = supervisor_with(&factory, stream, events_tx);

            let error = supervisor
                .handle_display_anchor_changed(2, 10_000)
                .expect_err("no replacement stream survives");
            assert_eq!(error.code, RECORDING_STREAM_ERROR);
        }

        #[test]
        fn display_anchor_change_does_not_change_user_source() {
            let factory = FakeSystemStreamFactory::new(1);
            let stream = FakeSystemStream::new();
            let (events_tx, _events_rx) = mpsc::sync_channel(8);
            let mut supervisor = supervisor_with(&factory, stream, events_tx);

            supervisor
                .handle_display_anchor_changed(2, 10_000)
                .expect("anchor change keeps the user source");

            let outputs = factory.registered_outputs();
            assert!(
                outputs
                    .iter()
                    .all(|output| *output != SystemStreamOutput::Screen
                        && *output != SystemStreamOutput::Microphone),
                "display ids never appear in source selection; only Audio is registered"
            );
            assert_eq!(factory.stream_count(), 0);
        }
    }

    #[cfg(target_os = "macos")]
    mod worker_capture {
        use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
        use std::sync::mpsc::{self, SyncSender};
        use std::sync::{Arc, Mutex};
        use std::thread;
        use std::time::Duration;

        use super::super::platform::{
            DisplayAnchor, SystemStream, SystemStreamEvent, SystemStreamFactory,
            run_system_capture_worker,
        };
        use super::super::{
            AudioBlock, CaptureControl, FirstStreamError, RecordingError, RECORDING_STREAM_ERROR,
        };
        use crate::audio_capture::RecordingWarningReporter;
        use crate::audio_capture::system_audio_recovery::AudioSampleTiming;

        // A fake system-audio driver that actually pumps Audio blocks onto the
        // worker's event channel, so the real system-capture worker loop
        // (interrupt consumption, supervisor reconcile, recovery window,
        // shutdown, WAV finalize) is exercised end-to-end without ScreenCaptureKit.
        // The sample counter is shared across rebuilt streams so presentation
        // timestamps stay monotonic, mirroring the device clock the real
        // ScreenCaptureKit stream uses across rebuilds.
        struct WorkerFakeFactory {
            anchor: DisplayAnchor,
            second_anchor: DisplayAnchor,
            anchor_probe_count: Arc<AtomicUsize>,
            create_stream_count: Arc<AtomicUsize>,
            update_failures_remaining: Arc<AtomicUsize>,
            interrupt_sender: Arc<Mutex<Option<SyncSender<()>>>>,
            counter: Arc<AtomicU64>,
            pump_stop_after_interrupt: bool,
            interrupt_seen: Arc<AtomicBool>,
        }

        impl SystemStreamFactory for WorkerFakeFactory {
            fn probe_display_anchor(&self) -> Result<DisplayAnchor, RecordingError> {
                // The first probe seeds the initial anchor; every subsequent
                // probe reports a different display, simulating a display swap
                // so the supervisor's anchor-change handler is exercised.
                let call = self.anchor_probe_count.fetch_add(1, Ordering::SeqCst);
                if call == 0 {
                    Ok(self.anchor)
                } else {
                    Ok(self.second_anchor)
                }
            }

            fn create_stream(
                &self,
                _display: DisplayAnchor,
                events: SyncSender<SystemStreamEvent>,
                interrupt: SyncSender<()>,
                _first_error: Arc<FirstStreamError>,
            ) -> Result<Box<dyn SystemStream>, RecordingError> {
                self.create_stream_count.fetch_add(1, Ordering::SeqCst);
                *self.interrupt_sender.lock().unwrap() = Some(interrupt);
                Ok(Box::new(WorkerFakeStream {
                    stop: Arc::new(AtomicBool::new(false)),
                    events,
                    update_failures_remaining: Arc::clone(&self.update_failures_remaining),
                    counter: Arc::clone(&self.counter),
                    pump: Arc::new(Mutex::new(None)),
                    pump_stop_after_interrupt: self.pump_stop_after_interrupt,
                    interrupt_seen: Arc::clone(&self.interrupt_seen),
                }))
        }

        fn mark_interrupt_consumed(&self) {
            self.interrupt_seen.store(true, Ordering::SeqCst);
        }
    }

        struct WorkerFakeStream {
            stop: Arc<AtomicBool>,
            events: SyncSender<SystemStreamEvent>,
            update_failures_remaining: Arc<AtomicUsize>,
            counter: Arc<AtomicU64>,
            pump: Arc<Mutex<Option<thread::JoinHandle<()>>>>,
            pump_stop_after_interrupt: bool,
            interrupt_seen: Arc<AtomicBool>,
        }

        impl SystemStream for WorkerFakeStream {
            fn update_content_filter(
                &self,
                _display: DisplayAnchor,
            ) -> Result<(), RecordingError> {
                // Fail the first `update_failures_remaining` calls, then succeed.
                let remaining = self.update_failures_remaining.load(Ordering::SeqCst);
                if remaining > 0 {
                    self.update_failures_remaining.fetch_sub(1, Ordering::SeqCst);
                    return Err(RecordingError::new(RECORDING_STREAM_ERROR));
                }
                Ok(())
            }

            fn start_capture(&self) -> Result<(), RecordingError> {
                let stop = Arc::clone(&self.stop);
                let events = self.events.clone();
                let counter = Arc::clone(&self.counter);
                let stop_after_interrupt = self.pump_stop_after_interrupt;
                let interrupt_seen = Arc::clone(&self.interrupt_seen);
                let handle = thread::spawn(move || {
                    while !stop.load(Ordering::SeqCst) {
                        // When configured, stop pumping as soon as the worker
                        // consumes the interrupt, so the recovery window opens
                        // with no further audio. The writer's wall-clock
                        // deadline (based on the worker's Instant clock) then
                        // elapses and the source is failed.
                        if stop_after_interrupt && interrupt_seen.load(Ordering::SeqCst) {
                            break;
                        }
                        let i = counter.fetch_add(1, Ordering::SeqCst);
                        let timing = AudioSampleTiming {
                            presentation_ns: i * 10_000_000,
                            duration_ns: 10_000_000,
                            valid: true,
                        };
                        let block = AudioBlock {
                            bytes: vec![0u8; 480 * 2 * 2],
                            frame_count: 480,
                            silent: false,
                        };
                        if events
                            .try_send(SystemStreamEvent::Audio { block, timing })
                            .is_err()
                        {
                            break;
                        }
                        thread::sleep(Duration::from_millis(5));
                    }
                });
                *self.pump.lock().unwrap() = Some(handle);
                Ok(())
            }

            fn stop_capture(&self) -> Result<(), RecordingError> {
                self.stop.store(true, Ordering::SeqCst);
                // Join the pump thread so the rebuild hands off cleanly: the old
                // stream's samples finish flushing before the new stream starts,
                // keeping presentation timestamps monotonic in the channel. The
                // real ScreenCaptureKit device clock continues across rebuilds;
                // a naive independent-thread model would interleave the two
                // streams and trip the writer's non-monotonic guard.
                if let Some(handle) = self.pump.lock().unwrap().take() {
                    let _ = handle.join();
                }
                Ok(())
            }
        }

        fn run_worker(
            factory: Arc<WorkerFakeFactory>,
            interrupt_sender: Arc<Mutex<Option<SyncSender<()>>>>,
            interrupt_at_ms: Option<u64>,
            second_interrupt_at_ms: Option<u64>,
            send_stop: bool,
            stop_delay_ms: u64,
        ) -> Result<Option<crate::audio_capture::CapturedRecording>, RecordingError> {
            let path = std::env::temp_dir().join(format!(
                "studymind-worker-test-{}-{}.wav",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            let (control_tx, control_rx) = mpsc::channel();
            let (ready_tx, ready_rx) = mpsc::sync_channel(1);
            let reporter = RecordingWarningReporter::no_op();
            let worker = thread::Builder::new()
                .name("studymind-worker-test".to_string())
                .spawn(move || {
                    run_system_capture_worker(factory, path.clone(), control_rx, ready_tx, reporter)
                })
                .expect("spawn worker");
            ready_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("worker becomes ready")
                .expect("worker reports ready without error");

            let interrupt = |at_ms: u64| {
                // Let some audio flow, then simulate the SCStream delegate
                // firing did_stop_with_error by signalling the interrupt channel.
                thread::sleep(Duration::from_millis(at_ms));
                if let Some(sender) = interrupt_sender.lock().unwrap().clone() {
                    let _ = sender.try_send(());
                }
            };

            if let Some(at_ms) = interrupt_at_ms {
                interrupt(at_ms);
            }
            if let Some(at_ms) = second_interrupt_at_ms {
                // The second interrupt fires after the first; the worker marks
                // the interrupt consumed on its next poll, so mirror that here
                // to let the deadline/stop pumps observe it.
                interrupt(at_ms);
            }
            if send_stop {
                // Normal happy-path: stop after `stop_delay_ms` so the capture
                // drains and finalizes. The deadline test uses a delay longer
                // than the 2s wall-clock recovery window so the writer fails the
                // source first; Stop then finalizes the failure.
                thread::sleep(Duration::from_millis(stop_delay_ms));
                control_tx
                    .send(CaptureControl::Stop)
                    .expect("send stop control");
            }
            worker.join().expect("worker thread joins")
        }

        /// Build a WorkerFakeFactory with the given knobs. `interrupt_seen` is
        /// shared so the pump thread can stop after the worker consumes an
        /// interrupt (used to simulate a stream that goes permanently silent so
        /// the recovery deadline elapses). The factory reports `anchor` on the
        /// first probe and `second_anchor` thereafter, simulating a display swap.
        fn build_factory(
            create_stream_count: Arc<AtomicUsize>,
            update_failures_remaining: Arc<AtomicUsize>,
            interrupt_sender: Arc<Mutex<Option<SyncSender<()>>>>,
            pump_stop_after_interrupt: bool,
            interrupt_seen: Arc<AtomicBool>,
        ) -> Arc<WorkerFakeFactory> {
            Arc::new(WorkerFakeFactory {
                anchor: 1,
                second_anchor: 2,
                anchor_probe_count: Arc::new(AtomicUsize::new(0)),
                create_stream_count,
                update_failures_remaining,
                interrupt_sender,
                counter: Arc::new(AtomicU64::new(0)),
                pump_stop_after_interrupt,
                interrupt_seen,
            })
        }

        #[test]
        fn worker_recovers_from_interrupt_without_rebuilding_stream() {
            let create_stream_count = Arc::new(AtomicUsize::new(0));
            let update_failures_remaining = Arc::new(AtomicUsize::new(0));
            let interrupt_sender = Arc::new(Mutex::new(None));
            let interrupt_seen = Arc::new(AtomicBool::new(false));
            let factory = build_factory(
                Arc::clone(&create_stream_count),
                Arc::clone(&update_failures_remaining),
                Arc::clone(&interrupt_sender),
                false,
                Arc::clone(&interrupt_seen),
            );

            let recording = run_worker(factory, interrupt_sender, Some(60), None, true, 60)
                .expect("capture completes after interrupt")
                .expect("capture produced a recording");

            assert!(recording.valid_frame_count > 0, "audio was written");
            assert_eq!(
                create_stream_count.load(Ordering::SeqCst),
                1,
                "filter update succeeded so no rebuild happened"
            );
        }

        #[test]
        fn worker_rebuilds_stream_when_filter_update_fails() {
            let create_stream_count = Arc::new(AtomicUsize::new(0));
            let update_failures_remaining = Arc::new(AtomicUsize::new(1));
            let interrupt_sender = Arc::new(Mutex::new(None));
            let interrupt_seen = Arc::new(AtomicBool::new(false));
            let factory = build_factory(
                Arc::clone(&create_stream_count),
                Arc::clone(&update_failures_remaining),
                Arc::clone(&interrupt_sender),
                false,
                Arc::clone(&interrupt_seen),
            );

            let recording = run_worker(factory, interrupt_sender, Some(60), None, true, 60)
                .expect("capture completes after rebuild")
                .expect("capture produced a recording");

            assert!(recording.valid_frame_count > 0, "audio was written");
            assert_eq!(
                create_stream_count.load(Ordering::SeqCst),
                2,
                "filter update failed so the stream was rebuilt once"
            );
            assert_eq!(
                update_failures_remaining.load(Ordering::SeqCst),
                0,
                "the failed update was consumed by reconcile"
            );
        }

        #[test]
        fn worker_second_interrupt_in_window_does_not_rebuild() {
            // Two interrupts inside the open 2s recovery window must NOT trigger
            // a second rebuild: the supervisor reconciles on the first and the
            // open window absorbs the second. The stream is created exactly once
            // and audio keeps flowing, so the capture completes successfully.
            let create_stream_count = Arc::new(AtomicUsize::new(0));
            let update_failures_remaining = Arc::new(AtomicUsize::new(0));
            let interrupt_sender = Arc::new(Mutex::new(None));
            let interrupt_seen = Arc::new(AtomicBool::new(false));
            let factory = build_factory(
                Arc::clone(&create_stream_count),
                Arc::clone(&update_failures_remaining),
                Arc::clone(&interrupt_sender),
                false,
                Arc::clone(&interrupt_seen),
            );

            let recording = run_worker(factory, interrupt_sender, Some(60), Some(90), true, 60)
                .expect("capture completes after double interrupt")
                .expect("capture produced a recording");

            assert!(recording.valid_frame_count > 0, "audio was written");
            assert_eq!(
                create_stream_count.load(Ordering::SeqCst),
                1,
                "the second interrupt inside the open window must not rebuild"
            );
        }

        #[test]
        fn worker_fails_source_when_recovery_deadline_elapses() {
            // Simulate a stream that goes permanently silent after the interrupt:
            // the pump stops, no audio arrives, and the writer's wall-clock
            // recovery deadline (2s, based on the worker's Instant clock) elapses
            // without further audio, so the source is failed with
            // RECORDING_STREAM_ERROR rather than producing a recording.
            let create_stream_count = Arc::new(AtomicUsize::new(0));
            let update_failures_remaining = Arc::new(AtomicUsize::new(0));
            let interrupt_sender = Arc::new(Mutex::new(None));
            let interrupt_seen = Arc::new(AtomicBool::new(false));
            let factory = build_factory(
                Arc::clone(&create_stream_count),
                Arc::clone(&update_failures_remaining),
                Arc::clone(&interrupt_sender),
                true,
                Arc::clone(&interrupt_seen),
            );

            let result = run_worker(factory, interrupt_sender, Some(60), None, true, 2500);
            assert!(
                matches!(result, Err(ref e) if e.code == RECORDING_STREAM_ERROR),
                "deadline elapsed with no audio must fail the source: {:?}",
                result
            );
        }

        #[test]
        fn worker_recovers_from_display_anchor_change_without_rebuilding() {
            // A routine display swap that the content filter can absorb must NOT
            // rebuild the stream: probe_display_anchor reports a new anchor on
            // the 250ms topology poll, the supervisor retargets the filter, and
            // audio keeps flowing. The stream is created exactly once.
            let create_stream_count = Arc::new(AtomicUsize::new(0));
            let update_failures_remaining = Arc::new(AtomicUsize::new(0));
            let interrupt_sender = Arc::new(Mutex::new(None));
            let interrupt_seen = Arc::new(AtomicBool::new(false));
            let factory = build_factory(
                Arc::clone(&create_stream_count),
                Arc::clone(&update_failures_remaining),
                Arc::clone(&interrupt_sender),
                false,
                Arc::clone(&interrupt_seen),
            );

            // No interrupt; let the topology poll (250ms) fire the anchor change.
            let recording = run_worker(factory, interrupt_sender, None, None, true, 400)
                .expect("capture completes after display anchor change")
                .expect("capture produced a recording");

            assert!(recording.valid_frame_count > 0, "audio was written");
            assert_eq!(
                create_stream_count.load(Ordering::SeqCst),
                1,
                "filter update absorbed the anchor change so no rebuild happened"
            );
        }

        #[test]
        fn worker_rebuilds_stream_when_anchor_change_filter_update_fails() {
            // When the content filter cannot retarget to the new display, the
            // supervisor must rebuild the stream. The first topology poll after
            // the swap reports a new anchor and the filter update fails once,
            // triggering exactly one rebuild.
            let create_stream_count = Arc::new(AtomicUsize::new(0));
            let update_failures_remaining = Arc::new(AtomicUsize::new(1));
            let interrupt_sender = Arc::new(Mutex::new(None));
            let interrupt_seen = Arc::new(AtomicBool::new(false));
            let factory = build_factory(
                Arc::clone(&create_stream_count),
                Arc::clone(&update_failures_remaining),
                Arc::clone(&interrupt_sender),
                false,
                Arc::clone(&interrupt_seen),
            );

            let recording = run_worker(factory, interrupt_sender, None, None, true, 400)
                .expect("capture completes after anchor-change rebuild")
                .expect("capture produced a recording");

            assert!(recording.valid_frame_count > 0, "audio was written");
            assert_eq!(
                create_stream_count.load(Ordering::SeqCst),
                2,
                "anchor-change filter update failed so the stream was rebuilt once"
            );
            assert_eq!(
                update_failures_remaining.load(Ordering::SeqCst),
                0,
                "the failed update was consumed by reconcile"
            );
        }
    }

    fn decode_pcm16(bytes: &[u8]) -> Vec<i16> {
        bytes
            .chunks_exact(2)
            .map(|sample| i16::from_le_bytes([sample[0], sample[1]]))
            .collect()
    }

    #[test]
    fn stream_play_failure_maps_to_microphone_initialization_error() {
        let error = map_stream_play_error::<()>(Err(())).expect_err("stream play must fail");
        assert_eq!(error.code, RECORDING_MIC_INIT_FAILED);
    }

    #[test]
    fn startup_failure_signal_is_propagated_by_the_readiness_handshake() {
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        ready_tx
            .send(Err(RecordingError::new(RECORDING_MIC_INIT_FAILED)))
            .expect("send startup failure");

        let error = receive_startup_signal(&ready_rx).expect_err("startup must fail");
        assert_eq!(error.code, RECORDING_MIC_INIT_FAILED);
    }

    #[test]
    fn writer_join_guard_closes_sender_before_drop_joins_writer() {
        let (sender, receiver) = mpsc::sync_channel::<AudioBlock>(1);
        let writer_exited = std::sync::Arc::new(AtomicBool::new(false));
        let writer_exited_in_thread = std::sync::Arc::clone(&writer_exited);
        let writer = std::thread::spawn(move || {
            assert!(receiver.recv().is_err());
            writer_exited_in_thread.store(true, Ordering::SeqCst);
        });

        drop(WriterJoinGuard::new(writer, sender));

        assert!(writer_exited.load(Ordering::SeqCst));
    }

    fn temp_root() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("StudyMind-macos-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp root");
        root
    }
}
