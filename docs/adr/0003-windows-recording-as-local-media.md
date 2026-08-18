# Windows recording is finalized as local media

StudyMind v1 implements built-in recording only on Windows with three `RecordingMode` values and treats a successfully finalized recording as `LocalMediaSource` for the existing Pipeline. A `RecordingSession` that loses either input in `mixed` mode fails as a whole, and its finalized WAV remains available after submission; this preserves the local-only boundary, keeps the existing recent-media shortcut valid, and avoids adding a second downstream media contract while preventing partial or failed submissions from silently discarding user audio.

## Consequences

- Non-Windows platforms do not expose the recording entry until a platform-specific capture backend is designed.
- Pause/resume, device selection, live RMS levels, silence warnings and global shortcuts remain outside v1.
- The renderer may transiently pass the Rust-generated path through `select_local_media_by_path`; the existing local-media validation remains the security boundary.
- An `EmptyRecording` is rejected, while a valid-frame `SilentRecording` is accepted; v1 does not infer failure from volume level.
- Window close waits for finalization and stays open on finalization failure; a successful stop enters the composer without auto-submitting.
- Mixed-mode inputs use equal-weight mixing and normalization when both streams end normally; a stream interruption fails the whole session.
- v1 warns when free space falls below 500MB but does not introduce a second forced-stop threshold; an actual write failure stops the session with an error.
- Finalized WAV files are not automatically deleted in v1; only protected temporary capture directories are cleaned. Retention management is a later concern.
- `RecordingMode` is immutable for a session; changing sources requires stopping and starting a new session.
- System-only recording does not request microphone permission; microphone permission is checked only for `mic` and `mixed`.
- A successful stop whose composer handoff fails retains the finalized WAV and offers retry rather than forcing a new recording.
- Only the explicit start button starts a session; the rest of the recording card does not trigger capture.
- v1 has no in-app delete action for finalized recordings; retention management is deferred to P1.
- A session binds the default microphone/output endpoints at start and does not switch devices during capture; an endpoint disappearance fails the session.
- While capability detection is unknown or loading, source controls and start remain disabled; v1 does not optimistically start capture.
