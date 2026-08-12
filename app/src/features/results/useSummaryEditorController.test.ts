import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SetStateAction } from "react";

import { createInitialWorkflow, type WorkflowState } from "../../workflow";
import { uiMessage, type UiMessage } from "../../i18n/uiMessage";

type StateUpdater<T> = T | ((current: T) => T);

type HookHarness = {
  resetRender: () => void;
  flushEffects: () => void;
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => T;
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => void;
  useRef: <T>(initialValue: T) => { current: T };
  useState: <T>(initialValue: T | (() => T)) => [T, (next: StateUpdater<T>) => void];
};

type SummaryEditorController = {
  summaryEditing: boolean;
  summaryDraft: string;
  summaryDirty: boolean;
  summarySaving: boolean;
  beginSummaryEdit: () => void;
  cancelSummaryEdit: () => void;
  updateSummaryDraft: (next: string) => void;
  saveSummaryDraft: () => Promise<void>;
};

const saveSummaryEditMock = vi.fn();

vi.mock("../../summaryClient", () => ({
  saveSummaryEdit: saveSummaryEditMock,
}));

function createHookHarness(): HookHarness {
  const states: unknown[] = [];
  const effects: Array<{
    callback: () => void | (() => void);
    deps?: readonly unknown[];
    previousDeps?: readonly unknown[];
    cleanup?: () => void;
  }> = [];
  let cursor = 0;

  return {
    resetRender: () => {
      cursor = 0;
    },
    flushEffects: () => {
      for (const effect of effects) {
        if (!effect) {
          continue;
        }
        const changed =
          effect.previousDeps === undefined ||
          effect.deps === undefined ||
          effect.deps.length !== effect.previousDeps.length ||
          effect.deps.some((value, index) => !Object.is(value, effect.previousDeps?.[index]));
        if (!changed) {
          continue;
        }
        effect.cleanup?.();
        effect.previousDeps = effect.deps;
        const cleanup = effect.callback();
        effect.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      }
    },
    useCallback: (callback) => callback,
    useEffect: (callback, deps) => {
      const effectIndex = cursor;
      cursor += 1;
      if (!effects[effectIndex]) {
        effects[effectIndex] = { callback, deps };
      } else {
        effects[effectIndex].callback = callback;
        effects[effectIndex].deps = deps;
      }
    },
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

function createWorkflow(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    ...createInitialWorkflow(),
    taskId: "task-1",
    taskDir: "D:/StudyMind/tasks/task-1",
    artifacts: { summary: "ai/summary.md" },
    summary: "original summary",
    ...overrides,
  };
}

async function createController(
  workflow: WorkflowState,
): Promise<{
  harness: HookHarness;
  render: (nextWorkflow?: WorkflowState) => SummaryEditorController;
  applySummarySave: ReturnType<typeof vi.fn>;
  setActionNotice: ReturnType<typeof vi.fn<
    (next: SetStateAction<UiMessage | null>) => void
  >>;
}> {
  const harness = createHookHarness();
  const applySummarySave = vi.fn();
  const setActionNotice = vi.fn<
    (next: SetStateAction<UiMessage | null>) => void
  >();
  let currentWorkflow = workflow;

  vi.doMock("react", () => ({
    useCallback: harness.useCallback,
    useEffect: harness.useEffect,
    useRef: harness.useRef,
    useState: harness.useState,
  }));
  const { useSummaryEditorController } = await import("./useSummaryEditorController");

  return {
    harness,
    applySummarySave,
    setActionNotice,
    render: (nextWorkflow = currentWorkflow) => {
      currentWorkflow = nextWorkflow;
      harness.resetRender();
      let controller = useSummaryEditorController({
        workflow: currentWorkflow,
        applySummarySave,
        setActionNotice,
      });
      harness.flushEffects();
      harness.resetRender();
      controller = useSummaryEditorController({
        workflow: currentWorkflow,
        applySummarySave,
        setActionNotice,
      });
      harness.flushEffects();
      return controller;
    },
  };
}

describe("useSummaryEditorController", () => {
  beforeEach(() => {
    vi.resetModules();
    saveSummaryEditMock.mockReset();
  });

  test("starts from the saved summary and supports edit, update, and cancel", async () => {
    const { render } = await createController(createWorkflow());
    let controller = render();

    expect(controller.summaryEditing).toBe(false);
    expect(controller.summaryDraft).toBe("original summary");
    expect(controller.summaryDirty).toBe(false);
    expect(Object.keys(controller).sort()).toEqual([
      "beginSummaryEdit",
      "cancelSummaryEdit",
      "saveSummaryDraft",
      "summaryDirty",
      "summaryDraft",
      "summaryEditing",
      "summarySaving",
      "updateSummaryDraft",
    ]);

    controller.beginSummaryEdit();
    controller = render();
    controller.updateSummaryDraft("edited summary");
    controller = render();
    expect(controller.summaryEditing).toBe(true);
    expect(controller.summaryDraft).toBe("edited summary");
    expect(controller.summaryDirty).toBe(true);

    controller.cancelSummaryEdit();
    controller = render();
    expect(controller.summaryEditing).toBe(false);
    expect(controller.summaryDraft).toBe("original summary");
    expect(controller.summaryDirty).toBe(false);
  });

  test("saves once and applies a matching response", async () => {
    let resolveSave: ((value: { task_id: string; summary: string }) => void) | undefined;
    saveSummaryEditMock.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    const { render, applySummarySave, setActionNotice } = await createController(createWorkflow());
    let controller = render();
    controller.beginSummaryEdit();
    controller = render();
    controller.updateSummaryDraft("edited summary");
    controller = render();

    const firstSave = controller.saveSummaryDraft();
    controller = render();
    const secondSave = controller.saveSummaryDraft();
    expect(saveSummaryEditMock).toHaveBeenCalledTimes(1);
    expect(controller.summarySaving).toBe(true);

    resolveSave?.({ task_id: "task-1", summary: "saved summary" });
    await Promise.all([firstSave, secondSave]);
    controller = render();
    expect(applySummarySave).toHaveBeenCalledWith("task-1", {
      task_id: "task-1",
      summary: "saved summary",
    });
    expect(controller.summaryEditing).toBe(false);
    expect(controller.summaryDraft).toBe("saved summary");
    expect(controller.summaryDirty).toBe(false);
    expect(controller.summarySaving).toBe(false);
    expect(setActionNotice).toHaveBeenLastCalledWith(uiMessage("synthesis.detail.summarySaved"));
  });

  test("does not submit when prerequisites are missing and reports blank saves", async () => {
    const { render, setActionNotice } = await createController(
      createWorkflow({ summary: "   " }),
    );
    let controller = render();
    controller.beginSummaryEdit();
    controller = render();
    await controller.saveSummaryDraft();
    expect(saveSummaryEditMock).not.toHaveBeenCalled();
    expect(setActionNotice).toHaveBeenLastCalledWith(uiMessage("synthesis.detail.summaryEmptySave"));

    const noTask = await createController(createWorkflow({ taskId: null }));
    controller = noTask.render();
    controller.beginSummaryEdit();
    controller = noTask.render();
    await controller.saveSummaryDraft();
    expect(saveSummaryEditMock).not.toHaveBeenCalled();

    const noArtifact = await createController(createWorkflow({ artifacts: {} }));
    controller = noArtifact.render();
    controller.beginSummaryEdit();
    controller = noArtifact.render();
    await controller.saveSummaryDraft();
    expect(saveSummaryEditMock).not.toHaveBeenCalled();
  });

  test("keeps the draft open and reports failures", async () => {
    saveSummaryEditMock.mockRejectedValueOnce(new Error("disk unavailable"));
    const { render, setActionNotice } = await createController(createWorkflow());
    let controller = render();
    controller.beginSummaryEdit();
    controller = render();
    controller.updateSummaryDraft("edited summary");
    controller = render();

    await controller.saveSummaryDraft();
    controller = render();
    expect(controller.summaryEditing).toBe(true);
    expect(controller.summaryDraft).toBe("edited summary");
    expect(controller.summaryDirty).toBe(true);
    expect(controller.summarySaving).toBe(false);
    expect(setActionNotice).toHaveBeenLastCalledWith(uiMessage("synthesis.detail.summarySaveFailed"));
  });

  test("rejects a response for the wrong task without applying or closing the draft", async () => {
    saveSummaryEditMock.mockResolvedValueOnce({
      task_id: "task-other",
      summary: "wrong task summary",
    });
    const { render, applySummarySave, setActionNotice } = await createController(createWorkflow());
    let controller = render();
    controller.beginSummaryEdit();
    controller = render();
    controller.updateSummaryDraft("edited summary");
    controller = render();

    await controller.saveSummaryDraft();
    controller = render();

    expect(applySummarySave).not.toHaveBeenCalled();
    expect(controller.summaryEditing).toBe(true);
    expect(controller.summaryDraft).toBe("edited summary");
    expect(controller.summaryDirty).toBe(true);
    expect(controller.summarySaving).toBe(false);
    expect(setActionNotice).toHaveBeenLastCalledWith(uiMessage("synthesis.detail.summarySaveFailed"));
  });

  test("cancels back to the workflow summary currently supplied by the parent", async () => {
    const { render } = await createController(createWorkflow());
    let controller = render();
    controller.beginSummaryEdit();
    controller = render();
    controller.updateSummaryDraft("unsaved summary");
    controller = render();

    controller = render(createWorkflow({ summary: "parent-saved summary" }));
    controller.cancelSummaryEdit();
    controller = render(createWorkflow({ summary: "parent-saved summary" }));

    expect(controller.summaryEditing).toBe(false);
    expect(controller.summaryDraft).toBe("parent-saved summary");
    expect(controller.summaryDirty).toBe(false);
  });

  test("resets on task switch and ignores a late response from the old task", async () => {
    let resolveSave: ((value: { task_id: string; summary: string }) => void) | undefined;
    saveSummaryEditMock.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    const { render, applySummarySave, setActionNotice } = await createController(createWorkflow());
    let controller = render();
    controller.beginSummaryEdit();
    controller = render();
    controller.updateSummaryDraft("old task edit");
    controller = render();
    const save = controller.saveSummaryDraft();
    controller = render();
    expect(controller.summarySaving).toBe(true);

    controller = render(
      createWorkflow({
        taskId: "task-2",
        taskDir: "D:/StudyMind/tasks/task-2",
        summary: "new task summary",
      }),
    );
    expect(controller.summaryEditing).toBe(false);
    expect(controller.summaryDraft).toBe("new task summary");
    expect(controller.summaryDirty).toBe(false);

    resolveSave?.({ task_id: "task-1", summary: "old task saved" });
    await save;
    controller = render();
    expect(applySummarySave).not.toHaveBeenCalled();
    expect(setActionNotice).not.toHaveBeenCalledWith(uiMessage("synthesis.detail.summarySaved"));
    expect(controller.summaryDraft).toBe("new task summary");
    expect(controller.summarySaving).toBe(false);
  });
});
