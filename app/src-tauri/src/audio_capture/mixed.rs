use super::wav_writer::WavCaptureSummary;
use super::{
    ActiveCapture, CapturedRecording, RecordingError, RecordingSource, RECORDING_STREAM_ERROR,
};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[derive(Clone, Default)]
pub(crate) struct CaptureGate {
    open: Arc<AtomicBool>,
}

impl CaptureGate {
    pub(crate) fn open(&self) {
        self.open.store(true, Ordering::Release);
    }

    pub(crate) fn is_open(&self) -> bool {
        self.open.load(Ordering::Acquire)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CaptureCommand {
    Stop,
    Cancel,
}

#[derive(Clone, Default)]
pub(crate) struct CaptureSignal {
    command: Arc<AtomicU8>,
}

impl CaptureSignal {
    pub(crate) fn request(&self, command: CaptureCommand) {
        let requested = match command {
            CaptureCommand::Stop => 1,
            CaptureCommand::Cancel => 2,
        };
        let mut current = self.command.load(Ordering::Acquire);
        while current < requested {
            match self.command.compare_exchange_weak(
                current,
                requested,
                Ordering::Release,
                Ordering::Acquire,
            ) {
                Ok(_) => return,
                Err(observed) => current = observed,
            }
        }
    }

    pub(crate) fn current(&self) -> Option<CaptureCommand> {
        match self.command.load(Ordering::Acquire) {
            1 => Some(CaptureCommand::Stop),
            2 => Some(CaptureCommand::Cancel),
            _ => None,
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct FirstSourceFailure {
    error: Arc<Mutex<Option<RecordingError>>>,
}

impl FirstSourceFailure {
    pub(crate) fn record(&self, error: RecordingError, source: RecordingSource) {
        let mut first = self
            .error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if first.is_none() {
            *first = Some(error.for_source(source));
        }
    }

    pub(crate) fn snapshot(&self) -> Option<RecordingError> {
        self.error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

pub(crate) struct SourceReady {
    pub(crate) source: RecordingSource,
    pub(crate) result: Result<(), RecordingError>,
}

pub(crate) type ReadySender = SyncSender<SourceReady>;
pub(crate) type ReadyReceiver = Receiver<SourceReady>;

pub(crate) fn ready_channel() -> (ReadySender, ReadyReceiver) {
    mpsc::sync_channel(2)
}

pub(crate) struct PreparedSource {
    pub(crate) source: RecordingSource,
    pub(crate) signal: CaptureSignal,
    pub(crate) worker: JoinHandle<Result<WavCaptureSummary, RecordingError>>,
}

pub(crate) fn start_mixed(
    sources: [PreparedSource; 2],
    ready: ReadyReceiver,
    gate: CaptureGate,
    failures: FirstSourceFailure,
    timeout: Duration,
) -> Result<Box<dyn ActiveCapture>, RecordingError> {
    if !has_mixed_source_identity(&sources) {
        return Err(cancel_and_join(sources, &failures));
    }

    let deadline = Instant::now().checked_add(timeout);
    let mut microphone_ready = false;
    let mut system_audio_ready = false;

    loop {
        let remaining = deadline
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
            .unwrap_or(Duration::MAX);
        if remaining.is_zero() {
            record_startup_timeout(&failures, microphone_ready, system_audio_ready);
            return Err(cancel_and_join(sources, &failures));
        }

        match ready.recv_timeout(remaining) {
            Ok(SourceReady { source, result }) => {
                let is_known_source = sources.iter().any(|prepared| prepared.source == source);
                let already_ready = match source {
                    RecordingSource::Microphone => microphone_ready,
                    RecordingSource::SystemAudio => system_audio_ready,
                };
                if !is_known_source || already_ready {
                    failures.record(RecordingError::new(RECORDING_STREAM_ERROR), source);
                    return Err(cancel_and_join(sources, &failures));
                }

                match result {
                    Ok(()) => match source {
                        RecordingSource::Microphone => microphone_ready = true,
                        RecordingSource::SystemAudio => system_audio_ready = true,
                    },
                    Err(error) => {
                        failures.record(error, source);
                        return Err(cancel_and_join(sources, &failures));
                    }
                }

                if microphone_ready && system_audio_ready {
                    gate.open();
                    return Ok(Box::new(MixedActiveCapture { sources, failures }));
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                record_startup_timeout(&failures, microphone_ready, system_audio_ready);
                return Err(cancel_and_join(sources, &failures));
            }
        }
    }
}

struct MixedActiveCapture {
    sources: [PreparedSource; 2],
    failures: FirstSourceFailure,
}

impl ActiveCapture for MixedActiveCapture {
    fn stop(self: Box<Self>) -> Result<CapturedRecording, RecordingError> {
        let MixedActiveCapture { sources, failures } = *self;
        for prepared in &sources {
            prepared.signal.request(CaptureCommand::Stop);
        }
        let summaries = join_sources(sources, &failures);
        if let Some(error) = failures.snapshot() {
            return Err(error);
        }
        if summaries.is_empty() {
            return Err(RecordingError::new(RECORDING_STREAM_ERROR));
        }

        let valid_frame_count = summaries.iter().fold(0_u64, |count, summary| {
            count.saturating_add(summary.valid_frame_count)
        });
        let duration_ms = summaries
            .iter()
            .map(|summary| summary.duration_ms)
            .max()
            .unwrap_or(0);
        let silent = summaries.iter().all(|summary| summary.silent);
        let source_paths = summaries.into_iter().map(|summary| summary.path).collect();
        Ok(CapturedRecording {
            source_paths,
            valid_frame_count,
            silent,
            duration_ms,
        })
    }

    fn cancel(self: Box<Self>) -> Result<(), RecordingError> {
        let MixedActiveCapture { sources, failures } = *self;
        for prepared in &sources {
            prepared.signal.request(CaptureCommand::Cancel);
        }
        let _ = join_sources(sources, &failures);
        failures.snapshot().map_or(Ok(()), Err)
    }
}

fn has_mixed_source_identity(sources: &[PreparedSource; 2]) -> bool {
    sources
        .iter()
        .filter(|prepared| prepared.source == RecordingSource::Microphone)
        .count()
        == 1
        && sources
            .iter()
            .filter(|prepared| prepared.source == RecordingSource::SystemAudio)
            .count()
            == 1
}

fn record_startup_timeout(
    failures: &FirstSourceFailure,
    microphone_ready: bool,
    system_audio_ready: bool,
) {
    let missing_source = match (microphone_ready, system_audio_ready) {
        (true, false) => Some(RecordingSource::SystemAudio),
        (false, true) => Some(RecordingSource::Microphone),
        (false, false) | (true, true) => None,
    };
    if failures.snapshot().is_none() {
        if let Some(source) = missing_source {
            failures.record(RecordingError::new(RECORDING_STREAM_ERROR), source);
        }
    }
}

fn cancel_and_join(sources: [PreparedSource; 2], failures: &FirstSourceFailure) -> RecordingError {
    for prepared in &sources {
        prepared.signal.request(CaptureCommand::Cancel);
    }
    let _ = join_sources(sources, failures);
    failures
        .snapshot()
        .unwrap_or_else(|| RecordingError::new(RECORDING_STREAM_ERROR))
}

fn join_sources(
    sources: [PreparedSource; 2],
    failures: &FirstSourceFailure,
) -> Vec<WavCaptureSummary> {
    let mut summaries = Vec::with_capacity(2);
    for prepared in sources {
        match prepared.worker.join() {
            Ok(Ok(summary)) => summaries.push(summary),
            Ok(Err(error)) => failures.record(error, prepared.source),
            Err(_) => failures.record(RecordingError::new(RECORDING_STREAM_ERROR), prepared.source),
        }
    }
    summaries
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_capture::wav_writer::WavCaptureSummary;
    use crate::audio_capture::{RecordingError, RecordingSource, RECORDING_STREAM_ERROR};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc::{self, Receiver};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    #[derive(Default)]
    struct WorkerObservation {
        ready: AtomicUsize,
        cancelled: AtomicUsize,
        joined: AtomicUsize,
        dropped: AtomicUsize,
        written: AtomicUsize,
    }

    fn prepared_worker(
        source: RecordingSource,
        ready: ReadySender,
        gate: CaptureGate,
        ready_permission: Receiver<()>,
        frame_permission: Option<Receiver<()>>,
        ready_result: Result<(), RecordingError>,
        observation: Arc<WorkerObservation>,
    ) -> PreparedSource {
        let signal = CaptureSignal::default();
        let worker_signal = signal.clone();
        let worker = thread::spawn(move || {
            loop {
                match ready_permission.recv_timeout(Duration::from_millis(1)) {
                    Ok(()) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if worker_signal.current() == Some(CaptureCommand::Cancel) {
                            observation.cancelled.fetch_add(1, Ordering::SeqCst);
                            observation.joined.fetch_add(1, Ordering::SeqCst);
                            return Ok(summary_for(source));
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        return Err(RecordingError::new(RECORDING_STREAM_ERROR));
                    }
                }
            }

            ready
                .send(SourceReady {
                    source,
                    result: ready_result,
                })
                .expect("send ready");
            observation.ready.fetch_add(1, Ordering::SeqCst);

            loop {
                if let Some(frame_permission) = frame_permission.as_ref() {
                    while frame_permission.try_recv().is_ok() {
                        if gate.is_open() {
                            observation.written.fetch_add(1, Ordering::SeqCst);
                        } else {
                            observation.dropped.fetch_add(1, Ordering::SeqCst);
                        }
                    }
                }

                match worker_signal.current() {
                    Some(CaptureCommand::Cancel) => {
                        observation.cancelled.fetch_add(1, Ordering::SeqCst);
                        observation.joined.fetch_add(1, Ordering::SeqCst);
                        return Ok(summary_for(source));
                    }
                    Some(CaptureCommand::Stop) => {
                        observation.joined.fetch_add(1, Ordering::SeqCst);
                        return Ok(summary_for(source));
                    }
                    None => thread::sleep(Duration::from_millis(1)),
                }
            }
        });

        PreparedSource {
            source,
            signal,
            worker,
        }
    }

    fn summary_for(source: RecordingSource) -> WavCaptureSummary {
        let name = match source {
            RecordingSource::Microphone => "microphone.wav",
            RecordingSource::SystemAudio => "system-audio.wav",
        };
        WavCaptureSummary {
            path: PathBuf::from(name),
            valid_frame_count: 1,
            silent: false,
            duration_ms: 10,
        }
    }

    #[test]
    fn mixed_start_opens_gate_only_after_both_sources_are_ready() {
        let (ready_sender, ready_receiver) = ready_channel();
        let gate = CaptureGate::default();
        let failures = FirstSourceFailure::default();
        let observation = Arc::new(WorkerObservation::default());
        let (microphone_ready_sender, microphone_ready_receiver) = mpsc::sync_channel(1);
        let (system_ready_sender, system_ready_receiver) = mpsc::sync_channel(1);
        let (frame_sender, frame_receiver) = mpsc::sync_channel(1);

        let microphone = prepared_worker(
            RecordingSource::Microphone,
            ready_sender.clone(),
            gate.clone(),
            microphone_ready_receiver,
            Some(frame_receiver),
            Ok(()),
            observation.clone(),
        );
        let system_audio = prepared_worker(
            RecordingSource::SystemAudio,
            ready_sender,
            gate.clone(),
            system_ready_receiver,
            None,
            Ok(()),
            observation.clone(),
        );
        let (started_sender, started_receiver) = mpsc::channel();
        let start_gate = gate.clone();
        let start_failures = failures.clone();
        let starter = thread::spawn(move || {
            started_sender
                .send(start_mixed(
                    [microphone, system_audio],
                    ready_receiver,
                    start_gate,
                    start_failures,
                    Duration::from_millis(100),
                ))
                .expect("send startup result");
        });

        microphone_ready_sender
            .send(())
            .expect("release microphone");
        frame_sender.send(()).expect("provide pre-gate frame");
        for _ in 0..20 {
            if observation.dropped.load(Ordering::SeqCst) == 1 {
                break;
            }
            thread::sleep(Duration::from_millis(1));
        }
        assert!(!gate.is_open());
        assert_eq!(observation.dropped.load(Ordering::SeqCst), 1);
        assert_eq!(observation.written.load(Ordering::SeqCst), 0);
        assert!(matches!(
            started_receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));

        system_ready_sender.send(()).expect("release system audio");
        let capture = started_receiver
            .recv_timeout(Duration::from_millis(100))
            .expect("startup result")
            .expect("mixed startup succeeds");
        starter.join().expect("starter joined");
        assert!(gate.is_open());
        capture.cancel().expect("cancel active capture");
    }

    #[test]
    fn mixed_start_failure_cancels_and_joins_both_sources() {
        let (ready_sender, ready_receiver) = ready_channel();
        let gate = CaptureGate::default();
        let failures = FirstSourceFailure::default();
        let observation = Arc::new(WorkerObservation::default());
        let (microphone_ready_sender, microphone_ready_receiver) = mpsc::sync_channel(1);
        let (system_ready_sender, system_ready_receiver) = mpsc::sync_channel(1);
        let microphone = prepared_worker(
            RecordingSource::Microphone,
            ready_sender.clone(),
            gate.clone(),
            microphone_ready_receiver,
            None,
            Ok(()),
            observation.clone(),
        );
        let system_audio = prepared_worker(
            RecordingSource::SystemAudio,
            ready_sender,
            gate.clone(),
            system_ready_receiver,
            None,
            Err(RecordingError::new(RECORDING_STREAM_ERROR)),
            observation.clone(),
        );

        microphone_ready_sender
            .send(())
            .expect("release microphone");
        for _ in 0..20 {
            if observation.ready.load(Ordering::SeqCst) == 1 {
                break;
            }
            thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(observation.ready.load(Ordering::SeqCst), 1);
        system_ready_sender.send(()).expect("release system audio");
        let error = match start_mixed(
            [microphone, system_audio],
            ready_receiver,
            gate.clone(),
            failures,
            Duration::from_millis(100),
        ) {
            Err(error) => error,
            Ok(_capture) => panic!("system initialization failure, got active capture"),
        };

        assert_eq!(error.code, RECORDING_STREAM_ERROR);
        assert_eq!(error.source, Some(RecordingSource::SystemAudio));
        assert!(!gate.is_open());
        assert_eq!(observation.cancelled.load(Ordering::SeqCst), 2);
        assert_eq!(observation.joined.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn mixed_start_timeout_cancels_and_joins_both_sources() {
        let (ready_sender, ready_receiver) = ready_channel();
        let gate = CaptureGate::default();
        let failures = FirstSourceFailure::default();
        let observation = Arc::new(WorkerObservation::default());
        let (_microphone_ready_sender, microphone_ready_receiver) = mpsc::sync_channel(1);
        let (_system_ready_sender, system_ready_receiver) = mpsc::sync_channel(1);
        let microphone = prepared_worker(
            RecordingSource::Microphone,
            ready_sender.clone(),
            gate.clone(),
            microphone_ready_receiver,
            None,
            Ok(()),
            observation.clone(),
        );
        let system_audio = prepared_worker(
            RecordingSource::SystemAudio,
            ready_sender,
            gate.clone(),
            system_ready_receiver,
            None,
            Ok(()),
            observation.clone(),
        );

        let error = match start_mixed(
            [microphone, system_audio],
            ready_receiver,
            gate.clone(),
            failures,
            Duration::from_millis(10),
        ) {
            Err(error) => error,
            Ok(_capture) => panic!("startup timeout, got active capture"),
        };

        assert_eq!(error.code, RECORDING_STREAM_ERROR);
        assert!(!gate.is_open());
        assert_eq!(observation.cancelled.load(Ordering::SeqCst), 2);
        assert_eq!(observation.joined.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn mixed_start_timeout_tags_the_only_missing_source() {
        let (ready_sender, ready_receiver) = ready_channel();
        let gate = CaptureGate::default();
        let failures = FirstSourceFailure::default();
        let observation = Arc::new(WorkerObservation::default());
        let (microphone_ready_sender, microphone_ready_receiver) = mpsc::sync_channel(1);
        let (_system_ready_sender, system_ready_receiver) = mpsc::sync_channel(1);
        let microphone = prepared_worker(
            RecordingSource::Microphone,
            ready_sender.clone(),
            gate.clone(),
            microphone_ready_receiver,
            None,
            Ok(()),
            observation.clone(),
        );
        let system_audio = prepared_worker(
            RecordingSource::SystemAudio,
            ready_sender,
            gate.clone(),
            system_ready_receiver,
            None,
            Ok(()),
            observation.clone(),
        );

        microphone_ready_sender
            .send(())
            .expect("release microphone");
        for _ in 0..20 {
            if observation.ready.load(Ordering::SeqCst) == 1 {
                break;
            }
            thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(observation.ready.load(Ordering::SeqCst), 1);

        let error = match start_mixed(
            [microphone, system_audio],
            ready_receiver,
            gate.clone(),
            failures,
            Duration::from_millis(10),
        ) {
            Err(error) => error,
            Ok(_capture) => panic!("startup timeout, got active capture"),
        };

        assert_eq!(error.code, RECORDING_STREAM_ERROR);
        assert_eq!(error.source, Some(RecordingSource::SystemAudio));
        assert!(!gate.is_open());
        assert_eq!(observation.cancelled.load(Ordering::SeqCst), 2);
        assert_eq!(observation.joined.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn mixed_start_timeout_without_any_ready_source_is_unsourced() {
        let (ready_sender, ready_receiver) = ready_channel();
        let gate = CaptureGate::default();
        let failures = FirstSourceFailure::default();
        let observation = Arc::new(WorkerObservation::default());
        let (_microphone_ready_sender, microphone_ready_receiver) = mpsc::sync_channel(1);
        let (_system_ready_sender, system_ready_receiver) = mpsc::sync_channel(1);
        let microphone = prepared_worker(
            RecordingSource::Microphone,
            ready_sender.clone(),
            gate.clone(),
            microphone_ready_receiver,
            None,
            Ok(()),
            observation.clone(),
        );
        let system_audio = prepared_worker(
            RecordingSource::SystemAudio,
            ready_sender,
            gate.clone(),
            system_ready_receiver,
            None,
            Ok(()),
            observation.clone(),
        );

        let error = match start_mixed(
            [microphone, system_audio],
            ready_receiver,
            gate.clone(),
            failures,
            Duration::from_millis(10),
        ) {
            Err(error) => error,
            Ok(_capture) => panic!("startup timeout, got active capture"),
        };

        assert_eq!(error.code, RECORDING_STREAM_ERROR);
        assert_eq!(error.source, None);
        assert!(!gate.is_open());
        assert_eq!(observation.cancelled.load(Ordering::SeqCst), 2);
        assert_eq!(observation.joined.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn mixed_start_rejects_duplicate_source_identity() {
        let (ready_sender, ready_receiver) = ready_channel();
        let gate = CaptureGate::default();
        let failures = FirstSourceFailure::default();
        let observation = Arc::new(WorkerObservation::default());
        let (_first_ready_sender, first_ready_receiver) = mpsc::sync_channel(1);
        let (_second_ready_sender, second_ready_receiver) = mpsc::sync_channel(1);
        let first_microphone = prepared_worker(
            RecordingSource::Microphone,
            ready_sender.clone(),
            gate.clone(),
            first_ready_receiver,
            None,
            Ok(()),
            observation.clone(),
        );
        let second_microphone = prepared_worker(
            RecordingSource::Microphone,
            ready_sender,
            gate.clone(),
            second_ready_receiver,
            None,
            Ok(()),
            observation.clone(),
        );

        let error = match start_mixed(
            [first_microphone, second_microphone],
            ready_receiver,
            gate.clone(),
            failures,
            Duration::from_millis(100),
        ) {
            Err(error) => error,
            Ok(_capture) => panic!("duplicate microphone sources are invalid, got active capture"),
        };

        assert_eq!(error.code, RECORDING_STREAM_ERROR);
        assert!(!gate.is_open());
        assert_eq!(observation.cancelled.load(Ordering::SeqCst), 2);
        assert_eq!(observation.joined.load(Ordering::SeqCst), 2);
    }
}
