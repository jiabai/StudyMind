# Handoff: StudyMind macOS recording feasibility validation

## Next-session objective

Use a macOS environment to run the implementation-precondition checks for the approved macOS
recording design. This session is for a throwaway feasibility prototype and evidence collection only;
do not implement the production backend or change the product contract.

## Source of truth

Do not duplicate these documents. Read them in this order:

1. `docs/adr/0005-macos-recording-backend.md` — accepted technical decision and non-negotiable
   boundaries.
2. `docs/test-plans/macos-recording-acceptance.md` — executable matrix; all rows are currently
   `Planned`.
3. `docs/design-docs/02-audio-recording-design.md` — UI/UX and cross-platform integration context.
4. `CONTEXT.md` — canonical domain vocabulary.

The source workspace was `StudyMind`; the current session changed documentation only. No production
code, macOS build, or real-device validation has been performed.

## Decisions that must not be silently changed

- The product meaning of `system` is capturable global macOS system audio, not “audio from the main
  display”. The main display is only the initial `SCContentFilter` technical entry point.
- Capture must be audio-only: register only audio output, never persist or pass screen sample buffers,
  and fail closed if that boundary cannot be proved.
- Verify `excludesCurrentProcessAudio`; if StudyMind self-audio cannot be reliably excluded, system and
  mixed are unavailable.
- On display changes, update the filter first and rebuild the stream if needed. A single recovery may
  last at most 2 seconds; fill the gap from media timestamps/capture timebase and emit a warning. A
  timeout is `RECORDING_STREAM_ERROR` with `source: "systemAudio"`.
- `mixed` requires both sources to become ready before the session time zero; any source failure,
  queue overflow, or missing valid frames fails the whole session and deletes temporary audio.
- The 2-second window is a fixed v1 constant. Multiple successful recoveries do not automatically fail
  the session; warnings aggregate `count` and `totalGapMs`.
- Warning delivery is an immediate `recording-warning` Tauri event plus persisted session warnings
  returned by `get_recording_state` and `stop_recording`. The first warning code is
  `RECORDING_SYSTEM_AUDIO_RECOVERED`.
- Do not recover or retain crash leftovers. On startup, remove stale recording temp directories that
  do not belong to an active session.

## Blocking feasibility matrix

Run and record evidence for `F-01` through `F-08` in
`docs/test-plans/macos-recording-acceptance.md`:

- `F-01`: Rust ScreenCaptureKit binding compiles/links and starts an audio-only stream on Intel and
  Apple Silicon.
- `F-02`: audio from at least two independent applications is captured as global system audio.
- `F-03`: changing the default output route does not change the product semantics.
- `F-04`: switching the main display and connecting/removing an external display is handled by filter
  update or stream rebuild.
- `F-05`: recovery within 2 seconds continues with timestamp-based silence padding; recovery beyond the
  window fails.
- `F-06`: StudyMind self-audio exclusion is proven.
- `F-07`: no screen output is registered and no video sample buffer reaches writer/Worker; fail-closed
  behavior is demonstrated.
- `F-08`: TCC behavior works in the ad-hoc package, including re-probe after returning from Settings.

Required environments are macOS 13+ Intel and Apple Silicon, with an external-display case where
available. Record exact macOS version, architecture, SDK/toolchain, binding version, ffmpeg resources,
bundle identity, and package type.

## Execution constraints

- Use the `prototype` flow for a throwaway validation harness; keep it separate from production code.
- Do not retain user audio in the handoff or evidence. Evidence may contain command output, statuses,
  timestamps, package metadata, screenshots, and WAV metadata, but not recordings.
- If binding compilation, global audio semantics, self-audio exclusion, or audio-only behavior fails,
  stop and report the exact failure. Reopen ADR 0005 before choosing Swift, Objective-C, or another
  binding.
- If all `F-*` checks pass, update only the acceptance-plan statuses/evidence and create a return handoff
  for the original StudyMind session. Do not start production implementation in this validation session.

## Return package

Return:

1. A table for `F-01`–`F-08` with `Pass`, `Fail`, or `Blocked` and concise evidence references.
2. Exact environment/package metadata.
3. Any observed deviations from ADR 0005, including whether they require reopening the ADR.
4. The updated acceptance-plan path or a patch summary; do not include user audio.

## Suggested skills

- `prototype` — build the throwaway macOS feasibility harness.
- `verification-before-completion` — require fresh evidence for every `Pass` claim.
- `architecture-designer` — use only if feasibility results force an ADR or boundary change.
- `grill-with-docs` — use only if the validation reveals a product decision that cannot be resolved
  from the current ADR and acceptance plan.

## Primary references

- https://developer.apple.com/documentation/screencapturekit/sccontentfilter
- https://developer.apple.com/documentation/screencapturekit/scstream
- https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/capturesaudio
