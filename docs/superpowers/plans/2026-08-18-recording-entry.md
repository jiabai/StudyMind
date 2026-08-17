# Recording Entry and Fake Composer Flow Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver Issue #10's fake-backed recording entry, controller, preference migration, and local-media composer handoff without changing Worker or WorkflowState contracts.

**Architecture:** Keep recording state in a dedicated useRecordingController and make RecordingCard presentational. Add a strict recordingClient and extend UI preferences to schema v2 with a nested recording mode. The active HeroUploadZone renders upload and recording as equal sibling cards and delegates final local-media selection to the existing workflow controller.

**Tech Stack:** React, TypeScript, Vitest, Tauri invoke, Rust/Serde UI preferences, existing i18n and local-media contracts.

---

### Task 1: Establish a clean baseline

**Files:**
- Worktree: D:\Github\StudyMind\.worktrees\issue-10-recording-entry

- [ ] Step 1: Run npm.cmd --prefix app install.
  Expected: exit 0 and no tracked source changes.

- [ ] Step 2: Run npm.cmd --prefix app test.
  Expected: the pre-change frontend suite passes; record its file/test count.

- [ ] Step 3: Run cargo test --manifest-path app/src-tauri/Cargo.toml --lib.
  Expected: the pre-change Rust suite passes.

- [ ] Step 4: Keep dependency caches, build output, and local resource placeholders untracked.

### Task 2: Migrate UI preferences to schema v2

**Files:**
- Modify: app/src-tauri/src/ui_preferences.rs
- Modify: app/src/settingsClient.ts
- Modify: app/src/i18n/startup.test.ts
- Test: app/src-tauri/src/ui_preferences.rs tests
- Test: app/src/settingsClient.test.ts

- [ ] Step 1: Add failing Rust tests for v1 migration, v2 round-trip, invalid recording mode recovery, and recording-only save preserving language.

Use these concrete assertions:

~~~rust
#[test]
fn v1_file_loads_with_default_mic_recording_preference() {
    let path = temp_file("v1-recording-default");
    write_raw(&path, r#"{"schemaVersion":1,"language":"en-US"}"#);
    let view = load_ui_preferences_from_file(&path).expect("load v1");
    assert_eq!(view.schema_version, 2);
    assert_eq!(view.recording.audio_source_mode, RecordingAudioSourceMode::Mic);
}

#[test]
fn v2_file_round_trips_recording_mode() {
    let path = temp_file("v2-recording-mode");
    write_raw(&path, r#"{"schemaVersion":2,"language":"en-US","recording":{"audioSourceMode":"mixed"}}"#);
    let view = load_ui_preferences_from_file(&path).expect("load v2");
    assert_eq!(view.recording.audio_source_mode, RecordingAudioSourceMode::Mixed);
}

#[test]
fn damaged_recording_preference_recovers_without_rewriting() {
    let path = temp_file("invalid-recording-mode");
    write_raw(&path, r#"{"schemaVersion":2,"language":"en-US","recording":{"audioSourceMode":"bad"}}"#);
    let before = fs::read(&path).expect("read original bytes");
    let view = load_ui_preferences_from_file(&path).expect("recover invalid mode");
    assert_eq!(view.recording.audio_source_mode, RecordingAudioSourceMode::Mic);
    assert!(view.recovered);
    assert_eq!(fs::read(&path).expect("read retained bytes"), before);
}

#[test]
fn recording_only_save_preserves_existing_language() {
    let path = temp_file("recording-only-save");
    write_raw(&path, r#"{"schemaVersion":2,"language":"zh-CN","recording":{"audioSourceMode":"mic"}}"#);
    save_ui_preferences_to_file(&path, SaveUiPreferencesInput::recording(RecordingAudioSourceMode::System))
        .expect("save recording preference");
    let view = load_ui_preferences_from_file(&path).expect("load saved preference");
    assert_eq!(view.language, LanguagePreference::ZhCn);
    assert_eq!(view.recording.audio_source_mode, RecordingAudioSourceMode::System);
}
~~~

The implementation must provide the SaveUiPreferencesInput::recording constructor used by the last test. Assert schema_version 2, nested recording.audio_source_mode, recovery status, and unchanged bytes for recoverable invalid files.

- [ ] Step 2: Run cargo test --manifest-path app/src-tauri/Cargo.toml --lib ui_preferences::tests::v1_file_loads_with_default_mic_recording_preference and verify RED because the current implementation accepts only schema v1.

- [ ] Step 3: Add an explicit Rust RecordingAudioSourceMode enum with serde values mic, system, and mixed. Extend UiPreferencesView and UiPreferencesFile with recording. Accept v1 as a migration input, synthesize mic, and persist v2 only on a successful save. Preserve atomic backup behavior.

- [ ] Step 4: Let SaveUiPreferencesInput carry optional language and optional recording updates. The command loads the existing file, merges supplied fields, and rejects a request that supplies neither field. This lets language and recording saves preserve each other.

- [ ] Step 5: Add TypeScript types:

~~~ts
export type RecordingAudioSourceMode = "mic" | "system" | "mixed";

export type UiPreferencesView = {
  schemaVersion: 2;
  language: LanguagePreference;
  recording: { audioSourceMode: RecordingAudioSourceMode };
  recovered: boolean;
};
~~~

Require the exact nested shape in mapUiPreferencesResponse. Keep getUiPreferences, saveUiPreferences(language), and add saveRecordingAudioSourceMode(mode); each save sends only its changed field.

- [ ] Step 6: Run cargo test --manifest-path app/src-tauri/Cargo.toml --lib ui_preferences::tests and npm.cmd --prefix app test -- settingsClient.test.ts i18n/startup.test.ts. Expected: all preference tests pass.

### Task 3: Add the strict recording IPC client

**Files:**
- Create: app/src/recordingClient.ts
- Create: app/src/recordingClient.test.ts

- [ ] Step 1: Write failing tests for exact command and argument shapes, strict capability/start/stop/state parsing, malformed response rejection, and stable error code preservation.

~~~ts
test("starts a recording with the selected mode", async () => {
  const runner = vi.fn().mockResolvedValue({ sessionId: "s1" });
  await startRecording("mixed", runner);
  expect(runner).toHaveBeenCalledWith("start_recording", { mode: "mixed" });
});
~~~

- [ ] Step 2: Run npm.cmd --prefix app test -- recordingClient.test.ts and verify RED because the module does not exist.

- [ ] Step 3: Implement RecordingMode, RecordingCapabilities, RecordingResult, RecordingStateView, and functions getRecordingCapabilities, startRecording, stopRecording, cancelRecording, and getRecordingState. Use invoke as the default runner, exact-key validation, bounded strings, safe non-negative integers, and a RecordingClientError containing only a stable code.

- [ ] Step 4: Run npm.cmd --prefix app test -- recordingClient.test.ts and verify GREEN.

### Task 4: Build the fake-backed recording controller

**Files:**
- Create: app/src/features/workflow/useRecordingController.ts
- Create: app/src/features/workflow/useRecordingController.test.ts

- [ ] Step 1: Write failing tests for capability loading without permission/start calls, unavailable-mode fallback to mic, and saving a mode only after successful start.

- [ ] Step 2: Run npm.cmd --prefix app test -- useRecordingController.test.ts and verify RED.

- [ ] Step 3: Implement injected recording client, local-media handoff, preference read/write, timer/clock, and error-reporting dependencies. Expose capability loading/ready/unsupported/unavailable, mode, idle/starting/recording/stopping/error session states, elapsedMs, discard confirmation, retryable handoff, and callbacks setMode/start/stop/requestDiscard/confirmDiscard/closeDiscard/retryHandoff.

- [ ] Step 4: Add failing tests for elapsed time, fixed mode, stop-to-selection without auto-submit, handoff retry without a second stop, cancel confirmation, and Escape semantics. Run the focused test and verify RED.

- [ ] Step 5: Implement stop/cancel/handoff and timer behavior minimally. On stop success, retain the result until selectLocalMediaByPath succeeds; on handoff failure retry only selection. Call cancel only after explicit confirmation. Remove listeners and timers on unmount.

- [ ] Step 6: Run npm.cmd --prefix app test -- useRecordingController.test.ts and verify GREEN.

### Task 5: Add RecordingCard and the equal sibling layout

**Files:**
- Create: app/src/features/workflow/RecordingCard.tsx
- Create: app/src/features/workflow/RecordingCard.test.tsx
- Modify: app/src/features/workflow/HeroUploadZone.tsx
- Create: app/src/features/workflow/HeroUploadZone.test.tsx
- Modify: app/src/App.css
- Modify: app/src/i18n/workflowResources.ts
- Test: app/src/i18n/resources.test.ts if key enumeration requires it

- [ ] Step 1: Write failing tests asserting equal upload/recording cards, explicit-button-only start, disabled mode/upload controls while recording, fixed mode display, discard dialog, and retryable handoff error.

- [ ] Step 2: Run npm.cmd --prefix app test -- RecordingCard.test.tsx HeroUploadZone.test.tsx and verify RED.

- [ ] Step 3: Implement RecordingCard as a pure view component. It must not call Tauri, read/write preferences, or mutate WorkflowState. Render native select, explicit start/stop/discard buttons, elapsed time, capability notices, stable errors, retry, and accessible discard confirmation.

- [ ] Step 4: Integrate the card into HeroUploadZone without changing existing upload, drag/drop, recent-media, title, or remove behavior. Disable upload interaction during an active recording and ensure background clicks never start either flow.

- [ ] Step 5: Add responsive equal-weight card CSS, stacking at the existing narrow breakpoint. Add zh-CN, zh-TW, and en-US workflow copy for labels, loading/unavailable states, actions, elapsed time, discard, retry, and stable error explanations. Never interpolate paths, device names, tokens, or raw errors.

- [ ] Step 6: Run npm.cmd --prefix app test -- RecordingCard.test.tsx HeroUploadZone.test.tsx i18n/resources.test.ts and verify GREEN.

### Task 6: Wire App and existing composer callbacks

**Files:**
- Modify: app/src/App.tsx
- Modify: app/src/features/workflow/HeroUploadZone.tsx
- Test: app/src/features/workflow/HeroUploadZone.test.tsx
- Test: app/src/features/workflow/useRecordingController.test.ts

- [ ] Step 1: Add a failing controller integration assertion that a fake stop result is passed to selectLocalMediaByPath, the validated selection reaches the existing selection callback, and submitTask is not called.

- [ ] Step 2: Run npm.cmd --prefix app test -- useRecordingController.test.ts HeroUploadZone.test.tsx and verify RED because App does not instantiate the recording controller.

- [ ] Step 3: Instantiate useRecordingController in App and pass the existing workflow selection callbacks. Render the recording sibling only when the login guide is absent. Keep submitTask as the only Worker-processing entry; a successful stop only sets the selected composer source.

- [ ] Step 4: Run npm.cmd --prefix app test -- HeroUploadZone.test.tsx useRecordingController.test.ts and verify GREEN.

### Task 7: Full verification and focused commits

**Files:**
- Inspect all Issue #10 changes; no unrelated files.

- [ ] Step 1: Run npm.cmd --prefix app test.
  Expected: all existing and new frontend tests pass.

- [ ] Step 2: Run npm.cmd --prefix app run build.
  Expected: TypeScript and Vite build succeed.

- [ ] Step 3: Run cargo test --manifest-path app/src-tauri/Cargo.toml --lib and cargo fmt --manifest-path app/src-tauri/Cargo.toml -- --check.
  Expected: all Rust tests pass and formatting is clean.

- [ ] Step 4: Run git diff --check master...HEAD and git status --short.
  Expected: no whitespace errors, generated artifacts, or unrelated changes.

- [ ] Step 5: Commit green groups separately with:
  - feat(settings): migrate UI preferences to recording schema v2
  - feat(recording): add fake-backed frontend controller and IPC client
  - feat(workflow): add recording entry and composer handoff

After all commits, request a fresh code review against 3071721 before merging.

## Plan self-review

- Coverage includes preference migration, strict IPC, fake controller, elapsed time, fixed mode, capability fallback, stop/cancel confirmation, composer handoff/retry, equal-card UI, i18n, accessibility, and regression verification.
- Real WASAPI, mixed capture, low disk, window close, cleanup hardening, Worker, Pipeline, and WorkflowState changes remain explicitly out of scope.
- No TODO/TBD implementation steps remain; every task names exact files, behavior, and commands.
- The controller consumes the recording types defined by recordingClient.ts, and preference helpers expose schema-v2 views to both LocaleProvider and the recording controller.
