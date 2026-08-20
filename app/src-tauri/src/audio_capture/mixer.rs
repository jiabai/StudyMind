use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
#[cfg(test)]
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use super::wav_writer::read_wave_info;
use super::{
    CaptureWorkspace, CapturedRecording, FinalizedRecording, RecordingError, RecordingFinalizer,
    RecordingMode, RECORDING_FINALIZE_FAILED, RECORDING_MIX_FAILED,
};

pub(crate) trait FfmpegCommandRunner: Send + Sync {
    fn run(&self, executable: &Path, args: &[OsString]) -> Result<(), RecordingError>;
}

struct SystemFfmpegCommandRunner;

impl FfmpegCommandRunner for SystemFfmpegCommandRunner {
    fn run(&self, executable: &Path, args: &[OsString]) -> Result<(), RecordingError> {
        let output = Command::new(executable)
            .args(args)
            .output()
            .map_err(|_| RecordingError::new(RECORDING_FINALIZE_FAILED))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(RecordingError::new(RECORDING_FINALIZE_FAILED))
        }
    }
}

pub(crate) struct FfmpegRecordingFinalizer {
    resource_dir: PathBuf,
    recordings_dir: PathBuf,
    runner: Arc<dyn FfmpegCommandRunner>,
}

impl FfmpegRecordingFinalizer {
    pub(crate) fn new(resource_dir: PathBuf, recordings_dir: PathBuf) -> Self {
        Self {
            resource_dir,
            recordings_dir,
            runner: Arc::new(SystemFfmpegCommandRunner),
        }
    }

    #[cfg(test)]
    fn with_runner(
        resource_dir: PathBuf,
        recordings_dir: PathBuf,
        runner: Arc<dyn FfmpegCommandRunner>,
    ) -> Self {
        Self {
            resource_dir,
            recordings_dir,
            runner,
        }
    }

    fn executable_path(&self) -> PathBuf {
        if cfg!(windows) {
            self.resource_dir.join("bin").join("ffmpeg.exe")
        } else {
            self.resource_dir.join("bin").join("ffmpeg")
        }
    }

    fn validate_source(workspace: &CaptureWorkspace, source: &Path) -> Result<(), RecordingError> {
        let root = workspace
            .temp_dir
            .canonicalize()
            .map_err(|_| RecordingError::new(RECORDING_FINALIZE_FAILED))?;
        let source = source
            .canonicalize()
            .map_err(|_| RecordingError::new(RECORDING_FINALIZE_FAILED))?;
        if source == root || !source.starts_with(&root) || !source.is_file() {
            return Err(RecordingError::new(RECORDING_FINALIZE_FAILED));
        }
        Ok(())
    }

    fn output_name() -> String {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        format!("recording_{timestamp}.wav")
    }

    fn build_args(mode: RecordingMode, sources: &[PathBuf], output: &Path) -> Vec<OsString> {
        let mut args = vec![OsString::from("-y")];
        for source in sources {
            args.push(OsString::from("-i"));
            args.push(source.as_os_str().to_os_string());
        }
        if mode == RecordingMode::Mixed {
            args.extend([
                OsString::from("-filter_complex"),
                OsString::from(
                    "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0:normalize=1[mixed]",
                ),
                OsString::from("-map"),
                OsString::from("[mixed]"),
            ]);
        }
        args.extend([
            OsString::from("-ar"),
            OsString::from("16000"),
            OsString::from("-ac"),
            OsString::from("1"),
            OsString::from("-c:a"),
            OsString::from("pcm_s16le"),
            output.as_os_str().to_os_string(),
        ]);
        args
    }
}

impl RecordingFinalizer for FfmpegRecordingFinalizer {
    fn finalize(
        &self,
        workspace: &CaptureWorkspace,
        capture: CapturedRecording,
        mode: RecordingMode,
    ) -> Result<FinalizedRecording, RecordingError> {
        let expected_sources = if mode == RecordingMode::Mixed { 2 } else { 1 };
        if capture.source_paths.len() != expected_sources {
            return Err(RecordingError::new(RECORDING_FINALIZE_FAILED));
        }
        for source in &capture.source_paths {
            Self::validate_source(workspace, source)?;
        }

        std::fs::create_dir_all(&self.recordings_dir)
            .map_err(|_| RecordingError::new(RECORDING_FINALIZE_FAILED))?;
        let output = workspace.temp_dir.join(".final-output.wav");
        let args = Self::build_args(mode, &capture.source_paths, &output);
        self.runner
            .run(&self.executable_path(), &args)
            .map_err(|error| {
                if mode == RecordingMode::Mixed {
                    RecordingError::new(RECORDING_MIX_FAILED)
                } else {
                    error
                }
            })?;

        let info = read_wave_info(&output)?;
        if info.format.channels != 1
            || info.format.sample_rate != 16_000
            || info.format.bits_per_sample != 16
            || info.format.block_align != 2
            || info.data_bytes == 0
        {
            return Err(RecordingError::new(RECORDING_FINALIZE_FAILED));
        }

        let display_name = Self::output_name();
        let final_path = self.recordings_dir.join(&display_name);
        std::fs::rename(&output, &final_path)
            .map_err(|_| RecordingError::new(RECORDING_FINALIZE_FAILED))?;
        let size_bytes = std::fs::metadata(&final_path)
            .map_err(|_| RecordingError::new(RECORDING_FINALIZE_FAILED))?
            .len();

        Ok(FinalizedRecording {
            path: final_path,
            display_name,
            duration_ms: capture.duration_ms,
            size_bytes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_capture::wav_writer::{WaveFormat, WaveWriter};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FakeRunner {
        calls: Mutex<Vec<Vec<OsString>>>,
        writes_output: bool,
        call_count: AtomicUsize,
    }

    impl FakeRunner {
        fn new(writes_output: bool) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                writes_output,
                call_count: AtomicUsize::new(0),
            }
        }
    }

    impl FfmpegCommandRunner for FakeRunner {
        fn run(&self, _executable: &Path, args: &[OsString]) -> Result<(), RecordingError> {
            self.calls.lock().expect("calls lock").push(args.to_vec());
            self.call_count.fetch_add(1, Ordering::SeqCst);
            if self.writes_output {
                let output = args.last().expect("output path");
                let format = WaveFormat::new(
                    vec![1, 0, 1, 0, 0x80, 0x3e, 0, 0, 0, 0, 0, 0, 2, 0, 16, 0],
                    1,
                    16_000,
                    2,
                    16,
                )
                .expect("valid test format");
                let mut writer =
                    WaveWriter::create(PathBuf::from(output), format).expect("create fake output");
                writer
                    .write_frames(&[1, 0, 2, 0], 2, false)
                    .expect("write fake output");
                writer.finish().expect("finish fake output");
            }
            Ok(())
        }
    }

    fn workspace(root: &Path) -> (CaptureWorkspace, PathBuf) {
        let temp_dir = root.join(".tmp").join("session-1");
        std::fs::create_dir_all(&temp_dir).expect("create workspace");
        let source = temp_dir.join("mic.wav");
        std::fs::write(&source, b"source").expect("write source");
        (
            CaptureWorkspace {
                session_id: "session-1".to_string(),
                temp_dir,
            },
            source,
        )
    }

    #[test]
    fn single_source_finalization_uses_structured_normalization_args() {
        let root = std::env::temp_dir().join(format!("StudyMind-mixer-{}", uuid::Uuid::new_v4()));
        let (workspace, source) = workspace(&root);
        let runner = Arc::new(FakeRunner::new(true));
        let finalizer = FfmpegRecordingFinalizer::with_runner(
            root.join("resources"),
            root.join("recordings"),
            runner.clone(),
        );

        let result = finalizer
            .finalize(
                &workspace,
                CapturedRecording {
                    source_paths: vec![source],
                    valid_frame_count: 2,
                    silent: false,
                    duration_ms: 100,
                },
                RecordingMode::Mic,
            )
            .expect("finalize single source");

        let calls = runner.calls.lock().expect("calls lock");
        assert_eq!(calls.len(), 1);
        assert!(calls[0]
            .windows(2)
            .any(|pair| pair == [OsString::from("-ar"), OsString::from("16000")]));
        assert!(calls[0]
            .windows(2)
            .any(|pair| pair == [OsString::from("-ac"), OsString::from("1")]));
        assert!(calls[0]
            .windows(2)
            .any(|pair| pair
                == [OsString::from("-c:a"), OsString::from("pcm_s16le")]));
        assert_eq!(
            result.path.parent(),
            Some(root.join("recordings").as_path())
        );
        assert!(result.path.is_file());

        std::fs::remove_dir_all(root).expect("remove mixer temp root");
    }

    #[test]
    fn mixed_source_rejects_outside_paths_before_running_ffmpeg() {
        let root = std::env::temp_dir().join(format!("StudyMind-mixer-{}", uuid::Uuid::new_v4()));
        let (workspace, source) = workspace(&root);
        let outside = root.join("outside.wav");
        std::fs::write(&outside, b"outside").expect("write outside source");
        let runner = Arc::new(FakeRunner::new(true));
        let finalizer = FfmpegRecordingFinalizer::with_runner(
            root.join("resources"),
            root.join("recordings"),
            runner.clone(),
        );

        let error = finalizer
            .finalize(
                &workspace,
                CapturedRecording {
                    source_paths: vec![source, outside],
                    valid_frame_count: 2,
                    silent: false,
                    duration_ms: 100,
                },
                RecordingMode::Mixed,
            )
            .expect_err("outside source must be rejected");

        assert_eq!(error.code, RECORDING_FINALIZE_FAILED);
        assert_eq!(runner.call_count.load(Ordering::SeqCst), 0);
        std::fs::remove_dir_all(root).expect("remove mixer temp root");
    }

    #[test]
    fn mixed_source_finalization_uses_equal_weight_amix_and_normalization_args() {
        let root = std::env::temp_dir().join(format!("StudyMind-mixer-{}", uuid::Uuid::new_v4()));
        let (workspace, mic_source) = workspace(&root);
        let system_source = workspace.temp_dir.join("system.wav");
        std::fs::write(&system_source, b"system").expect("write system source");
        let runner = Arc::new(FakeRunner::new(true));
        let finalizer = FfmpegRecordingFinalizer::with_runner(
            root.join("resources"),
            root.join("recordings"),
            runner.clone(),
        );

        finalizer
            .finalize(
                &workspace,
                CapturedRecording {
                    source_paths: vec![mic_source, system_source],
                    valid_frame_count: 4,
                    silent: false,
                    duration_ms: 200,
                },
                RecordingMode::Mixed,
            )
            .expect("finalize mixed sources");

        let calls = runner.calls.lock().expect("calls lock");
        assert_eq!(calls.len(), 1);
        assert!(calls[0].windows(2).any(|pair| {
            pair == [
                OsString::from("-filter_complex"),
                OsString::from(
                    "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0:normalize=1[mixed]",
                ),
            ]
        }));
        assert!(calls[0]
            .windows(2)
            .any(|pair| pair == [OsString::from("-map"), OsString::from("[mixed]")]));
        assert!(calls[0]
            .windows(2)
            .any(|pair| pair == [OsString::from("-c:a"), OsString::from("pcm_s16le")]));

        std::fs::remove_dir_all(root).expect("remove mixer temp root");
    }
}
