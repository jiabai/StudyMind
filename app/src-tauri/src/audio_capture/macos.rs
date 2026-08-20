use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "macos")]
use std::sync::mpsc;
use std::sync::mpsc::{Receiver, SyncSender, TrySendError};
use std::thread::JoinHandle;

use super::wav_writer::{WavCaptureSummary, WaveFormat, WaveWriter};
#[cfg(target_os = "macos")]
use super::CaptureWorkspace;
use super::{
    CapturedRecording, RecordingCapabilities, RecordingError, RecordingMode, RecordingPlatform,
    RecordingErrorCode, RecordingSourceCapability, RECORDING_MIC_ACCESS_DENIED,
    RECORDING_MIC_INIT_FAILED,
    RECORDING_MIX_FAILED, RECORDING_STREAM_ERROR, RECORDING_SYSTEM_AUDIO_UNAVAILABLE,
    RECORDING_SYSTEM_LOOPBACK_INIT_FAILED,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PermissionStatus {
    Authorized,
    NotDetermined,
    Denied,
    Restricted,
}

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
    fn start(
        &self,
        workspace: &super::CaptureWorkspace,
    ) -> Result<Box<dyn super::ActiveCapture>, RecordingError>;
}

struct UnavailableSystemAudioProbe;

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
        Ok(SystemAudioAvailability::InitializationFailed) | Err(_) => {
            RecordingSourceCapability {
                available: false,
                reason_code: Some(RECORDING_SYSTEM_LOOPBACK_INIT_FAILED),
            }
        }
    }
}

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

    RecordingCapabilities {
        platform: RecordingPlatform::Macos,
        microphone,
        system_audio: system_capability_for(system_probe.probe()),
        mixed: RecordingSourceCapability {
            available: false,
            reason_code: Some(RECORDING_MIX_FAILED),
        },
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

#[derive(Debug)]
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
                    chunk.try_into().expect("chunks_exact guarantees four bytes"),
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
    receiver
        .recv()
        .map_err(|_| RecordingError::new(fallback))?
}

#[derive(Default)]
struct FirstStreamError(AtomicBool);

impl FirstStreamError {
    fn store(&self) {
        let _ = self
            .0
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst);
    }

    fn is_set(&self) -> bool {
        self.0.load(Ordering::SeqCst)
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

struct WriterJoinGuard<T> {
    writer: Option<JoinHandle<T>>,
    sender: Option<SyncSender<AudioBlock>>,
}

impl<T> WriterJoinGuard<T> {
    fn new(writer: JoinHandle<T>, sender: SyncSender<AudioBlock>) -> Self {
        Self {
            writer: Some(writer),
            sender: Some(sender),
        }
    }

    #[cfg(target_os = "macos")]
    fn sender(&self) -> SyncSender<AudioBlock> {
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

impl<T> Drop for WriterJoinGuard<T> {
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
    use crate::audio_capture::{ActiveCapture, RecordingBackend};

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

    fn configure_system_audio_stream(
        filter: &SCContentFilter,
        sender: SyncSender<AudioBlock>,
        first_error: Arc<FirstStreamError>,
    ) -> Result<SCStream, RecordingError> {
        let config = native_system_stream_configuration();
        let mut stream = SCStream::new(filter, &config);
        let callback_error = Arc::clone(&first_error);
        let registered = stream.add_output_handler(
            move |sample: CMSampleBuffer, output: SCStreamOutputType| {
                let output = native_system_stream_output(output);
                let block = if output == SystemStreamOutput::Audio {
                    pcm16_from_screen_capture_sample(sample)
                } else {
                    Err(RecordingError::new(RECORDING_STREAM_ERROR))
                };
                match accept_system_sample(output, block) {
                    Ok(block) => {
                        let _ = submit_block(&sender, block, &callback_error);
                    }
                    Err(_) => callback_error.store(),
                }
            },
            SCStreamOutputType::Audio,
        );
        if registered.is_none() {
            return Err(RecordingError::new(RECORDING_SYSTEM_LOOPBACK_INIT_FAILED));
        }
        Ok(stream)
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
            let content = SCShareableContent::get()
                .map_err(|_| RecordingError::new(RECORDING_SYSTEM_AUDIO_UNAVAILABLE))?;
            if content.displays().is_empty() {
                Ok(SystemAudioAvailability::NoShareableDisplay)
            } else {
                Ok(SystemAudioAvailability::Available)
            }
        }
    }

    struct NativeSystemAudioRuntime;

    impl SystemAudioRuntime for NativeSystemAudioRuntime {
        fn start(
            &self,
            workspace: &CaptureWorkspace,
        ) -> Result<Box<dyn ActiveCapture>, RecordingError> {
            let (control_tx, control_rx) = mpsc::channel();
            let (ready_tx, ready_rx) = mpsc::sync_channel(1);
            let path = workspace.temp_dir.join("system.wav");
            let worker = thread::Builder::new()
                .name("studymind-macos-system-audio".to_string())
                .spawn(move || run_system_capture_worker(path, control_rx, ready_tx))
                .map_err(|_| RecordingError::new(RECORDING_SYSTEM_LOOPBACK_INIT_FAILED))?;

            match receive_startup_signal_with(&ready_rx, RECORDING_SYSTEM_LOOPBACK_INIT_FAILED) {
                Ok(()) => Ok(Box::new(MacosActiveCapture { control_tx, worker })),
                Err(error) => {
                    let _ = worker.join();
                    Err(error)
                }
            }
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
        ) -> Result<Box<dyn ActiveCapture>, RecordingError> {
            match mode {
                RecordingMode::Mic => {
                    authorize_start(mode, permission_status()?, request_microphone_access)?;

                    let (control_tx, control_rx) = mpsc::channel();
                    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
                    let path = workspace.temp_dir.join("mic.wav");
                    let worker = thread::Builder::new()
                        .name("studymind-macos-microphone".to_string())
                        .spawn(move || run_capture_worker(path, control_rx, ready_tx))
                        .map_err(|_| RecordingError::new(RECORDING_MIC_INIT_FAILED))?;

                    // CoreAudio/CPAL device setup can block in native code and cannot be safely
                    // force-detached. Wait for the worker's readiness/error signal, and on error
                    // join it before returning so controller cleanup cannot race a live writer.
                    match receive_startup_signal(&ready_rx) {
                        Ok(()) => Ok(Box::new(MacosActiveCapture { control_tx, worker })),
                        Err(error) => {
                            let _ = worker.join();
                            Err(error)
                        }
                    }
                }
                RecordingMode::System => self.system_runtime.start(workspace),
                RecordingMode::Mixed => Err(RecordingError::new(RECORDING_MIX_FAILED)),
            }
        }
    }

    struct MacosActiveCapture {
        control_tx: mpsc::Sender<CaptureControl>,
        worker: JoinHandle<Result<Option<CapturedRecording>, RecordingError>>,
    }

    impl ActiveCapture for MacosActiveCapture {
        fn stop(self: Box<Self>) -> Result<CapturedRecording, RecordingError> {
            let _ = self.control_tx.send(CaptureControl::Stop);
            self.worker
                .join()
                .map_err(|_| RecordingError::new(RECORDING_STREAM_ERROR))??
                .ok_or_else(|| RecordingError::new(RECORDING_STREAM_ERROR))
        }

        fn cancel(self: Box<Self>) -> Result<(), RecordingError> {
            let _ = self.control_tx.send(CaptureControl::Cancel);
            let _ = self
                .worker
                .join()
                .map_err(|_| RecordingError::new(RECORDING_STREAM_ERROR))??;
            Ok(())
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

    fn run_system_capture_worker(
        path: PathBuf,
        control_rx: mpsc::Receiver<CaptureControl>,
        ready_tx: SyncSender<Result<(), RecordingError>>,
    ) -> Result<Option<CapturedRecording>, RecordingError> {
        let content = match SCShareableContent::get() {
            Ok(content) => content,
            Err(_) => {
                return notify_setup_error(
                    ready_tx,
                    RecordingError::new(RECORDING_SYSTEM_AUDIO_UNAVAILABLE),
                )
            }
        };
        let display = match content.displays().into_iter().next() {
            Some(display) => display,
            None => {
                return notify_setup_error(
                    ready_tx,
                    RecordingError::new(RECORDING_SYSTEM_AUDIO_UNAVAILABLE),
                )
            }
        };
        let filter = SCContentFilter::create()
            .with_display(&display)
            .with_excluding_windows(&[])
            .build();
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

        let (audio_tx, audio_rx) = mpsc::sync_channel(AUDIO_QUEUE_CAPACITY);
        let (writer_ready_tx, writer_ready_rx) = mpsc::sync_channel(1);
        let writer = thread::Builder::new()
            .name("studymind-macos-system-audio-writer".to_string())
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
            .map_err(|_| RecordingError::new(RECORDING_SYSTEM_LOOPBACK_INIT_FAILED));
        let writer = match writer {
            Ok(writer) => writer,
            Err(error) => return notify_setup_error(ready_tx, error),
        };
        let writer_guard = WriterJoinGuard::new(writer, audio_tx);
        match receive_startup_signal_with(&writer_ready_rx, RECORDING_SYSTEM_LOOPBACK_INIT_FAILED)
        {
            Ok(()) => {}
            Err(error) => return notify_setup_error(ready_tx, error),
        }

        let first_error = Arc::new(FirstStreamError::default());
        let stream = match configure_system_audio_stream(
            &filter,
            writer_guard.sender(),
            Arc::clone(&first_error),
        ) {
            Ok(stream) => stream,
            Err(error) => return notify_setup_error(ready_tx, error),
        };
        if let Err(error) = map_system_start_error(stream.start_capture()) {
            drop(stream);
            return notify_setup_error(ready_tx, error);
        }
        if ready_tx.send(Ok(())).is_err() {
            let _ = stream.stop_capture();
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
        if stream.stop_capture().is_err() {
            first_error.store();
        }
        drop(stream);
        let source_failed = first_error.is_set();
        let writer_result = writer_guard
            .join()
            .map_err(|_| RecordingError::new(RECORDING_STREAM_ERROR))?;
        finish_capture(control, source_failed, writer_result)
    }

    fn run_capture_worker(
        path: PathBuf,
        control_rx: mpsc::Receiver<CaptureControl>,
        ready_tx: SyncSender<Result<(), RecordingError>>,
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

        let first_error = Arc::new(FirstStreamError::default());
        let stream_config: cpal::StreamConfig = supported_config.clone().into();
        let stream = match sample_format {
            cpal::SampleFormat::F32 => build_stream(
                &device,
                &stream_config,
                writer_guard.sender(),
                Arc::clone(&first_error),
                channels,
                pcm16_from_f32,
            ),
            cpal::SampleFormat::I16 => build_stream(
                &device,
                &stream_config,
                writer_guard.sender(),
                Arc::clone(&first_error),
                channels,
                pcm16_from_i16,
            ),
            cpal::SampleFormat::U16 => build_stream(
                &device,
                &stream_config,
                writer_guard.sender(),
                Arc::clone(&first_error),
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
        channels: u16,
        convert: fn(&[T], u16) -> Result<AudioBlock, RecordingError>,
    ) -> Result<cpal::Stream, RecordingError> {
        let callback_error = Arc::clone(&first_error);
        device
            .build_input_stream(
                config,
                move |samples: &[T], _| match convert(samples, channels) {
                    Ok(block) => {
                        let _ = submit_block(&sender, block, &first_error);
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
        let capabilities = capabilities_for_with_system(
            PermissionStatus::NotDetermined,
            || true,
            &probe,
        );

        assert!(capabilities.system_audio.available);
        assert_eq!(probe.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn system_capability_maps_screen_recording_denial_to_unavailable() {
        let probe = StubSystemAudioProbe {
            result: Ok(SystemAudioAvailability::Denied),
            calls: AtomicUsize::new(0),
        };
        let capabilities = capabilities_for_with_system(
            PermissionStatus::Authorized,
            || true,
            &probe,
        );

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
            let capabilities = capabilities_for_with_system(
                PermissionStatus::Authorized,
                || true,
                &probe,
            );

            assert!(!capabilities.system_audio.available);
            assert_eq!(
                capabilities.system_audio.reason_code,
                Some(RECORDING_SYSTEM_AUDIO_UNAVAILABLE)
            );
        }
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
        let error = accept_system_sample(
            SystemStreamOutput::Screen,
            Ok(AudioBlock::silence(1, 2)),
        )
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
        sender
            .send(AudioBlock::silence(2, 2))
            .expect("first block");
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
        submit_block(&sender, AudioBlock::silence(1, 2), &first_error)
            .expect("first block");
        let error = submit_block(&sender, AudioBlock::silence(1, 2), &first_error)
            .expect_err("queue overflow");

        assert_eq!(error.code, RECORDING_STREAM_ERROR);
        assert!(first_error.is_set());
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
        let (sender, receiver) = mpsc::sync_channel(1);
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
