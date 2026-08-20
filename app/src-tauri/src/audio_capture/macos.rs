use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "macos")]
use std::sync::mpsc;
use std::sync::mpsc::{Receiver, SyncSender, TrySendError};

use super::wav_writer::{WavCaptureSummary, WaveFormat, WaveWriter};
#[cfg(target_os = "macos")]
use super::CaptureWorkspace;
use super::{
    CapturedRecording, RecordingCapabilities, RecordingError, RecordingMode, RecordingPlatform,
    RecordingSourceCapability, RECORDING_MIC_ACCESS_DENIED, RECORDING_MIC_INIT_FAILED,
    RECORDING_STREAM_ERROR, RECORDING_SYSTEM_AUDIO_UNAVAILABLE,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PermissionStatus {
    Authorized,
    NotDetermined,
    Denied,
    Restricted,
}

fn capabilities_for(
    permission: PermissionStatus,
    probe_input: impl FnOnce() -> bool,
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
        system_audio: RecordingSourceCapability {
            available: false,
            reason_code: Some(RECORDING_SYSTEM_AUDIO_UNAVAILABLE),
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
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};

    use super::*;
    use crate::audio_capture::{ActiveCapture, RecordingBackend};

    const AUDIO_QUEUE_CAPACITY: usize = 32;
    const START_TIMEOUT: Duration = Duration::from_secs(3);
    const CONTROL_POLL_INTERVAL: Duration = Duration::from_millis(20);

    #[derive(Default)]
    pub(crate) struct MacosRecordingBackend;

    impl RecordingBackend for MacosRecordingBackend {
        fn capabilities(&self) -> Result<RecordingCapabilities, RecordingError> {
            Ok(capabilities_for(permission_status()?, probe_default_input))
        }

        fn start(
            &self,
            mode: RecordingMode,
            workspace: &CaptureWorkspace,
        ) -> Result<Box<dyn ActiveCapture>, RecordingError> {
            if !matches!(mode, RecordingMode::Mic) {
                return Err(RecordingError::new(RECORDING_SYSTEM_AUDIO_UNAVAILABLE));
            }
            authorize_start(mode, permission_status()?, request_microphone_access)?;

            let (control_tx, control_rx) = mpsc::channel();
            let (ready_tx, ready_rx) = mpsc::sync_channel(1);
            let path = workspace.temp_dir.join("mic.wav");
            let worker = thread::Builder::new()
                .name("studymind-macos-microphone".to_string())
                .spawn(move || run_capture_worker(path, control_rx, ready_tx))
                .map_err(|_| RecordingError::new(RECORDING_MIC_INIT_FAILED))?;

            match ready_rx.recv_timeout(START_TIMEOUT) {
                Ok(Ok(())) => Ok(Box::new(MacosActiveCapture { control_tx, worker })),
                Ok(Err(error)) => {
                    let _ = worker.join();
                    Err(error)
                }
                Err(_) => {
                    let _ = control_tx.send(CaptureControl::Cancel);
                    let _ = worker.join();
                    Err(RecordingError::new(RECORDING_STREAM_ERROR))
                }
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
        let block = RcBlock::new(move |granted| {
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
        match writer_ready_rx.recv_timeout(START_TIMEOUT) {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                let _ = writer.join();
                return notify_setup_error(ready_tx, error);
            }
            Err(_) => {
                drop(audio_tx);
                let _ = writer.join();
                return notify_setup_error(ready_tx, RecordingError::new(RECORDING_STREAM_ERROR));
            }
        }

        let first_error = Arc::new(FirstStreamError::default());
        let stream_config: cpal::StreamConfig = supported_config.clone().into();
        let stream = match sample_format {
            cpal::SampleFormat::F32 => build_stream(
                &device,
                &stream_config,
                audio_tx,
                Arc::clone(&first_error),
                channels,
                pcm16_from_f32,
            ),
            cpal::SampleFormat::I16 => build_stream(
                &device,
                &stream_config,
                audio_tx,
                Arc::clone(&first_error),
                channels,
                pcm16_from_i16,
            ),
            cpal::SampleFormat::U16 => build_stream(
                &device,
                &stream_config,
                audio_tx,
                Arc::clone(&first_error),
                channels,
                pcm16_from_u16,
            ),
            _ => unreachable!("sample format checked above"),
        };
        let stream = match stream {
            Ok(stream) => stream,
            Err(error) => {
                let _ = writer.join();
                return notify_setup_error(ready_tx, error);
            }
        };
        if stream.play().is_err() {
            drop(stream);
            let _ = writer.join();
            return notify_setup_error(ready_tx, RecordingError::new(RECORDING_STREAM_ERROR));
        }
        if ready_tx.send(Ok(())).is_err() {
            drop(stream);
            let _ = writer.join();
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
        let writer_result = writer
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
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;

    use super::*;
    use crate::audio_capture::wav_writer::{WaveFormat, WaveWriter};
    use crate::audio_capture::{
        RecordingMode, RecordingPlatform, RECORDING_MIC_ACCESS_DENIED, RECORDING_MIC_INIT_FAILED,
        RECORDING_STREAM_ERROR, RECORDING_SYSTEM_AUDIO_UNAVAILABLE,
    };

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
        }

        // There is deliberately no request-access callback in the capability seam.
        // Supplying only the current status and a device/config probe makes prompting
        // impossible during capability evaluation.
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

    fn temp_root() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("StudyMind-macos-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp root");
        root
    }
}
