pub(crate) const SYSTEM_RECOVERY_WINDOW_MS: u64 = 2_000;

const NANOSECONDS_PER_MILLISECOND: u64 = 1_000_000;
const NANOSECONDS_PER_SECOND: u64 = 1_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AudioSampleTiming {
    pub(crate) presentation_ns: u64,
    pub(crate) duration_ns: u64,
    pub(crate) valid: bool,
}

impl AudioSampleTiming {
    pub(crate) const fn invalid() -> Self {
        Self {
            presentation_ns: 0,
            duration_ns: 0,
            valid: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WriteAction {
    Audio,
    Silence { frames: u64 },
    RebuildStream,
    Recovered { gap_ms: u64 },
    FailSource,
    StopCleanly,
}

#[derive(Debug)]
pub(crate) struct SystemAudioRecovery {
    sample_rate: u32,
    channels: u16,
    last_end_ns: Option<u64>,
    recovery_deadline_ms: Option<u64>,
    failed: bool,
    stopping: bool,
}

impl SystemAudioRecovery {
    pub(crate) fn new(sample_rate: u32, channels: u16) -> Self {
        Self {
            sample_rate,
            channels,
            last_end_ns: None,
            recovery_deadline_ms: None,
            failed: false,
            stopping: false,
        }
    }

    pub(crate) fn push(&mut self, timing: AudioSampleTiming) -> Vec<WriteAction> {
        if self.failed {
            return vec![WriteAction::FailSource];
        }
        if self.stopping {
            return vec![WriteAction::StopCleanly];
        }

        if self.sample_rate == 0 || self.channels == 0 || !timing.valid || timing.duration_ns == 0 {
            return self.fail_source();
        }

        let Some(end_ns) = timing.presentation_ns.checked_add(timing.duration_ns) else {
            return self.fail_source();
        };

        let Some(last_end_ns) = self.last_end_ns else {
            self.last_end_ns = Some(end_ns);
            self.clear_recovery();
            return vec![WriteAction::Audio];
        };

        if timing.presentation_ns < last_end_ns {
            return self.fail_source();
        }

        let gap_ns = timing.presentation_ns - last_end_ns;
        let Some(recovery_window_ns) =
            SYSTEM_RECOVERY_WINDOW_MS.checked_mul(NANOSECONDS_PER_MILLISECOND)
        else {
            return self.fail_source();
        };
        if gap_ns > recovery_window_ns {
            return self.fail_source();
        }

        let mut actions = Vec::with_capacity(if gap_ns == 0 { 1 } else { 3 });
        if gap_ns > 0 {
            let Some(silence_frames) = self.gap_frames(gap_ns) else {
                return self.fail_source();
            };
            actions.push(WriteAction::Silence {
                frames: silence_frames,
            });
        }
        actions.push(WriteAction::Audio);
        if gap_ns > 0 {
            actions.push(WriteAction::Recovered {
                gap_ms: gap_ns / NANOSECONDS_PER_MILLISECOND,
            });
        }

        self.last_end_ns = Some(end_ns);
        self.clear_recovery();
        actions
    }

    pub(crate) fn interrupt(&mut self, now_ms: u64) -> Vec<WriteAction> {
        if self.failed {
            return vec![WriteAction::FailSource];
        }
        if self.stopping {
            return vec![WriteAction::StopCleanly];
        }
        if self.recovery_deadline_ms.is_some() {
            return Vec::new();
        }

        let Some(deadline_ms) = now_ms.checked_add(SYSTEM_RECOVERY_WINDOW_MS) else {
            return self.fail_source();
        };
        self.recovery_deadline_ms = Some(deadline_ms);
        vec![WriteAction::RebuildStream]
    }

    pub(crate) fn deadline_elapsed(&mut self, now_ms: u64) -> Vec<WriteAction> {
        if self.failed {
            return vec![WriteAction::FailSource];
        }
        if self.stopping {
            return vec![WriteAction::StopCleanly];
        }

        let Some(deadline_ms) = self.recovery_deadline_ms else {
            return Vec::new();
        };

        if now_ms >= deadline_ms {
            return self.fail_source();
        }
        Vec::new()
    }

    pub(crate) fn stop(&mut self) -> Vec<WriteAction> {
        self.stopping = true;
        self.clear_recovery();
        vec![WriteAction::StopCleanly]
    }

    fn gap_frames(&self, gap_ns: u64) -> Option<u64> {
        let sample_rate = u64::from(self.sample_rate);
        let whole_seconds = gap_ns / NANOSECONDS_PER_SECOND;
        let remainder_ns = gap_ns % NANOSECONDS_PER_SECOND;
        let whole_frames = whole_seconds.checked_mul(sample_rate)?;
        let remainder_frames = remainder_ns
            .checked_mul(sample_rate)?
            .checked_div(NANOSECONDS_PER_SECOND)?;
        whole_frames.checked_add(remainder_frames)
    }

    fn clear_recovery(&mut self) {
        self.recovery_deadline_ms = None;
    }

    fn fail_source(&mut self) -> Vec<WriteAction> {
        self.failed = true;
        self.clear_recovery();
        vec![WriteAction::FailSource]
    }
}

#[cfg(test)]
mod tests {
    use super::{AudioSampleTiming, SystemAudioRecovery, WriteAction};

    fn sample(presentation_ns: u64, duration_ns: u64) -> AudioSampleTiming {
        AudioSampleTiming {
            presentation_ns,
            duration_ns,
            valid: true,
        }
    }

    #[test]
    fn recovery_inserts_silence_for_a_1040ms_gap() {
        let mut recovery = SystemAudioRecovery::new(48_000, 2);
        assert_eq!(
            recovery.push(sample(0, 20_000_000)),
            vec![WriteAction::Audio]
        );

        let actions = recovery.push(sample(1_040_000_000, 20_000_000));

        assert_eq!(
            actions,
            vec![
                WriteAction::Silence { frames: 48_960 },
                WriteAction::Audio,
                WriteAction::Recovered { gap_ms: 1_020 },
            ]
        );
    }

    #[test]
    fn recovery_accepts_exactly_two_seconds() {
        let mut recovery = SystemAudioRecovery::new(48_000, 2);
        recovery.push(sample(0, 20_000_000));
        assert!(!recovery
            .push(sample(2_020_000_000, 20_000_000))
            .contains(&WriteAction::FailSource));
    }

    #[test]
    fn recovery_fails_when_gap_exceeds_two_seconds() {
        let mut recovery = SystemAudioRecovery::new(48_000, 2);
        recovery.push(sample(0, 20_000_000));
        assert_eq!(
            recovery.push(sample(2_020_000_001, 20_000_000)),
            vec![WriteAction::FailSource]
        );
    }

    #[test]
    fn recovery_fails_when_timestamp_is_missing_or_non_monotonic() {
        let mut recovery = SystemAudioRecovery::new(48_000, 2);
        recovery.push(sample(1_000_000, 20_000_000));
        assert_eq!(
            recovery.push(AudioSampleTiming::invalid()),
            vec![WriteAction::FailSource]
        );
        assert_eq!(
            recovery.push(sample(900_000, 20_000_000)),
            vec![WriteAction::FailSource]
        );
    }

    #[test]
    fn recovery_deadline_fails_without_future_audio() {
        let mut recovery = SystemAudioRecovery::new(48_000, 2);
        recovery.push(sample(0, 20_000_000));
        assert_eq!(recovery.interrupt(10_000), vec![WriteAction::RebuildStream]);
        assert_eq!(
            recovery.deadline_elapsed(12_000),
            vec![WriteAction::FailSource]
        );
    }

    #[test]
    fn stop_cancels_recovery_without_source_failure() {
        let mut recovery = SystemAudioRecovery::new(48_000, 2);
        recovery.push(sample(0, 20_000_000));
        recovery.interrupt(10_000);
        assert_eq!(recovery.stop(), vec![WriteAction::StopCleanly]);
    }
}
