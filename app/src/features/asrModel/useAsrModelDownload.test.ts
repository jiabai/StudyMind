import { beforeEach, describe, expect, test, vi } from "vitest";

type StateUpdater<T> = T | ((current: T) => T);

type HookHarness = {
  resetRender: () => void;
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => T;
  useEffect: () => void;
  useRef: <T>(initialValue: T) => { current: T };
  useState: <T>(initialValue: T | (() => T)) => [T, (next: StateUpdater<T>) => void];
};

const listenMock = vi.fn();
const cancelAsrModelDownloadMock = vi.fn();
const getAsrModelStatusMock = vi.fn();
const downloadAsrModelMock = vi.fn();
const getLlmConfigMock = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

vi.mock("../../settingsClient", () => ({
  ASR_MODEL_DOWNLOAD_PROGRESS_EVENT: "asr-model-download-progress",
  cancelAsrModelDownload: cancelAsrModelDownloadMock,
  getAsrModelStatus: getAsrModelStatusMock,
  downloadAsrModel: downloadAsrModelMock,
  getLlmConfig: getLlmConfigMock,
}));

function createHookHarness(): HookHarness {
  const states: unknown[] = [];
  let cursor = 0;
  return {
    resetRender: () => {
      cursor = 0;
    },
    useCallback: (callback) => callback,
    useEffect: () => undefined,
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

async function createModelDownloadHook() {
  const harness = createHookHarness();
  vi.doMock("react", () => ({
    useCallback: harness.useCallback,
    useEffect: harness.useEffect,
    useRef: harness.useRef,
    useState: harness.useState,
  }));
  const { useAsrModelDownload } = await import("./useAsrModelDownload");
  return () => {
    harness.resetRender();
    return useAsrModelDownload();
  };
}

describe("useAsrModelDownload cancellation", () => {
  beforeEach(() => {
    vi.resetModules();
    listenMock.mockReset();
    cancelAsrModelDownloadMock.mockReset();
    getAsrModelStatusMock.mockReset();
    downloadAsrModelMock.mockReset();
    getLlmConfigMock.mockReset();
  });

  test.each([
    [
      "idle timeout from a bare Tauri rejection",
      "ASR_MODEL_DOWNLOAD_IDLE_TIMEOUT",
      "asrModel.notice.idleTimeout",
    ],
    [
      "idle timeout from an Error rejection",
      new Error("ASR_MODEL_DOWNLOAD_IDLE_TIMEOUT"),
      "asrModel.notice.idleTimeout",
    ],
    [
      "execution timeout from a bare Tauri rejection",
      "ASR_MODEL_DOWNLOAD_EXECUTION_TIMEOUT",
      "asrModel.notice.executionTimeout",
    ],
    [
      "execution timeout from an Error rejection",
      new Error("ASR_MODEL_DOWNLOAD_EXECUTION_TIMEOUT"),
      "asrModel.notice.executionTimeout",
    ],
  ])("handles %s as a retryable terminal failure", async (_label, rejection, noticeCode) => {
    listenMock.mockResolvedValue(() => undefined);
    downloadAsrModelMock
      .mockRejectedValueOnce(rejection)
      .mockResolvedValueOnce({ started: false, status: "cancelled" });
    const render = await createModelDownloadHook();

    let hook = render();
    await hook.startAsrModelDownload();
    hook = render();

    expect(hook.modelDownloadProgress.phase).toBe("failed");
    expect(hook.modelDownloadProgress.message).toEqual({
      messageCode: "model.download.failed",
      args: {},
    });
    expect(hook.modelDownloadNotice).toEqual({ messageCode: noticeCode });
    expect(hook.modelDownloadActive).toBe(false);

    await hook.startAsrModelDownload();
    expect(downloadAsrModelMock).toHaveBeenCalledTimes(2);
  });

  test("keeps unknown or decorated rejection text generic and private", async () => {
    const secret = "Authorization: Bearer model-download-secret";
    listenMock.mockResolvedValue(() => undefined);
    downloadAsrModelMock.mockRejectedValue(
      new Error(`ASR_MODEL_DOWNLOAD_IDLE_TIMEOUT ${secret}`),
    );
    const render = await createModelDownloadHook();

    let hook = render();
    await hook.startAsrModelDownload();
    hook = render();

    expect(hook.modelDownloadProgress.phase).toBe("failed");
    expect(hook.modelDownloadNotice).toEqual({
      messageCode: "asrModel.notice.downloadFailed",
    });
    expect(
      JSON.stringify({
        progress: hook.modelDownloadProgress,
        notice: hook.modelDownloadNotice,
      }),
    ).not.toContain(secret);
  });

  test("restores the running model download after tree termination fails", async () => {
    listenMock.mockResolvedValue(() => undefined);
    downloadAsrModelMock.mockImplementation(() => new Promise(() => undefined));
    cancelAsrModelDownloadMock.mockResolvedValue({
      status: "failed",
      error: "tree termination failed; Authorization: Bearer super-secret",
    });
    const render = await createModelDownloadHook();

    let hook = render();
    void hook.startAsrModelDownload();
    await Promise.resolve();
    hook = render();
    expect(hook.modelDownloadProgress.phase).toBe("running");
    expect(hook.modelDownloadProgress.wireStatus).toBeNull();
    expect(hook.modelDownloadProgress.message).toEqual({
      messageCode: "model.download.preparing",
      args: { model: "iic/SenseVoiceSmall" },
    });

    await hook.cancelCurrentAsrModelDownload();
    hook = render();

    expect(cancelAsrModelDownloadMock).toHaveBeenCalledTimes(1);
    expect(hook.modelDownloadProgress.phase).toBe("running");
    expect(hook.modelDownloadProgress.message).toEqual({
      messageCode: "model.download.preparing",
      args: { model: "iic/SenseVoiceSmall" },
    });
    expect(hook.modelDownloadNotice).toEqual({
      messageCode: "asrModel.notice.cancelFailed",
    });
    expect(JSON.stringify(hook.modelDownloadNotice)).not.toContain("super-secret");
    expect(hook.modelDownloadActive).toBe(true);
  });

  test("shows cancelling until the model worker confirms cancellation", async () => {
    let resolveDownload: ((value: { started: false; status: "cancelled" }) => void) | null = null;
    listenMock.mockResolvedValue(() => undefined);
    downloadAsrModelMock.mockImplementation(
      () =>
        new Promise<{ started: false; status: "cancelled" }>((resolve) => {
          resolveDownload = resolve;
        }),
    );
    cancelAsrModelDownloadMock.mockResolvedValue({ status: "cancelling" });
    const render = await createModelDownloadHook();

    let hook = render();
    const download = hook.startAsrModelDownload();
    await Promise.resolve();
    hook = render();
    await hook.cancelCurrentAsrModelDownload();
    hook = render();
    expect(hook.modelDownloadProgress.phase).toBe("cancelling");
    expect(hook.modelDownloadProgress.wireStatus).toBeNull();
    expect(hook.modelDownloadActive).toBe(true);

    requireResolver<{ started: false; status: "cancelled" }>(resolveDownload)({
      started: false,
      status: "cancelled",
    });
    await download;
    hook = render();

    expect(hook.modelDownloadProgress.phase).toBe("cancelled");
    expect(hook.modelDownloadActive).toBe(false);
  });

  test("does not start the worker after cancellation while listener registration is pending", async () => {
    let resolveListener: ((value: () => void) => void) | null = null;
    const unlisten = vi.fn();
    listenMock.mockImplementation(
      () =>
        new Promise<() => void>((resolve) => {
          resolveListener = resolve;
        }),
    );
    downloadAsrModelMock.mockResolvedValue({ started: false, status: "cancelled" });
    cancelAsrModelDownloadMock.mockResolvedValue({
      status: "failed",
      error: "nothing was running",
    });
    const render = await createModelDownloadHook();

    let hook = render();
    const download = hook.startAsrModelDownload();
    hook = render();
    await hook.cancelCurrentAsrModelDownload();

    requireResolver(resolveListener)(unlisten);
    await download;
    hook = render();

    expect(downloadAsrModelMock).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(hook.modelDownloadProgress.phase).toBe("cancelled");
    expect(hook.modelDownloadProgress.message).toEqual({
      messageCode: "model.download.cancelled",
      args: {},
    });
    expect(hook.modelDownloadNotice).toEqual({
      messageCode: "asrModel.notice.cancelled",
    });
    expect(hook.modelDownloadActive).toBe(false);
  });

  test("keeps a completed wire event after the download invoke resolves", async () => {
    let progressHandler: ((event: { payload: unknown }) => void) | null = null;
    let resolveDownload:
      | ((value: { started: true; status: "completed" }) => void)
      | null = null;
    const unlisten = vi.fn();
    listenMock.mockImplementation(async (_eventName, handler) => {
      progressHandler = handler;
      return unlisten;
    });
    downloadAsrModelMock.mockImplementation(
      () =>
        new Promise<{ started: true; status: "completed" }>((resolve) => {
          resolveDownload = resolve;
        }),
    );
    getAsrModelStatusMock.mockResolvedValue({
      asrModel: "iic/SenseVoiceSmall",
      asrModelDir: "safe-model-dir",
      asrModelAvailable: false,
      asrModelSource: "modelscope",
    });
    const render = await createModelDownloadHook();

    let hook = render();
    const download = hook.startAsrModelDownload();
    await Promise.resolve();

    requireResolver(progressHandler)({
      payload: {
        status: "completed",
        progress: 100,
        message_code: "model.download.completed",
        message_args: { model: "iic/SenseVoiceSmall" },
      },
    });
    hook = render();
    expect(hook.modelDownloadProgress).toEqual({
      phase: "completed",
      wireStatus: "completed",
      message: {
        messageCode: "model.download.completed",
        args: { model: "iic/SenseVoiceSmall" },
      },
      progress: 100,
    });

    requireResolver(resolveDownload)({ started: true, status: "completed" });
    await download;
    hook = render();

    expect(getAsrModelStatusMock).not.toHaveBeenCalled();
    expect(hook.modelDownloadProgress).toEqual({
      phase: "completed",
      wireStatus: "completed",
      message: {
        messageCode: "model.download.completed",
        args: { model: "iic/SenseVoiceSmall" },
      },
      progress: 100,
    });
    expect(hook.modelDownloadNotice).toBeNull();
    expect(hook.modelDownloadActive).toBe(false);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  test("keeps a cancelled wire event after a late timeout rejection", async () => {
    let progressHandler: ((event: { payload: unknown }) => void) | null = null;
    let rejectDownload: ((reason: Error) => void) | null = null;
    const unlisten = vi.fn();
    listenMock.mockImplementation(async (_eventName, handler) => {
      progressHandler = handler;
      return unlisten;
    });
    downloadAsrModelMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectDownload = reject;
        }),
    );
    const render = await createModelDownloadHook();

    let hook = render();
    const download = hook.startAsrModelDownload();
    await Promise.resolve();

    requireResolver(progressHandler)({
      payload: {
        status: "cancelled",
        progress: 58,
        message_code: "model.download.cancelled",
      },
    });
    hook = render();
    expect(hook.modelDownloadProgress).toEqual({
      phase: "cancelled",
      wireStatus: "cancelled",
      message: { messageCode: "model.download.cancelled", args: {} },
      progress: 58,
    });

    requireResolver(rejectDownload)(new Error("ASR_MODEL_DOWNLOAD_IDLE_TIMEOUT"));
    await download;
    hook = render();

    expect(hook.modelDownloadProgress).toEqual({
      phase: "cancelled",
      wireStatus: "cancelled",
      message: { messageCode: "model.download.cancelled", args: {} },
      progress: 58,
    });
    expect(hook.modelDownloadNotice).toBeNull();
    expect(hook.modelDownloadActive).toBe(false);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  test("keeps the local cancelling phase when a late non-terminal wire event arrives", async () => {
    let progressHandler: ((event: { payload: unknown }) => void) | null = null;
    let resolveCancellation: ((value: { status: "cancelling" }) => void) | null = null;
    listenMock.mockImplementation(async (_eventName, handler) => {
      progressHandler = handler;
      return () => undefined;
    });
    downloadAsrModelMock.mockImplementation(() => new Promise(() => undefined));
    cancelAsrModelDownloadMock.mockImplementation(
      () =>
        new Promise<{ status: "cancelling" }>((resolve) => {
          resolveCancellation = resolve;
        }),
    );
    const render = await createModelDownloadHook();

    let hook = render();
    void hook.startAsrModelDownload();
    await Promise.resolve();
    hook = render();
    const cancellation = hook.cancelCurrentAsrModelDownload();
    hook = render();
    expect(hook.modelDownloadProgress.phase).toBe("cancelling");

    requireResolver(progressHandler)({
      payload: {
        status: "downloading",
        progress: 64,
        message_code: "model.file.downloading",
        current_file: "model.pt",
      },
    });
    hook = render();

    expect(hook.modelDownloadProgress.phase).toBe("cancelling");
    expect(hook.modelDownloadProgress.progress).toBe(64);
    expect(hook.modelDownloadProgress.message).toEqual({
      messageCode: "model.cancel.requested",
      args: {},
    });
    expect(hook.modelDownloadActive).toBe(true);

    requireResolver(resolveCancellation)({ status: "cancelling" });
    await cancellation;
  });

  test("keeps a terminal event when an older cancel failure resolves later", async () => {
    let progressHandler: ((event: { payload: unknown }) => void) | null = null;
    let resolveCancellation:
      | ((value: { status: "failed"; error: string }) => void)
      | null = null;
    listenMock.mockImplementation(async (_eventName, handler) => {
      progressHandler = handler;
      return () => undefined;
    });
    downloadAsrModelMock.mockImplementation(() => new Promise(() => undefined));
    cancelAsrModelDownloadMock.mockImplementation(
      () =>
        new Promise<{ status: "failed"; error: string }>((resolve) => {
          resolveCancellation = resolve;
        }),
    );
    const render = await createModelDownloadHook();

    let hook = render();
    void hook.startAsrModelDownload();
    await Promise.resolve();
    hook = render();
    const cancellation = hook.cancelCurrentAsrModelDownload();

    requireResolver(progressHandler)({
      payload: {
        status: "cancelled",
        progress: 73,
        message_code: "model.download.cancelled",
      },
    });
    hook = render();
    expect(hook.modelDownloadProgress).toEqual({
      phase: "cancelled",
      wireStatus: "cancelled",
      message: { messageCode: "model.download.cancelled", args: {} },
      progress: 73,
    });

    requireResolver(resolveCancellation)({
      status: "failed",
      error: "Authorization: Bearer stale-secret",
    });
    await cancellation;
    hook = render();

    expect(hook.modelDownloadProgress).toEqual({
      phase: "cancelled",
      wireStatus: "cancelled",
      message: { messageCode: "model.download.cancelled", args: {} },
      progress: 73,
    });
    expect(hook.modelDownloadNotice).not.toEqual({
      messageCode: "asrModel.notice.cancelFailed",
    });
    expect(JSON.stringify(hook)).not.toContain("stale-secret");
  });

  test("resumes from the newest non-terminal progress after cancellation fails", async () => {
    let progressHandler: ((event: { payload: unknown }) => void) | null = null;
    let resolveCancellation:
      | ((value: { status: "failed"; error: string }) => void)
      | null = null;
    listenMock.mockImplementation(async (_eventName, handler) => {
      progressHandler = handler;
      return () => undefined;
    });
    downloadAsrModelMock.mockImplementation(() => new Promise(() => undefined));
    cancelAsrModelDownloadMock.mockImplementation(
      () =>
        new Promise<{ status: "failed"; error: string }>((resolve) => {
          resolveCancellation = resolve;
        }),
    );
    const render = await createModelDownloadHook();

    let hook = render();
    void hook.startAsrModelDownload();
    await Promise.resolve();
    hook = render();
    const cancellation = hook.cancelCurrentAsrModelDownload();

    requireResolver(progressHandler)({
      payload: {
        status: "downloading",
        progress: 64,
        message_code: "model.file.downloading",
        current_file: "model.pt",
      },
    });
    requireResolver(resolveCancellation)({
      status: "failed",
      error: "tree termination failed",
    });
    await cancellation;
    hook = render();

    expect(hook.modelDownloadProgress).toEqual({
      phase: "running",
      wireStatus: "downloading",
      message: {
        messageCode: "model.file.downloading",
        args: {},
      },
      progress: 64,
      currentFile: "model.pt",
    });
    expect(hook.modelDownloadNotice).toEqual({
      messageCode: "asrModel.notice.cancelFailed",
    });
  });

  test("applies only strict wire events and does not refresh state or time for invalid payloads", async () => {
    let progressHandler: ((event: { payload: unknown }) => void) | null = null;
    listenMock.mockImplementation(async (_eventName, handler) => {
      progressHandler = handler;
      return () => undefined;
    });
    downloadAsrModelMock.mockImplementation(() => new Promise(() => undefined));
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const render = await createModelDownloadHook();

    let hook = render();
    void hook.startAsrModelDownload();
    await Promise.resolve();
    hook = render();
    const validHandler = requireResolver(progressHandler);

    validHandler({
      payload: {
        status: "downloading",
        progress: 42,
        message_code: "model.file.downloading",
        current_file: "model.pt",
      },
    });
    hook = render();
    expect(hook.modelDownloadProgress).toEqual({
      phase: "running",
      wireStatus: "downloading",
      progress: 42,
      message: { messageCode: "model.file.downloading", args: {} },
      currentFile: "model.pt",
    });
    const validState = hook.modelDownloadProgress;
    const timeCallsAfterValidEvent = now.mock.calls.length;

    validHandler({
      payload: {
        status: "downloading",
        progress: 99,
        message_code: "model.file.downloading",
        current_file: "../private/model.pt",
        message: "raw https://secret.example/private",
      },
    });
    hook = render();

    expect(hook.modelDownloadProgress).toBe(validState);
    expect(hook.modelDownloadStalled).toBe(false);
    expect(now).toHaveBeenCalledTimes(timeCallsAfterValidEvent);
    expect(warning).toHaveBeenLastCalledWith(
      "Dropped invalid model download progress event: model.file.downloading",
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain("secret.example");

    validHandler({
      payload: {
        status: "downloading",
        progress: 55,
        message_code: "future.action.running",
      },
    });
    hook = render();

    expect(hook.modelDownloadProgress.message).toEqual({
      messageCode: "future.action.running",
      args: {},
    });
    expect(warning).toHaveBeenLastCalledWith(
      "Unknown model download progress code: future.action.running",
    );

    now.mockRestore();
    warning.mockRestore();
  });

  test("checks the selected model only when a task asks to ensure readiness", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    getLlmConfigMock.mockResolvedValue({ asrModel: "iic/SenseVoiceSmall-onnx" });
    getAsrModelStatusMock.mockResolvedValue({
      asrModel: "iic/SenseVoiceSmall-onnx",
      asrModelDir: "safe-model-dir/onnx",
      asrModelAvailable: true,
      asrModelSource: "modelscope",
    });
    const render = await createModelDownloadHook();

    let hook = render();
    expect(getAsrModelStatusMock).not.toHaveBeenCalled();

    await expect(hook.ensureAsrModelReady()).resolves.toBe("iic/SenseVoiceSmall-onnx");
    hook = render();

    expect(getAsrModelStatusMock).toHaveBeenCalledWith("iic/SenseVoiceSmall-onnx");
    expect(downloadAsrModelMock).not.toHaveBeenCalled();
    expect(hook.asrModelStatus).toMatchObject({
      model: "iic/SenseVoiceSmall-onnx",
      available: true,
    });
    vi.unstubAllGlobals();
  });
});
