# macOS System Audio Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver GitHub Issue #18 so macOS 13+ can create a system-only `RecordingSession`, capture global system audio through ScreenCaptureKit, and hand a normalized WAV to the existing local-media pipeline.

**Architecture:** Extend the existing macOS backend in `audio_capture/macos.rs`; keep `RecordingController`, `ActiveCapture`, app-local workspaces, `WaveWriter`, the ffmpeg finalizer, and `LocalMediaSource` unchanged as the integration seams. ScreenCaptureKit objects and callbacks remain confined to a dedicated native worker; the callback converts audio buffers into owned PCM blocks and sends them through a bounded queue to a writer thread. The initial main-display `SCContentFilter` is a technical entry point only: no display identity or video output crosses the system-audio boundary.

**Tech Stack:** Rust/Tauri 2, `screencapturekit` 8 with `macos_13_0`, ScreenCaptureKit `SCStream`/`SCContentFilter`, existing `WaveWriter` and `FfmpegRecordingFinalizer`, React/Vitest, macOS x86_64/arm64 CI.

---

## Scope and non-goals

- Implement `RecordingMode::System` only.
- Do not implement mixed orchestration; Issue #20 owns the dual-source `RecordingSession`.
- Add an explicit `mixed` capability to the Rust/TypeScript capability contract. macOS reports it unavailable throughout #18; #20 is the only ticket allowed to enable it. Windows derives it from its two implemented sources so existing behavior does not regress.
- Do not implement permission lifecycle/fallback; Issue #19 owns revoke, re-probe, restart, and settings-return behavior.
- Do not implement interruption recovery or default-output/display-change recovery; Issue #21 and acceptance tasks own those scenarios.
- Keep the product meaning of `system` as capturable global macOS system audio. “Main display audio” is prohibited in UI, capability reasons, errors, logs, and result metadata.
- Keep ScreenCaptureKit audio-only fail-closed: never register a screen output, never write or forward video sample buffers, and fail the active session if a video buffer reaches the adapter.
- E1 probe output is prior feasibility evidence only. Add injectable automated tests for product behavior; do not treat the probe as a unit-test replacement.

## Files and responsibilities

- Modify `app/src-tauri/Cargo.toml` and `app/src-tauri/Cargo.lock` — add the macOS-only ScreenCaptureKit binding and lock the resolved dependency.
- Modify `app/src-tauri/src/audio_capture/macos.rs` — add ScreenCaptureKit capability probing, permission/start mapping, audio-only stream configuration, PCM conversion, bounded writer lifecycle, and injectable tests.
- Modify `app/src-tauri/src/audio_capture/mod.rs` only where the shared backend seam or controller tests need system-source coverage; preserve the existing `RecordingBackend`, `ActiveCapture`, finalizer, and cleanup contracts.
- Modify `app/src/recordingClient.ts` and `app/src/recordingClient.test.ts` — parse the explicit `mixed` capability and reject incomplete payloads.
- Modify `app/src/features/workflow/useRecordingController.ts` and `app/src/features/workflow/useRecordingController.test.ts` — gate mixed mode on the explicit capability instead of inferring it from mic + system.
- Modify `app/src-tauri/Info.plist` — declare the Screen Recording purpose string and explicitly state that only audio is saved.
- Modify `.github/workflows/desktop-release.yml` — verify the merged `NSScreenCaptureUsageDescription` in both x86_64 and arm64 app bundles; keep native `audio_capture` tests and `cargo check` before packaging.
- Modify `app/src/features/workflow/useRecordingController.test.ts` and, only if a real compatibility defect appears, its production controller — cover a macOS capability payload where system is available and mic is not requested for system start.
- Modify `docs/design-docs/02-audio-recording-design.md` — replace stale “mic awaiting native verification” wording and record the #18/#19/#20/#21 scope split.
- Modify `docs/adr/0005-macos-recording-backend.md` — replace the derived mixed-mode rule with the approved explicit rollout gate.
- Modify `docs/test-plans/macos-recording-acceptance.md` — backfill only the E1 system evidence that is actually executed; keep F-03/F-04/F-05, E2/E3, packaging, and recovery pending.

## Implementation tasks

### Task 1: Add the explicit mixed-mode capability gate

**Files:**

- Modify: `app/src-tauri/src/audio_capture/mod.rs`
- Modify: `app/src-tauri/src/audio_capture/wasapi.rs`
- Modify: `app/src-tauri/src/audio_capture/macos.rs`
- Modify: `app/src/recordingClient.ts`
- Modify: `app/src/recordingClient.test.ts`
- Modify: `app/src/features/workflow/useRecordingController.ts`
- Modify: `app/src/features/workflow/useRecordingController.test.ts`
- Modify: `docs/adr/0005-macos-recording-backend.md`

- [ ] Write failing Rust tests proving every capability payload contains an explicit `mixed` field, Windows reports it available only when both implemented sources are available, and macOS #18 reports it unavailable with `RECORDING_MIX_FAILED` even when mic and system are individually available.
- [ ] Write failing TypeScript tests proving the parser rejects a payload without `mixed` and `isModeAvailable("mixed")` reads only `capabilities.mixed.available`.
- [ ] Verify RED:

```bash
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture
npm --prefix app test -- --run src/recordingClient.test.ts src/features/workflow/useRecordingController.test.ts
```

- [ ] Add the explicit capability:

```rust
pub(crate) struct RecordingCapabilities {
    pub(crate) platform: RecordingPlatform,
    pub(crate) microphone: RecordingSourceCapability,
    pub(crate) system_audio: RecordingSourceCapability,
    pub(crate) mixed: RecordingSourceCapability,
}
```

```ts
export type RecordingCapabilities = {
  platform: "windows" | "macos" | "unsupported";
  microphone: RecordingSourceCapability;
  systemAudio: RecordingSourceCapability;
  mixed: RecordingSourceCapability;
};
```

- [ ] Update `validate_mode` so `RecordingMode::Mixed` also requires `capabilities.mixed.available`; keep source-specific errors first, then return the mixed capability reason when both sources are individually available but orchestration is not implemented.
- [ ] Update ADR 0005 to record that mixed availability is explicit during staged delivery: #18 keeps it unavailable, #20 enables it after dual-source readiness/atomicity is implemented.
- [ ] Verify GREEN with the same Rust and TypeScript commands, then run `git diff --check`.
- [ ] Commit: `feat(recording): gate mixed mode explicitly`

### Task 2: Add the ScreenCaptureKit dependency and a compile-only native probe

**Files:**

- Modify: `app/src-tauri/Cargo.toml`
- Modify: `app/src-tauri/Cargo.lock`
- Test: `app/src-tauri/src/audio_capture/macos.rs`

- [ ] Add the target-only dependency:

```toml
[target.'cfg(target_os = "macos")'.dependencies]
screencapturekit = { version = "8", features = ["macos_13_0"] }
```

- [ ] Keep the dependency behind `cfg(target_os = "macos")`; Windows and unsupported platforms must not acquire ScreenCaptureKit symbols.
- [ ] Add the smallest native compile probe in `macos.rs`: import the crate types needed for shareable-content enumeration, content-filter construction, stream configuration, audio output registration, and stream start/stop. The probe must not start a stream or request permission.
- [ ] Run on a macOS host:

```bash
cargo check --manifest-path app/src-tauri/Cargo.toml --target x86_64-apple-darwin
```

Expected: the `cfg(target_os = "macos")` branch compiles against the installed Apple SDK without changing Windows behavior.

- [ ] Commit: `build(macos): add ScreenCaptureKit dependency`

### Task 3: Define the system capability and permission seams test-first

**Files:**

- Modify: `app/src-tauri/src/audio_capture/macos.rs`
- Test: `app/src-tauri/src/audio_capture/macos.rs`

- [ ] Introduce narrow injectable seams for:

```rust
trait SystemAudioProbe {
    fn probe(&self) -> Result<SystemAudioAvailability, RecordingError>;
}

trait SystemAudioRuntime {
    fn start(
        &self,
        workspace: &CaptureWorkspace,
    ) -> Result<Box<dyn ActiveCapture>, RecordingError>;
}
```

The production implementation may use ScreenCaptureKit directly, but tests must be able to return authorization denial, no shareable display, initialization failure, and a valid capability without Apple runtime state.

- [ ] Add failing tests with these exact behaviors:

```rust
#[test]
fn system_capability_probe_never_requests_permission() {}

#[test]
fn system_capability_maps_screen_recording_denial_to_unavailable() {}

#[test]
fn system_capability_requires_macos_13_and_a_shareable_display() {}

#[test]
fn system_start_does_not_request_microphone_permission() {}

#[test]
fn system_start_redacts_native_errors_to_stable_codes() {}
```

- [ ] Implement capability probing so `capabilities()` is side-effect free. `NotDetermined`/denied Screen Recording state must not cause an unsolicited prompt; start-time authorization and runtime setup errors map to `RECORDING_SYSTEM_AUDIO_UNAVAILABLE` or `RECORDING_SYSTEM_LOOPBACK_INIT_FAILED` according to the existing error contract.
- [ ] Preserve existing mic behavior: `start(Mic)` continues to request only microphone permission; `start(System)` never calls the microphone permission bridge.
- [ ] Run:

```bash
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture::macos_test
```

Expected: capability and permission-seam tests pass without requiring a real TCC state.

- [ ] Commit: `test(recording): define macOS system audio capability seams`

### Task 4: Build the audio-only ScreenCaptureKit stream adapter

**Files:**

- Modify: `app/src-tauri/src/audio_capture/macos.rs`
- Test: `app/src-tauri/src/audio_capture/macos.rs`

- [ ] Add a stream-configuration builder with these invariants:

```rust
assert!(configuration.captures_audio);
assert!(configuration.excludes_current_process_audio);
assert_eq!(registered_outputs, [SCStreamOutputType::Audio]);
assert!(registered_outputs.iter().all(|output| *output != SCStreamOutputType::Screen));
```

- [ ] Build the initial `SCContentFilter` from the current main display only as the API entry point. Do not expose, persist, log, or serialize its display ID, name, bounds, or selection as a recording source.
- [ ] Configure a stable audio sample rate and channel layout accepted by the selected ScreenCaptureKit API, then construct a temporary PCM16 `WaveFormat` from the negotiated values. The existing finalizer remains responsible for 16 kHz/mono/16-bit normalization.
- [ ] Register only the audio output callback. If the binding reports a video sample buffer at any adapter boundary, record the first source error as `RECORDING_STREAM_ERROR`, stop the stream, and prevent finalization.
- [ ] Add deterministic tests:

```rust
#[test]
fn system_stream_config_is_audio_only_and_excludes_current_process() {}

#[test]
fn main_display_filter_is_not_a_user_visible_source() {}

#[test]
fn video_buffer_is_fail_closed_and_never_reaches_writer() {}

#[test]
fn audio_sample_buffers_become_owned_pcm16_blocks() {}
```

- [ ] Commit: `feat(recording): configure macOS system audio-only stream`

### Task 5: Add bounded PCM writing and system capture lifecycle

**Files:**

- Modify: `app/src-tauri/src/audio_capture/macos.rs`
- Modify: `app/src-tauri/src/audio_capture/mod.rs` only if controller seam coverage requires it
- Test: `app/src-tauri/src/audio_capture/macos.rs`

- [ ] Use the same lifecycle shape as the mic backend: the native stream stays in its worker, the callback performs no disk I/O, and a bounded queue transfers owned PCM blocks to a writer thread.
- [ ] Preserve first-error priority over normal stop. Queue full/disconnected, callback failure, stream start failure, writer failure, and adapter video input must terminate the source with `RECORDING_STREAM_ERROR` or the specific stable initialization error.
- [ ] On stop, stop the stream, close the sender, drain queued blocks, finish one temporary WAV, and return `CapturedRecording` with the correct frame count and silent/empty summary.
- [ ] On cancel or any setup/runtime failure, join the worker and writer and leave no system WAV in the session temp directory.
- [ ] Add tests:

```rust
#[test]
fn system_start_stop_returns_one_captured_recording() {}

#[test]
fn system_stop_drains_blocks_and_preserves_silent_recordings() {}

#[test]
fn system_empty_capture_returns_recording_empty() {}

#[test]
fn system_cancel_leaves_no_temporary_wav() {}

#[test]
fn system_queue_overflow_maps_to_stream_error_without_blocking() {}

#[test]
fn system_runtime_error_wins_over_concurrent_stop() {}
```

- [ ] Run:

```bash
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture
```

Expected: all platform-appropriate capture, writer, cleanup, and finalizer tests pass.

- [ ] Commit: `feat(recording): deliver macOS system audio lifecycle`

### Task 6: Wire system mode through the existing controller and finalizer

**Files:**

- Modify: `app/src-tauri/src/audio_capture/macos.rs`
- Modify: `app/src-tauri/src/audio_capture/mod.rs` only for shared controller tests
- Test: `app/src-tauri/src/audio_capture/mod.rs`
- Test: `app/src/features/workflow/useRecordingController.test.ts`

- [ ] Make `MacosRecordingBackend::capabilities()` report `system_audio.available` only when the macOS version, Screen Recording capability, shareable content, and required audio-only runtime prerequisites are valid.
- [ ] Route `RecordingMode::System` through the ScreenCaptureKit adapter and preserve the existing `RecordingController::start/stop/cancel` state machine, app-local workspace cleanup, finalizer invocation, and `LocalMediaSource` result shape.
- [ ] Keep `RecordingMode::Mixed` owned by Issue #20. Assert the explicit macOS mixed capability remains unavailable while system mode is enabled, so #18 cannot expose an unimplemented mode.
- [ ] Add controller tests for system start/stop/cancel, system capability rejection, empty capture, and redacted error payloads. Do not add a second Tauri command or Worker contract.
- [ ] Add frontend tests proving a macOS capability payload with system audio available selects/enables `system`, does not request microphone permission for system start, and preserves the existing `RecordingResult` handoff.
- [ ] Run:

```bash
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture
npm --prefix app test -- --run src/features/workflow/useRecordingController.test.ts
```

- [ ] Commit: `feat(recording): wire macOS system audio into RecordingSession`

### Task 7: Add Screen Recording metadata and native CI gates

**Files:**

- Modify: `app/src-tauri/Info.plist`
- Modify: `.github/workflows/desktop-release.yml`
- Test: `.github/workflows/desktop-release.yml`

- [ ] Add:

```xml
<key>NSScreenCaptureUsageDescription</key>
<string>StudyMind records system audio for local transcription and study notes. Screen content is not saved.</string>
```

- [ ] In both macOS release jobs, verify the merged app bundle contains exactly that purpose string before codesign verification.
- [ ] Keep native `cargo test ... audio_capture` and `cargo check` before bundle creation for both `x86_64-apple-darwin` and `aarch64-apple-darwin`.
- [ ] Run the workflow syntax/configuration checks available on the development host. Native package and TCC behavior remain macOS acceptance tasks.
- [ ] Commit: `build(macos): declare system audio permission usage`

### Task 8: Update product and acceptance documentation

**Files:**

- Modify: `docs/design-docs/02-audio-recording-design.md`
- Modify: `docs/test-plans/macos-recording-acceptance.md`

- [ ] Replace the stale status text that says mic native verification is pending. State that #17 E1 mic acceptance is complete, #18 system implementation is the current implementation slice, and #19/#20/#21 own permission lifecycle, mixed, and recovery.
- [ ] Record the product wording: Screen Recording permission is required to capture system audio, but the product saves no screen video and the main display is not the recording scope.
- [ ] Backfill only executed #18 evidence. Mark system start/stop/cancel, TCC behavior, audio-only configuration, global audio capture, and self-audio exclusion `Pass` only with reproducible E1 evidence. Keep F-03/F-04/F-05, E2/E3, package signing, and recovery as `Blocked`/`Planned`.
- [ ] Explicitly distinguish native automated tests from the E1 feasibility probe; the probe cannot replace product unit tests.
- [ ] Run:

```bash
rg -n "system audio|ScreenCaptureKit|NSScreenCaptureUsageDescription|F-03|F-04|F-05|E2|E3|#18|#19|#20|#21" docs/design-docs/02-audio-recording-design.md docs/test-plans/macos-recording-acceptance.md
git diff --check
```

- [ ] Commit: `docs(macos): align system audio implementation and acceptance gates`

### Task 9: Verify and hand off without claiming full macOS acceptance

**Files:**

- Modify: `docs/handoffs/studymind-macos-recording-implementation-handoff.md`
- Modify: `docs/test-plans/macos-recording-acceptance.md`

- [ ] On a macOS host with E1 conditions, run:

```bash
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture
cargo check --manifest-path app/src-tauri/Cargo.toml
npm --prefix app test
npm --prefix app run build
```

- [ ] Run the manual E1 system checks: play audio from two independent applications, verify both sources are captured, play StudyMind audio and verify it is excluded, confirm no video buffer reaches the writer, stop/cancel, inspect the final WAV with `ffprobe`, and record the exact commit/toolchain/SDK.
- [ ] Do not claim default-output changes, display changes, stream interruption recovery, Apple Silicon, or signed/notarized package acceptance without their environments.
- [ ] Update the handoff with the exact native test count and evidence paths, then run `git diff --check` and the repository’s required checks before committing.
- [ ] Commit: `docs(macos): hand off system audio verification results`

## Spec coverage checklist

| Issue #18 requirement | Plan coverage |
|---|---|
| explicit staged gate keeps mixed unavailable until #20 | Task 1 |
| macOS 13+ capability and Screen Recording TCC | Tasks 2–3, 6–7 |
| audio-only `SCStream`, no video output/propagation | Task 4 |
| main display is only a technical filter entry | Task 4 |
| global audio from at least two applications | Task 9 manual E1 check |
| exclude StudyMind process audio | Tasks 4, 9 |
| start/stop/cancel and existing LocalMediaSource handoff | Tasks 5–6 |
| stable, redacted errors | Tasks 3, 5–6 |
| no microphone permission for system mode | Tasks 3, 6 |
| injectable automated tests | Tasks 3–6 |

The plan intentionally leaves Apple Silicon, external-display/default-output changes, interruption recovery, and package signing as later acceptance work. Those items do not become `Pass` merely because the system backend is implemented on E1.
