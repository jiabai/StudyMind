import type {
  ChangeEvent,
  DependencyList,
  EffectCallback,
  SetStateAction,
} from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { createInitialWorkflow } from "../../workflowState";
import type { WorkflowState } from "../../workflow";
import type { UiMessage } from "../../i18n/uiMessage";
import type {
  SaveTranscriptEditResponse,
  TranscriptDetailResponse,
} from "../../transcriptDetailClient";
import type { SaveSummaryEditResponse } from "../../summaryClient";
import type { TranscriptDetailController } from "./useTranscriptDetailController";

type StateUpdater<T> = T | ((current: T) => T);
type EffectRecord = {
  cleanup?: void | (() => void);
  deps?: DependencyList;
};

const mocks = vi.hoisted(() => ({
  clipboardWriteText: vi.fn(),
  loadTranscriptDetail: vi.fn(),
  revealItemInDir: vi.fn(),
  saveTranscriptEdit: vi.fn(),
  useSummaryEditorController: vi.fn(),
}));

vi.mock("../../transcriptDetailClient", () => ({
  loadTranscriptDetail: mocks.loadTranscriptDetail,
  saveTranscriptEdit: mocks.saveTranscriptEdit,
}));

vi.mock("../results/useSummaryEditorController", () => ({
  useSummaryEditorController: mocks.useSummaryEditorController,
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: mocks.revealItemInDir,
}));

function createHookHarness() {
  const states: unknown[] = [];
  const refs: unknown[] = [];
  const effects: EffectRecord[] = [];
  let stateCursor = 0;
  let refCursor = 0;
  let effectCursor = 0;

  return {
    resetRender() {
      stateCursor = 0;
      refCursor = 0;
      effectCursor = 0;
    },
    useCallback<T extends (...args: never[]) => unknown>(callback: T): T {
      return callback;
    },
    useState<T>(initialValue: T | (() => T)): [T, (next: StateUpdater<T>) => void] {
      const index = stateCursor++;
      if (states.length <= index) {
        states[index] = typeof initialValue === "function"
          ? (initialValue as () => T)()
          : initialValue;
      }
      return [
        states[index] as T,
        (next) => {
          states[index] = typeof next === "function"
            ? (next as (current: T) => T)(states[index] as T)
            : next;
        },
      ];
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = refCursor++;
      if (refs.length <= index) {
        refs[index] = { current: initialValue };
      }
      return refs[index] as { current: T };
    },
    useEffect(effect: EffectCallback, deps?: DependencyList): void {
      const index = effectCursor++;
      const previous = effects[index];
      const changed = !previous || !deps || !previous.deps ||
        deps.length !== previous.deps.length ||
        deps.some((value, dependencyIndex) => !Object.is(value, previous.deps?.[dependencyIndex]));
      if (!changed) {
        return;
      }
      previous?.cleanup?.();
      effects[index] = { cleanup: effect(), deps };
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function readyWorkflow(
  taskId = "task-escape",
  text = "第一段原稿。",
): WorkflowState {
  return {
    ...createInitialWorkflow(),
    stage: "completed",
    taskId,
    taskDir: `D:/StudyMind/outputs/tasks/${taskId}`,
    text,
    artifacts: { transcript_txt: "transcript/transcript.txt" },
  };
}

function detailResponse(
  taskId = "task-escape",
  text = "第一段原稿。",
): TranscriptDetailResponse {
  return {
    task_id: taskId,
    text,
    segments: [
      {
        id: "segment-1",
        start_ms: 0,
        end_ms: 3000,
        text,
      },
    ],
    audio_path: `D:/StudyMind/outputs/tasks/${taskId}/media/audio.wav`,
    audio_asset_path: `D:/StudyMind/cache/audio-review/${taskId}.wav`,
    has_original_backup: false,
  };
}

function savedResponse(
  taskId = "task-escape",
  text = "第一段保留草稿。",
): SaveTranscriptEditResponse {
  return {
    task_id: taskId,
    text,
    artifacts: { transcript_txt: "transcript/transcript.txt" },
    has_original_backup: true,
  };
}

type ControllerHarness = {
  render: () => TranscriptDetailController;
  setWorkflow: (next: WorkflowState) => TranscriptDetailController;
  applyTranscriptSave: ReturnType<typeof vi.fn>;
  applySummarySave: ReturnType<typeof vi.fn>;
  setActionNotice: ReturnType<typeof vi.fn>;
};

async function createController({
  initialWorkflow = readyWorkflow(),
  waitForInitialLoad = true,
}: {
  initialWorkflow?: WorkflowState;
  waitForInitialLoad?: boolean;
} = {}): Promise<ControllerHarness> {
  const harness = createHookHarness();
  vi.doMock("react", () => ({
    useCallback: harness.useCallback,
    useEffect: harness.useEffect,
    useRef: harness.useRef,
    useState: harness.useState,
  }));
  const { useTranscriptDetailController } = await import("./useTranscriptDetailController");
  const applyTranscriptSave = vi.fn();
  const applySummarySave = vi.fn();
  const setActionNotice = vi.fn<
    (value: SetStateAction<UiMessage | null>) => void
  >();
  const summaryEditorFields = {
    summaryEditing: false,
    summaryDraft: "当前摘要",
    summaryDirty: false,
    summarySaving: false,
    beginSummaryEdit: vi.fn(),
    cancelSummaryEdit: vi.fn(),
    updateSummaryDraft: vi.fn(),
    saveSummaryDraft: vi.fn<
      (expectedTaskId?: string) => Promise<SaveSummaryEditResponse | void>
    >(),
  };
  mocks.useSummaryEditorController.mockReturnValue(summaryEditorFields);
  let workflow = initialWorkflow;
  const render = () => {
    harness.resetRender();
    return useTranscriptDetailController({
      workflow,
      locale: "zh-CN",
      applyTranscriptSave,
      applySummarySave,
      setActionNotice,
    });
  };
  const setWorkflow = (next: WorkflowState) => {
    workflow = next;
    return render();
  };

  render();
  if (waitForInitialLoad) {
    await vi.waitFor(() =>
      expect(mocks.loadTranscriptDetail).toHaveBeenCalledOnce()
    );
    await vi.waitFor(() =>
      expect(render().transcriptSegments.length).toBeGreaterThan(0)
    );
  }
  return {
    render,
    setWorkflow,
    applyTranscriptSave,
    applySummarySave,
    setActionNotice,
  };
}

describe("useTranscriptDetailController segment editing", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    mocks.clipboardWriteText.mockReset();
    mocks.loadTranscriptDetail.mockReset();
    mocks.revealItemInDir.mockReset();
    mocks.saveTranscriptEdit.mockReset();
    mocks.useSummaryEditorController.mockReset();
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: mocks.clipboardWriteText,
      },
    });
    mocks.clipboardWriteText.mockResolvedValue(undefined);
    mocks.loadTranscriptDetail.mockResolvedValue(detailResponse());
    mocks.revealItemInDir.mockResolvedValue(undefined);
    mocks.saveTranscriptEdit.mockResolvedValue(savedResponse());
  });

  test("keeps the exact flat public controller surface", async () => {
    const { render } = await createController();

    expect(Object.keys(render()).sort()).toEqual([
      "activeTranscriptSegmentId",
      "beginSummaryEdit",
      "beginTranscriptSegmentEdit",
      "cancelSummaryEdit",
      "closeDetail",
      "copyDetail",
      "copyTranscript",
      "currentTranscriptPath",
      "detailTab",
      "detailText",
      "editingTranscriptSegmentId",
      "endTranscriptSegmentEdit",
      "exportDetail",
      "exportPath",
      "exportTranscript",
      "handleTranscriptAudioMetadata",
      "handleTranscriptAudioPause",
      "handleTranscriptAudioPlay",
      "handleTranscriptTimeUpdate",
      "hasTranscriptSegments",
      "locateTranscriptByteRange",
      "locatedTranscriptRange",
      "openDetailTab",
      "playTranscriptSegment",
      "prepareTranscriptForTaskDeletion",
      "saveTranscriptDraft",
      "saveSummaryDraft",
      "scrubTranscriptAudio",
      "summaryDirty",
      "summaryDraft",
      "summaryEditing",
      "summarySaving",
      "toggleTranscriptAudio",
      "transcriptAudioCurrentTime",
      "transcriptAudioDuration",
      "transcriptAudioPlaying",
      "transcriptAudioProgress",
      "transcriptAudioRef",
      "transcriptAudioScrubberMax",
      "transcriptAudioScrubberStyle",
      "transcriptAudioSrc",
      "transcriptDetail",
      "transcriptDirty",
      "transcriptDraft",
      "transcriptLoading",
      "transcriptSaving",
      "transcriptSegmentRefs",
      "transcriptSegments",
      "updateFullTranscriptDraft",
      "updateSummaryDraft",
      "updateTranscriptSegmentDraft",
    ].sort());
  });

  test("exposes the summary editor surface and wires its owner inputs", async () => {
    const { render, applySummarySave, setActionNotice } = await createController();

    expect(render()).toMatchObject({
      summaryEditing: false,
      summaryDraft: "当前摘要",
      summaryDirty: false,
      summarySaving: false,
    });
    expect(mocks.useSummaryEditorController).toHaveBeenLastCalledWith({
      workflow: expect.objectContaining({ taskId: "task-escape" }),
      applySummarySave,
      setActionNotice,
    });
  });

  test("does not load without a current official transcript and resets review state", async () => {
    const workflow = {
      ...readyWorkflow(),
      taskId: null,
      text: "Workflow fallback",
      artifacts: {},
    };
    const { render } = await createController({
      initialWorkflow: workflow,
      waitForInitialLoad: false,
    });

    expect(mocks.loadTranscriptDetail).not.toHaveBeenCalled();
    expect(render().transcriptDraft).toBe("Workflow fallback");
    expect(render().transcriptSegments).toEqual([]);
    expect(render().transcriptDirty).toBe(false);
    expect(render().activeTranscriptSegmentId).toBeNull();
    expect(render().editingTranscriptSegmentId).toBeNull();
  });

  test("does not reload an already loaded task on an equivalent rerender", async () => {
    const { render } = await createController();

    render();
    render();

    expect(mocks.loadTranscriptDetail).toHaveBeenCalledTimes(1);
  });

  test("keeps workflow text and a fixed notice when detail loading fails", async () => {
    mocks.loadTranscriptDetail.mockRejectedValueOnce(
      new Error("C:/private/transcript.txt Authorization: secret"),
    );
    const { render, setActionNotice } = await createController({
      waitForInitialLoad: false,
    });

    await vi.waitFor(() =>
      expect(setActionNotice).toHaveBeenCalledWith({
        messageCode: "transcript.notice.detailLoadFallback",
      })
    );

    expect(render().transcriptDraft).toBe("第一段原稿。");
    expect(render().transcriptSegments).toEqual([]);
    expect(JSON.stringify(setActionNotice.mock.calls)).not.toContain("C:/private");
    expect(JSON.stringify(setActionNotice.mock.calls)).not.toContain("secret");
  });

  test("keeps editing available with the fixed no-audio notice", async () => {
    mocks.loadTranscriptDetail.mockResolvedValueOnce({
      ...detailResponse(),
      segments: [],
      audio_path: null,
      audio_asset_path: null,
    });
    const { render, setActionNotice } = await createController({
      waitForInitialLoad: false,
    });

    await vi.waitFor(() =>
      expect(setActionNotice).toHaveBeenCalledWith({
        messageCode: "transcript.notice.audioUnavailableEdit",
      })
    );

    expect(render().transcriptDraft).toBe("第一段原稿。");
    expect(render().transcriptAudioSrc).toBe("");
  });

  test("ignores a late transcript load after switching tasks", async () => {
    const taskALoad = deferred<TranscriptDetailResponse>();
    const taskBLoad = deferred<TranscriptDetailResponse>();
    mocks.loadTranscriptDetail.mockReset();
    mocks.loadTranscriptDetail.mockImplementation((taskId: string) =>
      taskId === "task-escape" ? taskALoad.promise : taskBLoad.promise
    );
    const { render, setWorkflow, setActionNotice } = await createController({
      waitForInitialLoad: false,
    });

    setWorkflow(readyWorkflow("task-b", "任务 B 文字稿"));
    taskBLoad.resolve(detailResponse("task-b", "任务 B 文字稿"));
    await vi.waitFor(() =>
      expect(render().transcriptDetail?.task_id).toBe("task-b")
    );
    taskALoad.resolve(detailResponse("task-escape", "迟到的任务 A"));
    await taskALoad.promise;
    await Promise.resolve();

    expect(render().transcriptDetail?.task_id).toBe("task-b");
    expect(render().transcriptDraft).toBe("任务 B 文字稿");
    expect(setActionNotice).toHaveBeenCalledTimes(1);
    expect(setActionNotice).toHaveBeenLastCalledWith(null);
  });

  test("ending segment edit keeps the in-memory draft dirty without saving", async () => {
    const { render } = await createController();
    let controller = render();

    controller.beginTranscriptSegmentEdit("segment-1");
    controller = render();
    controller.updateTranscriptSegmentDraft("segment-1", "第一段保留草稿。");
    controller = render();
    controller.endTranscriptSegmentEdit();
    controller = render();

    expect(controller.editingTranscriptSegmentId).toBeNull();
    expect(controller.transcriptSegments[0]?.text).toBe("第一段保留草稿。");
    expect(controller.transcriptDraft).toBe("第一段保留草稿。");
    expect(controller.transcriptDirty).toBe(true);
    expect(mocks.saveTranscriptEdit).not.toHaveBeenCalled();
  });

  test("ending segment edit clears pending audio resume before a later save", async () => {
    const { render } = await createController();
    let controller = render();
    const audio = {
      currentTime: 0,
      duration: 3,
      paused: false,
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
      playbackRate: 1,
    };
    controller.transcriptAudioRef.current = audio as unknown as HTMLAudioElement;

    controller.beginTranscriptSegmentEdit("segment-1");
    controller = render();
    controller.updateTranscriptSegmentDraft("segment-1", "第一段保留草稿。");
    controller = render();
    controller.endTranscriptSegmentEdit();
    controller = render();
    await controller.saveTranscriptDraft();

    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.play).not.toHaveBeenCalled();
  });

  test("releases only the current task audio before permanent deletion", async () => {
    const { render } = await createController();
    const controller = render();
    const audio = {
      paused: false,
      pause: vi.fn(),
      removeAttribute: vi.fn(),
      load: vi.fn(),
    };
    controller.transcriptAudioRef.current = audio as unknown as HTMLAudioElement;

    controller.prepareTranscriptForTaskDeletion("another-task");
    expect(audio.pause).not.toHaveBeenCalled();

    controller.prepareTranscriptForTaskDeletion("task-escape");

    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.removeAttribute).toHaveBeenCalledWith("src");
    expect(audio.load).toHaveBeenCalledOnce();
  });

  test("uses a stable localized code when saving fails without exposing raw details", async () => {
    mocks.saveTranscriptEdit.mockRejectedValueOnce(
      new Error("Authorization: Bearer secret at C:/private/transcript.txt"),
    );
    const { render, setActionNotice } = await createController();
    let controller = render();
    controller.updateFullTranscriptDraft("Edited user transcript");
    controller = render();

    await controller.saveTranscriptDraft();

    expect(setActionNotice).toHaveBeenLastCalledWith({
      messageCode: "transcript.notice.saveFailed",
    });
    expect(JSON.stringify(setActionNotice.mock.calls)).not.toContain("secret");
    expect(JSON.stringify(setActionNotice.mock.calls)).not.toContain("C:/private");
  });

  test("ignores a late transcript save after switching tasks", async () => {
    const taskASave = deferred<SaveTranscriptEditResponse>();
    mocks.saveTranscriptEdit.mockReturnValueOnce(taskASave.promise);
    const {
      render,
      setWorkflow,
      applyTranscriptSave,
      setActionNotice,
    } = await createController();
    setActionNotice.mockClear();
    let controller = render();
    const taskAAudio = {
      currentTime: 0,
      duration: 3,
      paused: false,
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
      playbackRate: 1,
    };
    controller.transcriptAudioRef.current =
      taskAAudio as unknown as HTMLAudioElement;
    controller.beginTranscriptSegmentEdit("segment-1");
    controller = render();
    controller.updateTranscriptSegmentDraft("segment-1", "任务 A 草稿");
    controller = render();
    const savePromise = controller.saveTranscriptDraft();

    mocks.loadTranscriptDetail.mockResolvedValueOnce(
      detailResponse("task-b", "任务 B 文字稿"),
    );
    setWorkflow(readyWorkflow("task-b", "任务 B 文字稿"));
    await vi.waitFor(() =>
      expect(render().transcriptDetail?.task_id).toBe("task-b")
    );
    const taskBAudio = {
      currentTime: 0,
      duration: 3,
      paused: true,
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
      playbackRate: 1,
    };
    render().transcriptAudioRef.current =
      taskBAudio as unknown as HTMLAudioElement;

    taskASave.resolve(savedResponse("task-escape", "迟到的任务 A 保存"));
    await savePromise;

    expect(render().transcriptDraft).toBe("任务 B 文字稿");
    expect(applyTranscriptSave).not.toHaveBeenCalled();
    expect(setActionNotice).not.toHaveBeenCalledWith({
      messageCode: "transcript.notice.saved",
    });
    expect(taskBAudio.play).not.toHaveBeenCalled();
  });

  test("clears pending audio resume when the review task changes", async () => {
    const { render, setWorkflow } = await createController();
    let controller = render();
    const taskAAudio = {
      currentTime: 0,
      duration: 3,
      paused: false,
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
      playbackRate: 1,
    };
    controller.transcriptAudioRef.current =
      taskAAudio as unknown as HTMLAudioElement;
    controller.beginTranscriptSegmentEdit("segment-1");

    mocks.loadTranscriptDetail.mockResolvedValueOnce(
      detailResponse("task-b", "任务 B 文字稿"),
    );
    setWorkflow(readyWorkflow("task-b", "任务 B 文字稿"));
    await vi.waitFor(() =>
      expect(render().transcriptDetail?.task_id).toBe("task-b")
    );
    controller = render();
    const taskBAudio = {
      currentTime: 0,
      duration: 3,
      paused: true,
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
      playbackRate: 1,
    };
    controller.transcriptAudioRef.current =
      taskBAudio as unknown as HTMLAudioElement;
    controller.beginTranscriptSegmentEdit("segment-1");
    controller = render();
    controller.updateTranscriptSegmentDraft("segment-1", "任务 B 保存");
    mocks.saveTranscriptEdit.mockResolvedValueOnce(
      savedResponse("task-b", "任务 B 保存"),
    );
    controller = render();
    await controller.saveTranscriptDraft();

    expect(taskAAudio.pause).toHaveBeenCalledOnce();
    expect(taskBAudio.play).not.toHaveBeenCalled();
    expect(render().transcriptDirty).toBe(false);
  });

  test("resumes audio after a successful save started from segment editing", async () => {
    const { render, applyTranscriptSave } = await createController();
    let controller = render();
    const audio = {
      currentTime: 0,
      duration: 3,
      paused: false,
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
      playbackRate: 1,
    };
    controller.transcriptAudioRef.current = audio as unknown as HTMLAudioElement;

    controller.beginTranscriptSegmentEdit("segment-1");
    controller = render();
    controller.updateTranscriptSegmentDraft("segment-1", "第一段保留草稿。");
    controller = render();
    await controller.saveTranscriptDraft();
    controller = render();

    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.play).toHaveBeenCalledOnce();
    expect(controller.editingTranscriptSegmentId).toBeNull();
    expect(controller.transcriptDirty).toBe(false);
    expect(applyTranscriptSave).toHaveBeenCalledWith(
      "task-escape",
      savedResponse(),
    );
  });

  test("copies the unsaved transcript draft and reports clipboard failure safely", async () => {
    const { render, setActionNotice } = await createController();
    let controller = render();
    controller.updateFullTranscriptDraft("Unsaved transcript draft");
    controller = render();

    await controller.copyTranscript();

    expect(mocks.clipboardWriteText).toHaveBeenCalledWith(
      "Unsaved transcript draft",
    );
    mocks.clipboardWriteText.mockRejectedValueOnce(
      new Error("clipboard secret at C:/private/transcript.txt"),
    );
    setActionNotice.mockClear();
    await controller.copyTranscript();

    expect(setActionNotice).toHaveBeenLastCalledWith({
      messageCode: "transcript.notice.transcriptCopyFailed",
    });
    expect(JSON.stringify(setActionNotice.mock.calls)).not.toContain("secret");
    expect(JSON.stringify(setActionNotice.mock.calls)).not.toContain("C:/private");
  });

  test("blocks dirty transcript location and reveals only the clean saved artifact", async () => {
    const { render, setActionNotice } = await createController();
    let controller = render();
    controller.updateFullTranscriptDraft("Unsaved transcript draft");
    controller = render();

    await controller.exportTranscript();

    expect(mocks.revealItemInDir).not.toHaveBeenCalled();
    expect(setActionNotice).toHaveBeenLastCalledWith({
      messageCode: "transcript.notice.unsavedLocate",
    });

    await controller.saveTranscriptDraft();
    controller = render();
    setActionNotice.mockClear();
    await controller.exportTranscript();

    expect(mocks.revealItemInDir).toHaveBeenCalledWith(
      controller.currentTranscriptPath,
    );
    expect(setActionNotice).toHaveBeenLastCalledWith({
      messageCode: "transcript.notice.transcriptLocated",
    });
  });

  test("reports transcript location failure without exposing rejection details", async () => {
    mocks.revealItemInDir.mockRejectedValueOnce(
      new Error("opener secret at C:/private/transcript.txt"),
    );
    const { render, setActionNotice } = await createController();
    setActionNotice.mockClear();

    await render().exportTranscript();

    expect(setActionNotice).toHaveBeenLastCalledWith({
      messageCode: "transcript.notice.transcriptLocateFailed",
    });
    expect(JSON.stringify(setActionNotice.mock.calls)).not.toContain("secret");
    expect(JSON.stringify(setActionNotice.mock.calls)).not.toContain("C:/private");
  });

  test("plays a selected segment and pauses the active playing segment", async () => {
    const { render } = await createController();
    let controller = render();
    const audio = {
      currentTime: 2,
      duration: 3,
      paused: false,
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
      playbackRate: 0.75,
    };
    controller.transcriptAudioRef.current = audio as unknown as HTMLAudioElement;
    const segment = controller.transcriptSegments[0]!;

    await controller.playTranscriptSegment(segment);
    controller = render();

    expect(audio.currentTime).toBe(0);
    expect(audio.playbackRate).toBe(1);
    expect(audio.play).toHaveBeenCalledOnce();
    expect(controller.activeTranscriptSegmentId).toBe("segment-1");

    await controller.playTranscriptSegment(segment);

    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.play).toHaveBeenCalledOnce();
  });

  test("starts a segment at an explicitly estimated text position", async () => {
    const { render } = await createController();
    const controller = render();
    const audio = {
      currentTime: 0,
      duration: 3,
      paused: true,
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
      playbackRate: 1,
    };
    controller.transcriptAudioRef.current = audio as unknown as HTMLAudioElement;

    await controller.playTranscriptSegment(controller.transcriptSegments[0]!, 1.75);

    expect(audio.currentTime).toBe(1.75);
    expect(audio.play).toHaveBeenCalledOnce();
    expect(audio.pause).not.toHaveBeenCalled();
  });

  test("clamps audio scrubbing and follows the matching segment", async () => {
    mocks.loadTranscriptDetail.mockResolvedValueOnce({
      ...detailResponse(),
      segments: [
        {
          id: "segment-1",
          start_ms: 0,
          end_ms: 1000,
          text: "First",
        },
        {
          id: "segment-2",
          start_ms: 1000,
          end_ms: 3000,
          text: "Second",
        },
      ],
    });
    const { render } = await createController();
    let controller = render();
    const audio = {
      currentTime: 0,
      duration: 3,
      paused: true,
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
      playbackRate: 0.75,
    };
    controller.transcriptAudioRef.current = audio as unknown as HTMLAudioElement;
    controller.handleTranscriptAudioMetadata();
    controller = render();

    controller.scrubTranscriptAudio({
      currentTarget: { valueAsNumber: 10 },
    } as ChangeEvent<HTMLInputElement>);
    controller = render();

    expect(audio.currentTime).toBe(3);
    expect(controller.transcriptAudioCurrentTime).toBe(3);
    expect(controller.transcriptAudioProgress).toBe(100);
    expect(controller.activeTranscriptSegmentId).toBe("segment-2");
  });

  test("uses fixed notices for rejected segment autoplay and audio playback", async () => {
    const { render, setActionNotice } = await createController();
    let controller = render();
    const audio = {
      currentTime: 0,
      duration: 3,
      paused: true,
      pause: vi.fn(),
      play: vi.fn()
        .mockRejectedValueOnce(
          new Error("autoplay secret at C:/private/transcript.txt"),
        )
        .mockRejectedValueOnce(
          new Error("playback secret at C:/private/transcript.txt"),
        ),
      playbackRate: 1,
    };
    controller.transcriptAudioRef.current = audio as unknown as HTMLAudioElement;
    setActionNotice.mockClear();

    await controller.playTranscriptSegment(controller.transcriptSegments[0]!);
    expect(setActionNotice).toHaveBeenLastCalledWith({
      messageCode: "transcript.notice.audioAutoplayFailed",
    });

    controller = render();
    await controller.toggleTranscriptAudio();
    expect(setActionNotice).toHaveBeenLastCalledWith({
      messageCode: "transcript.notice.audioPlaybackFailed",
    });
    expect(JSON.stringify(setActionNotice.mock.calls)).not.toContain("secret");
    expect(JSON.stringify(setActionNotice.mock.calls)).not.toContain("C:/private");
  });
});
