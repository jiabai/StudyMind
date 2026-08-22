use super::wav_writer::WavCaptureSummary;
use super::{
    ActiveCapture, CaptureCancelHandle, CapturedRecording, RecordingError, RecordingSource,
    RECORDING_EMPTY, RECORDING_STREAM_ERROR,
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
        request_all(&sources, CaptureCommand::Stop);
        let summaries = join_sources(sources, &failures);
        if let Some(error) = failures.snapshot() {
            return Err(error);
        }
        summarize_sources(summaries)
    }

    fn cancel(self: Box<Self>) -> Result<(), RecordingError> {
        let MixedActiveCapture { sources, failures } = *self;
        request_all(&sources, CaptureCommand::Cancel);
        let _ = join_sources(sources, &failures);
        failures.snapshot().map_or(Ok(()), Err)
    }

    fn cancel_for_cleanup(self: Box<Self>) -> Result<(), RecordingError> {
        let MixedActiveCapture { sources, failures } = *self;
        let failure_confirmed = failures.snapshot().is_some();
        request_all(&sources, CaptureCommand::Cancel);
        let mut cleanup_error = None;
        for prepared in sources {
            let source = prepared.source;
            match prepared.worker.join() {
                Ok(Ok(_)) => {}
                Ok(Err(_)) if failure_confirmed => {}
                Ok(Err(error)) => {
                    cleanup_error.get_or_insert_with(|| error.for_source(source));
                }
                Err(_) => {
                    cleanup_error.get_or_insert_with(|| {
                        RecordingError::new(RECORDING_STREAM_ERROR).for_source(source)
                    });
                }
            }
        }
        cleanup_error.map_or(Ok(()), Err)
    }

    fn cancel_handle(&self) -> Option<CaptureCancelHandle> {
        let signals = self
            .sources
            .iter()
            .map(|prepared| prepared.signal.clone())
            .collect::<Vec<_>>();
        Some(CaptureCancelHandle::new(move || {
            for signal in &signals {
                signal.request(CaptureCommand::Cancel);
            }
        }))
    }
}

fn request_all(sources: &[PreparedSource; 2], command: CaptureCommand) {
    for prepared in sources {
        prepared.signal.request(command);
    }
}

fn summarize_sources(
    mut summaries: Vec<(RecordingSource, WavCaptureSummary)>,
) -> Result<CapturedRecording, RecordingError> {
    summaries.sort_by_key(|(source, _)| match source {
        RecordingSource::Microphone => 0,
        RecordingSource::SystemAudio => 1,
    });

    let mut valid_frame_count = 0_u64;
    let mut duration_ms = 0_u64;
    let mut silent = true;
    let mut source_paths = Vec::with_capacity(summaries.len());
    for (source, summary) in summaries {
        if summary.valid_frame_count == 0 {
            return Err(RecordingError::new(RECORDING_EMPTY).for_source(source));
        }
        valid_frame_count = valid_frame_count
            .checked_add(summary.valid_frame_count)
            .ok_or_else(|| RecordingError::new(RECORDING_STREAM_ERROR).for_source(source))?;
        duration_ms = duration_ms.max(summary.duration_ms);
        silent &= summary.silent;
        source_paths.push(summary.path);
    }

    if source_paths.is_empty() {
        return Err(RecordingError::new(RECORDING_STREAM_ERROR));
    }

    Ok(CapturedRecording {
        source_paths,
        valid_frame_count,
        silent,
        duration_ms,
    })
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
) -> Vec<(RecordingSource, WavCaptureSummary)> {
    let mut summaries = Vec::with_capacity(2);
    for prepared in sources {
        let source = prepared.source;
        match prepared.worker.join() {
            Ok(Ok(summary)) => summaries.push((source, summary)),
            Ok(Err(error)) => failures.record(error, source),
            Err(_) => failures.record(RecordingError::new(RECORDING_STREAM_ERROR), source),
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
    use std::time::{Duration, Instant};

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

    fn wait_until(label: &str, mut predicate: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_millis(250);
        let mut observed = predicate();
        while !observed && Instant::now() < deadline {
            thread::yield_now();
            observed = predicate();
        }
        assert!(observed, "timed out waiting for {label}");
    }

    fn prepared_summary_worker(
        source: RecordingSource,
        result: Result<WavCaptureSummary, RecordingError>,
        wait_for_all_stop: Option<Arc<AtomicUsize>>,
        wait_for_cancel_after_stop: bool,
        observation: Option<Arc<WorkerObservation>>,
    ) -> PreparedSource {
        let signal = CaptureSignal::default();
        let worker_signal = signal.clone();
        let worker = thread::spawn(move || {
            let mut result = Some(result);
            loop {
                match worker_signal.current() {
                    Some(CaptureCommand::Cancel) => {
                        if let Some(observation) = observation.as_ref() {
                            observation.cancelled.fetch_add(1, Ordering::SeqCst);
                            observation.joined.fetch_add(1, Ordering::SeqCst);
                        }
                        return result.take().expect("worker result");
                    }
                    Some(CaptureCommand::Stop) => {
                        if let Some(stop_count) = wait_for_all_stop.as_ref() {
                            stop_count.fetch_add(1, Ordering::SeqCst);
                            let deadline = Instant::now() + Duration::from_millis(250);
                            while stop_count.load(Ordering::SeqCst) < 2 && Instant::now() < deadline
                            {
                                thread::yield_now();
                            }
                            if stop_count.load(Ordering::SeqCst) < 2 {
                                return Err(
                                    RecordingError::new(RECORDING_STREAM_ERROR).for_source(source)
                                );
                            }
                        }
                        if wait_for_cancel_after_stop {
                            let deadline = Instant::now() + Duration::from_millis(250);
                            while worker_signal.current() != Some(CaptureCommand::Cancel)
                                && Instant::now() < deadline
                            {
                                thread::yield_now();
                            }
                            if worker_signal.current() != Some(CaptureCommand::Cancel) {
                                return Err(
                                    RecordingError::new(RECORDING_STREAM_ERROR).for_source(source)
                                );
                            }
                        }
                        if let Some(observation) = observation.as_ref() {
                            observation.joined.fetch_add(1, Ordering::SeqCst);
                        }
                        return result.take().expect("worker result");
                    }
                    None => thread::yield_now(),
                }
            }
        });

        PreparedSource {
            source,
            signal,
            worker,
        }
    }

    #[test]
    fn mixed_stop_broadcasts_before_join_and_returns_fixed_source_order() {
        let stop_count = Arc::new(AtomicUsize::new(0));
        let microphone_summary = WavCaptureSummary {
            path: PathBuf::from("microphone.wav"),
            valid_frame_count: 441,
            silent: false,
            duration_ms: 11,
        };
        let system_summary = WavCaptureSummary {
            path: PathBuf::from("system-audio.wav"),
            valid_frame_count: 480,
            silent: false,
            duration_ms: 10,
        };
        let sources = [
            prepared_summary_worker(
                RecordingSource::SystemAudio,
                Ok(system_summary),
                Some(stop_count.clone()),
                false,
                None,
            ),
            prepared_summary_worker(
                RecordingSource::Microphone,
                Ok(microphone_summary),
                Some(stop_count),
                false,
                None,
            ),
        ];
        let capture = MixedActiveCapture {
            sources,
            failures: FirstSourceFailure::default(),
        };

        let captured = Box::new(capture).stop().expect("mixed stop succeeds");

        assert_eq!(
            captured.source_paths,
            vec![
                PathBuf::from("microphone.wav"),
                PathBuf::from("system-audio.wav")
            ]
        );
        assert_eq!(captured.valid_frame_count, 921);
        assert_eq!(captured.duration_ms, 11);
        assert!(!captured.silent);
    }

    #[test]
    fn mixed_stop_rejects_one_empty_source_without_partial_result() {
        let sources = [
            prepared_summary_worker(
                RecordingSource::Microphone,
                Ok(WavCaptureSummary {
                    path: PathBuf::from("microphone.wav"),
                    valid_frame_count: 12,
                    silent: true,
                    duration_ms: 10,
                }),
                None,
                false,
                None,
            ),
            prepared_summary_worker(
                RecordingSource::SystemAudio,
                Ok(WavCaptureSummary {
                    path: PathBuf::from("system-audio.wav"),
                    valid_frame_count: 0,
                    silent: true,
                    duration_ms: 0,
                }),
                None,
                false,
                None,
            ),
        ];
        let capture = MixedActiveCapture {
            sources,
            failures: FirstSourceFailure::default(),
        };

        let error = Box::new(capture)
            .stop()
            .expect_err("empty source must fail");

        assert_eq!(error.code, super::RECORDING_EMPTY);
        assert_eq!(error.source, Some(RecordingSource::SystemAudio));
    }

    #[test]
    fn mixed_stop_accepts_valid_silent_source() {
        let sources = [
            prepared_summary_worker(
                RecordingSource::Microphone,
                Ok(WavCaptureSummary {
                    path: PathBuf::from("microphone.wav"),
                    valid_frame_count: 3,
                    silent: false,
                    duration_ms: 10,
                }),
                None,
                false,
                None,
            ),
            prepared_summary_worker(
                RecordingSource::SystemAudio,
                Ok(WavCaptureSummary {
                    path: PathBuf::from("system-audio.wav"),
                    valid_frame_count: 2,
                    silent: true,
                    duration_ms: 15,
                }),
                None,
                false,
                None,
            ),
        ];
        let capture = MixedActiveCapture {
            sources,
            failures: FirstSourceFailure::default(),
        };

        let captured = Box::new(capture)
            .stop()
            .expect("valid silent source is accepted");

        assert_eq!(captured.valid_frame_count, 5);
        assert!(!captured.silent);
    }

    #[test]
    fn mixed_source_failure_beats_concurrent_normal_stop() {
        let sources = [
            prepared_summary_worker(
                RecordingSource::Microphone,
                Err(RecordingError::new(RECORDING_STREAM_ERROR)),
                None,
                false,
                None,
            ),
            prepared_summary_worker(
                RecordingSource::SystemAudio,
                Ok(summary_for(RecordingSource::SystemAudio)),
                None,
                false,
                None,
            ),
        ];
        let capture = MixedActiveCapture {
            sources,
            failures: FirstSourceFailure::default(),
        };

        let error = Box::new(capture)
            .stop()
            .expect_err("source failure must win");

        assert_eq!(error.code, RECORDING_STREAM_ERROR);
        assert_eq!(error.source, Some(RecordingSource::Microphone));
    }

    #[test]
    fn mixed_cancel_handle_upgrades_inflight_stop_before_join_finishes() {
        let stop_count = Arc::new(AtomicUsize::new(0));
        let sources = [
            prepared_summary_worker(
                RecordingSource::Microphone,
                Ok(summary_for(RecordingSource::Microphone)),
                Some(stop_count.clone()),
                true,
                None,
            ),
            prepared_summary_worker(
                RecordingSource::SystemAudio,
                Ok(summary_for(RecordingSource::SystemAudio)),
                Some(stop_count.clone()),
                true,
                None,
            ),
        ];
        let capture: Box<dyn ActiveCapture> = Box::new(MixedActiveCapture {
            sources,
            failures: FirstSourceFailure::default(),
        });
        let cancel_handle = capture
            .cancel_handle()
            .expect("mixed capture is cancellable");
        let stopping = thread::spawn(move || capture.stop());

        wait_until("both workers receiving stop", || {
            stop_count.load(Ordering::SeqCst) == 2
        });
        cancel_handle.request();

        let captured = stopping
            .join()
            .expect("stop worker joined")
            .expect("cancel upgrades stop cleanly");
        assert_eq!(captured.valid_frame_count, 2);
    }

    #[test]
    fn mixed_first_confirmed_failure_is_not_overwritten_by_join_error() {
        let panicking_worker = |source| {
            let signal = CaptureSignal::default();
            let worker_signal = signal.clone();
            let worker = thread::spawn(move || -> Result<WavCaptureSummary, RecordingError> {
                loop {
                    if worker_signal.current().is_some() {
                        panic!("simulated worker join failure");
                    }
                    thread::yield_now();
                }
            });
            PreparedSource {
                source,
                signal,
                worker,
            }
        };
        let sources = [
            prepared_summary_worker(
                RecordingSource::Microphone,
                Ok(summary_for(RecordingSource::Microphone)),
                None,
                false,
                None,
            ),
            panicking_worker(RecordingSource::SystemAudio),
        ];
        let capture = MixedActiveCapture {
            sources,
            failures: {
                let failures = FirstSourceFailure::default();
                failures.record(
                    RecordingError::new(RECORDING_EMPTY),
                    RecordingSource::Microphone,
                );
                failures
            },
        };

        let error = Box::new(capture)
            .stop()
            .expect_err("first failure must win");

        assert_eq!(error.code, super::RECORDING_EMPTY);
        assert_eq!(error.source, Some(RecordingSource::Microphone));
    }

    #[test]
    fn mixed_cleanup_joins_all_workers_after_a_join_panic() {
        let observation = Arc::new(WorkerObservation::default());
        let panicking_worker = |source| {
            let signal = CaptureSignal::default();
            let worker_signal = signal.clone();
            let worker = thread::spawn(move || -> Result<WavCaptureSummary, RecordingError> {
                loop {
                    if worker_signal.current().is_some() {
                        panic!("simulated cleanup join failure");
                    }
                    thread::yield_now();
                }
            });
            PreparedSource {
                source,
                signal,
                worker,
            }
        };
        let sources = [
            panicking_worker(RecordingSource::Microphone),
            prepared_summary_worker(
                RecordingSource::SystemAudio,
                Ok(summary_for(RecordingSource::SystemAudio)),
                None,
                false,
                Some(observation.clone()),
            ),
        ];
        let failures = FirstSourceFailure::default();
        failures.record(
            RecordingError::new(RECORDING_STREAM_ERROR),
            RecordingSource::Microphone,
        );

        let error = Box::new(MixedActiveCapture { sources, failures })
            .cancel_for_cleanup()
            .expect_err("join panic must remain a cleanup error");

        assert_eq!(error.code, RECORDING_STREAM_ERROR);
        assert_eq!(error.source, Some(RecordingSource::Microphone));
        assert_eq!(observation.joined.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn mixed_cancel_broadcasts_joins_and_returns_no_capture() {
        let observation = Arc::new(WorkerObservation::default());
        let sources = [
            prepared_summary_worker(
                RecordingSource::Microphone,
                Ok(summary_for(RecordingSource::Microphone)),
                None,
                false,
                Some(observation.clone()),
            ),
            prepared_summary_worker(
                RecordingSource::SystemAudio,
                Ok(summary_for(RecordingSource::SystemAudio)),
                None,
                false,
                Some(observation.clone()),
            ),
        ];
        let capture = MixedActiveCapture {
            sources,
            failures: FirstSourceFailure::default(),
        };

        Box::new(capture).cancel().expect("mixed cancel succeeds");

        assert_eq!(observation.cancelled.load(Ordering::SeqCst), 2);
        assert_eq!(observation.joined.load(Ordering::SeqCst), 2);
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
        wait_until("pre-gate frame to be dropped", || {
            observation.dropped.load(Ordering::SeqCst) == 1
        });
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
        wait_until("microphone readiness", || {
            observation.ready.load(Ordering::SeqCst) == 1
        });
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
        wait_until("microphone readiness", || {
            observation.ready.load(Ordering::SeqCst) == 1
        });

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
