import type {
  DependencyList,
  EffectCallback,
  SetStateAction,
} from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { createInitialWorkflow, type WorkflowState } from "../../workflowState";
import type { TranscriptNote } from "../../transcriptNotesState";
import type { TranscriptNotesResponse } from "../../transcriptNotesClient";
import type { UiMessage } from "../../i18n/uiMessage";
import type { TranscriptNotesController } from "./useTranscriptNotesController";

type StateUpdater<T> = T | ((current: T) => T);
type EffectRecord = { cleanup?: void | (() => void); deps?: DependencyList };

const mocks = vi.hoisted(() => ({
  loadTranscriptNotes: vi.fn(),
  saveTranscriptNotes: vi.fn(),
}));

vi.mock("../../transcriptNotesClient", () => ({
  loadTranscriptNotes: mocks.loadTranscriptNotes,
  saveTranscriptNotes: mocks.saveTranscriptNotes,
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

function readyWorkflow(taskId: string): WorkflowState {
  return {
    ...createInitialWorkflow(),
    stage: "completed",
    taskId,
    taskDir: `D:/StudyMind/outputs/tasks/${taskId}`,
    artifacts: { transcript_txt: "transcript/transcript.txt" },
  };
}

function note(id: string, segmentId: string, content: string): TranscriptNote {
  return {
    id,
    transcript_segment_id: segmentId,
    source_text: `原文 ${segmentId}`,
    content,
    created_at: "2026-08-11T10:00:00+00:00",
    updated_at: "2026-08-11T10:00:00+00:00",
  };
}

function response(taskId: string, notes: TranscriptNote[]): TranscriptNotesResponse {
  return { task_id: taskId, notes };
}

type Harness = {
  render: () => TranscriptNotesController;
  setWorkflow: (workflow: WorkflowState) => TranscriptNotesController;
};

async function createController(taskId = "task-a"): Promise<Harness> {
  const hookHarness = createHookHarness();
  vi.doMock("react", () => ({
    useCallback: hookHarness.useCallback,
    useEffect: hookHarness.useEffect,
    useRef: hookHarness.useRef,
    useState: hookHarness.useState,
  }));
  const { useTranscriptNotesController } = await import("./useTranscriptNotesController");
  let workflow = readyWorkflow(taskId);
  const setActionNotice = vi.fn<(value: SetStateAction<UiMessage | null>) => void>();
  const render = () => {
    hookHarness.resetRender();
    return useTranscriptNotesController({ workflow, setActionNotice });
  };
  const setWorkflow = (next: WorkflowState) => {
    workflow = next;
    return render();
  };
  render();
  return { render, setWorkflow };
}

describe("useTranscriptNotesController", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.loadTranscriptNotes.mockReset();
    mocks.saveTranscriptNotes.mockReset();
    mocks.loadTranscriptNotes.mockResolvedValue(response("task-a", []));
    mocks.saveTranscriptNotes.mockImplementation(async (taskId: string, notes: TranscriptNote[]) =>
      response(taskId, notes));
  });

  test("loads notes for the active task and resets notes when the task changes", async () => {
    mocks.loadTranscriptNotes
      .mockResolvedValueOnce(response("task-a", [note("note-a", "segment-a", "A")]))
      .mockResolvedValueOnce(response("task-b", []));
    const controller = await createController();
    await vi.waitFor(() => expect(controller.render().notes).toHaveLength(1));

    controller.setWorkflow(readyWorkflow("task-b"));
    expect(controller.render().notes).toEqual([]);
    await vi.waitFor(() => expect(mocks.loadTranscriptNotes).toHaveBeenLastCalledWith("task-b"));
  });

  test("creates one blank note and does not duplicate the same segment", async () => {
    const controller = await createController();
    const created = controller.render().createNoteForSegment("segment-a", "原文 A");
    expect(created?.content).toBe("");
    expect(controller.render().notes).toHaveLength(1);
    controller.render().createNoteForSegment("segment-a", "原文 A");
    expect(controller.render().notes).toHaveLength(1);
    await vi.waitFor(() => expect(mocks.saveTranscriptNotes).toHaveBeenCalledOnce());
  });

  test("edits on explicit save, cancels drafts, and deletes with persistence", async () => {
    const controller = await createController();
    controller.render().createNoteForSegment("segment-a", "原文 A");
    await vi.waitFor(() => expect(mocks.saveTranscriptNotes).toHaveBeenCalledOnce());

    controller.render().beginNoteEdit("note-missing");
    controller.render().beginNoteEdit(controller.render().notes[0].id);
    controller.render().updateNoteDraft("课堂重点");
    controller.render().cancelNoteEdit();
    expect(controller.render().notes[0].content).toBe("");

    controller.render().beginNoteEdit(controller.render().notes[0].id);
    controller.render().updateNoteDraft("课堂重点");
    await controller.render().saveNote();
    expect(controller.render().notes[0].content).toBe("课堂重点");
    await controller.render().deleteNote(controller.render().notes[0].id);
    expect(controller.render().notes).toEqual([]);
  });

  test("keeps the local note and exposes a save error when persistence fails", async () => {
    mocks.saveTranscriptNotes.mockRejectedValue(new Error("disk unavailable"));
    const controller = await createController();
    controller.render().createNoteForSegment("segment-a", "原文 A");
    await vi.waitFor(() => expect(controller.render().notes).toHaveLength(1));
    expect(controller.render().notesSaveError?.messageCode).toBe("transcript.notes.saveFailed");
  });

  test("ignores a late load from a previous task", async () => {
    let resolveLate!: (value: TranscriptNotesResponse) => void;
    const late = new Promise<TranscriptNotesResponse>((resolve) => {
      resolveLate = resolve;
    });
    mocks.loadTranscriptNotes.mockReset();
    mocks.loadTranscriptNotes.mockReturnValueOnce(late).mockResolvedValueOnce(response("task-b", []));
    const controller = await createController();
    controller.setWorkflow(readyWorkflow("task-b"));
    resolveLate(response("task-a", [note("late", "segment-a", "late")]));
    await vi.waitFor(() => expect(controller.render().activeTaskId).toBe("task-b"));
    expect(controller.render().notes).toEqual([]);
  });
});
