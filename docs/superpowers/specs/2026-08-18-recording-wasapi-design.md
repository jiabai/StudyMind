# Windows WASAPI Recording Backend Design

## Problem

The recording entry is present in the StudyMind UI, but production Tauri wiring still uses an unavailable backend. On Windows this makes microphone, system audio, and mixed mode unavailable, so the source selector and start button remain disabled.

The existing recording-entry work deliberately delivered the UI and a fake backend only. This document defines the missing production implementation.

## Goal

On Windows, make the existing three-mode recording entry perform real local capture:

- `mic`: default capture endpoint through WASAPI.
- `system`: default render endpoint through WASAPI loopback.
- `mixed`: both endpoints captured concurrently and mixed with equal weight.

Every successful stop produces one validated 16 kHz, mono, signed PCM WAV under app-local `recordings/`, then uses the existing local-media handoff. No Worker contract or workflow stage changes are required.

## Non-goals

- Device picker beyond the default microphone and default render endpoint.
- Pause/resume, live levels, global shortcuts, audio-device hot switching, recording library management, or automatic retention.
- macOS/Linux capture implementation.
- Network capture or URL ingestion.

## Production wiring

`RecordingController::default()` remains suitable only for tests and non-production fallback. Tauri setup will:

1. Resolve `RuntimePaths`.
2. Ensure `outputs`, `cache`, `logs`, `models`, `recordings`, and `recordings/.tmp` exist.
3. Remove only stale session directories directly below the protected `.tmp` directory, using canonical-path containment checks.
4. Register `RecordingController::from_runtime_paths(paths)` before the application begins serving commands.

On Windows `from_runtime_paths` constructs:

- `WasapiRecordingBackend`;
- `RecordingFileStore` rooted at `<user_data>/recordings`;
- `FfmpegRecordingFinalizer` rooted at `<resource_dir>/bin/ffmpeg.exe` and `<user_data>/recordings`.

On non-Windows it returns the current unavailable implementations, preserving a truthful unsupported capability response.

## Capture data model

The controller keeps its existing state machine but makes the captured artifact explicit:

```text
CaptureWorkspace {
  session_id
  temp_dir                 recordings/.tmp/<session-id>
}

CapturedRecording {
  source_paths[]           paths below workspace.temp_dir
  valid_frame_count        sum of accepted PCM frames
  silent                   informational; valid silence is still accepted
  duration_ms              capture duration based on accepted frames
}
```

`RecordingFinalizer::finalize` receives the workspace as well as the capture summary. It validates that every source path is inside the workspace before invoking ffmpeg. Fake implementations remain injectable and can ignore the new artifact fields.

## WASAPI backend

`app/src-tauri/src/audio_capture/wasapi.rs` is compiled only for Windows and uses the cached `windows` projection for COM, MMDevice, Audio Client, Audio Capture Client, and synchronization APIs. The existing `windows-sys` dependency remains for unrelated job-object code; the audio projection is target-specific so non-Windows builds do not gain Windows APIs.

Capability probing creates an `IMMDeviceEnumerator`, resolves the default capture endpoint and default render endpoint, and opens each endpoint far enough to validate a shared-mode audio client. Probe failure is converted to the existing stable source-specific error codes; no device name or HRESULT crosses the IPC boundary.

Start binds the endpoints once for the session. Each required source gets an event-driven capture worker:

1. Initialize COM for the worker thread.
2. Activate `IAudioClient` in shared mode.
3. Use the endpoint mix format returned by WASAPI; do not assume 16-bit, stereo, or a fixed sample rate.
4. For system audio set `AUDCLNT_STREAMFLAGS_LOOPBACK`.
5. Register an event handle and read all available packets from `IAudioCaptureClient`.
6. Append packet data to its temporary WAV writer and update frame counters/silence tracking.
7. Stop on a shared cancellation signal, endpoint failure, or explicit stop.

The mixed mode starts both workers as one transaction. If either worker cannot initialize or later fails, the session reports a stable stream/init error and does not produce a partial final recording.

The stop path signals all workers, waits for their bounded shutdown, flushes WAV headers, validates that the temporary files are contained by the workspace, and returns the capture summary. Cancel follows the same shutdown path and removes only the protected workspace.

## WAV writer

`app/src-tauri/src/audio_capture/wav_writer.rs` writes a placeholder RIFF/WAVE header, appends PCM packet bytes, and patches RIFF/data sizes on close. It preserves the native `WAVEFORMATEX`/`WAVEFORMATEXTENSIBLE` fields needed to describe the captured endpoint format. The writer rejects overflow, short writes, malformed formats, and data-size/header inconsistencies.

The writer is independently testable with generated PCM frames. Tests cover mono/stereo, extensible format headers, zero frames, frame-count calculation, and header patching after stop.

## Finalization and mixing

`app/src-tauri/src/audio_capture/mixer.rs` resolves the bundled executable at `<resource_dir>/bin/ffmpeg.exe` and invokes it with `std::process::Command`; no shell is involved and paths are passed as individual arguments.

Single-source finalization uses:

```text
-y -i <source> -ar 16000 -ac 1 -c:a pcm_s16le <temporary-final-output>
```

Mixed finalization uses two inputs and an equal-weight `amix` filter with longest-duration behavior and normalization, followed by `-ar 16000 -ac 1 -c:a pcm_s16le`. The final output is first written to a sibling temporary file and atomically renamed into `recordings/recording_<timestamp>_<session-id>.wav` only after ffmpeg succeeds and the WAV header/data are validated.

The command runner is injected for unit tests. Non-zero exit, missing executable, invalid output, and rename failure map to `RECORDING_FINALIZE_FAILED` or the more specific existing mix/write errors. ffmpeg stderr is retained only for internal diagnostics and is redacted from UI/log payloads.

## File and privacy boundaries

- Temporary capture paths are generated from UUIDs and are never accepted from the renderer.
- All temp deletion checks canonical containment under `<user_data>/recordings/.tmp`.
- Final output is always generated by Rust below `<user_data>/recordings`; the renderer receives only the existing finalized result needed for local-media handoff.
- Device names, absolute temp paths, COM HRESULTs, command lines, and ffmpeg stderr are not returned as user-visible errors.
- System-only mode initializes render loopback only and does not request microphone access.

## Lifecycle behavior

- A recording session owns all capture workers and remains immutable in mode.
- Stop is idempotence-protected by the existing session ID and state machine.
- Capture failure leaves the workspace for diagnostics/retry handling until the controller or explicit discard cleans it; successful stop and cancel clean it.
- Finalized WAVs remain after a successful stop, including when the renderer’s local-media handoff needs a retry.
- Window close is intercepted while a recording is active/finalizing. The close command requests cancellation/finalization through the controller and closes only after the backend reaches a terminal state; if finalization fails, the window remains open.

## Testing and acceptance

### Unit and contract tests

- Controller tests cover real capture artifact paths, mixed transaction failure, cleanup containment, and production constructor selection.
- WAV writer tests cover valid headers and frame counts.
- ffmpeg finalizer tests assert exact structured arguments, output validation, atomic rename, and redacted errors using a fake command runner.
- Runtime tests cover recording directories and stale temp cleanup without deleting siblings or paths outside `.tmp`.
- Frontend tests remain green and add the real-capability response regression: Windows-ready capabilities enable the select and start action; unavailable capabilities still disable them.

### Windows integration tests

On a Windows machine with a microphone, a render endpoint, and packaged ffmpeg:

1. Capability probe reports the available endpoints.
2. Mic mode records speech and yields a non-empty 16 kHz mono WAV.
3. System mode records playing system audio without requesting microphone access.
4. Mixed mode records both sources and yields one normalized WAV.
5. Stop, cancel, endpoint failure, and app-close paths leave no orphaned worker or temp directory.
6. The resulting WAV can be handed to the existing local-media pipeline and transcribed.

## Rollout boundary

This implementation is Windows-only and must not make unsupported platforms appear ready. If bundled ffmpeg or an endpoint is unavailable, the UI shows the existing stable localized error and keeps the controls disabled or recoverable.
