# Windows WASAPI Recording Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan task-by-task.

**Goal:** Replace the production recording placeholder with real Windows WASAPI microphone, system loopback, and mixed capture, then finalize successful sessions as local WAV media.

**Architecture:** A Windows-only WASAPI backend writes native-format temporary WAV sources. A bundled-ffmpeg finalizer normalizes one or two sources to 16 kHz mono PCM WAV. Runtime setup injects the real controller with app-local recording paths; non-Windows retains the unavailable fallback.

**Tech Stack:** Rust 2021, Tauri 2, `windows 0.61.3` for target-specific WASAPI/COM bindings, existing `windows-sys 0.61.2`, bundled ffmpeg/ffprobe, existing React/TypeScript recording client.

---

## Task 1: Make runtime paths and controller construction production-ready

**Files:**

- Modify: `app/src-tauri/src/runtime.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src-tauri/src/audio_capture/mod.rs`
- Test: `app/src-tauri/src/runtime.rs`
- Test: `app/src-tauri/src/audio_capture/mod.rs`

**Step 1 — Write failing tests.**

- Assert `ensure_runtime_dirs` creates `recordings/.tmp` and `recordings`.
- Assert stale cleanup removes only direct session children below `.tmp` and refuses an outside/symlink target.
- Assert the production constructor accepts `RuntimePaths` and the Tauri setup registers it instead of the unavailable default.

**Step 2 — Run the focused tests and confirm failure.**

```text
cargo test --manifest-path app/src-tauri/Cargo.toml --lib runtime::tests audio_capture::tests
```

**Step 3 — Implement the smallest change.**

- Add recording directory constants and protected stale-temp cleanup.
- Add `RecordingController::from_runtime_paths` with Windows production components and non-Windows fallback.
- Resolve runtime paths and register the controller during Tauri setup after directory initialization.
- Preserve fake constructor injection for all existing tests.

**Step 4 — Run the focused tests again.**

```text
cargo test --manifest-path app/src-tauri/Cargo.toml --lib runtime::tests audio_capture::tests
```

**Step 5 — Commit.**

```text
git add app/src-tauri/src/runtime.rs app/src-tauri/src/lib.rs app/src-tauri/src/audio_capture/mod.rs
git commit -m "fix(recording): wire production runtime paths"
```

## Task 2: Add a tested native-format WAV writer

**Files:**

- Create: `app/src-tauri/src/audio_capture/wav_writer.rs`
- Modify: `app/src-tauri/src/audio_capture/mod.rs`
- Modify: `app/src-tauri/Cargo.toml`
- Modify: `app/src-tauri/Cargo.lock`
- Test: `app/src-tauri/src/audio_capture/wav_writer.rs`

**Step 1 — Write failing tests.**

- Create mono and stereo test writers, append known frames, close them, and assert RIFF/WAVE sizes and frame counts.
- Add an extensible-format fixture and assert the format bytes are retained.
- Assert zero-frame and overflow/short-write cases return stable write errors.

**Step 2 — Run the focused tests and confirm failure.**

```text
cargo test --manifest-path app/src-tauri/Cargo.toml --lib audio_capture::wav_writer
```

**Step 3 — Implement.**

- Write a placeholder header, stream packet bytes, count frames, track silence, and patch RIFF/data sizes on close.
- Keep all file operations inside the supplied workspace path.
- Add only the Windows dependency features required by the WASAPI format types.

**Step 4 — Run focused tests.**

```text
cargo test --manifest-path app/src-tauri/Cargo.toml --lib audio_capture::wav_writer
```

**Step 5 — Commit.**

```text
git add app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock app/src-tauri/src/audio_capture/mod.rs app/src-tauri/src/audio_capture/wav_writer.rs
git commit -m "feat(recording): add native wav writer"
```

## Task 3: Implement Windows WASAPI capability probing and capture lifecycle

**Files:**

- Create: `app/src-tauri/src/audio_capture/wasapi.rs`
- Modify: `app/src-tauri/src/audio_capture/mod.rs`
- Modify: `app/src-tauri/Cargo.toml`
- Modify: `app/src-tauri/Cargo.lock`
- Test: `app/src-tauri/src/audio_capture/wasapi.rs`

**Step 1 — Write failing tests.**

- Assert capability mapping distinguishes microphone init/access errors from system loopback errors without exposing HRESULT/device details.
- Assert mode start creates exactly the required source workers and mixed mode fails transactionally if either worker cannot initialize.
- Assert stop signals workers, waits for bounded shutdown, closes WAV headers, and returns source paths beneath the workspace.
- Assert cancel removes no outside path and does not return a partial capture.

**Step 2 — Run focused tests and confirm failure.**

```text
cargo test --manifest-path app/src-tauri/Cargo.toml --lib audio_capture::wasapi
```

**Step 3 — Implement.**

- Add `cfg(windows)` COM/MMDevice/WASAPI code using event-driven packet reads.
- Probe default capture and render endpoints without requesting mic access during capability query.
- Use shared-mode endpoint mix formats; enable loopback only for system audio.
- Coordinate workers with cancellation/error channels, bounded joins, and deterministic cleanup.
- Keep a non-Windows module path that compiles to the unavailable behavior.

**Step 4 — Run focused tests and compile on Windows.**

```text
cargo test --manifest-path app/src-tauri/Cargo.toml --lib audio_capture::wasapi
cargo check --manifest-path app/src-tauri/Cargo.toml
```

**Step 5 — Commit.**

```text
git add app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock app/src-tauri/src/audio_capture/mod.rs app/src-tauri/src/audio_capture/wasapi.rs
git commit -m "feat(recording): capture microphone and loopback with wasapi"
```

## Task 4: Add ffmpeg finalization and mixed-mode normalization

**Files:**

- Create: `app/src-tauri/src/audio_capture/mixer.rs`
- Modify: `app/src-tauri/src/audio_capture/mod.rs`
- Test: `app/src-tauri/src/audio_capture/mixer.rs`

**Step 1 — Write failing tests.**

- Assert single-source and mixed-mode commands contain structured arguments, normalized output options, and no shell command string.
- Assert non-zero exit, missing binary, invalid output, and rename failure map to stable errors.
- Assert final output is outside `.tmp`, source paths are contained by the workspace, and successful finalization cleans only the workspace later.

**Step 2 — Run focused tests and confirm failure.**

```text
cargo test --manifest-path app/src-tauri/Cargo.toml --lib audio_capture::mixer
```

**Step 3 — Implement.**

- Inject a command runner for tests and use the packaged `resources/bin/ffmpeg.exe` in production.
- Use atomic sibling output then rename to `recording_<timestamp>_<session-id>.wav`.
- Validate the final WAV header/data and preserve the existing `FinalizedRecording` result shape.
- Wire `RecordingController::stop` to pass the workspace to the finalizer and clean temp files only after successful finalization.

**Step 4 — Run focused tests.**

```text
cargo test --manifest-path app/src-tauri/Cargo.toml --lib audio_capture::mixer
```

**Step 5 — Commit.**

```text
git add app/src-tauri/src/audio_capture/mod.rs app/src-tauri/src/audio_capture/mixer.rs
git commit -m "feat(recording): finalize captures with bundled ffmpeg"
```

## Task 5: Add close lifecycle protection and frontend capability regression coverage

**Files:**

- Modify: `app/src-tauri/src/window_chrome.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src/features/workflow/useRecordingController.ts`
- Modify: `app/src/features/workflow/RecordingCard.tsx`
- Test: `app/src-tauri/src/window_chrome.rs`
- Test: `app/src/App.recording.test.ts`
- Test: `app/src/features/workflow/useRecordingController.test.ts`
- Test: `app/src/features/workflow/RecordingCard.test.tsx`

**Step 1 — Write failing tests.**

- Assert close while recording requests terminal cleanup before allowing the window to close.
- Assert Windows-ready capabilities enable source selection and start.
- Assert capability failure still disables controls and maps only stable codes.
- Assert a successful stop leaves the finalized result available for local-media handoff retry.

**Step 2 — Run focused tests and confirm failure.**

```text
npm.cmd --prefix app test -- src/App.recording.test.ts src/features/workflow/useRecordingController.test.ts src/features/workflow/RecordingCard.test.tsx
cargo test --manifest-path app/src-tauri/Cargo.toml --lib window_chrome audio_capture
```

**Step 3 — Implement.**

- Gate close through the recording controller without introducing a second renderer-owned lifecycle.
- Keep UI behavior unchanged for the established IPC contract; only ready capabilities should enable the controls.
- Ensure handoff retry never calls stop twice.

**Step 4 — Run focused tests.**

```text
npm.cmd --prefix app test -- src/App.recording.test.ts src/features/workflow/useRecordingController.test.ts src/features/workflow/RecordingCard.test.tsx
cargo test --manifest-path app/src-tauri/Cargo.toml --lib window_chrome audio_capture
```

**Step 5 — Commit.**

```text
git add app/src-tauri/src/window_chrome.rs app/src-tauri/src/lib.rs app/src/features/workflow app/src/App.recording.test.ts
git commit -m "fix(recording): protect close and ready-state controls"
```

## Task 6: Full verification and handoff

**Files:**

- Verify: `app/src-tauri/src/audio_capture/`
- Verify: `app/src-tauri/src/runtime.rs`
- Verify: `app/src-tauri/src/lib.rs`
- Verify: `app/src-tauri/src/window_chrome.rs`
- Verify: `app/src/features/workflow/`

**Step 1 — Run required checks.**

```text
uv run ruff check worker
uv run pytest worker/tests
npm.cmd --prefix app test
npm.cmd --prefix app run build
cargo test --manifest-path app/src-tauri/Cargo.toml --lib
cargo check --manifest-path app/src-tauri/Cargo.toml
```

**Step 2 — Run Windows acceptance.**

- Start the desktop app with a microphone and render output available.
- Verify capability response, mic/system/mixed recordings, cancellation, close protection, final WAV properties via ffprobe, and local-media handoff/transcription.
- Record exact commands and outcomes in `progress.md`.

**Step 3 — Request two-stage review.**

- First review implementation against this spec and ADR.
- Then review code quality, lifecycle safety, error redaction, and maintainability.
- Fix every actionable finding and rerun the affected checks.

**Step 4 — Commit any verification fixes, inspect diff, and report evidence.**

```text
git status --short
git diff master...HEAD --stat
git diff master...HEAD --check
```
