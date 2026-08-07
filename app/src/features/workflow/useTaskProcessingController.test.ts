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
const processVideoMock = vi.fn();
const retryInsightsMock = vi.fn();
const clearLocalMediaSelectionMock = vi.fn();

const SUBMITTED_URL = "https://www.douyin.com/video/7524373044106677544";
const URL_SUBMISSION = { kind: "url", url: SUBMITTED_URL } as const;
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
  processVideo: processVideoMock,
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
      kind: "url",
      url: "https://www.example.test/history-video",
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

describe("useTaskProcessingController cancellation", () => {
  beforeEach(() => {
    vi.resetModules();
    cancelProcessMock.mockReset();
    processLocalMediaMock.mockReset();
    processVideoMock.mockReset();
    retryInsightsMock.mockReset();
    clearLocalMediaSelectionMock.mockReset();
    clearLocalMediaSelectionMock.mockResolvedValue(true);
  });

  test("keeps the workflow and operation active when process termination fails", async () => {
    processVideoMock.mockImplementation(() => new Promise<WorkerResult>(() => undefined));
    cancelProcessMock.mockResolvedValue({
      status: "failed",
      error: "tree termination failed",
    });
    const { render, onResetTaskUi } = await createController();

    let controller = render();
    controller.updateUrlDraft(SUBMITTED_URL);
    controller = render();
    void controller.submitTask(
      URL_SUBMISSION,
      createBrowserPreviewAccountStatus(),
      vi.fn(),
    );
    controller = render();

    await controller.cancelCurrentProcessing();
    controller = render();

    expect(cancelProcessMock).toHaveBeenCalledTimes(1);
    expect(onResetTaskUi).not.toHaveBeenCalled();
    expect(controller.workflow.stage).toBe("video_extracting");
    expect(controller.workflow.statusMessage).toEqual({
      messageCode: "workflow.cancellation.failed",
    });
  });

  test("claims a user cancellation once while the signal request is pending", async () => {
    processVideoMock.mockImplementation(() => new Promise<WorkerResult>(() => undefined));
    let resolveCancel: ((value: { status: "cancelling" }) => void) | null = null;
    cancelProcessMock.mockImplementation(
      () =>
        new Promise<{ status: "cancelling" }>((resolve) => {
          resolveCancel = resolve;
        }),
    );
    const { render } = await createController();

    let controller = render();
    controller.updateUrlDraft(SUBMITTED_URL);
    controller = render();
    void controller.submitTask(
      URL_SUBMISSION,
      createBrowserPreviewAccountStatus(),
      vi.fn(),
    );
    controller = render();
    const firstCancel = controller.cancelCurrentProcessing();
    controller = render();
    const secondCancel = controller.cancelCurrentProcessing();

    expect(controller.workflow.stage).toBe("cancelling");
    expect(cancelProcessMock).toHaveBeenCalledTimes(1);
    requireResolver<{ status: "cancelling" }>(resolveCancel)({ status: "cancelling" });
    await Promise.all([firstCancel, secondCancel]);
  });

  test("resets only after the worker confirms cancellation", async () => {
    let resolveWorker: ((value: { status: "failed"; task_id: null; task_dir: null; artifacts: {}; text: string; summary: string; insights: []; transcript: null; error: { code: string; message: string; stage: "video_extracting" } }) => void) | null = null;
    processVideoMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWorker = resolve;
        }),
    );
    cancelProcessMock.mockResolvedValue({ status: "cancelling" });
    const { render, onResetTaskUi } = await createController();
    let controller = render();
    controller.updateUrlDraft(SUBMITTED_URL);
    controller = render();
    const processing = controller.submitTask(
      URL_SUBMISSION,
      createBrowserPreviewAccountStatus(),
      vi.fn(),
    );
    controller = render();

    await controller.cancelCurrentProcessing();
    controller = render();
    expect(controller.workflow.stage).toBe("cancelling");
    expect(onResetTaskUi).not.toHaveBeenCalled();

    requireResolver<{
      status: "failed";
      task_id: null;
      task_dir: null;
      artifacts: {};
      text: string;
      summary: string;
      insights: [];
      transcript: null;
      error: { code: string; message: string; stage: "video_extracting" };
    }>(resolveWorker)({
      status: "failed",
      task_id: null,
      task_dir: null,
      artifacts: {},
      text: "",
      summary: "",
      insights: [],
      transcript: null,
      error: {
        code: "WORKER_CANCELLED",
        message: "Worker process was cancelled.",
        stage: "video_extracting",
      },
    });
    await processing;
    controller = render();

    expect(onResetTaskUi).toHaveBeenCalledTimes(1);
    expect(controller.workflow.stage).toBe("waiting_input");
  });

  test("does not invalidate a running operation before its terminal result is known", async () => {
    let resolveWorker: ((value: { status: "completed"; task_id: string; task_dir: string; artifacts: {}; text: string; summary: string; insights: []; transcript: null; error: null }) => void) | null = null;
    processVideoMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWorker = resolve;
        }),
    );
    cancelProcessMock.mockResolvedValue({ status: "failed", error: "tree termination failed" });
    const { render } = await createController();
    let controller = render();

    controller.updateUrlDraft(SUBMITTED_URL);
    controller = render();
    const started = controller.submitTask(
      URL_SUBMISSION,
      createBrowserPreviewAccountStatus(),
      vi.fn(),
    );
    controller = render();
    await controller.cancelCurrentProcessing();
    requireResolver<{
      status: "completed";
      task_id: string;
      task_dir: string;
      artifacts: {};
      text: string;
      summary: string;
      insights: [];
      transcript: null;
      error: null;
    }>(resolveWorker)({
      status: "completed",
      task_id: "task-1",
      task_dir: "D:/StudyMind/outputs/task-1",
      artifacts: {},
      text: "final transcript",
      summary: "",
      insights: [],
      transcript: null,
      error: null,
    });
    await started;
    controller = render();

    expect(controller.workflow.stage).toBe("completed");
    expect(controller.workflow.text).toBe("final transcript");
  });
});

describe("useTaskProcessingController watchdog timeouts", () => {
  beforeEach(() => {
    vi.resetModules();
    cancelProcessMock.mockReset();
    processLocalMediaMock.mockReset();
    processVideoMock.mockReset();
    retryInsightsMock.mockReset();
    clearLocalMediaSelectionMock.mockReset();
    clearLocalMediaSelectionMock.mockResolvedValue(true);
  });

  test("clears process busy state after timeout without starting another process command", async () => {
    processVideoMock.mockResolvedValue(
      createWorkerResult({
        status: "failed",
        task_id: null,
        task_dir: null,
        artifacts: {},
        text: "",
        summary: "",
        insights: [],
        transcript: null,
        error: {
          code: "WORKER_IDLE_TIMEOUT",
          message: "Worker process made no progress for too long.",
          stage: "video_extracting",
        },
      }),
    );
    const { render } = await createController();
    let controller = render();
    controller.updateUrlDraft(SUBMITTED_URL);
    controller = render();

    await controller.submitTask(
      URL_SUBMISSION,
      createBrowserPreviewAccountStatus(),
      vi.fn(),
    );
    controller = render();

    expect(controller.workflow.stage).toBe("failed");
    expect(controller.workflow.error?.code).toBe("WORKER_IDLE_TIMEOUT");
    expect(controller.canRestoreHistory).toBe(true);
    expect(controller.toolbarNewTaskButtonState.disabled).toBe(false);
    expect(processVideoMock).toHaveBeenCalledTimes(1);

    controller.startNewTaskFromToolbar();
    controller = render();
    expect(controller.workflow.stage).toBe("waiting_input");
    expect(processVideoMock).toHaveBeenCalledTimes(1);
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
    processVideoMock.mockReset();
    retryInsightsMock.mockReset();
    clearLocalMediaSelectionMock.mockReset();
    clearLocalMediaSelectionMock.mockResolvedValue(true);
  });

  test("keeps the original input when preparing the selected model is cancelled or fails", async () => {
    const ensureAsrModelReady = vi.fn().mockResolvedValue(null);
    const { render } = await createController({ ensureAsrModelReady });
    let controller = render();
    controller.updateUrlDraft(SUBMITTED_URL);
    controller = render();

    await controller.submitTask(
      URL_SUBMISSION,
      createBrowserPreviewAccountStatus(),
      vi.fn(),
    );
    controller = render();

    expect(ensureAsrModelReady).toHaveBeenCalledTimes(1);
    expect(processVideoMock).not.toHaveBeenCalled();
    expect(controller.workflow.stage).toBe("waiting_input");
    expect(controller.workflow.composerSource).toEqual({
      kind: "url",
      urlDraft: SUBMITTED_URL,
    });
  });

  test("freezes the ready ONNX model snapshot into the worker submission", async () => {
    const ensureAsrModelReady = vi
      .fn()
      .mockResolvedValue("iic/SenseVoiceSmall-onnx");
    processVideoMock.mockResolvedValue(createWorkerResult());
    const { render } = await createController({ ensureAsrModelReady });
    let controller = render();
    controller.updateUrlDraft(SUBMITTED_URL);
    controller = render();

    await controller.submitTask(
      URL_SUBMISSION,
      createBrowserPreviewAccountStatus(),
      vi.fn(),
    );

    expect(processVideoMock).toHaveBeenCalledWith(
      SUBMITTED_URL,
      "iic/SenseVoiceSmall-onnx",
      undefined,
      expect.any(Function),
    );
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
    controller.updateUrlDraft("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    controller = render();
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
    expect(processVideoMock).not.toHaveBeenCalled();
    expect(controller.workflow.taskSource).toEqual({
      kind: "local_file",
      displayName: "Interview.wmv",
      mediaKind: "video",
    });
    expect(controller.workflow.composerSource).toEqual({
      kind: "url",
      urlDraft: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
  });

  test("rejects a submission that does not match the active composer branch", async () => {
    const { render } = await createController();
    let controller = render();
    controller.setLocalMediaSelection(LOCAL_SELECTION);
    controller = render();

    await controller.submitTask(
      URL_SUBMISSION,
      createBrowserPreviewAccountStatus(),
      vi.fn(),
    );

    expect(processVideoMock).not.toHaveBeenCalled();
    expect(processLocalMediaMock).not.toHaveBeenCalled();
    controller = render();
    expect(controller.workflow.stage).toBe("waiting_input");
    expect(controller.workflow.composerSource.kind).toBe("local_media");
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
      retainedUrlDraft: "",
    });

    await controller.submitTask(
      { kind: "local_media", selectionToken: LOCAL_SELECTION.selectionToken },
      createBrowserPreviewAccountStatus(),
      vi.fn(),
    );
    controller = render();
    expect(controller.workflow.composerSource).toEqual({
      kind: "url",
      urlDraft: "",
    });
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
      retainedUrlDraft: "",
    });
    expect(controller.workflow.taskSource).toBeNull();
  });

  test("clears a removed local selection with its exact token and restores the retained URL", async () => {
    const { render } = await createController();
    let controller = render();
    controller.updateUrlDraft("https://youtu.be/dQw4w9WgXcQ");
    controller = render();
    controller.setLocalMediaSelection(LOCAL_SELECTION);
    controller = render();

    await expect(controller.removeLocalMediaSelection()).resolves.toBe(true);
    controller = render();

    expect(clearLocalMediaSelectionMock).toHaveBeenCalledWith(
      LOCAL_SELECTION.selectionToken,
    );
    expect(controller.workflow.composerSource).toEqual({
      kind: "url",
      urlDraft: "https://youtu.be/dQw4w9WgXcQ",
    });
  });

  test("keeps DOM form events outside the application controller", () => {
    const source = readFileSync(
      new URL("./useTaskProcessingController.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("FormEvent");
    expect(source).not.toContain("preventDefault");
    expect(source).not.toContain("submitUrl");
  });
});

describe("useTaskProcessingController history restore", () => {
  beforeEach(() => {
    vi.resetModules();
    cancelProcessMock.mockReset();
    processLocalMediaMock.mockReset();
    processVideoMock.mockReset();
    retryInsightsMock.mockReset();
    clearLocalMediaSelectionMock.mockReset();
    clearLocalMediaSelectionMock.mockResolvedValue(true);
  });

  test("rejects history restore while video processing and keeps the active result authoritative", async () => {
    let progress: ((event: WorkerProgressEvent) => void) | null = null;
    let resolveWorker: ((value: WorkerResult) => void) | null = null;
    processVideoMock.mockImplementation(
      (
        _url: string,
        _asrModel: string,
        _runner: unknown,
        onProgress?: (event: WorkerProgressEvent) => void,
      ) => {
        progress = onProgress ?? null;
        return new Promise<WorkerResult>((resolve) => {
          resolveWorker = resolve;
        });
      },
    );
    const { render } = await createController();
    let controller = render();
    controller.updateUrlDraft(SUBMITTED_URL);
    controller = render();
    const processing = controller.submitTask(
      URL_SUBMISSION,
      createBrowserPreviewAccountStatus(),
      vi.fn(),
    );
    controller = render();

    expect(controller.restoreHistoryItem(createHistoryItem())).toBe(false);
    expect(controller.workflow.stage).toBe("video_extracting");
    expect(controller.canRestoreHistory).toBe(false);
    requireResolver<WorkerProgressEvent>(progress)({
      stage: "video_transcribing",
      message: { messageCode: "asr.transcribe.running", args: {} },
      progress: 60,
    });
    requireResolver<WorkerResult>(resolveWorker)(createWorkerResult());
    await processing;
    controller = render();

    expect(controller.workflow.taskId).toBe("active-task");
    expect(controller.workflow.text).toBe("active transcript");
    expect(controller.workflow.stage).toBe("completed");
    expect(controller.canRestoreHistory).toBe(true);
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

  test("rejects history restore while cancelling and accepts the natural terminal result", async () => {
    let resolveWorker: ((value: WorkerResult) => void) | null = null;
    processVideoMock.mockImplementation(
      () =>
        new Promise<WorkerResult>((resolve) => {
          resolveWorker = resolve;
        }),
    );
    cancelProcessMock.mockResolvedValue({ status: "cancelling" });
    const { render } = await createController();
    let controller = render();
    controller.updateUrlDraft(SUBMITTED_URL);
    controller = render();
    const processing = controller.submitTask(
      URL_SUBMISSION,
      createBrowserPreviewAccountStatus(),
      vi.fn(),
    );
    controller = render();
    await controller.cancelCurrentProcessing();
    controller = render();

    expect(controller.workflow.stage).toBe("cancelling");
    expect(controller.canRestoreHistory).toBe(false);
    expect(controller.restoreHistoryItem(createHistoryItem())).toBe(false);
    requireResolver<WorkerResult>(resolveWorker)(createWorkerResult());
    await processing;
    controller = render();

    expect(controller.workflow.taskId).toBe("active-task");
    expect(controller.workflow.stage).toBe("completed");
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
    expect(controller.workflow.composerSource).toEqual({
      kind: "url",
      urlDraft:
        history.source.kind === "url" ? history.source.url : "",
    });
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
    expect(controller.workflow.composerSource).toEqual({
      kind: "url",
      urlDraft: "",
    });
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

  test("refuses deletion completion while the workflow is active", async () => {
    processVideoMock.mockImplementation(() => new Promise<WorkerResult>(() => undefined));
    const { render, onResetTaskUi } = await createController();
    let controller = render();
    controller.updateUrlDraft(SUBMITTED_URL);
    controller = render();
    void controller.submitTask(
      URL_SUBMISSION,
      createBrowserPreviewAccountStatus(),
      vi.fn(),
    );
    controller = render();

    expect(controller.completeHistoryTaskDeletion("active-task")).toBe(false);
    controller = render();
    expect(controller.workflow.stage).toBe("video_extracting");
    expect(onResetTaskUi).not.toHaveBeenCalled();
  });

  test("ignores late progress and a terminal result from an invalidated operation after restoring history", async () => {
    let progress: ((event: WorkerProgressEvent) => void) | null = null;
    let resolveWorker: ((value: WorkerResult) => void) | null = null;
    processVideoMock.mockImplementation(
      (
        _url: string,
        _asrModel: string,
        _runner: unknown,
        onProgress?: (event: WorkerProgressEvent) => void,
      ) => {
        progress = onProgress ?? null;
        return new Promise<WorkerResult>((resolve) => {
          resolveWorker = resolve;
        });
      },
    );
    const history = createHistoryItem();
    const { render } = await createController();
    let controller = render();
    controller.updateUrlDraft(SUBMITTED_URL);
    controller = render();
    const oldProcessing = controller.submitTask(
      URL_SUBMISSION,
      createBrowserPreviewAccountStatus(),
      vi.fn(),
    );
    controller = render();

    controller.resetWorkflow();
    controller = render();
    expect(controller.restoreHistoryItem(history)).toBe(true);
    controller = render();
    requireResolver<WorkerProgressEvent>(progress)({
      stage: "video_transcribing",
      message: { messageCode: "asr.transcribe.running", args: {} },
      progress: 80,
    });
    requireResolver<WorkerResult>(resolveWorker)(createWorkerResult());
    await oldProcessing;
    controller = render();

    expect(controller.workflow.taskId).toBe(history.taskId);
    expect(controller.workflow.text).toBe(history.text);
    expect(controller.workflow.summary).toBe(history.summary);
    expect(controller.workflow.insights).toEqual(history.insights);
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
