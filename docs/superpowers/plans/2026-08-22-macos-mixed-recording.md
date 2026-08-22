# macOS Mixed Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one atomic microphone + system-audio `RecordingSession` on macOS and migrate Windows mixed capture to the same ready-gate, failure, stop, cancel, and cleanup semantics.

**Architecture:** Add a platform-neutral `audio_capture/mixed.rs` coordinator whose prepared source workers share a non-blocking capture gate, a broadcastable control signal, and a first-source-failure latch. Add a generic accepted-session failure supervisor that atomically replaces an active Controller session with a recoverable failed snapshot, emits an immediate terminal event, and performs capture cleanup in the background. WASAPI, cpal, and ScreenCaptureKit remain platform adapters; Rust and TypeScript share one source-aware `RecordingFailureView` without adding a second frontend media flow.

**Tech Stack:** Rust, Tauri, std threads/channels/atomics, WASAPI, cpal/CoreAudio, ScreenCaptureKit, hound-style project WAV writer, ffmpeg, React, TypeScript, Vitest.

---

## Execution prerequisite

Execute this plan in an isolated worktree/branch such as `codex/macos-mixed-recording`, based on the
latest `master` containing the confirmed design and terminal-failure revision. Do not mark E1/E2/E3
runtime rows Pass from Windows-host tests.

Current execution progress in `codex/macos-mixed-recording`: Task 1 is committed as `306f045` plus
review fix `8852573`; Task 2 is committed as `23e1613` and requires renewed spec/quality review after
this plan revision. Continue with Task 2 review, then Task 3; do not reimplement completed work.

## File responsibility map

- `app/src-tauri/src/audio_capture/mixed.rs`: platform-neutral gate, control signal, source-ready
  protocol, first-failure latch, startup barrier, `MixedActiveCapture`, and deterministic fake tests.
- `app/src-tauri/src/audio_capture/failure_supervisor.rs`: platform-neutral first-failure reporter,
  wakeup receiver, duplicate suppression, and deterministic race tests.
- `app/src-tauri/src/audio_capture/mod.rs`: stable `RecordingSource`, optional error source metadata,
  tagged recording/failed state, terminal event sink, acknowledgement command, Controller background
  cleanup, and cleanup/error-precedence tests.
- `app/src-tauri/src/audio_capture/wasapi.rs`: WASAPI source preparation and callback-side gate;
  single-source behavior remains local while mixed delegates lifecycle to `mixed.rs`.
- `app/src-tauri/src/audio_capture/macos.rs`: explicit mixed capability, permission order, cpal and
  ScreenCaptureKit prepared-source adapters, and existing system recovery integration.
- `app/src-tauri/src/audio_capture/mixer.rs`: exact two-input/fixed-order and different-format
  finalizer coverage; production equal-weight arguments remain unchanged.
- `app/src/recordingClient.ts`: strict optional `source`, shared `RecordingFailureView`, terminal
  event/state parsing, and failure acknowledgement.
- `app/src/features/workflow/useRecordingController.ts`: deduplicate terminal failures, stop the
  timer immediately, hydrate failed state, and retain one session/timer/handoff.
- `app/src/features/workflow/RecordingCard.tsx`: choose existing localized microphone/system copy
  for source-tagged stream errors.
- macOS ADR, acceptance plan, and handoff: record implementation evidence separately from native
  runtime evidence.

### Task 1: Add the stable error-source contract

**Files:**
- Modify: `app/src-tauri/src/audio_capture/mod.rs:101-121`
- Test: `app/src-tauri/src/audio_capture/mod.rs` test module

- [ ] **Step 1: Write failing serialization and preservation tests**

Add tests that require camelCase source values, omission for non-source errors, and preservation of
an already assigned source:

```rust
#[test]
fn recording_error_serializes_optional_closed_source() {
    let sourced = RecordingError::new(RECORDING_STREAM_ERROR)
        .for_source(RecordingSource::SystemAudio);
    assert_eq!(
        serde_json::to_value(&sourced).expect("serialize sourced error"),
        serde_json::json!({
            "code": "RECORDING_STREAM_ERROR",
            "message": "The recording stream was interrupted.",
            "source": "systemAudio"
        })
    );

    let unsourced = RecordingError::new(RECORDING_MIX_FAILED);
    let value = serde_json::to_value(&unsourced).expect("serialize unsourced error");
    assert!(value.get("source").is_none());
}

#[test]
fn recording_error_keeps_the_first_assigned_source() {
    let error = RecordingError::new(RECORDING_STREAM_ERROR)
        .for_source(RecordingSource::Microphone)
        .for_source(RecordingSource::SystemAudio);
    assert_eq!(error.source, Some(RecordingSource::Microphone));
}

#[test]
fn recording_error_payload_contains_no_native_diagnostics() {
    let value = serde_json::to_value(
        RecordingError::new(RECORDING_STREAM_ERROR)
            .for_source(RecordingSource::SystemAudio),
    )
    .expect("serialize redacted error");
    let object = value.as_object().expect("error object");
    assert_eq!(object.len(), 3);
    assert!(object.contains_key("code"));
    assert!(object.contains_key("message"));
    assert!(object.contains_key("source"));
}
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```text
cargo test --manifest-path app/src-tauri/Cargo.toml recording_error_ -- --test-threads=1
```

Expected: compilation fails because `RecordingSource`, `RecordingError::for_source`, and
`RecordingError.source` do not exist.

- [ ] **Step 3: Implement the closed source enum and optional field**

Add this immediately before `RecordingError` and extend its constructor:

```rust
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
```

Keep `RecordingWarningSource` unchanged: warning sources and failure sources are separate closed
contracts even though both currently contain `systemAudio`.

- [ ] **Step 4: Run focused and module tests and verify GREEN**

Run:

```text
cargo test --manifest-path app/src-tauri/Cargo.toml recording_error_ -- --test-threads=1
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture -- --test-threads=1
```

Expected: all three new tests pass; existing audio-capture tests pass after any direct `RecordingError`
struct literals are updated with `source: None`.

- [ ] **Step 5: Commit**

```text
git add app/src-tauri/src/audio_capture/mod.rs
git commit -m "feat(recording): attach source to capture errors"
```

### Task 2: Build the shared ready gate and atomic startup barrier

**Files:**
- Create: `app/src-tauri/src/audio_capture/mixed.rs`
- Modify: `app/src-tauri/src/audio_capture/mod.rs:8-17`
- Test: `app/src-tauri/src/audio_capture/mixed.rs`

- [ ] **Step 1: Write failing gate/startup tests with fake workers**

Create `mixed.rs` with a test module first. The test fixture must spawn workers that report Ready,
increment separate pre/post-gate counters, and wait for a control signal. Add these named tests:

```rust
#[test]
fn mixed_start_opens_gate_only_after_both_sources_are_ready() {
    let fixture = MixedFixture::new();
    let mic = fixture.spawn_ready_source(RecordingSource::Microphone, "mic.wav");
    let system = fixture.spawn_blocked_source(RecordingSource::SystemAudio, "system.wav");

    assert!(fixture.wait_until_ready(RecordingSource::Microphone));
    assert_eq!(fixture.post_gate_frames(), 0);
    fixture.release(RecordingSource::SystemAudio);

    let capture = start_mixed(
        [mic, system],
        fixture.ready_receiver(),
        fixture.gate(),
        fixture.failures(),
        Duration::from_secs(3),
    )
    .expect("both sources become ready");
    assert!(fixture.gate().is_open());
    assert_eq!(fixture.pre_gate_written_frames(), 0);
    capture.cancel().expect("cancel capture");
}

#[test]
fn mixed_start_failure_cancels_and_joins_both_sources() {
    let fixture = MixedFixture::new();
    let mic = fixture.spawn_ready_source(RecordingSource::Microphone, "mic.wav");
    let system = fixture.spawn_failed_source(
        RecordingSource::SystemAudio,
        RecordingError::new(RECORDING_SYSTEM_LOOPBACK_INIT_FAILED),
    );

    let error = start_mixed(
        [mic, system],
        fixture.ready_receiver(),
        fixture.gate(),
        fixture.failures(),
        Duration::from_secs(3),
    )
    .expect_err("mixed startup must be atomic");
    assert_eq!(error.code, RECORDING_SYSTEM_LOOPBACK_INIT_FAILED);
    assert_eq!(error.source, Some(RecordingSource::SystemAudio));
    assert!(fixture.all_workers_joined());
    assert!(!fixture.gate().is_open());
}
```

Also add `mixed_start_timeout_tags_the_only_missing_source`,
`mixed_start_timeout_without_any_ready_source_is_unsourced`, and
`mixed_start_rejects_duplicate_source_identity` so timeout attribution and malformed adapters are
deterministic.

- [ ] **Step 2: Register the module and verify RED**

Add `mod mixed;` beside `mod mixer;` in `mod.rs`, then run:

```text
cargo test --manifest-path app/src-tauri/Cargo.toml mixed_start_ -- --test-threads=1
```

Expected: compilation fails because the shared coordinator types and functions are not defined.

- [ ] **Step 3: Implement the minimal shared startup types**

Implement these production interfaces in `mixed.rs`:

```rust
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::wav_writer::WavCaptureSummary;
use super::{
    ActiveCapture, RecordingError, RecordingSource, RECORDING_STREAM_ERROR,
};

#[derive(Clone, Default)]
pub(crate) struct CaptureGate(Arc<AtomicBool>);

impl CaptureGate {
    pub(crate) fn open(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub(crate) fn is_open(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CaptureCommand {
    Stop = 1,
    Cancel = 2,
}

#[derive(Clone, Default)]
pub(crate) struct CaptureSignal(Arc<AtomicU8>);

impl CaptureSignal {
    pub(crate) fn request(&self, command: CaptureCommand) {
        let requested = command as u8;
        let mut current = self.0.load(Ordering::Acquire);
        while requested > current {
            match self.0.compare_exchange_weak(
                current,
                requested,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(observed) => current = observed,
            }
        }
    }

    pub(crate) fn current(&self) -> Option<CaptureCommand> {
        match self.0.load(Ordering::Acquire) {
            1 => Some(CaptureCommand::Stop),
            2 => Some(CaptureCommand::Cancel),
            _ => None,
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct FirstSourceFailure(Arc<Mutex<Option<RecordingError>>>);

impl FirstSourceFailure {
    pub(crate) fn record(&self, error: RecordingError, source: RecordingSource) {
        let mut first = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if first.is_none() {
            *first = Some(error.for_source(source));
        }
    }

    pub(crate) fn snapshot(&self) -> Option<RecordingError> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }
}

pub(crate) struct SourceReady {
    pub(crate) source: RecordingSource,
    pub(crate) result: Result<(), RecordingError>,
}

pub(crate) type ReadySender = mpsc::SyncSender<SourceReady>;
pub(crate) type ReadyReceiver = mpsc::Receiver<SourceReady>;

pub(crate) fn ready_channel() -> (ReadySender, ReadyReceiver) {
    mpsc::sync_channel(2)
}

pub(crate) struct PreparedSource {
    pub(crate) source: RecordingSource,
    pub(crate) signal: CaptureSignal,
    pub(crate) worker: JoinHandle<Result<WavCaptureSummary, RecordingError>>,
}
```

Implement `start_mixed` with the exact signature
`fn start_mixed([PreparedSource; 2], ReadyReceiver, CaptureGate, FirstSourceFailure, Duration) ->
Result<Box<dyn ActiveCapture>, RecordingError>`. It validates exactly one source of each kind, receives two `SourceReady`
messages until the single deadline, source-tag any startup error, request Cancel on both sources,
join both on every failure, and open `CaptureGate` only after both Ready messages succeed. Return a
private `MixedActiveCapture` containing the two prepared sources and the exact
`FirstSourceFailure` instance supplied to `start_mixed`.

At deadline, tag `RECORDING_STREAM_ERROR` with the only source still missing when exactly one Ready
was observed; if neither source became Ready, return the same code without source. Failure precedence
is the mutex latch observation order, never a source media timestamp. `CaptureSignal::request` must
make Cancel dominate Stop until finalization begins; a later Stop must not downgrade Cancel.

- [ ] **Step 4: Run the startup tests and verify GREEN**

Run:

```text
cargo test --manifest-path app/src-tauri/Cargo.toml mixed_start_ -- --test-threads=1
```

Expected: all four startup tests pass without sleeping longer than the injected timeout.

- [ ] **Step 5: Commit**

```text
git add app/src-tauri/src/audio_capture/mixed.rs app/src-tauri/src/audio_capture/mod.rs
git commit -m "feat(recording): add atomic mixed startup barrier"
```

### Task 3: Complete mixed stop, cancel, result, and failure precedence

**Files:**
- Modify: `app/src-tauri/src/audio_capture/mixed.rs`
- Modify: `app/src-tauri/src/audio_capture/mod.rs`
- Test: `app/src-tauri/src/audio_capture/mixed.rs`

- [ ] **Step 1: Write failing stop/result tests**

Add deterministic tests named exactly:

```rust
#[test]
fn mixed_stop_broadcasts_before_join_and_returns_fixed_source_order() {
    let fixture = MixedFixture::started_with_summaries(
        summary("system.wav", 480, false, 10),
        summary("mic.wav", 441, false, 11),
    );
    let capture = fixture.start().expect("start mixed");
    let result = capture.stop().expect("stop mixed");

    assert!(fixture.both_stop_signals_seen_before_first_join());
    assert_eq!(
        result.source_paths,
        vec![fixture.path("mic.wav"), fixture.path("system.wav")]
    );
    assert_eq!(result.valid_frame_count, 921);
    assert_eq!(result.duration_ms, 11);
    assert!(!result.silent);
}

#[test]
fn mixed_stop_rejects_one_empty_source_without_partial_result() {
    let fixture = MixedFixture::started_with_summaries(
        summary("mic.wav", 12, true, 10),
        summary("system.wav", 0, true, 0),
    );
    let error = fixture.start().expect("start mixed").stop()
        .expect_err("empty system source fails mixed");
    assert_eq!(error.code, RECORDING_EMPTY);
    assert_eq!(error.source, Some(RecordingSource::SystemAudio));
    assert!(fixture.no_partial_result_committed());
}
```

Also add:

- `mixed_stop_accepts_valid_silent_source`;
- `mixed_source_failure_beats_concurrent_normal_stop`;
- `mixed_cancel_handle_upgrades_inflight_stop_before_join_finishes`;
- `mixed_first_confirmed_failure_is_not_overwritten_by_join_error`;
- `mixed_cancel_broadcasts_joins_and_returns_no_capture`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```text
cargo test --manifest-path app/src-tauri/Cargo.toml mixed_stop_ -- --test-threads=1
cargo test --manifest-path app/src-tauri/Cargo.toml mixed_source_failure_ -- --test-threads=1
cargo test --manifest-path app/src-tauri/Cargo.toml mixed_cancel_ -- --test-threads=1
```

Expected: tests fail because `MixedActiveCapture` does not yet implement the required join and
summary semantics.

- [ ] **Step 3: Implement broadcast-before-join and per-source validation**

Implement helpers with this behavior:

```rust
fn request_all(sources: &[PreparedSource], command: CaptureCommand) {
    for source in sources {
        source.signal.request(command);
    }
}

fn summarize_sources(
    mut summaries: Vec<(RecordingSource, WavCaptureSummary)>,
) -> Result<CapturedRecording, RecordingError> {
    summaries.sort_by_key(|(source, _)| match source {
        RecordingSource::Microphone => 0,
        RecordingSource::SystemAudio => 1,
    });
    for (source, summary) in &summaries {
        if summary.valid_frame_count == 0 {
            return Err(RecordingError::new(RECORDING_EMPTY).for_source(*source));
        }
    }
    let valid_frame_count = summaries.iter().try_fold(0u64, |total, (_, summary)| {
        total.checked_add(summary.valid_frame_count)
            .ok_or_else(|| RecordingError::new(RECORDING_STREAM_ERROR))
    })?;
    Ok(CapturedRecording {
        source_paths: summaries.iter().map(|(_, summary)| summary.path.clone()).collect(),
        valid_frame_count,
        silent: summaries.iter().all(|(_, summary)| summary.silent),
        duration_ms: summaries.iter().map(|(_, summary)| summary.duration_ms).max().unwrap_or(0),
    })
}
```

`MixedActiveCapture::stop` must request Stop on both, join both even after an error, record each
worker error in `FirstSourceFailure`, return the latched failure before summaries, then call
`summarize_sources`. `cancel` must request Cancel on both and join both; return a genuine latched
source failure if one was already confirmed, but never construct a `CapturedRecording`.

Add a generic cloneable handle in `mod.rs` and a default `None` method so adapters can migrate in
Tasks 5 and 7 without breaking intermediate builds:

```rust
#[derive(Clone)]
pub(crate) struct CaptureCancelHandle(
    Arc<dyn Fn() + Send + Sync>,
);

impl CaptureCancelHandle {
    pub(crate) fn new(request: impl Fn() + Send + Sync + 'static) -> Self {
        Self(Arc::new(request))
    }

    pub(crate) fn request(&self) {
        (self.0)();
    }
}

pub(crate) trait ActiveCapture: Send {
    fn cancel_handle(&self) -> Option<CaptureCancelHandle> {
        None
    }
    fn stop(self: Box<Self>) -> Result<CapturedRecording, RecordingError>;
    fn cancel(self: Box<Self>) -> Result<(), RecordingError>;
}
```

`MixedActiveCapture::cancel_handle` captures clones of both source signals and requests
`CaptureCommand::Cancel` on each. Because Task 2 made Cancel monotonic over Stop, a handle request
while `stop()` is joining upgrades both workers without accessing the consumed capture object.

- [ ] **Step 4: Run all mixed tests and verify GREEN**

Run:

```text
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture::mixed -- --test-threads=1
```

Expected: startup, stop, empty/silent, failure-priority, and cancel tests all pass.

- [ ] **Step 5: Commit**

```text
git add app/src-tauri/src/audio_capture/mixed.rs app/src-tauri/src/audio_capture/mod.rs
git commit -m "feat(recording): make mixed stop and cleanup atomic"
```

### Task 4: Add the accepted-session terminal failure supervisor

**Files:**
- Create: `app/src-tauri/src/audio_capture/failure_supervisor.rs`
- Modify: `app/src-tauri/src/audio_capture/mod.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Test: `app/src-tauri/src/audio_capture/failure_supervisor.rs`
- Test: `app/src-tauri/src/audio_capture/mod.rs` test module

- [ ] **Step 1: Write failing first-failure reporter tests**

Add deterministic tests that use channels and barriers rather than sleeps:

```rust
#[test]
fn failure_reporter_wakes_once_and_preserves_first_confirmed_error() {
    let (reporter, monitor) = recording_failure_channel();
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
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```text
cargo test --manifest-path app/src-tauri/Cargo.toml failure_reporter_ -- --test-threads=1
```

Expected: compilation fails because `failure_supervisor.rs` and `recording_failure_channel` do not
exist.

- [ ] **Step 3: Implement the platform-neutral first-failure channel**

Create these focused primitives. The mutex establishes first-observation order; no media timestamp
participates in failure precedence.

```rust
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

pub(crate) fn recording_failure_channel(
) -> (RecordingFailureReporter, RecordingFailureMonitor) {
    let shared = Arc::new(Mutex::new(FailureShared {
        phase: FailurePhase::Starting,
        first: None,
    }));
    let (wake, receiver) = mpsc::sync_channel(1);
    (
        RecordingFailureReporter { shared: shared.clone(), wake },
        RecordingFailureMonitor { shared, wake: receiver },
    )
}

impl RecordingFailureReporter {
    pub(crate) fn report(&self, error: RecordingError) {
        let mut shared = self.shared.lock().unwrap_or_else(|p| p.into_inner());
        if shared.first.is_none() {
            shared.first = Some(error);
            if matches!(shared.phase, FailurePhase::Accepted) {
                let _ = self.wake.try_send(());
            }
        }
    }
}
```

Implement `accept`, `wait`, `try_wait`, and `snapshot` on the monitor without exposing its mutex or
receiver. `accept(&mut self)` atomically returns a pre-acceptance failure if one exists; otherwise it
changes the phase to Accepted. Reports after that transition send the one runtime wakeup.
Keep this module free of Tauri, file-store, platform, and UI types.

- [ ] **Step 4: Write failing Controller terminal-state tests**

Extend the fake backend so its returned capture retains a `RecordingFailureReporter`. Add tests named:

- `accepted_runtime_failure_emits_before_blocked_capture_cleanup_finishes`;
- `runtime_failure_state_hydrates_with_same_failure_view`;
- `runtime_failure_cancels_capture_and_cleans_workspace_in_background`;
- `duplicate_runtime_failure_does_not_replace_identity_or_emit_a_second_user_failure`;
- `stop_after_runtime_failure_returns_the_latched_error`;
- `cancel_after_runtime_failure_is_idempotent_and_preserves_snapshot`;
- `cleanup_pending_rejects_acknowledgement_and_new_start`;
- `successful_capture_teardown_reemits_failure_with_cleanup_complete`;
- `file_cleanup_error_does_not_keep_cleanup_pending`;
- `capture_cancel_error_keeps_cleanup_pending_and_blocks_recording`;
- `matching_failure_acknowledgement_is_idempotent`;
- `stale_failure_acknowledgement_cannot_clear_a_newer_failure`;
- `new_session_ownership_atomically_clears_the_old_failure`;
- `cancel_during_stopping_requests_capture_cancel_and_prevents_finalizer`;
- `finalizing_rejects_cancel_without_interrupting_finalization`.

Use a fake capture whose `cancel` waits on a test-controlled barrier. Assert the first sink event and
failed state are observable while cancel remains blocked; then release the barrier and assert the
same failure identity is emitted with `cleanup_pending == false`.

- [ ] **Step 5: Run Controller tests and verify RED**

Run:

```text
cargo test --manifest-path app/src-tauri/Cargo.toml accepted_runtime_failure_ -- --test-threads=1
cargo test --manifest-path app/src-tauri/Cargo.toml runtime_failure_ -- --test-threads=1
cargo test --manifest-path app/src-tauri/Cargo.toml failure_acknowledgement_ -- --test-threads=1
```

Expected: tests fail because the Controller has no failure sink, failed snapshot, acknowledgement,
or background cleanup path.

- [ ] **Step 6: Add the shared failure view, tagged state, and sink**

Add a new stable generic error code `RECORDING_CLEANUP_IN_PROGRESS`. Define one serialized payload:

```rust
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
```

Add `RecordingFailureSink` plus no-op and Tauri implementations. The Tauri implementation emits
`recording-failed` with the `RecordingFailureView` itself. Inject it beside the existing warning
sink so unit tests can capture exact payloads.

- [ ] **Step 7: Make Controller state shareable with one background cleanup owner**

Change Controller state storage to an `Arc<Mutex<ControllerState>>`. Replace the code-only Error
variant with:

```rust
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
```

After backend start succeeds, call `monitor.accept()`. A latched pre-acceptance error cancels the
capture, cleans the workspace, returns the startup error, and restores Idle without event/snapshot.
Otherwise install `RecordingSession`, spawn exactly one monitor thread, and let
that thread atomically take the matching active session when the monitor wakes. Under the state
lock, construct and store `cleanup_pending=true`; release the lock before emitting or doing I/O.
Emit the first event immediately, then call `capture.cancel()` and `file_store.cleanup()`.

If capture cancellation succeeds, update the matching snapshot to `cleanup_pending=false` even when
file cleanup fails, refresh warnings, and re-emit the same identity. If capture cancellation fails,
keep `cleanup_pending=true`; do not replace `error_code` or `source`. A pending failure remains
visible with copy equivalent to “安全结束录音中；若持续无法重试，请重启应用”, so the same field
covers both ordinary cleanup and an unconfirmed native teardown without inventing a second state.

Extend `RecordingBackend::start` with a `RecordingFailureReporter` argument. Backends must report
only failures after their start method has returned `Ok`; startup failures remain direct return
values after local cleanup. For the narrow return/event race, retain the failed snapshot even if the
event reaches JavaScript before the start promise resolves; Task 9 buffers by session id and performs
post-start hydration.

- [ ] **Step 8: Implement stop/cancel/acknowledge race rules**

Make `stop` return the stored error for the same failed session. Make `cancel` return `Ok(())` for the
same failed session while preserving its snapshot and treating the call as an idempotent cleanup
request. Reject cancel in `Finalizing` with `RECORDING_SESSION_INVALID`.

When stop takes the active capture, obtain its cancel handle and enter `Stopping` before calling
`capture.stop()`. A matching cancel in this state sets `cancel_requested=true`, invokes the handle,
and returns success. After capture joins, a latched source failure still wins; otherwise a requested
cancel cleans the workspace, skips finalizer, returns `RECORDING_SESSION_INVALID` to the superseded
stop caller, and leaves the Controller idle. Only a successful, non-cancelled capture result may
atomically change `Stopping` to `Finalizing`; from that point cancel is rejected and ffmpeg continues.

Every start failure branch must return Controller state to Idle after cleanup and must not construct
a failed snapshot. Runtime watcher failures and stop/Empty/finalizer failures after an accepted start
must construct the shared failed snapshot. Since `ActiveCapture::stop` is contractually detached from
all callbacks/workers before returning, stop/Empty/finalizer failures use `cleanup_pending=false`;
only asynchronous runtime cleanup uses the pending transition.

Add:

```rust
pub(crate) fn acknowledge_failure(&self, session_id: &str) -> Result<(), RecordingError>
```

It returns `RECORDING_CLEANUP_IN_PROGRESS` for a matching pending failure, clears a matching completed
failure, succeeds for a duplicate acknowledgement of that same session, and returns
`RECORDING_SESSION_INVALID` for a stale/mismatched id. Store only the most recently acknowledged id
in process memory; clear it when a new session atomically takes ownership. Register the corresponding
`acknowledge_recording_failure` Tauri command in `lib.rs`.

- [ ] **Step 9: Run failure-supervisor and full audio-capture tests**

Run:

```text
cargo test --manifest-path app/src-tauri/Cargo.toml failure_supervisor -- --test-threads=1
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture -- --test-threads=1
```

Expected: all terminal-state, cleanup, acknowledgement, existing warning, start/stop/cancel, and
mixed coordinator tests pass.

- [ ] **Step 10: Commit**

```text
git add app/src-tauri/src/audio_capture/failure_supervisor.rs app/src-tauri/src/audio_capture/mod.rs app/src-tauri/src/lib.rs
git commit -m "feat(recording): supervise accepted-session failures"
```

### Task 5: Migrate Windows WASAPI mixed capture to the coordinator

**Files:**
- Modify: `app/src-tauri/src/audio_capture/wasapi.rs:34-230,331-365`
- Test: `app/src-tauri/src/audio_capture/wasapi.rs` test module

- [ ] **Step 1: Write failing Windows adapter tests**

Extract a platform-neutral packet-write seam and add tests proving that packets are drained but not
written before the gate. Add tests for source tagging and mixed source preparation:

```rust
#[test]
fn packet_before_shared_gate_is_discarded_without_blocking() {
    let gate = CaptureGate::default();
    let block = vec![1_u8, 0, 2, 0];
    let mut writer = FakePacketWriter::default();
    write_packet_if_open(&gate, &mut writer, &block, 2, false)
        .expect("discard pre-gate packet");
    assert_eq!(writer.frames_written, 0);

    gate.open();
    write_packet_if_open(&gate, &mut writer, &block, 2, false)
        .expect("write post-gate packet");
    assert_eq!(writer.frames_written, 2);
}

#[test]
fn wasapi_runtime_error_is_tagged_with_source() {
    let error = source_stream_error(SourceKind::SystemAudio);
    assert_eq!(error.code, RECORDING_STREAM_ERROR);
    assert_eq!(error.source, Some(RecordingSource::SystemAudio));
}
```

Add a coordinator-facing test that creates two fake WASAPI prepared workers in reverse completion
order and asserts final paths remain mic then system. Add
`wasapi_runtime_failure_reports_after_ready_without_waiting_for_stop`, injecting a
`RecordingFailureReporter` and asserting the reporter receives the same source-tagged error returned
by the worker.

- [ ] **Step 2: Run focused tests and verify RED**

Run on Windows:

```text
cargo test --manifest-path app/src-tauri/Cargo.toml wasapi_ -- --test-threads=1
cargo test --manifest-path app/src-tauri/Cargo.toml packet_before_shared_gate_ -- --test-threads=1
```

Expected: compilation fails because the gate-aware write seam and source-tagged error helper do not
exist.

- [ ] **Step 3: Refactor WASAPI start into single and mixed paths**

Map `SourceKind` to the public closed source:

```rust
impl SourceKind {
    fn source(self) -> RecordingSource {
        match self {
            Self::Microphone => RecordingSource::Microphone,
            Self::SystemAudio => RecordingSource::SystemAudio,
        }
    }

    fn stream_error(self) -> RecordingError {
        RecordingError::new(RECORDING_STREAM_ERROR).for_source(self.source())
    }
}
```

Keep mic/system-only startup behavior, but pass an already-open `CaptureGate` to their worker.
For mixed, create one closed gate, one `FirstSourceFailure`, one two-entry ready channel, prepare both
workers with clones of that latch, and pass the original latch explicitly to
`mixed::start_mixed(sources, ready_rx, gate, failures, Duration::from_secs(3))`.

Change `run_source_worker` and `capture_packets` to receive `CaptureSignal`, `CaptureGate`,
`FirstSourceFailure`, and `RecordingFailureReporter`. After `IAudioClient::Start`, send `SourceReady`.
Continue calling
`GetBuffer`/`ReleaseBuffer` before the gate opens, but call `WaveWriter::write_frames` only when
`gate.is_open()`. On queue/native/stop errors, latch `kind.stream_error()` before returning it; once
the shared gate is open, also report that same error through the generic reporter so an accepted
session terminates without waiting for user stop. Before the gate opens, return the startup error to
`start_mixed` and do not publish an accepted-session event.

Implement `cancel_handle` for WASAPI active captures by cloning their existing control signal and
requesting Cancel. This makes the Controller Stopping/Finalizing boundary work for mic, system, and
mixed without a Windows-specific branch.

- [ ] **Step 4: Run WASAPI and audio-capture tests and verify GREEN**

Run:

```text
cargo test --manifest-path app/src-tauri/Cargo.toml wasapi -- --test-threads=1
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture -- --test-threads=1
```

Expected: WASAPI single-source tests remain green; mixed uses the shared coordinator; no pre-gate
frame reaches a writer.

- [ ] **Step 5: Commit**

```text
git add app/src-tauri/src/audio_capture/wasapi.rs
git commit -m "refactor(windows): use shared mixed coordinator"
```

### Task 6: Open macOS mixed capability and enforce permission order

**Files:**
- Modify: `app/src-tauri/src/audio_capture/macos.rs:90-151,1050-1162`
- Test: `app/src-tauri/src/audio_capture/macos.rs` test module compiled as `macos_test` on Windows

- [ ] **Step 1: Replace obsolete mixed-denial tests with failing capability/order tests**

Add tests that drive fake permission and system-runtime functions without native APIs:

```rust
#[test]
fn macos_mixed_capability_is_explicit_and_requires_both_sources() {
    let available = capabilities_for_with_system(
        PermissionStatus::Authorized,
        || true,
        &FakeSystemAudioProbe::available(),
    );
    assert!(available.mixed.available);

    let no_system = capabilities_for_with_system(
        PermissionStatus::Authorized,
        || true,
        &FakeSystemAudioProbe::denied(),
    );
    assert!(!no_system.mixed.available);
    assert_eq!(no_system.mixed.reason_code, Some(RECORDING_MIX_FAILED));
}

#[test]
fn mixed_requests_microphone_before_starting_system_permission_path() {
    let calls = Mutex::new(Vec::new());
    authorize_microphone_for_mode(
        RecordingMode::Mixed,
        PermissionStatus::NotDetermined,
        || {
            calls.lock().expect("calls").push("microphone");
            true
        },
    )
    .expect("microphone granted");
    calls.lock().expect("calls").push("system");
    assert_eq!(*calls.lock().expect("calls"), vec!["microphone", "system"]);
}
```

Also test microphone denial prevents the fake system start call and returns
`RECORDING_MIC_ACCESS_DENIED` with source=`microphone`. Add
`mixed_ready_deadline_starts_after_both_permission_steps_complete` using an injected clock: advance
the clock arbitrarily during fake TCC handling, then assert the coordinator still receives a fresh
three-second Ready budget.

- [ ] **Step 2: Run portable macOS seam tests and verify RED**

Run on Windows:

```text
cargo test --manifest-path app/src-tauri/Cargo.toml macos_test -- --test-threads=1
```

Expected: new capability/order tests fail because mixed is hard-coded unavailable and
`authorize_start` rejects mixed.

- [ ] **Step 3: Implement explicit capability and microphone authorization**

Compute the source capabilities first, then construct mixed explicitly:

```rust
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
```

Replace `authorize_start` with `authorize_microphone_for_mode`: System returns `Ok(())` without
requesting microphone; Mic and Mixed perform the existing lazy microphone request. Source-tag denied
and initialization errors. The mixed backend branch must call this function before preparing or
starting the ScreenCaptureKit source.

- [ ] **Step 4: Run portable macOS tests and verify GREEN**

Run:

```text
cargo test --manifest-path app/src-tauri/Cargo.toml macos_test -- --test-threads=1
```

Expected: capability matrix and permission-order tests pass; system-only still never requests
microphone access.

- [ ] **Step 5: Commit**

```text
git add app/src-tauri/src/audio_capture/macos.rs
git commit -m "feat(macos): enable explicit mixed capability"
```

### Task 7: Adapt macOS cpal and ScreenCaptureKit workers to the shared gate

**Files:**
- Modify: `app/src-tauri/src/audio_capture/macos.rs:1050-1545`
- Modify: `app/src-tauri/src/audio_capture/mixed.rs` only if a platform-neutral prepared-source
  constructor needs visibility adjustment
- Test: `app/src-tauri/src/audio_capture/macos.rs` test module

- [ ] **Step 1: Write failing worker-seam and backend atomicity tests**

Add pure tests for the callback decision and fake runtime adapters:

```rust
#[test]
fn macos_callback_drops_pre_gate_block_and_writes_post_gate_block() {
    let gate = CaptureGate::default();
    let (tx, rx) = mpsc::sync_channel(2);
    let first_error = FirstStreamError::default();
    submit_gated_block(&gate, &tx, AudioBlock {
        bytes: vec![1, 0],
        frame_count: 1,
        silent: false,
    }, &first_error).expect("drop before gate");
    assert!(rx.try_recv().is_err());

    gate.open();
    submit_gated_block(&gate, &tx, AudioBlock {
        bytes: vec![2, 0],
        frame_count: 1,
        silent: false,
    }, &first_error).expect("submit after gate");
    assert_eq!(rx.recv().expect("post-gate block").frame_count, 1);
}

#[test]
fn macos_mixed_system_failure_cancels_microphone_without_partial_capture() {
    let backend = FakeMacosMixedBackend::system_start_failure();
    let error = backend.start_mixed().expect_err("mixed start fails atomically");
    assert_eq!(error.source, Some(RecordingSource::SystemAudio));
    assert!(backend.microphone_cancelled_and_joined());
    assert!(backend.no_source_paths_returned());
}
```

Add tests for mic runtime failure, system queue overflow, stop/failure race, cancel, existing system
recovery warning propagation, and `system_stream_config_spec().registered_outputs == [Audio]` in mixed.

- [ ] **Step 2: Run portable macOS tests and verify RED**

Run:

```text
cargo test --manifest-path app/src-tauri/Cargo.toml macos_test -- --test-threads=1
```

Expected: compilation/test failures because native workers do not accept `CaptureGate`,
`CaptureSignal`, `ReadySender`, or `FirstSourceFailure`, and mixed still returns MixFailed.

- [ ] **Step 3: Refactor source preparation without changing native capture semantics**

Change the macOS runtime seam from returning an already-active `ActiveCapture` to returning a
`PreparedSource`. Both preparation functions receive the same gate/latch and a cloned ready sender:

```rust
trait SystemAudioRuntime: Send + Sync {
    fn prepare(
        &self,
        workspace: &CaptureWorkspace,
        reporter: RecordingWarningReporter,
        gate: CaptureGate,
        ready: ReadySender,
        failures: FirstSourceFailure,
        terminal: RecordingFailureReporter,
    ) -> Result<PreparedSource, RecordingError>;
}
```

Create an equivalent private `prepare_microphone_source`. Each spawned worker owns its
`CaptureSignal`; after writer and native stream startup it sends `SourceReady { source, result:
Ok(()) }`. Setup errors send a source-tagged Err and return the same error. Callback handling becomes:

```rust
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
```

Use it in cpal callbacks and before converting system audio blocks into writer events. Do not block
either callback. Keep ScreenCaptureKit supervisor, CMSampleBuffer timing, filter update/rebuild,
2-second recovery, warning aggregation, self-audio exclusion, and Audio-only registration unchanged.
After the shared gate is open, every terminal queue/native/early-exit error must be sent once to the
generic `RecordingFailureReporter` before the worker returns. Before the gate opens, send the error
through `SourceReady`/`start_mixed` only, so permission and native initialization errors remain
`RecordingStartFailure` values.

For Mic/System single-source starts, use an opened gate and wait for that source's Ready before
returning the single-source active capture. Refactor `MacosActiveCapture` to own one
`PreparedSource`; stop requests `CaptureCommand::Stop`, joins the worker, source-tags any error, and
converts its `WavCaptureSummary` into a one-path `CapturedRecording`. Cancel requests
`CaptureCommand::Cancel`, joins, and returns no capture. This keeps the public single-source contract
unchanged after the worker return type becomes `WavCaptureSummary`.
Implement `cancel_handle` by cloning that prepared source's `CaptureSignal`; mixed uses the handle
from Task 3. Thus cpal and ScreenCaptureKit also honor cancel-over-stop before Finalizing.

For Mixed, create one closed gate/latch/channel,
prepare mic first and system second with clones of the same failure latch, then call
`mixed::start_mixed(sources, ready_rx, gate, failures, Duration::from_secs(3))`.

- [ ] **Step 4: Run all host-side Rust tests and verify GREEN**

Run on Windows:

```text
cargo test --manifest-path app/src-tauri/Cargo.toml macos_test -- --test-threads=1
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture -- --test-threads=1
cargo check --manifest-path app/src-tauri/Cargo.toml
```

Expected: all portable macOS and audio-capture tests pass; Cargo check passes. Record these as
host-side evidence only.

- [ ] **Step 5: Compile and test the native target when an Intel Mac is available**

Run on E1 with full Xcode:

```text
cargo check --manifest-path app/src-tauri/Cargo.toml
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture -- --test-threads=1
```

Expected: native cpal/ScreenCaptureKit code compiles and tests pass. If no Mac is available, leave
this checkbox unchecked and keep Issue #20 `ready-for-human`; do not emulate a Pass.

- [ ] **Step 6: Commit**

```text
git add app/src-tauri/src/audio_capture/macos.rs app/src-tauri/src/audio_capture/mixed.rs
git commit -m "feat(macos): coordinate atomic mixed capture"
```

### Task 8: Lock down finalizer and Controller no-partial-commit behavior

**Files:**
- Modify: `app/src-tauri/src/audio_capture/mixer.rs` test module
- Modify: `app/src-tauri/src/audio_capture/mod.rs` test module

- [ ] **Step 1: Write failing finalizer tests with distinct source formats**

Replace raw placeholder source bytes in the mixed success test with real WAVs: mic 44.1 kHz mono
PCM16 and system 48 kHz stereo PCM16. Assert input order and exact equal-weight filter:

```rust
assert_eq!(calls[0][1], OsString::from("-i"));
assert_eq!(calls[0][2], mic_source.as_os_str());
assert_eq!(calls[0][3], OsString::from("-i"));
assert_eq!(calls[0][4], system_source.as_os_str());
assert!(calls[0].windows(2).any(|pair| pair == [
    OsString::from("-filter_complex"),
    OsString::from(
        "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0:normalize=1[mixed]"
    ),
]));
```

Add a test where the runner returns an error and assert `RECORDING_MIX_FAILED`, no final path, and
the session temp directory remains available for Controller cleanup.

- [ ] **Step 2: Write failing Controller atomicity tests**

Add a fake backend whose `start` clock advances only after a simulated dual-ready barrier, then
assert `started_at_ms` uses the post-barrier value. Add table-driven stop failures for microphone
stream error, system stream error, Empty with each source, and mix finalization failure. For every
case assert `TrackingFileStore.cleanup_calls == 1` and `finalizer.calls == 0` for source failures.

- [ ] **Step 3: Run focused tests and verify RED where coverage exposes gaps**

Run:

```text
cargo test --manifest-path app/src-tauri/Cargo.toml mixed_source_finalization_ -- --test-threads=1
cargo test --manifest-path app/src-tauri/Cargo.toml mixed_controller_ -- --test-threads=1
```

Expected: distinct-format/order tests fail until fixtures are upgraded; any cleanup or timing gap
must fail with an explicit assertion rather than be waived.

- [ ] **Step 4: Make only the minimal Controller/finalizer corrections**

Keep production `mixer.rs` arguments unchanged unless a failing test identifies an actual defect.
Controller must continue calling `backend.start` before assigning:

```rust
started_at_ms: self.clock.now_ms(),
```

Keep operation error precedence over cleanup error:

```rust
let result = match operation_result {
    Err(error) => Err(error),
    Ok(finalized) => cleanup_result.map(|()| finalized),
};
```

Do not add a partial finalization path. If the shared coordinator returns an error, finalizer call
count must remain zero and the entire workspace must be cleaned.

- [ ] **Step 5: Run finalizer, Controller, and full audio-capture tests**

Run:

```text
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture::mixer -- --test-threads=1
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture -- --test-threads=1
```

Expected: all tests pass, including distinct source formats, exact two-input order, start timer,
failure cleanup, cancel cleanup, and no partial commit.

- [ ] **Step 6: Commit**

```text
git add app/src-tauri/src/audio_capture/mixer.rs app/src-tauri/src/audio_capture/mod.rs
git commit -m "test(recording): enforce mixed atomic finalization"
```

### Task 9: Preserve source-tagged errors and terminal state through the frontend session

**Files:**
- Modify: `app/src/recordingClient.ts:5-91,410-440`
- Modify: `app/src/recordingClient.test.ts`
- Modify: `app/src/features/workflow/useRecordingController.ts:37-64,144-164,520-650`
- Modify: `app/src/features/workflow/useRecordingController.test.ts`
- Modify: `app/src/features/workflow/RecordingCard.tsx:30-108,165-180`
- Modify: `app/src/features/workflow/RecordingCard.test.tsx`

- [ ] **Step 1: Write failing strict parser tests**

Add tests for valid source-tagged errors, source omission, and rejection of unknown sources/extra
keys:

```typescript
test("preserves a valid source-tagged command error", async () => {
  let captured: unknown;
  try {
    await stopRecording("session-1", async () => {
      throw {
        code: "RECORDING_STREAM_ERROR",
        message: "The recording stream was interrupted.",
        source: "systemAudio",
      };
    });
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(RecordingClientError);
  expect(captured).toMatchObject({
    code: "RECORDING_STREAM_ERROR",
    source: "systemAudio",
  });
});
```

Unknown `source: "display"`, non-string source, and source attached through an accessor must collapse
to `RECORDING_UNKNOWN_ERROR` under the existing defensive parser.

- [ ] **Step 2: Run client tests and verify RED**

Run:

```text
npm --prefix app test -- --run src/recordingClient.test.ts
```

Expected: valid sourced error currently collapses because `readRecordingObject` allows only code
and message, and `RecordingClientError` has no source field.

- [ ] **Step 3: Implement the strict optional source parser**

Add:

```typescript
export type RecordingSource = "microphone" | "systemAudio";

export class RecordingClientError extends Error {
  readonly code: RecordingClientErrorCode;
  readonly source?: RecordingSource;

  constructor(code: RecordingClientErrorCode, source?: RecordingSource) {
    super(code);
    this.name = "RecordingClientError";
    this.code = code;
    this.source = source;
  }
}

function isRecordingSource(value: unknown): value is RecordingSource {
  return value === "microphone" || value === "systemAudio";
}
```

In `mapRecordingCommandError`, read required `code`/`message` and optional `source`; reject the whole
object if source exists but is not closed-set. Return `new RecordingClientError(response.code,
source)`. In the existing `error instanceof RecordingClientError` branch, validate and preserve
`error.source` instead of reconstructing a code-only error.

- [ ] **Step 4: Write failing failure-view, event, state, and acknowledgement parser tests**

Define one valid fixture and assert both parsers produce the same object:

```typescript
const VALID_FAILURE: RecordingFailureView = {
  sessionId: "session-1",
  mode: "mixed",
  elapsedMs: 4321,
  errorCode: "RECORDING_STREAM_ERROR",
  source: "systemAudio",
  cleanupPending: true,
  warnings: [],
};

test("event and failed hydration share one strict failure view", async () => {
  const event = parseRecordingFailureEvent(VALID_FAILURE);
  const state = await getRecordingState(async () => ({
    status: "failed",
    ...VALID_FAILURE,
  }));
  expect(event).toEqual(VALID_FAILURE);
  expect(state).toEqual({ status: "failed", ...VALID_FAILURE });
});
```

Reject missing/extra keys, unknown status, unknown mode/source/error code, unsafe `elapsedMs`,
non-boolean `cleanupPending`, malformed warnings, accessor properties, and overlong session ids.
Add command-runner coverage for
`acknowledge_recording_failure` with exactly `{ sessionId }`.

- [ ] **Step 5: Implement the shared TypeScript contract and listener**

Add:

```typescript
export type RecordingActiveStateView = {
  sessionId: string;
  mode: RecordingMode;
  elapsedMs: number;
  warnings: RecordingWarningView[];
};

export type RecordingFailureView = {
  sessionId: string;
  mode: RecordingMode;
  elapsedMs: number;
  errorCode: RecordingClientErrorCode;
  source?: RecordingSource;
  cleanupPending: boolean;
  warnings: RecordingWarningView[];
};

export type RecordingStateView =
  | ({ status: "recording" } & RecordingActiveStateView)
  | ({ status: "failed" } & RecordingFailureView);

export type RecordingFailureListener = (
  handler: (failure: RecordingFailureView) => void,
) => Promise<() => void>;

export const listenRecordingFailures: RecordingFailureListener = async (handler) =>
  listen<unknown>("recording-failed", (event) => {
    try {
      handler(parseRecordingFailureEvent(event.payload));
    } catch {
      // Fail closed: malformed native events never enter UI state.
    }
  });
```

Use one `parseRecordingFailureView` helper for both event and failed-state parsing. Add
`acknowledgeRecordingFailure(sessionId)`, add `RECORDING_CLEANUP_IN_PROGRESS` to the closed error-code
union, and preserve the existing strict command boundary.

- [ ] **Step 6: Write failing Controller tests for immediate failure and deduplication**

Add tests named:

- `runtime_failure_event_stops_timer_and_enters_error_without_handoff`;
- `duplicate_event_stop_error_and_hydration_report_once`;
- `cleanup_completion_event_updates_pending_without_reporting_again`;
- `failed_hydration_restores_error_after_remount`;
- `failure_event_arriving_before_start_response_is_buffered_by_session_id`;
- `post_start_hydration_closes_the_start_response_race`;
- `cleanup_pending_disables_dismiss_and_restart`;
- `completed_failure_acknowledges_then_returns_idle`;
- `stale_failure_event_cannot_replace_the_current_session`;
- `process_idle_null_does_not_restore_an_old_failure`.

Keep the existing source-preservation cases: start failure from microphone, stop failure from
systemAudio, one active session, one timer, zero handoffs on failure, and no second media flow.

- [ ] **Step 7: Implement one failure reducer in `useRecordingController`**

Track the current failure identity as:

```typescript
function failureIdentity(failure: RecordingFailureView): string {
  return `${failure.sessionId}\u0000${failure.errorCode}\u0000${failure.source ?? ""}`;
}
```

One `applyRecordingFailure` function must handle event, stop error enriched from hydration, and
failed-state hydration. On the first identity it clears active session/timer/discard confirmation,
sets `session.status = "error"`, stores source/warnings/cleanupPending, clears handoff, and calls
`onError` once. A repeated identity only refreshes cleanupPending and warnings.

Subscribe to failures beside warnings. Buffer events by `sessionId` when the start promise has not
yet returned; after receiving `StartRecordingResponse`, apply a buffered failure before setting
recording state, then call `getRecordingState` once to close the event/response race. Ignore stale
events whose session id matches neither the active start response nor the retained failed session.

Expose `dismissFailure`: return without action while cleanup is pending; otherwise call
`acknowledgeRecordingFailure`, clear the matching local error, and return to idle. A new start is
disabled while pending; after cleanup it may start directly, letting the backend atomically replace
the old snapshot.

- [ ] **Step 8: Update Card copy and controls**

Extend `RecordingSessionView` with `errorSource`, `cleanupPending`, and warnings. Source-tagged stream
errors use existing microphone/system localized copy. While cleanup is pending, disable dismiss and
start and show localized copy equivalent to “安全结束录音中；若持续无法重试，请重启应用”. Once false,
enable dismiss/retry without displaying the error a second time.

- [ ] **Step 9: Run focused frontend tests and verify GREEN**

Run:

```text
npm --prefix app test -- --run src/recordingClient.test.ts src/features/workflow/useRecordingController.test.ts src/features/workflow/RecordingCard.test.tsx
```

Expected: strict parsers, event buffering, hydration, deduplication, cleanup UI, acknowledgement,
source copy, warnings, and one-session/one-handoff tests pass.

- [ ] **Step 10: Commit**

```text
git add app/src/recordingClient.ts app/src/recordingClient.test.ts app/src/features/workflow/useRecordingController.ts app/src/features/workflow/useRecordingController.test.ts app/src/features/workflow/RecordingCard.tsx app/src/features/workflow/RecordingCard.test.tsx
git commit -m "feat(recording): surface terminal recording failures"
```

### Task 10: Run full verification and record honest acceptance status

**Files:**
- Modify: `docs/adr/0005-macos-recording-backend.md`
- Modify: `docs/test-plans/macos-recording-acceptance.md`
- Modify: `docs/handoffs/studymind-macos-recording-implementation-handoff.md`
- Verify: all files changed by Tasks 1-9

- [ ] **Step 1: Run fresh full verification**

Run:

```text
cargo fmt --manifest-path app/src-tauri/Cargo.toml -- --check
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture -- --test-threads=1
cargo check --manifest-path app/src-tauri/Cargo.toml
npm --prefix app test
npm --prefix app run build
git diff --check
```

Expected: every command exits 0. Record exact Rust and frontend test counts from output; do not reuse
the historical 780-test count if the new suite differs.

- [ ] **Step 2: Review the implementation against the design**

Check each invariant directly:

```text
both native sources Ready before gate open
no callback blocks on the gate
no pre-gate frame reaches either WAV
mic.wav then system.wav, each with native format
one empty source fails mixed
one valid silent source remains valid
first confirmed source failure wins
stop and cancel signal both before join
accepted-session runtime failure emits before background cleanup completes
event, command error, and hydration share one failure identity and report once
cleanup completion updates the same failure without a second user error
cleanupPending blocks acknowledgement/start until native teardown is confirmed
startup failure returns directly without failed snapshot or terminal event
failed state survives frontend remount but not Tauri process restart
no source error reaches ffmpeg
no failed mixed session creates LocalMediaSource
ScreenCaptureKit remains Audio-only
frontend uses one session, timer, result, and handoff
```

Expected: each statement points to a production path and at least one automated test. Fix any gap
before updating evidence.

- [ ] **Step 3: Update ADR, acceptance, and handoff evidence**

Record commit SHAs and exact command outputs. In the acceptance table, add host-side implementation
evidence to M-01 through M-10 and D-06 through D-10, but leave E1/E2 runtime status Planned unless those machines actually
ran the scenario. Keep E2 Apple Silicon and E3 external-display/recovery status unchanged. State
explicitly that Windows `macos_test` coverage does not prove native cpal/SCK behavior.

- [ ] **Step 4: Perform a focused code review**

Review the full range from the design commit:

```text
git diff --check a3eef3c..HEAD
git diff --stat a3eef3c..HEAD
git log --oneline a3eef3c..HEAD
```

Expected: only Issue #20 implementation, tests, and evidence docs are present; no unrelated
refactor, diagnostic WAV, native identifiers, raw OSStatus, or device/display names were added.

- [ ] **Step 5: Commit evidence updates**

```text
git add docs/adr/0005-macos-recording-backend.md docs/test-plans/macos-recording-acceptance.md docs/handoffs/studymind-macos-recording-implementation-handoff.md
git commit -m "docs(macos): record mixed implementation evidence"
```

- [ ] **Step 6: Move Issue #20 to human validation without closing it**

After all available commands pass and the branch is ready for review, run:

```text
gh issue edit 20 --remove-label ready-for-agent --add-label ready-for-human
gh issue comment 20 --body "Shared Windows/macOS mixed coordinator implemented with atomic ready, stop, failure, and cleanup semantics. Host-side Rust/frontend verification is recorded in the acceptance plan. E1 mixed native runtime and E2 Apple Silicon validation remain pending; this issue is not closed."
```

Expected: Issue #20 remains OPEN with `ready-for-human`. If GitHub access is unavailable, report the
exact commands as the only remaining external action; do not close or relabel locally by assumption.
