import { beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";

import { createBrowserPreviewAccountStatus } from "../../accountState";
import type { HistoryItem } from "../../historyClient";
import type { WorkerProgressEvent, WorkerResult } from "../../workflow";

type StateUpdater<T> = T | ((current: T) => T);

type HookHarness = {
  resetRender: () => void;
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => T;
  useMemo: <T>(factory: () => T) => T;
  useRef: <T>(initialValue: T) => { current: T };
  useState: <T>(initialValue: T | (() => T)) => [T, (next: StateUpdater<T>) => void];
};

const cancelProcessMock = vi.fn();
const processLocalMediaMock = vi.fn();
const retryInsightsMock = vi.fn();
const clearLocalMediaSelectionMock = vi.fn();

const LOCAL_SELECTION = {
  selectionToken: "01234567-89ab-4def-8abc-0123456789ab",
  displayName: "Interview.wmv",
  mediaKind: "video",
  extension: "wmv",
  sizeBytes: 1024,
} as const;

vi.mock("../../workerClient", () => ({
  cancelProcess: cancelProcessMock,
  processLocalMedia: processLocalMediaMock,
  retryInsights: retryInsightsMock,
}));

vi.mock("../../localMediaClient", () => ({
  clearLocalMediaSelection: clearLocalMediaSelectionMock,
}));

function createHookHarness(): HookHarness {
  const states: unknown[] = [];
  let cursor = 0;

  return {
    resetRender: () => {
      cursor = 0;
    },
    useCallback: (callback) => callback,
    useMemo: (factory) => factory(),
    useRef: <T,>(initialValue: T) => {
      const stateIndex = cursor;
      cursor += 1;
      if (states.length <= stateIndex) {
        states[stateIndex] = { current: initialValue };
      }
      return states[stateIndex] as { current: T };
    },
    useState: <T,>(initialValue: T | (() => T)) => {
      const stateIndex = cursor;
      cursor += 1;
      if (states.length <= stateIndex) {
        states[stateIndex] =
          typeof initialValue === "function"
            ? (initialValue as () => T)()
            : initialValue;
      }
      const setState = (next: StateUpdater<T>) => {
        states[stateIndex] =
          typeof next === "function"
            ? (next as (current: T) => T)(states[stateIndex] as T)
            : next;
      };
      return [states[stateIndex] as T, setState];
    },
  };
}

function requireResolver<T>(resolver: ((value: T) => void) | null): (value: T) => void {
  if (!resolver) {
    throw new Error("Expected deferred operation resolver.");
  }
  return resolver;
}

const TEST_DISSECTION: NonNullable<WorkerResult["dissection"]> = {
  schemaVersion: 1,
  sourceTranscriptSha256: "a".repeat(64),
  sourceLanguage: null,
  sourceChunks: [{ id: 1, startByte: 0, endByte: 3, sha256: "b".repeat(64) }],
  overallNarrative: {
    openingHook: null,
    structureType: "statement",
    turningPoint: null,
    closingType: null,
  },
  segments: [{
    id: 1,
    title: "Opening",
    sourceChunkIds: [1],
    coreClaim: "abc",
    supportingPoints: [],
    rhetoricalDevices: [],
    rhythmNote: "Brief",
    reusablePattern: "Direct",
    riskFlags: [],
  }],
  highlights: ["abc"],
  reusableTemplate: { name: "Direct", skeleton: ["A", "B", "C"] },
  audienceFit: [],
  strengths: ["Direct"],
  weaknesses: ["Brief"],
};

function createHistoryItem(overrides: Partial<HistoryItem> = {}): HistoryItem {
  const { dissection, dissectionStale, ...rest } = overrides;
  return {
    taskId: "history-task",
    source: {
      kind: "local_file",
      displayName: "Lecture.mp4",
      mediaKind: "video",
    },
    status: "completed",
    taskDir: "D:/StudyMind/outputs/tasks/history-task",
    artifacts: {
      transcript_txt: "transcript/transcript.txt",
      summary: "ai/summary.md",
      insights: "ai/insights.json",
    },
    error: null,
    text: "history transcript",
    summary: "history summary",
    transcript: { source: "asr", language: "Chinese", engine: "SenseVoice" },
    insights: [
      {
        id: 1,
        topic: "history insight",
        matchReason: "history relevance",
        followUpQuestions: ["history question"],
        suitableUse: "history use case",
        sourceChunkId: null,
      },
    ],
    dissection: dissection ?? null,
    dissectionStale: dissectionStale ?? false,
    title: null,
    ...rest,
  };
}

function createWorkerResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  const { dissection, dissection_source_status, ...rest } = overrides;
  return {
    status: "completed",
    task_id: "active-task",
    task_dir: "D:/StudyMind/outputs/tasks/active-task",
    artifacts: { transcript_txt: "transcript/transcript.txt" },
    text: "active transcript",
    summary: "active summary",
    insights: [],
    transcript: { source: "asr", language: "Chinese", engine: "SenseVoice" },
    dissection: dissection ?? null,
    dissection_source_status: dissection_source_status ?? null,
    error: null,
    ...rest,
  };
}

async function createController(
  overrides: {
    ensureAsrModelReady?: () => Promise<
      "iic/SenseVoiceSmall" | "iic/SenseVoiceSmall-onnx" | null
    >;
    modelDownloadActive?: boolean;
  } = {},
) {
  const harness = createHookHarness();
  const onResetTaskUi = vi.fn();
  vi.doMock("react", () => ({
    useCallback: harness.useCallback,
    useMemo: harness.useMemo,
    useRef: harness.useRef,
    useState: harness.useState,
  }));
  const { useTaskProcessingController } = await import("./useTaskProcessingController");

  return {
    render: () => {
      harness.resetRender();
      return useTaskProcessingController({
        onResetTaskUi,
        onRetryStarted: vi.fn(),
        processBlockerMessage: () => ({ messageCode: "account.notice.processingUnavailable" }),
        aiBlockerMessage: () => ({ messageCode: "account.notice.aiUnavailable" }),
        ...overrides,
      });
    },
    onResetTaskUi,
  };
}

describe("useTaskProcessingController watchdog timeouts", () => {
  beforeEach(() => {
    vi.resetModules();
    cancelProcessMock.mockReset();
    processLocalMediaMock.mockReset();
    retryInsightsMock.mockReset();
    clearLocalMediaSelectionMock.mockReset();
    clearLocalMediaSelectionMock.mockResolvedValue(true);
  });

  test("keeps the complete current task after AI timeout without retrying or opening Credits", async () => {
    const source = createHistoryItem({
      taskId: "source-task",
      taskDir: "D:/StudyMind/outputs/tasks/source-task",
      artifacts: {
        transcript_txt: "transcript/transcript.txt",
        transcript_md: "transcript/transcript.md",
        summary: "ai/summary.md",
        insights: "ai/insights.json",
      },
      text: "preserved transcript",
      summary: "preserved summary",
    });
    retryInsightsMock.mockResolvedValue(
      createWorkerResult({
        status: "partial_completed",
        task_id: null,
        task_dir: null,
        artifacts: {},
        text: "",
        summary: "",
        insights: [],
        transcript: null,
        error: {
          code: "WORKER_EXECUTION_TIMEOUT",
          message: "Worker process exceeded the maximum execution time.",
          stage: "insights_generating",
        },
      }),
    );
    const openAccountPanel = vi.fn();
    const { render } = await createController();
    let controller = render();
    expect(controller.restoreHistoryItem(source)).toBe(true);
    controller = render();

    await controller.retryInsightGeneration(
      "summary",
      "en-US",
      null,
      createBrowserPreviewAccountStatus(),
      openAccountPanel,
    );
    controller = render();

    expect(controller.workflow.stage).toBe("partial_completed");
    expect(controller.workflow.activeAiTarget).toBeNull();
    expect(controller.workflow.aiErrorTarget).toBe("summary");
    expect(controller.workflow.taskId).toBe(source.taskId);
    expect(controller.workflow.taskDir).toBe(source.taskDir);
    expect(controller.workflow.text).toBe(source.text);
    expect(controller.workflow.transcript).toEqual(source.transcript);
    expect(controller.workflow.artifacts).toEqual(source.artifacts);
    expect(controller.workflow.summary).toBe(source.summary);
    expect(controller.workflow.insights).toEqual(source.insights);
    expect(retryInsightsMock).toHaveBeenCalledTimes(1);
    expect(retryInsightsMock).toHaveBeenCalledWith(
      {
        taskId: "source-task",
        target: "summary",
        outputLanguage: "en-US",
      },
      undefined,
      expect.any(Function),
    );
    expect(openAccountPanel).not.toHaveBeenCalled();
  });

  test("applies retry progress and preserves the prior dissection after cancellation", async () => {
    let resolveRetry: ((value: WorkerResult) => void) | null = null;
    retryInsightsMock.mockImplementation(
      (_input, _runner, onProgress: (event: WorkerProgressEvent) => void) => {
        onProgress({
          stage: "insights_generating",
          progress: 76,
          message: {
            messageCode: "ai.generation.running",
            args: { attempt: 2, total: 3 },
          },
        });
        return new Promise<WorkerResult>((resolve) => {
          resolveRetry = resolve;
        });
      },
    );
    cancelProcessMock.mockResolvedValue({ status: "cancelling" });
    const source = createHistoryItem({ dissection: TEST_DISSECTION });
    const { render } = await createController();
    let controller = render();
    expect(controller.restoreHistoryItem(source)).toBe(true);
    controller = render();

    const retry = controller.retryInsightGeneration(
      "dissection",
      "zh-CN",
      null,
      createBrowserPreviewAccountStatus(),
      vi.fn(),
    );
    controller = render();

    expect(controller.workflow.progressMessage).toEqual({
      messageCode: "ai.generation.running",
      args: { attempt: 2, total: 3 },
    });
    expect(controller.workflow.progressPercent).toBe(76);
    expect(controller.workflow.text).toBe(source.text);
    expect(controller.workflow.dissection).toEqual(TEST_DISSECTION);

    await controller.cancelCurrentProcessing();
    requireResolver<WorkerResult>(resolveRetry)(
      createWorkerResult({
        status: "failed",
        task_id: source.taskId,
        task_dir: source.taskDir,
        artifacts: {},
        text: "",
        summary: "",
        insights: [],
        transcript: null,
        dissection: null,
        dissection_source_status: null,
        error: {
          code: "WORKER_CANCELLED",
          message: "",
          stage: "insights_generating",
        },
      }),
    );
    await retry;
    controller = render();

    expect(controller.workflow.stage).toBe("completed");
    expect(controller.workflow.text).toBe(source.text);
    expect(controller.workflow.dissection).toEqual(TEST_DISSECTION);
  });
});

describe("useTaskProcessingController closed local-media source", () => {
  beforeEach(() => {
    vi.resetModules();
    cancelProcessMock.mockReset();
    processLocalMediaMock.mockReset();
    retryInsightsMock.mockReset();
    clearLocalMediaSelectionMock.mockReset();
    clearLocalMediaSelectionMock.mockResolvedValue(true);
  });

  test("dispatches token-only local processing and clears the stale composer token on success", async () => {
    processLocalMediaMock.mockResolvedValue(
      createWorkerResult({
        artifacts: {
          audio: "media/audio.wav",
          transcript_txt: "transcript/transcript.txt",
        },
      }),
    );
    const { render } = await createController();
    let controller = render();
    controller.setLocalMediaSelection(LOCAL_SELECTION);
    controller = render();

    await controller.submitTask(
      {
        kind: "local_media",
        selectionToken: LOCAL_SELECTION.selectionToken,
      },
      createBrowserPreviewAccountStatus(),
      vi.fn(),
    );
    controller = render();

    expect(processLocalMediaMock).toHaveBeenCalledWith(
      {
        selectionToken: LOCAL_SELECTION.selectionToken,
        asrModel: "iic/SenseVoiceSmall",
      },
      undefined,
      expect.any(Function),
    );
    expect(controller.workflow.taskSource).toEqual({
      kind: "local_file",
      displayName: "Interview.wmv",
      mediaKind: "video",
    });
    expect(controller.workflow.composerSource).toEqual({ kind: "none" });
  });

  test("retains a local selection on retryable failure but clears it for invalid source", async () => {
    processLocalMediaMock
      .mockResolvedValueOnce(
        createWorkerResult({
          status: "failed",
          task_id: null,
          task_dir: null,
          artifacts: {},
          text: "",
          summary: "",
          transcript: null,
          error: {
            code: "AUDIO_NORMALIZATION_FAILED",
            message: "",
            stage: "video_extracting",
          },
        }),
      )
      .mockResolvedValueOnce(
        createWorkerResult({
          status: "failed",
          task_id: null,
          task_dir: null,
          artifacts: {},
          text: "",
          summary: "",
          transcript: null,
          error: {
            code: "LOCAL_MEDIA_SELECTION_CHANGED",
            message: "",
            stage: "video_extracting",
          },
        }),
      );
    const { render } = await createController();
    let controller = render();
    controller.setLocalMediaSelection(LOCAL_SELECTION);
    controller = render();

    await controller.submitTask(
      { kind: "local_media", selectionToken: LOCAL_SELECTION.selectionToken },
      createBrowserPreviewAccountStatus(),
      vi.fn(),
    );
    controller = render();
    expect(controller.workflow.composerSource).toEqual({
      kind: "local_media",
      selection: LOCAL_SELECTION,
    });

    await controller.submitTask(
      { kind: "local_media", selectionToken: LOCAL_SELECTION.selectionToken },
      createBrowserPreviewAccountStatus(),
      vi.fn(),
    );
    controller = render();
    expect(controller.workflow.composerSource).toEqual({ kind: "none" });
  });

  test("retains a local selection after confirmed cancellation", async () => {
    let resolveWorker: ((result: WorkerResult) => void) | null = null;
    processLocalMediaMock.mockImplementation(
      () =>
        new Promise<WorkerResult>((resolve) => {
          resolveWorker = resolve;
        }),
    );
    cancelProcessMock.mockResolvedValue({ status: "cancelling" });
    const { render } = await createController();
    let controller = render();
    controller.setLocalMediaSelection(LOCAL_SELECTION);
    controller = render();
    const processing = controller.submitTask(
      { kind: "local_media", selectionToken: LOCAL_SELECTION.selectionToken },
      createBrowserPreviewAccountStatus(),
      vi.fn(),
    );
    controller = render();

    await controller.cancelCurrentProcessing();
    requireResolver<WorkerResult>(resolveWorker)(
      createWorkerResult({
        status: "failed",
        task_id: null,
        task_dir: null,
        artifacts: {},
        text: "",
        summary: "",
        transcript: null,
        error: {
          code: "WORKER_CANCELLED",
          message: "",
          stage: "video_extracting",
        },
      }),
    );
    await processing;
    controller = render();

    expect(controller.workflow.stage).toBe("waiting_input");
    expect(controller.workflow.composerSource).toEqual({
      kind: "local_media",
      selection: LOCAL_SELECTION,
    });
    expect(controller.workflow.taskSource).toBeNull();
  });

  test("clears a removed local selection with its exact token and returns to no selection", async () => {
    const { render } = await createController();
    let controller = render();
    controller.setLocalMediaSelection(LOCAL_SELECTION);
    controller = render();

    await expect(controller.removeLocalMediaSelection()).resolves.toBe(true);
    controller = render();

    expect(clearLocalMediaSelectionMock).toHaveBeenCalledWith(
      LOCAL_SELECTION.selectionToken,
    );
    expect(controller.workflow.composerSource).toEqual({ kind: "none" });
  });

  test("keeps DOM form events outside the application controller", () => {
    const source = readFileSync(
      new URL("./useTaskProcessingController.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("FormEvent");
    expect(source).not.toContain("preventDefault");
  });
});

describe("useTaskProcessingController history restore", () => {
  beforeEach(() => {
    vi.resetModules();
    cancelProcessMock.mockReset();
    processLocalMediaMock.mockReset();
    retryInsightsMock.mockReset();
    clearLocalMediaSelectionMock.mockReset();
    clearLocalMediaSelectionMock.mockResolvedValue(true);
  });

  test("rejects history restore during AI retry without mixing task artifacts or insights", async () => {
    let resolveRetry: ((value: WorkerResult) => void) | null = null;
    retryInsightsMock.mockImplementation(
      () =>
        new Promise<WorkerResult>((resolve) => {
          resolveRetry = resolve;
        }),
    );
    const source = createHistoryItem({ taskId: "source-task" });
    const rejected = createHistoryItem({
      taskId: "other-task",
      text: "other transcript",
      summary: "other summary",
      artifacts: { transcript_txt: "other/transcript.txt" },
      insights: [],
    });
    const { render } = await createController();
    let controller = render();
    expect(controller.restoreHistoryItem(source)).toBe(true);
    controller = render();

    const retry = controller.retryInsightGeneration(
      "insights",
      "en-US",
      null,
      createBrowserPreviewAccountStatus(),
      vi.fn(),
    );
    controller = render();
    expect(controller.workflow.stage).toBe("insights_generating");
    expect(retryInsightsMock).toHaveBeenCalledWith(
      {
        taskId: "source-task",
        target: "insights",
        outputLanguage: "en-US",
      },
      undefined,
      expect.any(Function),
    );
    expect(controller.restoreHistoryItem(rejected)).toBe(false);
    requireResolver<WorkerResult>(resolveRetry)(
      createWorkerResult({
        task_id: "source-task",
        task_dir: source.taskDir,
        artifacts: { insights: "ai/fresh-insights.json" },
        text: "",
        summary: "",
        insights: [
          {
            id: 2,
            topic: "fresh insight",
            matchReason: "fresh relevance",
            followUpQuestions: ["fresh question"],
            suitableUse: "fresh use case",
            sourceChunkId: null,
          },
        ],
      }),
    );
    await retry;
    controller = render();

    expect(controller.workflow.taskId).toBe("source-task");
    expect(controller.workflow.taskDir).toBe(source.taskDir);
    expect(controller.workflow.artifacts.transcript_txt).toBe("transcript/transcript.txt");
    expect(controller.workflow.artifacts.insights).toBe("ai/fresh-insights.json");
    expect(controller.workflow.text).toBe("history transcript");
    expect(controller.workflow.insights[0]?.topic).toBe("fresh insight");
    expect(controller.workflow.text).not.toBe("other transcript");
  });

  test("attributes a partial AI retry failure to its typed target and keeps the transcript", async () => {
    retryInsightsMock.mockResolvedValue(
      createWorkerResult({
        status: "partial_completed",
        task_id: "source-task",
        text: "",
        summary: "",
        insights: [],
        error: {
          code: "INSIGHTFLOW_EMPTY_SUMMARY",
          message: "No summary returned.",
          stage: "insights_generating",
        },
      }),
    );
    const source = createHistoryItem({
      taskId: "source-task",
      summary: "",
      artifacts: { transcript_txt: "transcript/transcript.txt" },
      insights: [],
    });
    const { render } = await createController();
    let controller = render();
    expect(controller.restoreHistoryItem(source)).toBe(true);
    controller = render();

    const retry = controller.retryInsightGeneration(
      "summary",
      "zh-TW",
      null,
      createBrowserPreviewAccountStatus(),
      vi.fn(),
    );
    controller = render();
    expect(controller.workflow.activeAiTarget).toBe("summary");
    expect(retryInsightsMock).toHaveBeenCalledWith(
      {
        taskId: "source-task",
        target: "summary",
        outputLanguage: "zh-TW",
      },
      undefined,
      expect.any(Function),
    );

    await retry;
    controller = render();

    expect(controller.workflow.stage).toBe("partial_completed");
    expect(controller.workflow.activeAiTarget).toBeNull();
    expect(controller.workflow.aiErrorTarget).toBe("summary");
    expect(controller.workflow.text).toBe("history transcript");
  });

  test("restores a stable history task as one complete identity and invalidates old progress", async () => {
    const history = createHistoryItem();
    const { render, onResetTaskUi } = await createController();
    let controller = render();

    expect(controller.restoreHistoryItem(history)).toBe(true);
    controller = render();

    expect(onResetTaskUi).toHaveBeenCalledTimes(1);
    expect(controller.workflow.taskId).toBe(history.taskId);
    expect(controller.workflow.taskDir).toBe(history.taskDir);
    expect(controller.workflow.artifacts).toEqual(history.artifacts);
    expect(controller.workflow.text).toBe(history.text);
    expect(controller.workflow.summary).toBe(history.summary);
    expect(controller.workflow.insights).toEqual(history.insights);
    expect(controller.workflow.taskSource).toEqual(history.source);
    expect(controller.workflow.composerSource).toEqual({ kind: "none" });
    expect("setWorkflow" in controller).toBe(false);
  });

  test("restores a local History source and preserves it through AI retry", async () => {
    const history = createHistoryItem({
      source: {
        kind: "local_file",
        displayName: "Interview.wmv",
        mediaKind: "video",
      },
    });
    retryInsightsMock.mockResolvedValue(
      createWorkerResult({
        task_id: history.taskId,
        task_dir: history.taskDir,
        summary: "fresh summary",
      }),
    );
    const { render } = await createController();
    let controller = render();

    expect(controller.restoreHistoryItem(history)).toBe(true);
    controller = render();
    await controller.retryInsightGeneration(
      "summary",
      "en-US",
      null,
      createBrowserPreviewAccountStatus(),
      vi.fn(),
    );
    controller = render();

    expect(controller.workflow.taskSource).toEqual(history.source);
    expect(controller.workflow.composerSource).toEqual({ kind: "none" });
  });

  test("resets only when the successfully deleted history task is current", async () => {
    const history = createHistoryItem();
    const { render, onResetTaskUi } = await createController();
    let controller = render();
    expect(controller.restoreHistoryItem(history)).toBe(true);
    controller = render();
    onResetTaskUi.mockClear();

    expect(controller.completeHistoryTaskDeletion("another-task")).toBe(false);
    controller = render();
    expect(controller.workflow.taskId).toBe(history.taskId);
    expect(onResetTaskUi).not.toHaveBeenCalled();

    expect(controller.completeHistoryTaskDeletion(history.taskId)).toBe(true);
    controller = render();
    expect(controller.workflow.stage).toBe("waiting_input");
    expect(controller.workflow.taskId).toBeNull();
    expect(onResetTaskUi).toHaveBeenCalledTimes(1);

    controller.applyTranscriptSave(history.taskId, {
      task_id: history.taskId,
      text: "late deleted transcript",
      artifacts: { transcript_txt: "transcript/transcript.txt" },
      has_original_backup: true,
    });
    controller = render();
    expect(controller.workflow.taskId).toBeNull();
    expect(controller.workflow.text).toBe("");
  });

  test("applies transcript saves only to the still-current task after history restoration", async () => {
    const first = createHistoryItem({ taskId: "first-task" });
    const second = createHistoryItem({
      taskId: "second-task",
      text: "second transcript",
      artifacts: { transcript_txt: "second/transcript.txt" },
    });
    const { render } = await createController();
    let controller = render();
    expect(controller.restoreHistoryItem(first)).toBe(true);
    controller = render();
    expect(controller.restoreHistoryItem(second)).toBe(true);
    controller = render();

    controller.applyTranscriptSave("first-task", {
      task_id: "first-task",
      text: "late first-task edit",
      artifacts: { transcript_txt: "first/edited.txt" },
      has_original_backup: true,
    });
    controller = render();
    expect(controller.workflow.taskId).toBe("second-task");
    expect(controller.workflow.text).toBe("second transcript");
    expect(controller.workflow.artifacts.transcript_txt).toBe("second/transcript.txt");

    controller.applyTranscriptSave("second-task", {
      task_id: "second-task",
      text: "second edited transcript",
      artifacts: { transcript_txt: "second/edited.txt" },
      has_original_backup: true,
    });
    controller = render();
    expect(controller.workflow.text).toBe("second edited transcript");
    expect(controller.workflow.artifacts.transcript_txt).toBe("second/edited.txt");
  });

  test("marks an existing dissection stale only when a transcript save changes its text", async () => {
    const history = createHistoryItem({
      text: "original transcript",
      dissection: TEST_DISSECTION,
      dissectionStale: false,
    });
    const { render } = await createController();
    let controller = render();
    expect(controller.restoreHistoryItem(history)).toBe(true);
    controller = render();

    controller.applyTranscriptSave(history.taskId, {
      task_id: history.taskId,
      text: "original transcript",
      artifacts: history.artifacts,
      has_original_backup: true,
    });
    controller = render();
    expect(controller.workflow.dissectionStale).toBe(false);

    controller.applyTranscriptSave(history.taskId, {
      task_id: history.taskId,
      text: "edited transcript",
      artifacts: history.artifacts,
      has_original_backup: true,
    });
    controller = render();
    expect(controller.workflow.dissection).toEqual(TEST_DISSECTION);
    expect(controller.workflow.dissectionStale).toBe(true);
  });
});
