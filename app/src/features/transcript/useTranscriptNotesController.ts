import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  loadTranscriptNotes,
  saveTranscriptNotes,
} from "../../transcriptNotesClient";
import {
  appendTranscriptNote,
  createTranscriptNote,
  findTranscriptNoteForSegment,
  removeTranscriptNote,
  updateTranscriptNote,
  type TranscriptNote,
} from "../../transcriptNotesState";
import { uiMessage, type UiMessage } from "../../i18n/uiMessage";
import type { WorkflowState } from "../../workflow";

type UseTranscriptNotesControllerOptions = {
  workflow: WorkflowState;
  setActionNotice: Dispatch<SetStateAction<UiMessage | null>>;
};

function nowIso(): string {
  return new Date().toISOString().replace("Z", "+00:00");
}

export function useTranscriptNotesController({
  workflow,
  setActionNotice: _setActionNotice,
}: UseTranscriptNotesControllerOptions) {
  const [notes, setNotes] = useState<TranscriptNote[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesLoadError, setNotesLoadError] = useState<UiMessage | null>(null);
  const [notesSaving, setNotesSaving] = useState(false);
  const [notesSaveError, setNotesSaveError] = useState<UiMessage | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteContent, setEditingNoteContent] = useState("");
  const [focusedNoteId, setFocusedNoteId] = useState<string | null>(null);
  const [loadGeneration, setLoadGeneration] = useState(0);
  const currentTaskIdRef = useRef(workflow.taskId);
  const saveGenerationRef = useRef(0);
  currentTaskIdRef.current = workflow.taskId;

  useEffect(() => {
    const taskId = workflow.taskId;
    const requestGeneration = ++saveGenerationRef.current;
    let cancelled = false;

    setNotes([]);
    setNotesLoadError(null);
    setNotesSaveError(null);
    setEditingNoteId(null);
    setEditingNoteContent("");
    setFocusedNoteId(null);

    if (!taskId) {
      setNotesLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setNotesLoading(true);
    void loadTranscriptNotes(taskId)
      .then((result) => {
        if (
          cancelled ||
          currentTaskIdRef.current !== taskId ||
          saveGenerationRef.current !== requestGeneration ||
          result.task_id !== taskId
        ) {
          return;
        }
        setNotes(result.notes);
        setNotesLoadError(null);
      })
      .catch(() => {
        if (
          cancelled ||
          currentTaskIdRef.current !== taskId ||
          saveGenerationRef.current !== requestGeneration
        ) {
          return;
        }
        setNotesLoadError(uiMessage("transcript.notes.loadError"));
      })
      .finally(() => {
        if (!cancelled && currentTaskIdRef.current === taskId) {
          setNotesLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [loadGeneration, workflow.taskId]);

  const retryLoadNotes = useCallback(() => {
    setLoadGeneration((generation) => generation + 1);
  }, []);

  const focusNoteForSegment = useCallback(
    (segmentId: string) => {
      const note = findTranscriptNoteForSegment(notes, segmentId);
      if (note) {
        setFocusedNoteId(note.id);
      }
      return note;
    },
    [notes],
  );

  const persistNotes = useCallback(
    async (
      taskId: string,
      nextNotes: TranscriptNote[],
      failureMessage: UiMessage,
      generation: number,
    ) => {
      setNotesSaving(true);
      setNotesSaveError(null);
      try {
        const result = await saveTranscriptNotes(taskId, nextNotes);
        if (
          currentTaskIdRef.current !== taskId ||
          saveGenerationRef.current !== generation
        ) {
          return false;
        }
        setNotes(result.notes);
        setNotesSaveError(null);
        return true;
      } catch {
        if (
          currentTaskIdRef.current !== taskId ||
          saveGenerationRef.current !== generation
        ) {
          return false;
        }
        setNotesSaveError(failureMessage);
        return false;
      } finally {
        if (
          currentTaskIdRef.current === taskId &&
          saveGenerationRef.current === generation
        ) {
          setNotesSaving(false);
        }
      }
    },
    [],
  );

  const createNoteForSegment = useCallback(
    (segmentId: string, sourceText: string) => {
      const existing = findTranscriptNoteForSegment(notes, segmentId);
      if (existing) {
        setFocusedNoteId(existing.id);
        return existing;
      }
      const taskId = workflow.taskId;
      if (!taskId) {
        return null;
      }

      const note = createTranscriptNote(segmentId, sourceText, nowIso());
      const nextNotes = appendTranscriptNote(notes, note);
      setNotes(nextNotes);
      setFocusedNoteId(note.id);
      void persistNotes(
        taskId,
        nextNotes,
        uiMessage("transcript.notes.saveFailed"),
        saveGenerationRef.current,
      );
      return note;
    },
    [notes, persistNotes, workflow.taskId],
  );

  const beginNoteEdit = useCallback(
    (noteId: string) => {
      const note = notes.find((candidate) => candidate.id === noteId);
      if (!note) {
        return;
      }
      setFocusedNoteId(note.id);
      setEditingNoteId(note.id);
      setEditingNoteContent(note.content);
      setNotesSaveError(null);
    },
    [notes],
  );

  const updateNoteDraft = useCallback((content: string) => {
    setEditingNoteContent(content);
  }, []);

  const cancelNoteEdit = useCallback(() => {
    setEditingNoteId(null);
    setEditingNoteContent("");
  }, []);

  const saveNote = useCallback(async () => {
    const taskId = workflow.taskId;
    const noteId = editingNoteId;
    if (!taskId || !noteId) {
      return false;
    }
    const nextNotes = updateTranscriptNote(
      notes,
      noteId,
      editingNoteContent,
      nowIso(),
    );
    setNotes(nextNotes);
    const saved = await persistNotes(
      taskId,
      nextNotes,
      uiMessage("transcript.notes.saveFailed"),
      saveGenerationRef.current,
    );
    if (saved && currentTaskIdRef.current === taskId) {
      setEditingNoteId(null);
      setEditingNoteContent("");
    }
    return saved;
  }, [editingNoteContent, editingNoteId, notes, persistNotes, workflow.taskId]);

  const deleteNote = useCallback(
    async (noteId: string) => {
      const taskId = workflow.taskId;
      if (!taskId) {
        return false;
      }
      const previousNotes = notes;
      const nextNotes = removeTranscriptNote(previousNotes, noteId);
      setNotes(nextNotes);
      const saved = await persistNotes(
        taskId,
        nextNotes,
        uiMessage("transcript.notes.deleteFailed"),
        saveGenerationRef.current,
      );
      if (saved && currentTaskIdRef.current === taskId) {
        if (editingNoteId === noteId) {
          setEditingNoteId(null);
          setEditingNoteContent("");
        }
        if (focusedNoteId === noteId) {
          setFocusedNoteId(null);
        }
      } else if (!saved && currentTaskIdRef.current === taskId) {
        setNotes(previousNotes);
      }
      return saved;
    }, [editingNoteId, focusedNoteId, notes, persistNotes, workflow.taskId],
  );

  const clearFocusedNote = useCallback(() => {
    setFocusedNoteId(null);
  }, []);

  return {
    activeTaskId: workflow.taskId,
    notes,
    notesLoading,
    notesLoadError,
    notesSaving,
    notesSaveError,
    editingNoteId,
    editingNoteContent,
    focusedNoteId,
    retryLoadNotes,
    createNoteForSegment,
    focusNoteForSegment,
    beginNoteEdit,
    updateNoteDraft,
    cancelNoteEdit,
    saveNote,
    deleteNote,
    clearFocusedNote,
  };
}

export type TranscriptNotesController = ReturnType<
  typeof useTranscriptNotesController
>;
