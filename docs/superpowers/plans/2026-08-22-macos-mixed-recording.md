# macOS Mixed Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one atomic microphone + system-audio `RecordingSession` on macOS and migrate Windows mixed capture to the same ready-gate, failure, stop, cancel, and cleanup semantics.

**Architecture:** Add a platform-neutral `audio_capture/mixed.rs` coordinator whose prepared source workers share a non-blocking capture gate, a broadcastable control signal, and a first-source-failure latch. WASAPI, cpal, and ScreenCaptureKit remain platform adapters; they preserve native WAV formats and hand exactly two successful summaries to the existing equal-weight ffmpeg finalizer. Rust and TypeScript IPC gain optional closed-set source metadata without adding new error codes or a second frontend media flow.

**Tech Stack:** Rust, Tauri, std threads/channels/atomics, WASAPI, cpal/CoreAudio, ScreenCaptureKit, hound-style project WAV writer, ffmpeg, React, TypeScript, Vitest.

---

## Execution prerequisite

Execute this plan in an isolated worktree/branch such as `codex/macos-mixed-recording`, based on the
latest `master`. The design commit `a3eef3c` must be present. Do not mark E1/E2/E3 runtime rows Pass
from Windows-host tests.

## File responsibility map

- `app/src-tauri/src/audio_capture/mixed.rs`: platform-neutral gate, control signal, source-ready
  protocol, first-failure latch, startup barrier, `MixedActiveCapture`, and deterministic fake tests.
- `app/src-tauri/src/audio_capture/mod.rs`: stable `RecordingSource`, optional error source metadata,
  module wiring, and Controller cleanup/error-precedence tests.
- `app/src-tauri/src/audio_capture/wasapi.rs`: WASAPI source preparation and callback-side gate;
  single-source behavior remains local while mixed delegates lifecycle to `mixed.rs`.
- `app/src-tauri/src/audio_capture/macos.rs`: explicit mixed capability, permission order, cpal and
  ScreenCaptureKit prepared-source adapters, and existing system recovery integration.
- `app/src-tauri/src/audio_capture/mixer.rs`: exact two-input/fixed-order and different-format
  finalizer coverage; production equal-weight arguments remain unchanged.
- `app/src/recordingClient.ts`: strict optional `source` parsing on command errors.
- `app/src/features/workflow/useRecordingController.ts`: preserve source on session errors while
  retaining one session/timer/handoff.
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

Also add `mixed_start_timeout_cancels_and_joins_both_sources` and
`mixed_start_rejects_duplicate_source_identity` so malformed adapters cannot produce two mic inputs.

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
        self.0.store(command as u8, Ordering::Release);
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

- [ ] **Step 4: Run all mixed tests and verify GREEN**

Run:

```text
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture::mixed -- --test-threads=1
```

Expected: startup, stop, empty/silent, failure-priority, and cancel tests all pass.

- [ ] **Step 5: Commit**

```text
git add app/src-tauri/src/audio_capture/mixed.rs
git commit -m "feat(recording): make mixed stop and cleanup atomic"
```

### Task 4: Migrate Windows WASAPI mixed capture to the coordinator

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
order and asserts final paths remain mic then system.

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

Change `run_source_worker` and `capture_packets` to receive `CaptureSignal`, `CaptureGate`, and
`FirstSourceFailure`. After `IAudioClient::Start`, send `SourceReady`. Continue calling
`GetBuffer`/`ReleaseBuffer` before the gate opens, but call `WaveWriter::write_frames` only when
`gate.is_open()`. On queue/native/stop errors, latch `kind.stream_error()` before returning it.

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

### Task 5: Open macOS mixed capability and enforce permission order

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
`RECORDING_MIC_ACCESS_DENIED` with source=`microphone`.

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

### Task 6: Adapt macOS cpal and ScreenCaptureKit workers to the shared gate

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

For Mic/System single-source starts, use an opened gate and wait for that source's Ready before
returning the single-source active capture. Refactor `MacosActiveCapture` to own one
`PreparedSource`; stop requests `CaptureCommand::Stop`, joins the worker, source-tags any error, and
converts its `WavCaptureSummary` into a one-path `CapturedRecording`. Cancel requests
`CaptureCommand::Cancel`, joins, and returns no capture. This keeps the public single-source contract
unchanged after the worker return type becomes `WavCaptureSummary`.

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

### Task 7: Lock down finalizer and Controller no-partial-commit behavior

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

### Task 8: Preserve source-tagged errors through the frontend session

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

- [ ] **Step 4: Write failing controller/Card tests for source preservation and one flow**

Add one test where `startRecording("mixed")` rejects with microphone source and one where
`stopRecording` rejects with systemAudio source. Assert `session.errorCode`, `session.errorSource`,
one start call, one active session, one stop call, zero local-media handoffs, and no second timer.
Add Card render assertions that source-tagged stream errors choose the existing microphone/system
localized keys.

- [ ] **Step 5: Implement source-aware session errors without changing callbacks**

Extend `RecordingSessionView`:

```typescript
export type RecordingSessionView = {
  status: RecordingSessionStatus;
  errorCode?: RecordingControllerErrorCode;
  errorSource?: RecordingSource;
  warningCode?: RecordingControllerErrorCode;
  warnings?: RecordingWarningView[];
};
```

Add one internal failure shape and replace code-only extraction with a helper returning both fields:

```typescript
type StableRecordingFailure = {
  errorCode: RecordingControllerErrorCode;
  errorSource?: RecordingSource;
};

function stableRecordingFailure(
  error: unknown,
  fallback: RecordingControllerErrorCode,
): StableRecordingFailure {
  if (error instanceof RecordingClientError) {
    return { errorCode: error.code, errorSource: error.source };
  }
  return { errorCode: stableErrorCode(error, fallback) };
}
```

Use it in start/stop/cancel catch
paths, and continue invoking `onError(errorCode)` unchanged. Update `errorCopyKey` to accept optional
source; for `RECORDING_STREAM_ERROR`, map microphone to `microphoneUnavailable`, systemAudio to
`systemUnavailable`, and no source to the existing generic stream key.

- [ ] **Step 6: Run focused frontend tests and verify GREEN**

Run:

```text
npm --prefix app test -- --run src/recordingClient.test.ts src/features/workflow/useRecordingController.test.ts src/features/workflow/RecordingCard.test.tsx
```

Expected: parser, controller, and Card tests pass; warnings/hydration tests remain green; mixed uses
one session and one handoff.

- [ ] **Step 7: Commit**

```text
git add app/src/recordingClient.ts app/src/recordingClient.test.ts app/src/features/workflow/useRecordingController.ts app/src/features/workflow/useRecordingController.test.ts app/src/features/workflow/RecordingCard.tsx app/src/features/workflow/RecordingCard.test.tsx
git commit -m "feat(recording): explain mixed source failures"
```

### Task 9: Run full verification and record honest acceptance status

**Files:**
- Modify: `docs/adr/0005-macos-recording-backend.md`
- Modify: `docs/test-plans/macos-recording-acceptance.md`
- Modify: `docs/handoffs/studymind-macos-recording-implementation-handoff.md`
- Verify: all files changed by Tasks 1-8

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
no source error reaches ffmpeg
no failed mixed session creates LocalMediaSource
ScreenCaptureKit remains Audio-only
frontend uses one session, timer, result, and handoff
```

Expected: each statement points to a production path and at least one automated test. Fix any gap
before updating evidence.

- [ ] **Step 3: Update ADR, acceptance, and handoff evidence**

Record commit SHAs and exact command outputs. In the acceptance table, add host-side implementation
evidence to M-01 through M-07, but leave E1/E2 runtime status Planned unless those machines actually
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
