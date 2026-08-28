import { beforeEach, describe, expect, test, vi } from "vitest";
import type { HistoryItem, HistoryListItem } from "../../historyClient";
import type { HistoryController } from "./useHistoryController";

type StateUpdater<T> = T | ((current: T) => T);

type HookHarness = {
  resetRender: () => void;
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => T;
  useEffect: () => void;
  useRef: <T>(initialValue: T) => { current: T };
  useState: <T>(initialValue: T | (() => T)) => [T, (next: StateUpdater<T>) => void];
};

const getHistoryMock = vi.fn<() => Promise<HistoryListItem[]>>();
const getHistoryDetailMock = vi.fn<(taskId: string) => Promise<HistoryItem>>();
const deleteHistoryTaskMock = vi.fn<(taskId: string) => Promise<{ taskId: string; deleted: true }>>();

vi.mock("../../historyClient", () => ({
  deleteHistoryTask: deleteHistoryTaskMock,
  getHistory: getHistoryMock,
  getHistoryDetail: getHistoryDetailMock,
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

function createHistoryItem(overrides: Partial<HistoryListItem> = {}): HistoryListItem {
  return {
    taskId: "task-1",
    id: "task-1",
    createdAt: "2026-07-09T00:00:00.000Z",
    source: { kind: "local_file", displayName: "Lecture.mp4", mediaKind: "video" },
    status: "completed",
    taskDir: "D:/StudyMind/tasks/task-1",
    outputDir: "D:/StudyMind/outputs",
    artifacts: { transcript_txt: "transcript/transcript.txt" },
    error: null,
    textPreview: "demo transcript",
    insightsCount: 0,
    title: null,
    ...overrides,
  };
}

function createHistoryDetail(taskId = "task-1"): HistoryItem {
  return {
    taskId,
    source: { kind: "local_file", displayName: "Lecture.mp4", mediaKind: "video" },
    status: "completed",
    taskDir: `D:/StudyMind/tasks/${taskId}`,
    artifacts: { transcript_txt: "transcript/transcript.txt" },
    error: null,
    text: "demo transcript body",
    summary: "",
    transcript: null,
    insights: [],
    dissection: null,
    dissectionStale: false,
    title: null,
  };
}

async function createController(
  onHistoryItemSelected: (item: HistoryItem) => void = vi.fn(),
): Promise<{
  render: () => HistoryController;
  onHistoryItemSelected: typeof onHistoryItemSelected;
  setOnHistoryItemSelected: (callback: (item: HistoryItem) => void) => void;
  onHistoryItemDeleted: ReturnType<typeof vi.fn>;
  onPrepareHistoryItemDeletion: ReturnType<typeof vi.fn>;
}> {
  const harness = createHookHarness();
  let currentOnHistoryItemSelected = onHistoryItemSelected;
  vi.doMock("react", () => ({
    useCallback: harness.useCallback,
    useEffect: harness.useEffect,
    useRef: harness.useRef,
    useState: harness.useState,
  }));
  const { useHistoryController } = await import("./useHistoryController");
  const onHistoryItemDeleted = vi.fn();
  const onPrepareHistoryItemDeletion = vi.fn();

  return {
    render: () => {
      harness.resetRender();
      return useHistoryController({
        onHistoryItemSelected: currentOnHistoryItemSelected,
        onHistoryItemDeleted,
        onPrepareHistoryItemDeletion,
      });
    },
    onHistoryItemSelected,
    setOnHistoryItemSelected: (callback) => {
      currentOnHistoryItemSelected = callback;
    },
    onHistoryItemDeleted,
    onPrepareHistoryItemDeletion,
  };
}

describe("useHistoryController", () => {
  beforeEach(() => {
    vi.resetModules();
    getHistoryMock.mockReset();
    getHistoryDetailMock.mockReset();
    deleteHistoryTaskMock.mockReset();
  });

  test("opens history and loads items", async () => {
    const item = createHistoryItem();
    getHistoryMock.mockResolvedValueOnce([item]);
    const { render } = await createController();

    let controller = render();
    expect(controller.historyOpen).toBe(false);
    expect(controller.historyLoading).toBe(false);

    const load = controller.openHistory();
    controller = render();
    expect(controller.historyOpen).toBe(true);
    expect(controller.historyLoading).toBe(true);
    expect(controller.historyItems).toEqual([]);

    await load;
    controller = render();
    expect(getHistoryMock).toHaveBeenCalledTimes(1);
    expect(controller.historyOpen).toBe(true);
    expect(controller.historyLoading).toBe(false);
    expect(controller.historyItems).toEqual([item]);
    expect(controller.historyNotice).toBeNull();
  });

  test("shows an empty notice when history has no items", async () => {
    getHistoryMock.mockResolvedValueOnce([]);
    const { render } = await createController();

    let controller = render();
    await controller.openHistory();
    controller = render();

    expect(controller.historyOpen).toBe(true);
    expect(controller.historyLoading).toBe(false);
    expect(controller.historyItems).toEqual([]);
    expect(controller.historyNotice).toEqual({ messageCode: "history.notice.empty" });
  });

  test("keeps the sheet open and surfaces load errors", async () => {
    getHistoryMock.mockRejectedValueOnce(new Error("disk unavailable private-token"));
    const { render } = await createController();

    let controller = render();
    await controller.openHistory();
    controller = render();

    expect(controller.historyOpen).toBe(true);
    expect(controller.historyLoading).toBe(false);
    expect(controller.historyItems).toEqual([]);
    expect(controller.historyLoadError).toBe(true);
    expect(controller.historyNotice).toEqual({ messageCode: "history.notice.loadFailed" });
    expect(JSON.stringify(controller.historyNotice)).not.toContain("private-token");
  });

  test("retries a failed history load and clears the failure state", async () => {
    const item = createHistoryItem();
    getHistoryMock
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockResolvedValueOnce([item]);
    const { render } = await createController();

    let controller = render();
    await controller.openHistory();
    controller = render();
    expect(controller.historyLoadError).toBe(true);

    await controller.retryHistoryLoad();
    controller = render();

    expect(getHistoryMock).toHaveBeenCalledTimes(2);
    expect(controller.historyLoadError).toBe(false);
    expect(controller.historyItems).toEqual([item]);
    expect(controller.historyNotice).toBeNull();
  });

  test("ignores a closed list request after the history sheet is reopened", async () => {
    let resolveFirst!: (value: HistoryListItem[]) => void;
    let resolveSecond!: (value: HistoryListItem[]) => void;
    getHistoryMock
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveFirst = resolve; }),
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveSecond = resolve; }),
      );
    const { render } = await createController();

    let controller = render();
    const firstLoad = controller.openHistory();
    controller = render();
    controller.closeHistory();
    controller = render();
    const secondLoad = controller.openHistory();

    resolveFirst([createHistoryItem({ taskId: "stale", id: "stale" })]);
    await firstLoad;
    controller = render();
    expect(controller.historyOpen).toBe(true);
    expect(controller.historyLoading).toBe(true);
    expect(controller.historyItems).toEqual([]);

    const newest = createHistoryItem({ taskId: "newest", id: "newest" });
    resolveSecond([newest]);
    await secondLoad;
    controller = render();
    expect(controller.historyLoading).toBe(false);
    expect(controller.historyItems).toEqual([newest]);
    expect(controller.historyNotice).toBeNull();
  });

  test("selects a history item and closes the sheet", async () => {
    const item = createHistoryItem({ id: "selected-task" });
    const detail = createHistoryDetail(item.taskId);
    getHistoryMock.mockResolvedValueOnce([item]);
    getHistoryDetailMock.mockResolvedValueOnce(detail);
    const { render, onHistoryItemSelected } = await createController();

    let controller = render();
    await controller.openHistory();
    controller = render();
    expect(controller.historyOpen).toBe(true);

    await controller.openHistoryItem(item);
    controller = render();

    expect(getHistoryDetailMock).toHaveBeenCalledWith(item.taskId);
    expect(onHistoryItemSelected).toHaveBeenCalledWith(detail);
    expect(controller.historyOpen).toBe(false);
  });

  test("ignores an older detail response after a newer history selection", async () => {
    const first = createHistoryItem({ taskId: "first", id: "first" });
    const second = createHistoryItem({ taskId: "second", id: "second" });
    let resolveFirst!: (value: HistoryItem) => void;
    let resolveSecond!: (value: HistoryItem) => void;
    getHistoryDetailMock
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveFirst = resolve; }),
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveSecond = resolve; }),
      );
    const { render, onHistoryItemSelected } = await createController();
    const controller = render();

    const firstLoad = controller.openHistoryItem(first);
    const secondLoad = controller.openHistoryItem(second);
    resolveSecond(createHistoryDetail("second"));
    await secondLoad;
    resolveFirst(createHistoryDetail("first"));
    await firstLoad;

    expect(onHistoryItemSelected).toHaveBeenCalledTimes(1);
    expect(onHistoryItemSelected).toHaveBeenCalledWith(createHistoryDetail("second"));
  });

  test("uses the latest selection callback when an older detail request resolves", async () => {
    const item = createHistoryItem({ taskId: "pending", id: "pending" });
    let resolveDetail!: (value: HistoryItem) => void;
    getHistoryDetailMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveDetail = resolve; }),
    );
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const { render, setOnHistoryItemSelected } = await createController(firstCallback);

    const controller = render();
    const pending = controller.openHistoryItem(item);
    setOnHistoryItemSelected(secondCallback);
    render();

    resolveDetail(createHistoryDetail(item.taskId));
    await pending;

    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledWith(createHistoryDetail(item.taskId));
  });

  test("cancels deletion confirmation without invoking Tauri", async () => {
    const item = createHistoryItem();
    const { render } = await createController();

    let controller = render();
    controller.requestHistoryItemDeletion(item);
    controller = render();
    expect(controller.historyDeleteCandidate).toEqual(item);

    controller.cancelHistoryItemDeletion();
    controller = render();

    expect(controller.historyDeleteCandidate).toBeNull();
    expect(deleteHistoryTaskMock).not.toHaveBeenCalled();
  });

  test("clears the notice on demand without touching the list", async () => {
    getHistoryMock.mockRejectedValueOnce(new Error("disk unavailable"));
    const { render } = await createController();

    let controller = render();
    await controller.openHistory();
    controller = render();
    expect(controller.historyNotice).toEqual({
      messageCode: "history.notice.loadFailed",
    });

    controller.clearHistoryNotice();
    controller = render();
    expect(controller.historyNotice).toBeNull();
    expect(controller.historyItems).toEqual([]);
    expect(controller.historyOpen).toBe(true);
  });

  test("removes a task only after confirmed deletion succeeds", async () => {
    const item = createHistoryItem();
    getHistoryMock.mockResolvedValueOnce([item]);
    deleteHistoryTaskMock.mockResolvedValueOnce({ taskId: item.taskId, deleted: true });
    const {
      render,
      onHistoryItemDeleted,
      onPrepareHistoryItemDeletion,
    } = await createController();
    let controller = render();
    await controller.openHistory();
    controller = render();
    controller.requestHistoryItemDeletion(item);
    controller = render();

    await controller.confirmHistoryItemDeletion();
    controller = render();

    expect(onPrepareHistoryItemDeletion).toHaveBeenCalledWith(item.taskId);
    expect(deleteHistoryTaskMock).toHaveBeenCalledWith(item.taskId);
    expect(onHistoryItemDeleted).toHaveBeenCalledWith(item.taskId);
    expect(controller.historyItems).toEqual([]);
    expect(controller.historyDeleteCandidate).toBeNull();
    expect(controller.historyDeleting).toBe(false);
  });

  test("reloads disk history and preserves the candidate after deletion fails", async () => {
    const item = createHistoryItem();
    getHistoryMock.mockResolvedValueOnce([item]).mockResolvedValueOnce([item]);
    deleteHistoryTaskMock.mockRejectedValueOnce(new Error("D:/private/review-secret"));
    const { render, onHistoryItemDeleted } = await createController();
    let controller = render();
    await controller.openHistory();
    controller = render();
    controller.requestHistoryItemDeletion(item);
    controller = render();

    await controller.confirmHistoryItemDeletion();
    controller = render();

    expect(getHistoryMock).toHaveBeenCalledTimes(2);
    expect(onHistoryItemDeleted).not.toHaveBeenCalled();
    expect(controller.historyItems).toEqual([item]);
    expect(controller.historyDeleteCandidate).toEqual(item);
    expect(controller.historyNotice).toEqual({ messageCode: "history.notice.deleteFailed" });
    expect(JSON.stringify(controller.historyNotice)).not.toContain("review-secret");
  });

  test("does not let a deletion recovery list overwrite a reopened sheet", async () => {
    const item = createHistoryItem();
    let resolveRecovery!: (value: HistoryListItem[]) => void;
    let resolveReopen!: (value: HistoryListItem[]) => void;
    getHistoryMock
      .mockResolvedValueOnce([item])
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveRecovery = resolve; }),
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveReopen = resolve; }),
      );
    deleteHistoryTaskMock.mockRejectedValueOnce(new Error("delete failed"));
    const { render } = await createController();

    let controller = render();
    await controller.openHistory();
    controller = render();
    controller.requestHistoryItemDeletion(item);
    controller = render();
    const deletion = controller.confirmHistoryItemDeletion();
    await vi.waitFor(() => expect(getHistoryMock).toHaveBeenCalledTimes(2));

    controller = render();
    controller.closeHistory();
    controller = render();
    const reopened = controller.openHistory();
    const newest = createHistoryItem({ taskId: "newest", id: "newest" });
    resolveReopen([newest]);
    await reopened;

    resolveRecovery([createHistoryItem({ taskId: "stale", id: "stale" })]);
    await deletion;
    controller = render();

    expect(controller.historyOpen).toBe(true);
    expect(controller.historyItems).toEqual([newest]);
    expect(controller.historyNotice).toBeNull();
  });

  test("claims one deletion request and invalidates an older detail response", async () => {
    const item = createHistoryItem();
    let resolveDelete!: (value: { taskId: string; deleted: true }) => void;
    let resolveDetail!: (value: HistoryItem) => void;
    deleteHistoryTaskMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveDelete = resolve; }),
    );
    getHistoryDetailMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveDetail = resolve; }),
    );
    const { render, onHistoryItemSelected, onHistoryItemDeleted } = await createController();
    let controller = render();
    const detail = controller.openHistoryItem(item);
    controller.requestHistoryItemDeletion(item);
    controller = render();
    const firstDelete = controller.confirmHistoryItemDeletion();
    controller = render();
    const secondDelete = controller.confirmHistoryItemDeletion();

    expect(deleteHistoryTaskMock).toHaveBeenCalledTimes(1);
    resolveDelete({ taskId: item.taskId, deleted: true });
    await Promise.all([firstDelete, secondDelete]);
    resolveDetail(createHistoryDetail(item.taskId));
    await detail;

    expect(onHistoryItemDeleted).toHaveBeenCalledOnce();
    expect(onHistoryItemSelected).not.toHaveBeenCalled();
  });
});
