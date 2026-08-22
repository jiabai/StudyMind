use super::{RecordingError, RECORDING_STATE_UNAVAILABLE};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex};

enum FailurePhase {
    Starting,
    Accepted,
}

struct FailureShared {
    phase: FailurePhase,
    first: Option<RecordingError>,
}

#[derive(Clone)]
pub(crate) struct RecordingFailureReporter {
    shared: Arc<Mutex<FailureShared>>,
    wake: SyncSender<()>,
}

pub(crate) struct RecordingFailureMonitor {
    shared: Arc<Mutex<FailureShared>>,
    wake: Receiver<()>,
}

pub(crate) fn recording_failure_channel() -> (
    RecordingFailureReporter,
    RecordingFailureMonitor,
) {
    let shared = Arc::new(Mutex::new(FailureShared {
        phase: FailurePhase::Starting,
        first: None,
    }));
    let (wake, receiver) = mpsc::sync_channel(1);
    (
        RecordingFailureReporter {
            shared: Arc::clone(&shared),
            wake,
        },
        RecordingFailureMonitor {
            shared,
            wake: receiver,
        },
    )
}

impl RecordingFailureReporter {
    pub(crate) fn report(&self, error: RecordingError) {
        let mut shared = self
            .shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if shared.first.is_none() {
            shared.first = Some(error);
            if matches!(shared.phase, FailurePhase::Accepted) {
                let _ = self.wake.try_send(());
            }
        }
    }

    pub(crate) fn snapshot(&self) -> Option<RecordingError> {
        self.shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .first
            .clone()
    }
}

impl RecordingFailureMonitor {
    pub(crate) fn accept(&mut self) -> Result<(), RecordingError> {
        let mut shared = self
            .shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(error) = shared.first.clone() {
            return Err(error);
        }
        shared.phase = FailurePhase::Accepted;
        Ok(())
    }

    pub(crate) fn wait(&self) -> Result<(), RecordingError> {
        self.wake
            .recv()
            .map(|()| ())
            .map_err(|_| RecordingError::new(RECORDING_STATE_UNAVAILABLE))
    }

    #[allow(dead_code)]
    pub(crate) fn try_wait(&self) -> Result<(), RecordingError> {
        self.wake
            .try_recv()
            .map(|()| ())
            .map_err(|_| RecordingError::new(RECORDING_STATE_UNAVAILABLE))
    }

    pub(crate) fn snapshot(&self) -> Option<RecordingError> {
        self.shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .first
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use super::recording_failure_channel;

    #[test]
    fn failure_reporter_wakes_once_and_preserves_first_confirmed_error() {
        let (reporter, mut monitor) = recording_failure_channel();
        monitor.accept().expect("accept recording session");
        reporter.report(
            RecordingError::new(RECORDING_STREAM_ERROR)
                .for_source(RecordingSource::SystemAudio),
        );
        reporter.report(
            RecordingError::new(RECORDING_STREAM_ERROR)
                .for_source(RecordingSource::Microphone),
        );

        monitor.wait().expect("first failure wakeup");
        assert_eq!(
            monitor.snapshot().expect("latched failure").source,
            Some(RecordingSource::SystemAudio),
        );
        assert!(monitor.try_wait().is_err());
    }

    #[test]
    fn unreported_failure_channel_disconnects_without_fabricating_an_error() {
        let (reporter, monitor) = recording_failure_channel();
        drop(reporter);

        assert!(monitor.wait().is_err());
        assert_eq!(monitor.snapshot(), None);
    }

    #[test]
    fn failure_before_acceptance_is_returned_as_startup_failure_without_runtime_wakeup() {
        let (reporter, mut monitor) = recording_failure_channel();
        reporter.report(
            RecordingError::new(RECORDING_STREAM_ERROR)
                .for_source(RecordingSource::Microphone),
        );

        let error = monitor.accept().expect_err("startup failure");

        assert_eq!(error.source, Some(RecordingSource::Microphone));
        assert!(monitor.try_wait().is_err());
    }
}
