import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { uiMessage, type UiMessage } from "../../i18n/uiMessage";
import { saveSummaryEdit, type SaveSummaryEditResponse } from "../../summaryClient";
import type { WorkflowState } from "../../workflow";

export type UseSummaryEditorControllerOptions = {
  workflow: WorkflowState;
  applySummarySave: (
    expectedTaskId: string | null,
    saved: SaveSummaryEditResponse,
  ) => void;
  setActionNotice: Dispatch<SetStateAction<UiMessage | null>>;
};

export function useSummaryEditorController({
  workflow,
  applySummarySave,
  setActionNotice,
}: UseSummaryEditorControllerOptions) {
  const [summaryEditing, setSummaryEditing] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState(workflow.summary);
  const [summaryDirty, setSummaryDirty] = useState(false);
  const [summarySaving, setSummarySaving] = useState(false);
  const currentTaskIdRef = useRef(workflow.taskId);
  const previousTaskIdRef = useRef(workflow.taskId);
  const saveGenerationRef = useRef(0);
  const summarySavingRef = useRef(false);

  currentTaskIdRef.current = workflow.taskId;

  useEffect(() => {
    if (previousTaskIdRef.current === workflow.taskId) {
      return;
    }

    previousTaskIdRef.current = workflow.taskId;
    saveGenerationRef.current += 1;
    summarySavingRef.current = false;
    setSummaryDraft(workflow.summary);
    setSummaryEditing(false);
    setSummaryDirty(false);
    setSummarySaving(false);
  }, [workflow.taskId]);

  const beginSummaryEdit = useCallback(() => {
    setSummaryEditing(true);
  }, []);

  const cancelSummaryEdit = useCallback(() => {
    setSummaryDraft(workflow.summary);
    setSummaryEditing(false);
    setSummaryDirty(false);
  }, [workflow.summary]);

  const updateSummaryDraft = useCallback((next: string) => {
    setSummaryDraft(next);
    setSummaryDirty(true);
  }, []);

  const saveSummaryDraft = useCallback(async () => {
    if (summarySavingRef.current) {
      return;
    }

    const expectedTaskId = workflow.taskId;
    if (!expectedTaskId || !workflow.artifacts.summary) {
      setActionNotice(uiMessage("synthesis.detail.summarySaveFailed"));
      return;
    }
    if (!summaryDraft.trim()) {
      setActionNotice(uiMessage("synthesis.detail.summaryEmptySave"));
      return;
    }

    summarySavingRef.current = true;
    setSummarySaving(true);
    const requestGeneration = saveGenerationRef.current;

    try {
      const saved = await saveSummaryEdit(expectedTaskId, summaryDraft);
      if (
        currentTaskIdRef.current !== expectedTaskId ||
        saveGenerationRef.current !== requestGeneration
      ) {
        return;
      }
      if (saved.task_id !== expectedTaskId) {
        setActionNotice(uiMessage("synthesis.detail.summarySaveFailed"));
        return;
      }

      setSummaryDraft(saved.summary);
      setSummaryEditing(false);
      setSummaryDirty(false);
      applySummarySave(expectedTaskId, saved);
      setActionNotice(uiMessage("synthesis.detail.summarySaved"));
    } catch {
      if (
        currentTaskIdRef.current === expectedTaskId &&
        saveGenerationRef.current === requestGeneration
      ) {
        setActionNotice(uiMessage("synthesis.detail.summarySaveFailed"));
      }
    } finally {
      if (
        currentTaskIdRef.current === expectedTaskId &&
        saveGenerationRef.current === requestGeneration
      ) {
        summarySavingRef.current = false;
        setSummarySaving(false);
      }
    }
  }, [
    applySummarySave,
    setActionNotice,
    summaryDraft,
    workflow.artifacts.summary,
    workflow.taskId,
  ]);

  return {
    summaryEditing,
    summaryDraft,
    summaryDirty,
    summarySaving,
    beginSummaryEdit,
    cancelSummaryEdit,
    updateSummaryDraft,
    saveSummaryDraft,
  };
}
