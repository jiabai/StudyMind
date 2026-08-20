# macOS Microphone RecordingSession Implementation Plan

> **For Codex:** Execute task-by-task with TDD. Do not implement ScreenCaptureKit system audio or mixed recording in this ticket.

**Goal:** Deliver GitHub Issue #17 so macOS 12+ can create a microphone-only `RecordingSession` through the existing controller and hand a normalized WAV to the local-media pipeline.

**Architecture:** Keep `RecordingController`, `RecordingBackend`, `ActiveCapture`, app-local workspaces, and `FfmpegRecordingFinalizer` as the stable seams. Add a macOS backend whose dedicated worker thread owns the non-`Send` CPAL 0.15 CoreAudio stream. Its real-time callback converts borrowed samples to owned PCM16 blocks and only calls `try_send` on a bounded queue; a separate writer thread owns `WaveWriter` and all disk I/O. Use typed AVFoundation bindings only as the lazy TCC permission gate immediately before microphone start.

**Stack:** Rust/Tauri 2, CPAL 0.15.3, `objc2-av-foundation` 0.3.2, `block2` 0.6.2, bounded `std::sync::mpsc::sync_channel`, existing ffmpeg finalizer, React/Vitest, Rust tests.

## Fixed decisions

- Implement `mic` only. macOS `systemAudio` remains unavailable with `RECORDING_SYSTEM_AUDIO_UNAVAILABLE`; #18 owns ScreenCaptureKit.
- `capabilities()` never prompts. `notDetermined` stays startable; denied/restricted maps to `RECORDING_MIC_ACCESS_DENIED`; absent/default-device configuration failures map to `RECORDING_MIC_INIT_FAILED`.
- `start(Mic)` lazily requests TCC. `start(System|Mixed)` fails without requesting microphone permission.
- Pin CPAL to `0.15.3`. CPAL 0.18.1's CoreAudio backend requires macOS 14.2 and cannot satisfy Issue #17's macOS 12.x contract. Correct the stale `0.18` design appendix entry.
- CPAL 0.15's stream stays inside its worker thread. `MacosActiveCapture` holds only channels and a `JoinHandle`, preserving `ActiveCapture: Send`.
- Write temporary interleaved PCM16 at device sample rate/channel count. The existing finalizer produces `16 kHz / mono / 16-bit PCM` and performs the unchanged `LocalMediaSource` handoff.
- Existing failed-recording preservation conflicts with ADR 0005/#17. Capture, empty, finalization, and cancel failures must clean the workspace; the original operational error wins over a secondary cleanup error.
- F-03/F-04/F-05, E2/E3, packaged TCC identity, Developer ID signing/notarization, default-device changes, and recovery scenarios remain implementation-after acceptance blockers.

## Task 1: Extend the capability contract

**Files:** Modify `app/src-tauri/src/audio_capture/mod.rs`, `app/src/recordingClient.ts`, `app/src/recordingClient.test.ts`, `app/src/features/workflow/useRecordingController.ts`, and `app/src/features/workflow/useRecordingController.test.ts`.

1. Write failing tests that:
   - serialize `RecordingPlatform::Macos` as `"macos"`;
   - accept a complete macOS capability payload while still rejecting `"linux"`;
   - treat macOS mic-only capabilities as usable, select `mic`, and leave system/mixed unavailable;
   - preserve Windows and unsupported behavior.
2. Confirm RED:

   ```powershell
   npm.cmd --prefix app test -- recordingClient.test.ts useRecordingController.test.ts
   cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture::tests::public_mode_and_error_payloads_are_stable_and_redacted
   ```

3. Add `Macos` to the Rust enum and `"macos"` to the TypeScript parser/type. Replace Windows-only UI guards with `platform !== "unsupported"`; derive modes only from source capabilities.
4. Re-run the narrow tests and commit:

   ```powershell
   git add app/src-tauri/src/audio_capture/mod.rs app/src/recordingClient.ts app/src/recordingClient.test.ts app/src/features/workflow/useRecordingController.ts app/src/features/workflow/useRecordingController.test.ts
   git commit -m "feat(recording): add macOS capability platform"
   ```

## Task 2: Align controller cleanup with the approved contract

**Files:** Modify `app/src-tauri/src/audio_capture/mod.rs`.

1. Change the current preservation tests to require one cleanup call for stream failure and finalization failure. Add cleanup assertions for empty capture and cancel-capture failure. Add a case proving the original capture/finalizer error wins if cleanup also fails.
2. Confirm RED with `cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture::tests`.
3. Refactor `stop` so capture failure, empty capture, finalizer failure, and success all attempt cleanup before settling state. Refactor `cancel` to attempt cleanup even if `capture.cancel()` fails. Return cleanup failure only when there is no earlier operational failure.
4. Re-run tests and commit `fix(recording): clean failed capture workspaces`.

## Task 3: Add a reusable PCM16 WAV constructor

**Files:** Modify `app/src-tauri/src/audio_capture/wav_writer.rs`.

1. Write tests for `WaveFormat::pcm_s16le(channels, sample_rate)`: canonical 16-byte PCM `fmt`, 16 bits/sample, checked block alignment and byte rate, and rejection of zero/overflow inputs.
2. Confirm RED with `cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture::wav_writer::tests`.
3. Implement the little-endian PCM constructor in the shared writer; do not duplicate WAV headers in the macOS backend.
4. Re-run tests and commit `refactor(recording): expose PCM16 wave format`.

## Task 4: Build the macOS TCC/CoreAudio backend test-first

**Files:** Modify `app/src-tauri/Cargo.toml`, `app/src-tauri/Cargo.lock`, and `app/src-tauri/src/audio_capture/mod.rs`; create `app/src-tauri/src/audio_capture/macos.rs`.

1. Add macOS-target-only dependencies:

   ```toml
   [target.'cfg(target_os = "macos")'.dependencies]
   cpal = "=0.15.3"
   objc2-av-foundation = { version = "0.3.2", default-features = false, features = ["std", "AVCaptureDevice", "AVMediaFormat", "block2"] }
   block2 = "0.6.2"
   ```

   Regenerate the lockfile. Do not add `screencapturekit` in #17.

2. Define narrow, injectable internal seams for permission status/request, default input/config lookup, worker startup, bounded block submission, and writer outcome. Write macOS tests covering:
   - authorized/not-determined/denied/restricted/device-missing capability results;
   - capability probing never requesting permission;
   - lazy permission allow/deny and distinct denied/init stable errors;
   - system/mixed rejection without TCC requests;
   - F32/I16/U16 to interleaved PCM16 conversion and correct frame counts;
   - `try_send` full/disconnected queue => first `RECORDING_STREAM_ERROR` without blocking;
   - CPAL runtime error winning over concurrent normal stop;
   - stop draining blocks and producing one valid WAV summary;
   - non-empty silence remaining a valid silent capture;
   - cancel terminating worker/writer without a final product.

3. Implement TCC with `AVCaptureDevice::authorizationStatusForMediaType(AVMediaTypeAudio)`. For `NotDetermined`, call `requestAccessForMediaType_completionHandler` only from `start(Mic)` and bridge its completion block through a one-shot channel. Do not expose OSStatus, device names, or raw errors.
4. Implement capture:
   - construct host/device/config/stream inside a dedicated worker thread;
   - support default F32/I16/U16 input; unsupported formats are init failures;
   - create a named-capacity audio `sync_channel` and a writer thread owning `WaveWriter` for `<workspace>/mic.wav`;
   - callback only converts/copies a block and calls `try_send`; no disk I/O, blocking, ffmpeg, logging, or cleanup;
   - callback queue failure and CPAL error callback atomically store the first stream error;
   - worker stops stream, closes sender, joins writer, and gives source failure priority over normal stop;
   - `MacosActiveCapture::stop/cancel` send control and join; they never own the CPAL stream.
5. Wire `#[cfg(target_os = "macos")] mod macos` and a macOS `from_runtime_paths` branch using the existing finalizer, local file store, and clock. Narrow the unavailable branch to non-Windows/non-macOS. Leave disk probing to #22.
6. Verify on x64 and arm64 macOS:

   ```bash
   cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture
   cargo check --manifest-path app/src-tauri/Cargo.toml
   ```

7. Commit `feat(recording): capture macOS microphone audio`.

## Task 5: Add microphone bundle metadata and macOS automation

**Files:** Create `app/src-tauri/Info.plist`; modify `.github/workflows/desktop-release.yml`.

1. Add only `NSMicrophoneUsageDescription` with: `StudyMind records microphone audio for local transcription and study notes.` Do not add the ScreenCaptureKit purpose string before #18.
2. In both macOS release jobs, run Rust audio-capture tests and target `cargo check` before bundling.
3. After bundling, assert the exact purpose string with `/usr/libexec/PlistBuddy` while retaining resource, architecture, and codesign checks.
4. Build the ad-hoc app on macOS, inspect its merged plist, and commit `build(macos): declare microphone permission usage`.

## Task 6: Prove lifecycle and normalized handoff regressions

**Files:** Modify `app/src/features/workflow/useRecordingController.test.ts`; modify production controller code only if a test exposes a compatibility defect; extend tests in `app/src-tauri/src/audio_capture/mixer.rs`.

1. Re-run upload mutual exclusion, navigation guard, duplicate-start, stop, cancel, redacted error, and preference fallback scenarios using macOS mic-only capabilities.
2. Assert start still sends `{ mode: "mic" }` and consumes the unchanged `RecordingResult`; Worker/media contracts must not change.
3. Extend the single-source finalizer test to prove `-ar 16000 -ac 1 -c:a pcm_s16le`.
4. Run:

   ```powershell
   npm.cmd --prefix app test -- useRecordingController.test.ts
   cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture::mixer::tests
   ```

5. Commit `test(recording): cover macOS microphone lifecycle`.

## Task 7: Correct docs and record deferred acceptance

**Files:** Modify `docs/design-docs/02-audio-recording-design.md` and `docs/test-plans/macos-recording-acceptance.md`.

1. Replace the stale `cpal = "0.18"` example with the implemented `=0.15.3` pin and explain its macOS 12 compatibility reason. Keep `screencapturekit` as #18 scope.
2. Record automated source/unit/build evidence from this ticket without overclaiming actual TCC behavior.
3. Keep F-03/F-04/F-05 as implementation-after verification/acceptance blockers. Keep E2, E3, signing/notarization, default-device change, and recovery scenarios as later acceptance tasks.
4. Run `rg -n "cpal|F-03|F-04|F-05|E2|E3|Developer ID|公证" docs/design-docs/02-audio-recording-design.md docs/test-plans/macos-recording-acceptance.md` and `git diff --check`.
5. Commit `docs(macos): align microphone implementation gates`.

## Task 8: Full verification, review, and handoff

**Review fixed point:** `c901039`.

1. Run local regressions:

   ```powershell
   npm.cmd --prefix app test
   npm.cmd --prefix app run build
   cargo test --manifest-path app/src-tauri/Cargo.toml
   cargo check --manifest-path app/src-tauri/Cargo.toml
   git diff --check c901039..HEAD
   git status --short
   ```

2. On x86_64 and arm64 macOS run full Rust/frontend tests and builds. Build an ad-hoc `.app`, inspect `Info.plist`, and manually exercise capability/no-prompt, first-start prompt, allow, deny, stop, cancel, empty, and silent scenarios where available. Record unavailable checks as blockers, not passes.
3. Run the repository code-review workflow against `c901039` and Issue #17. Reject callback I/O/blocking/logging, a CPAL stream stored in `MacosActiveCapture`, raw device/OS detail exposure, ScreenCaptureKit additions, or Worker contract changes.
4. Apply review fixes test-first. Push only after available gates pass. Update #17 with commits, evidence, and exact remaining blockers; close it only when implementation acceptance is genuinely met.

## Primary references

- [ADR 0005](../../adr/0005-macos-recording-backend.md)
- [macOS recording acceptance plan](../../test-plans/macos-recording-acceptance.md)
- [Apple authorization guidance](https://developer.apple.com/documentation/avfoundation/requesting-authorization-to-capture-and-save-media)
- [Tauri 2 macOS bundle metadata](https://v2.tauri.app/distribute/macos-application-bundle/)
- [CPAL 0.15.3](https://docs.rs/cpal/0.15.3/cpal/)
- [objc2 AVFoundation](https://docs.rs/objc2-av-foundation/0.3.2/objc2_av_foundation/struct.AVCaptureDevice.html)
