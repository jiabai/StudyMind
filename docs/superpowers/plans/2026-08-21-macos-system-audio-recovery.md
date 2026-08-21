
# macOS System Audio Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Issue #21 so macOS system recording survives display/filter and default-output interruptions without changing the product meaning of “system audio”, fills recoverable gaps with timestamp-derived silence, and reports durable recovery warnings.

**Architecture:** Add a platform-neutral recovery state machine that receives owned PCM16 blocks plus CoreMedia timing and returns deterministic write/rebuild/failure actions. Keep ScreenCaptureKit delegate, display-anchor reconciliation, filter update/rebuild, and stream ownership in the macOS worker. Thread a warning reporter through the recording controller so Rust persists warning aggregates and emits best-effort Tauri events; the frontend consumes events and state/stop snapshots without estimating gaps itself.

**Tech Stack:** Rust/Tauri, ScreenCaptureKit 8.0.1, CoreMedia CMTime, existing bounded WAV writer/finalizer, TypeScript/Vitest, TDD.

---

## Repository Baseline

Worktree: D:/Github/StudyMind/.worktrees/issue-21-macos-system-audio-recovery

Branch: codex/issue-21-macos-system-audio-recovery

Approved design: docs/superpowers/specs/2026-08-21-macos-system-audio-recovery-design.md

Current facts:

- master contains Issue #18 and paused acceptance commit 04324f0.
- Frontend baseline: 75 test files / 771 tests passed.
- Rust was already 343/343 on master. The fresh worktree may fail the Tauri build script when ignored resources/python/**/* are absent. Do not commit runtime-resource junctions or alter production resource configuration to hide this environment issue.
- Do not change acceptance statuses from Partial, Blocked, or Planned merely because host-side tests pass. Native macOS F-03/F-04/F-05/E2/E3/signing evidence remains deferred.

## File Map

- Create app/src-tauri/src/audio_capture/system_audio_recovery.rs: portable timing/recovery state machine and unit tests.
- Modify app/src-tauri/src/audio_capture/mod.rs: warning code/view/accumulator/reporter, controller persistence, backend reporter plumbing, state/result contracts.
- Modify app/src-tauri/src/audio_capture/macos.rs: event queue, ScreenCaptureKit delegate, display-anchor reconciliation, filter update/rebuild, and system worker integration.
- Modify app/src-tauri/src/lib.rs: inject the Tauri warning sink during app setup.
- Modify app/src/recordingClient.ts: parse warning views in state/result and add the closed warning code/source contract.
- Modify app/src/features/workflow/useRecordingController.ts: subscribe to recording-warning, hydrate warnings from state, and carry final stop warnings.
- Modify app/src/features/workflow/RecordingCard.tsx only if the existing warning surface cannot render the approved localised recovery warning without exposing internal details.
- Modify the matching Rust and TypeScript test files listed by each task.
- Update docs/test-plans/macos-recording-acceptance.md and docs/handoffs/studymind-macos-recording-implementation-handoff.md only after implementation tests pass; keep native acceptance states unchanged.

## Task 1: Add the portable recovery state machine

**Files:**

- Create: app/src-tauri/src/audio_capture/system_audio_recovery.rs
- Modify: app/src-tauri/src/audio_capture/mod.rs to register the module
- Test: app/src-tauri/src/audio_capture/system_audio_recovery.rs

- [x] **Step 1: Write the failing tests first.**

Add tests with these exact behaviours and names:

~~~rust
#[test]
fn recovery_inserts_silence_for_a_1040ms_gap() {
    let mut recovery = SystemAudioRecovery::new(48_000, 2);
    assert_eq!(recovery.push(sample(0, 20_000_000)), vec![WriteAction::Audio]);

    let actions = recovery.push(sample(1_040_000_000, 20_000_000));

    // The presentation delta is 1,040ms; subtracting the first sample's
    // 20ms duration leaves a 1,020ms media gap.
    assert_eq!(actions, vec![
        WriteAction::Silence { frames: 48_960 },
        WriteAction::Audio,
        WriteAction::Recovered { gap_ms: 1_020 },
    ]);
}

#[test]
fn recovery_accepts_exactly_two_seconds() {
    let mut recovery = SystemAudioRecovery::new(48_000, 2);
    recovery.push(sample(0, 20_000_000));
    assert!(!recovery.push(sample(2_020_000_000, 20_000_000))
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
    assert_eq!(recovery.push(AudioSampleTiming::invalid()), vec![WriteAction::FailSource]);
    assert_eq!(recovery.push(sample(900_000, 20_000_000)), vec![WriteAction::FailSource]);
}

#[test]
fn recovery_deadline_fails_without_future_audio() {
    let mut recovery = SystemAudioRecovery::new(48_000, 2);
    recovery.push(sample(0, 20_000_000));
    assert_eq!(recovery.interrupt(10_000), vec![WriteAction::RebuildStream]);
    assert_eq!(recovery.deadline_elapsed(12_000), vec![WriteAction::FailSource]);
}

#[test]
fn stop_cancels_recovery_without_source_failure() {
    let mut recovery = SystemAudioRecovery::new(48_000, 2);
    recovery.push(sample(0, 20_000_000));
    recovery.interrupt(10_000);
    assert_eq!(recovery.stop(), vec![WriteAction::StopCleanly]);
}
~~~

The helper must construct real presentation and duration values. The initial run must fail because the API does not exist.

- [x] **Step 2: Verify RED.**

Run:

~~~powershell
cargo test --manifest-path app/src-tauri/Cargo.toml system_audio_recovery -- --test-threads=1
~~~

Expected: failure caused by the missing recovery API, not a test typo. If the failure is only the known missing-resource build script, report that environment limitation and do not edit production resource configuration.

- [x] **Step 3: Implement the minimal deterministic state machine.**

Use these concrete shapes:

~~~rust
pub(crate) const SYSTEM_RECOVERY_WINDOW_MS: u64 = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AudioSampleTiming {
    pub(crate) presentation_ns: u64,
    pub(crate) duration_ns: u64,
    pub(crate) valid: bool,
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

pub(crate) struct SystemAudioRecovery {
    sample_rate: u32,
    channels: u16,
    last_end_ns: Option<u64>,
    recovery_deadline_ms: Option<u64>,
    failed: bool,
}
~~~

push validates timing, computes next_start minus last_end, converts only a non-negative gap to frames with checked arithmetic, and emits FailSource on overflow, invalid timing, non-monotonic timing, or a gap greater than 2,000ms. interrupt(now_ms) sets one deadline and returns RebuildStream; deadline_elapsed(now_ms) fails only after the deadline; stop returns StopCleanly without converting user stop into source failure. Do not add retries, wall-clock-derived silence, or frontend dependencies.

- [x] **Step 4: Verify GREEN and regression coverage.**

Run the focused test, then:

~~~powershell
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture -- --test-threads=1
~~~

Expected: all recovery and existing audio capture tests pass.

The standalone recovery-module test passed 6/6. The full Cargo command remains
blocked in this worktree by the pre-existing missing `resources/python/**/*`
tree required by the Tauri build script; no production resource configuration
was changed.

- [ ] **Step 5: Commit.**

~~~powershell
git add app/src-tauri/src/audio_capture/system_audio_recovery.rs app/src-tauri/src/audio_capture/mod.rs
git commit -m "feat(recording): add system audio recovery state machine"
~~~

## Task 2: Add warning aggregation and controller contracts

**Files:**

- Modify: app/src-tauri/src/audio_capture/mod.rs
- Test: app/src-tauri/src/audio_capture/mod.rs

- [x] **Step 1: Write failing tests.**

Add tests named:

~~~rust
#[test]
fn warnings_accumulate_by_code_and_source() {
    // Record two 400ms recoveries; expect count=2 and total_gap_ms=800.
}

#[test]
fn warning_emitter_failure_does_not_drop_accumulator() {
    // Make the sink fail; state and stop still expose one warning.
}

#[test]
fn state_and_stop_return_recovery_warnings() {
    // The active state and finalized result carry the same aggregate.
}
~~~

Use a fake sink and the real RecordingController/fake capture path. Assert exact values: warningCode is RECORDING_SYSTEM_AUDIO_RECOVERED, source is systemAudio, and count/totalGapMs are correct.

- [x] **Step 2: Verify RED.**

~~~powershell
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture::tests::warnings_ -- --test-threads=1
~~~

Expected: failure because the warning view, accumulator, and state/result fields do not exist.

- [x] **Step 3: Implement the closed warning contract.**

Add SystemAudioRecovered to RecordingErrorCode and these serializable types:

~~~rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RecordingWarningSource {
    SystemAudio,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordingWarningView {
    pub(crate) warning_code: RecordingErrorCode,
    pub(crate) source: Option<RecordingWarningSource>,
    pub(crate) count: u32,
    pub(crate) total_gap_ms: u64,
}
~~~

Implement WarningAccumulator::record with a mutex-protected vector keyed by warning code and source. Implement a no-op test sink and a RecordingWarningReporter containing session id, accumulator, and sink. Add warnings to RecordingStateView and RecordingResult. Preserve StartRecordingResponse.warnings as the existing startup disk-warning code list. Pass the reporter through RecordingBackend::start; Windows may ignore it and macOS will use it.

- [x] **Step 4: Verify GREEN.**

~~~powershell
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture -- --test-threads=1
~~~

Expected: warning tests and existing Rust audio tests pass.

The focused Cargo command is currently blocked before test compilation by the
pre-existing missing `resources/python/**/*` tree required by the Tauri build
script; no production resource configuration was changed. Rustfmt parsing and
`git diff --check` pass for the changed files.

- [ ] **Step 5: Commit.**

~~~powershell
git add app/src-tauri/src/audio_capture/mod.rs
git commit -m "feat(recording): persist system audio recovery warnings"
~~~

## Task 3: Add the macOS stream supervisor and recovery integration

**Files:**

- Modify: app/src-tauri/src/audio_capture/macos.rs
- Modify: app/src-tauri/src/audio_capture/system_audio_recovery.rs only for adapter methods
- Test: app/src-tauri/src/audio_capture/macos.rs

- [ ] **Step 1: Write failing fake-driver tests.**

Add test-only fake stream/display drivers and tests named:

~~~rust
#[test]
fn stream_delegate_error_starts_recovery() {
    // A delegate signal makes the worker request a rebuild.
}

#[test]
fn display_anchor_change_updates_filter_before_rebuild() {
    // A successful update avoids rebuild and source failure.
}

#[test]
fn filter_update_failure_rebuilds_audio_only_stream() {
    // An update failure rebuilds with only Audio output.
}

#[test]
fn rebuild_failure_maps_to_system_stream_error() {
    // No replacement stream survives; return the stable source error.
}

#[test]
fn display_anchor_change_does_not_change_user_source() {
    // The source remains systemAudio and no mic/screen handler is registered.
}
~~~

The fake driver records calls and registered output types. Assert Audio is the only output and display ids never appear in warning/source selection.

- [ ] **Step 2: Verify RED.**

~~~powershell
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture::macos_test -- --test-threads=1
~~~

Expected: failures because delegate, factory seam, and reconciliation loop do not exist.

- [ ] **Step 3: Implement the native stream seam.**

Add a native-only SystemStreamFactory/SystemStreamHandle seam around:

~~~rust
SCStream::new_with_delegate(&filter, &config, delegate)
stream.add_output_handler(audio_handler, SCStreamOutputType::Audio)
stream.update_content_filter(&filter)
stream.start_capture()
stream.stop_capture()
~~~

The delegate sends a bounded StreamInterrupted signal to the worker. The output handler sends owned PCM16 data plus presentation timestamp and sample duration without blocking. Queue overflow stores the existing first stream error and fails closed.

- [ ] **Step 4: Implement display-anchor reconciliation and bounded recovery.**

In run_system_capture_worker:

1. Keep the current technical display anchor and existing audio-only configuration.
2. Poll shareable display topology in the worker loop every 250ms and compare only the technical display id.
3. On anchor change or delegate interruption, call update_content_filter first. If it fails, stop/drop the current stream, build the same configuration, register only Audio, and start it.
4. Pass recovered timing to SystemAudioRecovery; write Silence blocks before recovered audio and call the warning reporter for Recovered.
5. At the monotonic deadline, fail with RECORDING_STREAM_ERROR and source systemAudio. User stop/cancel exits without turning unfinished recovery into source failure.
6. Ensure every old stream is stopped/dropped before replacement. Keep one writer and one active callback set.

- [ ] **Step 5: Verify GREEN.**

~~~powershell
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture::macos_test -- --test-threads=1
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture -- --test-threads=1
~~~

Expected: fake supervisor, recovery, and existing system lifecycle tests pass. Windows host results are not macOS native acceptance.

- [ ] **Step 6: Commit.**

~~~powershell
git add app/src-tauri/src/audio_capture/macos.rs app/src-tauri/src/audio_capture/system_audio_recovery.rs
git commit -m "feat(recording): recover macOS system audio streams"
~~~

## Task 4: Inject the Tauri warning event sink

**Files:**

- Modify: app/src-tauri/src/audio_capture/mod.rs
- Modify: app/src-tauri/src/lib.rs
- Test: app/src-tauri/src/audio_capture/mod.rs

- [ ] **Step 1: Write a failing event payload test.**

Record one event with a fake sink and assert:

~~~rust
assert_eq!(event.session_id, "session-1");
assert_eq!(event.warning_code, RecordingErrorCode::SystemAudioRecovered);
assert_eq!(event.source, Some(RecordingWarningSource::SystemAudio));
assert_eq!(event.count, 1);
assert_eq!(event.total_gap_ms, 1_040);
~~~

Also assert a sink error does not change the accumulator or fail active capture.

- [ ] **Step 2: Verify RED.**

~~~powershell
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture::tests::warning_ -- --test-threads=1
~~~

Expected: failure because the Tauri sink/event adapter does not exist.

- [ ] **Step 3: Implement the Tauri sink and setup injection.**

Use Tauri's Emitter trait and fixed event name recording-warning. Serialize only RecordingWarningEvent; never include OSStatus, error text, device name, display id, paths, or audio data. Change setup to inject app.handle().clone() through RecordingController::from_runtime_paths. Unit tests use NoopWarningSink.

- [ ] **Step 4: Verify GREEN and commit.**

~~~powershell
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture -- --test-threads=1
git add app/src-tauri/src/audio_capture/mod.rs app/src-tauri/src/lib.rs
git commit -m "feat(recording): emit system audio recovery warnings"
~~~

## Task 5: Extend the TypeScript contract and controller hydration

**Files:**

- Modify: app/src/recordingClient.ts
- Modify: app/src/features/workflow/useRecordingController.ts
- Test: app/src/recordingClient.test.ts
- Test: app/src/features/workflow/useRecordingController.test.ts
- Test: app/src/features/workflow/RecordingCard.test.tsx if presentation needs coverage

- [ ] **Step 1: Write failing parser and controller tests.**

Add tests named:

~~~ts
it("parses bounded recovery warnings in state and stop responses", async () => {
  // Assert warningCode, source, count, and totalGapMs are preserved.
});

it("rejects unknown warning sources and unsafe warning counters", async () => {
  // Reject display ids, negative values, and oversized values.
});

it("accepts only recovery events for the active session", async () => {
  // An event for another session does not change warning state.
});

it("hydrates missed recovery warnings from getRecordingState", async () => {
  // Mount with state warnings and assert the recording view exposes them.
});

it("keeps recording active after a recovery warning", async () => {
  // Emit a current-session warning and assert status remains recording.
});
~~~

The initial run must fail because warning view/state/result parsing and the event dependency do not exist.

- [ ] **Step 2: Verify RED.**

~~~powershell
npm --prefix app test -- --run src/recordingClient.test.ts src/features/workflow/useRecordingController.test.ts
~~~

Expected: failures only for the new warning contract/event behaviours.

- [ ] **Step 3: Implement closed parsing and event hydration.**

Add:

~~~ts
export type RecordingWarningSource = "systemAudio";

export type RecordingWarningView = {
  warningCode: "RECORDING_SYSTEM_AUDIO_RECOVERED";
  source: RecordingWarningSource;
  count: number;
  totalGapMs: number;
};
~~~

Extend RecordingStateView and RecordingResult with warnings. Update the closed code list and validate safe unsigned integer bounds. Add an injectable listenRecordingWarning dependency so tests do not import Tauri event globals; production wraps listen("recording-warning", handler) and returns an unlisten function.

On mount, call getRecordingState when provided and hydrate only an active session. On event, filter by activeSessionId, update RecordingSessionView.warnings and warningCode without changing status, and unlisten on unmount/session end. On stop, use result warnings as the final snapshot before handoff.

- [ ] **Step 4: Verify GREEN.**

~~~powershell
npm --prefix app test -- --run src/recordingClient.test.ts src/features/workflow/useRecordingController.test.ts src/features/workflow/RecordingCard.test.tsx
~~~

Expected: all new and existing recording tests pass.

- [ ] **Step 5: Commit.**

~~~powershell
git add app/src/recordingClient.ts app/src/recordingClient.test.ts app/src/features/workflow/useRecordingController.ts app/src/features/workflow/useRecordingController.test.ts app/src/features/workflow/RecordingCard.test.tsx
git commit -m "feat(recording): surface system audio recovery warnings"
~~~

## Task 6: Update acceptance documentation

**Files:**

- Modify: docs/test-plans/macos-recording-acceptance.md
- Modify: docs/handoffs/studymind-macos-recording-implementation-handoff.md

- [ ] **Step 1: Add implementation evidence only.**

Record portable recovery, warning contract, stream supervisor seam, and frontend tests as host-side evidence. Keep F-03 Partial, F-04/F-05 Blocked, E2/E3 Planned, C-06 Partial, and B-03/B-04 Blocked until native evidence exists.

- [ ] **Step 2: Add the deferred native checklist.**

List default-output switching, display topology/filter rebuild, <=2s timestamp-derived silence, >2s failure, warning persistence, E2/E3, C-06, Developer ID, notarization, and real .app restart/TCC as pending. Do not mark these Pass from Windows tests.

- [ ] **Step 3: Verify docs.**

~~~powershell
git diff --check
rg -n "F-03|F-04|F-05|RECORDING_SYSTEM_AUDIO_RECOVERED|E2|E3|Developer ID|暂缓|Partial|Blocked|Planned" docs/test-plans/macos-recording-acceptance.md docs/handoffs/studymind-macos-recording-implementation-handoff.md
~~~

Expected: deferred states and the recovery contract are visible, with no host-test/native-Pass conflation.

- [ ] **Step 4: Commit docs.**

~~~powershell
git add docs/test-plans/macos-recording-acceptance.md docs/handoffs/studymind-macos-recording-implementation-handoff.md
git commit -m "docs(macos): record system audio recovery implementation"
~~~

## Task 7: Final verification and handoff

- [ ] **Step 1: Run focused tests.**

~~~powershell
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture -- --test-threads=1
npm --prefix app test -- --run src/recordingClient.test.ts src/features/workflow/useRecordingController.test.ts src/features/workflow/RecordingCard.test.tsx
~~~

Expected: all focused tests pass. If Rust is blocked by missing ignored resources, report the exact limitation and retain the verified master baseline; do not change production resource declarations.

- [ ] **Step 2: Run project checks once.**

~~~powershell
cargo check --manifest-path app/src-tauri/Cargo.toml
npm --prefix app run build
git diff --check
~~~

Expected: Rust check, TypeScript/Vite build, and diff check pass. macOS native compilation remains explicitly unclaimed on Windows.

- [ ] **Step 3: Inspect final state.**

~~~powershell
git status --short
git log --oneline --decorate -12
~~~

Expected: only intended Issue #21 commits are present; no generated runtime resources or user files are tracked.

- [ ] **Step 4: Prepare handoff.**

Report the branch, commits, tests, resource-environment limitation, and deferred native acceptance items. Do not merge or push without a separate user instruction.
