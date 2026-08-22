# macOS Mixed RecordingSession 与终态失败监督规格

## Problem Statement

StudyMind 需要让 macOS 13+ 用户在一个 `RecordingSession` 中同时捕获麦克风和全局系统音频，并
继续把最终结果交给现有的本地转写与 InsightFlow 管线。当前单源 macOS 录音、system-audio
recovery、warning 聚合、Tauri event、前端 hydration 和基础验收已经完成，但 mixed 会话仍需要
统一的双源启动、运行、停止、取消、失败与清理语义。

用户不应看到“只保存了其中一路”的成功结果，也不应因为主显示器这个 ScreenCaptureKit 技术入口
而误解为产品正在录屏。任何一路在会话被接受后发生的致命问题，都必须立即停止用户可见计时，
进入可恢复的 `RecordingFailure` 终态，并在后台完成采集资源与临时产物清理。

## Solution

建立一套平台无关的 mixed coordinator 和 accepted-session failure supervisor：

- 麦克风与系统声音在共同 Ready 屏障后才定义 mixed audio time zero，并允许 `RecordingSession`
  成功返回；权限交互不计入 Ready deadline。
- 两路各自保留 native 协商格式，停止后由现有 finalizer 等权混音为一个 16 kHz、单声道、
  16-bit PCM `LocalMediaSource`。
- 任一路启动、运行、队列、停止、Empty 或 finalization 致命失败，都使整个会话失败且不提交
  partial result；首先确认的 failure 决定 source 归因。
- macOS system audio 使用 audio-only ScreenCaptureKit stream。主显示器只作为 `SCContentFilter`
  的技术入口，不改变“系统声音”的产品语义，也不创建、保存或传递视频输出。
- accepted-session failure 通过 `recording-failed` 和 `get_recording_state` 共享同一个
  `RecordingFailureView`，以 `(sessionId, errorCode, source?)` 去重；清理完成只更新同一身份的
  `cleanupPending` 与 warnings。
- 用户确认、重新开始、stop、cancel 和 finalizer 的竞态遵守单一 `RecordingSession` 生命周期，
  不新增第二套前端录音或媒体交接流程。

## User Stories

1. As a StudyMind learner, I want to select `mixed`, so that my local study recording contains both my microphone and the system audio played during class.
2. As a learner, I want the session timer to start only after both sources are ready, so that elapsed time represents one coherent mixed session.
3. As a learner, I want permission dialogs to complete before the ready timeout begins, so that a slow macOS TCC interaction does not create a false startup failure.
4. As a learner, I want microphone permission to be requested before Screen Recording permission for mixed, so that the first-run flow is predictable.
5. As a learner, I want partial permission or initialization failure to fail the whole mixed session, so that StudyMind never silently downgrades my explicit choice to microphone-only.
6. As a learner, I want the error to identify whether microphone or system audio failed, so that I know which permission or device condition to fix.
7. As a learner, I want the system-audio option to mean global system sound, so that a display used internally by ScreenCaptureKit is not presented as the recording source.
8. As a learner, I want mixed capture to be audio-only, so that no screen video is saved or sent to the transcription pipeline.
9. As a learner, I want frames received before both sources are ready to be discarded, so that pre-gate timing cannot create an unexplained offset in the final media.
10. As a learner, I want a runtime failure to stop the visible timer immediately, so that the UI does not imply that an unusable session is still recording.
11. As a learner, I want a runtime failure to be reported before slow native cleanup finishes, so that I receive actionable feedback without waiting for a blocked worker.
12. As a learner, I want the same failure not to appear repeatedly through event delivery, command results, or hydration, so that one problem produces one user-facing error entry.
13. As a learner, I want a failed session to remain recoverable until I acknowledge it or start a new session, so that a missed event does not erase important diagnostic state.
14. As a learner, I want state hydration to recover the same failure after the frontend misses an event, so that reopening or refocusing the recording UI does not lose the error.
15. As a learner, I want the UI to distinguish cleanup still in progress from cleanup complete, so that I understand why retrying may be temporarily unavailable.
16. As a learner, I want temporary-file deletion failure not to hide the original recording failure when native capture teardown is confirmed, so that a removable filesystem problem does not misreport the cause.
17. As a learner, I want StudyMind to block a new recording while native teardown is unconfirmed, so that a second session cannot race with workers still writing the first session's files.
18. As a learner, I want cancel to stop both sources and never create a final recording, so that abandoning a session does not leave a partial or diagnostic media product.
19. As a learner, I want cancel to win over stop while native workers are still joining, so that an explicit discard request is honored before finalization begins.
20. As a learner, I want cancel to be rejected after finalization starts, so that the finalizer is not interrupted midway through producing a consistent result.
21. As a learner, I want a valid silent source to remain legal, so that silence is not confused with an empty source that produced no valid frames.
22. As a learner, I want an empty source to fail the whole mixed session, so that StudyMind never submits one-sided audio as a successful mixed result.
23. As a learner, I want different native sample rates, channel counts, and PCM representations to be normalized by the existing finalizer, so that capture adapters can preserve their negotiated formats safely.
24. As a learner, I want successful mixed recording to continue through the existing local-media, transcription, summary, and mind-map flow, so that mixed capture behaves like other local recordings downstream.
25. As a maintainer, I want the first confirmed source failure to remain stable across concurrent stop, cancel, join, and cleanup errors, so that diagnostics are deterministic and privacy-safe.
26. As a maintainer, I want shared coordinator behavior to be tested with deterministic fake sources, so that Windows and macOS lifecycle semantics can be verified without native hardware.
27. As a maintainer, I want native macOS recovery to use sample-buffer timestamps and durations, so that short interruptions can be filled with silence and long interruptions can fail according to elapsed media time.
28. As a maintainer, I want display/filter changes to try `update_content_filter` before rebuilding an audio-only stream, so that normal topology changes avoid unnecessary capture teardown.
29. As a maintainer, I want stop, cancel, runtime error, and stream rebuild to release callbacks, writers, queues, and temporary paths, so that repeated sessions do not leak native resources.
30. As a release owner, I want Apple Silicon, external-display, default-output, recovery, signing, and notarization evidence tracked separately, so that host-side tests are not mistaken for native acceptance.

## Implementation Decisions

- `RecordingMode` remains the user-facing choice of `mic`, `system`, or `mixed`; mixed remains an explicit
  capability and is never derived in the frontend from two single-source capability flags.
- `RecordingSource` is a closed set containing `microphone` and `systemAudio`. `RecordingError` carries an
  optional stable source and never exposes device names, display identifiers, OSStatus values, paths, or
  native error text to the frontend.
- The platform-neutral mixed coordinator owns exactly two prepared sources, a shared ready gate, a monotonic
  Stop/Cancel control signal, and a first-source-failure latch. It does not own permissions, native stream
  creation, WAV encoding, recovery policy, ffmpeg, or frontend state.
- Ready means that the source can accept audio frames; it does not require a first frame. Before both sources
  are Ready, callbacks consume and discard data without blocking native realtime threads or writing WAV
  frames. Exactly one gate opening defines mixed audio time zero.
- Startup failures are `RecordingStartFailure`: the coordinator cancels and joins both workers, the
  Controller cleans the workspace, and the start command returns directly without a failed snapshot or
  runtime event. The three-second Ready deadline begins only after permission handling completes; if exactly
  one source is missing at timeout it receives source attribution, otherwise the timeout is unsourced.
- Stop broadcasts Stop to both workers before joining either one, joins both even when one result is already an
  error, records join errors without replacing an earlier latched failure, and only summarizes after the
  failure latch is clear.
- Mixed result summaries retain source identity, sort output paths in Microphone then SystemAudio order,
  reject any zero-valid-frame source with `RECORDING_EMPTY` and that source, accept valid silent frames, use
  checked addition for total valid frames, and do not create a partial result on any error.
- Cancel broadcasts Cancel to both workers, joins both, returns no captured recording, and preserves any
  already latched failure. Cancel is monotonic over Stop so a cloned cancel handle can upgrade an in-flight
  stop before finalization.
- `ActiveCapture` exposes an optional cloneable cancel handle. Mixed captures implement it by cloning both
  source signals; single-source adapters can adopt the same contract without a macOS- or mixed-specific
  Controller branch.
- ScreenCaptureKit is configured for audio output only. The main display is a technical content-filter
  anchor, not a user-visible source. On display/topology changes, the native supervisor first attempts
  content-filter update and rebuilds the audio-only stream only when update fails.
- System-audio recovery consumes CMSampleBuffer presentation timestamp and duration. A gap up to and
  including two seconds is filled with silence and aggregated as a warning; a gap beyond two seconds or an
  invalid timestamp fails the system source. Recovery warnings remain distinct from fatal RecordingFailure.
- `start_recording` success is the boundary between startup failure and accepted-session failure. After
  acceptance, one supervisor owns the failure wakeup and cleanup lifecycle for the session; it atomically
  replaces the active state with a failed snapshot before doing blocking cleanup work.
- Accepted runtime, early-source termination, stop, Empty, and finalizer failures use one serialized
  `RecordingFailureView` for both `recording-failed` and `get_recording_state`. The tagged state is
  `recording`, `failed`, or `null`; the failed view contains session, mode, elapsed time, stable error code,
  optional source, cleanup status, and aggregated warnings.
- `RecordingFailureIdentity` is `(sessionId, errorCode, source?)`. Events, command returns, and hydration
  reconcile by this identity. Duplicate reports never replace the first error or trigger a second frontend
  error entry; later cleanup/warning information may update the same identity.
- A runtime failure first becomes visible with `cleanupPending=true`. The supervisor then cancels the capture,
  joins workers, and cleans the workspace outside the state lock. Confirmed native teardown allows file
  deletion errors to be non-blocking; unconfirmed native teardown keeps cleanup pending and blocks new
  sessions until process restart. Cleanup completion re-emits the same failure identity with
  `cleanupPending=false`.
- Failure acknowledgement is accepted only for a matching session after cleanup is complete, is idempotent
  for the same identity, and cannot clear a newer failure. A new session atomically takes ownership of the
  Controller and clears the old failed snapshot only after the old cleanup contract permits it.
- `stop` on a matching failed session returns the latched error. `cancel` on a matching failed session is an
  idempotent cleanup request and preserves the snapshot. Cancel during Stopping requests the cloned handle;
  cancel during Finalizing is rejected without interrupting finalization.
- The finalizer continues to be the only owner of resampling, channel conversion, equal-weight mixing, and
  final 16 kHz mono PCM16 validation. Successful mixed capture produces one local media result; failures
  never create a `LocalMediaSource` from only one input.
- Frontend capability parsing, failure parsing, event delivery, hydration, timer ownership, retry/close
  controls, and media handoff all remain within the existing single RecordingSession flow. No mixed-only
  page, second timer, second session, or alternate media pipeline is introduced.
- The implementation is split into Task 1–10. Task 1 source metadata, Task 2 atomic startup barrier, and
  Task 3 mixed stop/cancel/result semantics are complete in the isolated worktree. Task 4 accepted-session
  terminal failure supervisor is next; Windows migration, macOS adapter integration, frontend integration,
  and final verification follow.

## Testing Decisions

- The highest useful seam is the platform-neutral recording contract: deterministic prepared-source fakes
  exercise the mixed coordinator, while Controller tests exercise accepted-session failure, event/state
  identity, cleanup ownership, and command races. Native APIs are tested only at their adapter seams.
- Tests assert external behavior and stable contracts rather than private implementation details. A test may
  use barriers, channels, atomic observations, and controlled worker results to prove ordering, but should
  not depend on fixed sleeps or scheduler luck.
- Coordinator tests cover the two-source Ready gate, pre-gate frame discard, startup failure and timeout
  attribution, stop-before-join broadcast, all-worker join after errors, fixed path order, checked frame
  totals, valid silence, EmptyRecording, source failure precedence, cancel-without-result, and cancel
  upgrading an in-flight stop.
- Failure supervisor tests cover first-error latching, one-shot wakeup, channel disconnect without fabricated
  errors, startup acceptance boundary, and failures arriving before/after acceptance.
- Controller tests cover immediate runtime failure visibility while cleanup is blocked, same-identity event and
  hydration deduplication, background cancel/join/cleanup, cleanup status re-emission, cleanup error
  precedence, acknowledgement, stale acknowledgement, replacement by a new session, stop-after-failure,
  idempotent cancel-after-failure, Stopping cancel, and Finalizing cancel rejection.
- Platform seam tests cover explicit mixed capability, permission order, audio-only output, main-display
  semantic neutrality, filter-update-before-rebuild, recovery timing, warning aggregation, queue overflow,
  native stop/error/rebuild cleanup, and no-video fail-closed behavior.
- Finalizer tests cover contained source paths, different negotiated source formats, equal-weight mix
  arguments, final output format, failure cleanup, and absence of partial results.
- Frontend tests cover explicit mixed capability, source-aware error parsing and localization, event/state
  hydration, identity deduplication, immediate timer stop, cleanup-pending controls, and preservation of one
  session/timer/handoff.
- Existing prior art includes the `SystemAudioRecovery` deterministic state-machine tests, warning
  accumulator/sink tests, `macos_test` pure-logic adapter tests, the existing audio-capture Controller
  tests, and the frontend parser/build suite. These remain regression gates.
- Required host-side verification includes the full `audio_capture` Rust test suite, Rust type checking,
  frontend tests, frontend production build, and `git diff --check`. Native macOS compilation and E1/E2/E3
  runtime evidence must record architecture, OS, Xcode/toolchain, commit SHA, artifacts, warnings, and
  signing results separately from Windows-host evidence.

## Out of Scope

- Apple Silicon E2 runtime acceptance, external-display/default-output E3 scenarios, and any claim that Intel
  or Windows results substitute for them.
- Developer ID signing, notarization, stable TCC identity across rebuilds, and release packaging evidence
  that requires unavailable certificates or credentials.
- Screen video capture, video persistence, video forwarding, or a user-visible display-selection feature.
- Automatic fallback from an explicitly started mixed session to microphone-only or system-only recording.
- Microphone device selection UI, sample-accurate cross-device clock synchronization, drift correction,
  pause/resume semantics, and a new media contract downstream of the existing LocalMediaSource pipeline.
- New network video URL ingestion, social-platform fallback parsing, or any Worker protocol expansion.
- Exposing native OSStatus, device names, display IDs, file paths, raw callback data, or arbitrary native
  error messages to the user-facing contract.
- Treating host-side tests, portable macOS seams, or existing E1 system-only evidence as proof that E2/E3
  mixed recovery and release acceptance are complete.

## Further Notes

- The canonical product vocabulary is defined in `CONTEXT.md`: `RecordingSession`, `RecordingMode`,
  `SystemAudioRecording`, `MixedRecordingReady`, `MixedRecordingFailure`, `RecordingStartFailure`,
  `RecordingFailure`, `RecordingFailureIdentity`, `RecordingCleanup`, `RecordingPermissionWait`,
  `RecordingWarning`, `EmptyRecording`, and `SilentRecording`.
- Issue #20 is the delivery ticket and already uses the `ready-for-agent` triage label. Its acceptance
  criteria remain the minimum product contract; this specification expands them with the accepted-session
  failure and cleanup semantics confirmed during the grilling/design review.
- Current implementation evidence in `codex/macos-mixed-recording`: Task 1 commits `306f045` and `8852573`,
  Task 2 commits `23e1613`, `a432bdd`, and `baf32e8`, and Task 3 commit `65f5725`; the latest mixed suite
  is 13/13 and the complete `audio_capture` suite is 91/91 on the Windows host.
- The worktree also contains progress record `e704f29`. Task 4 is the next implementation boundary and
  should begin with failure-supervisor tests in RED before production code is changed.
- This specification is a synthesis of the confirmed conversation decisions and existing project documents;
  it does not upgrade any pending native acceptance row to Pass.
