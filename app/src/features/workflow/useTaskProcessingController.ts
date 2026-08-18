import { useCallback, useRef, useState } from "react";

import type { AccountStatus } from "../../accountState";
import { canGenerateAiWithAccount, canProcessWithAccount } from "../../accountState";
import { historyItemToWorkerResult, type HistoryItem } from "../../historyClient";
import type { SaveSummaryEditResponse } from "../../summaryClient";
import type { SaveTranscriptEditResponse } from "../../transcriptDetailClient";
import { clearLocalMediaSelection } from "../../localMediaClient";
import type { LocalMediaSelectionView } from "../../localMediaContract";
import {
  confirmProcessingCancellation,
  createInitialWorkflow,
  finishInsightRetry,
  getToolbarNewTaskButtonState,
  isProcessingStage,
  mergeProgressEvent,
  requestProcessingCancellation,
  restoreProcessingAfterCancellationFailure,
  startInsightRetry,
  startProcessing,
  summarizeWorkerResult,
  type InsightRetryTarget,
  type TaskComposerSource,
  type TaskSourceSummary,
  type TaskSubmission,
} from "../../workflow";
import {
  cancelProcess,
  processLocalMedia,
  retryInsights,
} from "../../workerClient";
import type { PreferenceSnapshot } from "../../insightPreferences";
import type { SupportedLocale } from "../../i18n/locale";
import { uiMessage, type UiMessage } from "../../i18n/uiMessage";

type OpenAccountPanel = (notice?: UiMessage) => void;

export const HISTORY_RESTORE_UNAVAILABLE_MESSAGE =
  uiMessage("history.disabled.selectionWhileProcessing");

const LOCAL_MEDIA_RESELECTION_ERROR_CODES = new Set([
  "LOCAL_MEDIA_SELECTION_INVALID",
  "LOCAL_MEDIA_SELECTION_CHANGED",
  "LOCAL_MEDIA_UNSUPPORTED_FORMAT",
  "LOCAL_MEDIA_UNAVAILABLE",
  "LOCAL_MEDIA_LINKED",
  "LOCAL_MEDIA_VALIDATION_FAILED",
  "LOCAL_MEDIA_KIND_MISMATCH",
  "LOCAL_VIDEO_STREAM_MISSING",
  "LOCAL_VIDEO_AUDIO_STREAM_MISSING",
  "LOCAL_AUDIO_STREAM_MISSING",
]);

type UseTaskProcessingControllerOptions = {
  onResetTaskUi: () => void;
  onRetryStarted: () => void;
  ensureAsrModelReady?: () => Promise<"iic/SenseVoiceSmall" | "iic/SenseVoiceSmall-onnx" | null>;
  modelDownloadActive?: boolean;
  processBlockerMessage: (account: AccountStatus) => UiMessage;
  aiBlockerMessage: (account: AccountStatus) => UiMessage;
};

export function useTaskProcessingController({
  onResetTaskUi,
  onRetryStarted,
  ensureAsrModelReady,
  modelDownloadActive = false,
  processBlockerMessage,
  aiBlockerMessage,
}: UseTaskProcessingControllerOptions) {
  const [workflow, setWorkflow] = useState(createInitialWorkflow);
  const operationIdRef = useRef(0);
  const cancellationOperationIdRef = useRef<number | null>(null);

  const canSubmit =
    !modelDownloadActive && workflow.composerSource.kind === "local_media";
  const toolbarNewTaskButtonState = getToolbarNewTaskButtonState(workflow.stage);
  const canRestoreHistory = !isProcessingStage(workflow.stage);

  const setLocalMediaSelection = useCallback(
    (selection: LocalMediaSelectionView) => {
      setWorkflow((current) => {
        if (current.stage !== "waiting_input") {
          return current;
        }
        return {
          ...current,
          composerSource: {
            kind: "local_media",
            selection,
          },
        };
      });
    },
    [],
  );

  const removeLocalMediaSelection = useCallback(async (): Promise<boolean> => {
    if (workflow.composerSource.kind !== "local_media") {
      return false;
    }
    const { selectionToken } = workflow.composerSource.selection;
    try {
      await clearLocalMediaSelection(selectionToken);
    } catch {
      return false;
    }
    setWorkflow((current) =>
      current.composerSource.kind === "local_media" &&
      current.composerSource.selection.selectionToken === selectionToken
        ? {
            ...current,
            composerSource: { kind: "none" },
          }
        : current,
    );
    return true;
  }, [workflow.composerSource]);

  const applyTranscriptSave = useCallback(
    (expectedTaskId: string | null, saved: SaveTranscriptEditResponse) => {
      setWorkflow((current) => {
        if (
          !expectedTaskId ||
          current.taskId !== expectedTaskId ||
          saved.task_id !== expectedTaskId
        ) {
          return current;
        }

        return {
          ...current,
          text: saved.text,
          dissectionStale:
            current.dissection !== null && saved.text !== current.text
              ? true
              : current.dissectionStale,
          artifacts: {
            ...current.artifacts,
            ...saved.artifacts,
          },
        };
      });
    },
    [],
  );

  const applySummarySave = useCallback(
    (expectedTaskId: string | null, saved: SaveSummaryEditResponse) => {
      setWorkflow((current) => {
        if (
          !expectedTaskId ||
          current.taskId !== expectedTaskId ||
          saved.task_id !== expectedTaskId
        ) {
          return current;
        }

        return {
          ...current,
          summary: saved.summary,
        };
      });
    },
    [],
  );

  const resetWorkflow = useCallback(() => {
    clearComposerSelectionBestEffort(workflow.composerSource);
    operationIdRef.current += 1;
    cancellationOperationIdRef.current = null;
    onResetTaskUi();
    setWorkflow(createInitialWorkflow());
  }, [onResetTaskUi, workflow.composerSource]);

  const startNewTaskFromToolbar = useCallback(() => {
    if (toolbarNewTaskButtonState.disabled) {
      return;
    }

    resetWorkflow();
  }, [resetWorkflow, toolbarNewTaskButtonState.disabled]);

  const restoreHistoryItem = useCallback(
    (item: HistoryItem): boolean => {
      if (isProcessingStage(workflow.stage)) {
        return false;
      }

      operationIdRef.current += 1;
      cancellationOperationIdRef.current = null;
      clearComposerSelectionBestEffort(workflow.composerSource);
      onResetTaskUi();
      const composerSource: TaskComposerSource = { kind: "none" };
      setWorkflow({
        ...summarizeWorkerResult(historyItemToWorkerResult(item)),
        dissectionStale: item.dissectionStale,
        composerSource,
        taskSource: item.source,
      });
      return true;
    },
    [onResetTaskUi, workflow.composerSource, workflow.stage],
  );

  const completeHistoryTaskDeletion = useCallback(
    (deletedTaskId: string): boolean => {
      if (
        isProcessingStage(workflow.stage) ||
        !workflow.taskId ||
        workflow.taskId !== deletedTaskId
      ) {
        return false;
      }
      resetWorkflow();
      return true;
    },
    [resetWorkflow, workflow.stage, workflow.taskId],
  );

  const submitTask = useCallback(
    async (
      submission: TaskSubmission,
      account: AccountStatus,
      openAccountPanel: OpenAccountPanel,
    ) => {
      const prepared = prepareTaskSubmission(
        workflow.composerSource,
        submission,
      );
      if (!prepared) {
        return;
      }
      if (!canProcessWithAccount(account)) {
        openAccountPanel(processBlockerMessage(account));
        return;
      }
      const asrModel = ensureAsrModelReady
        ? await ensureAsrModelReady()
        : "iic/SenseVoiceSmall";
      if (!asrModel) {
        return;
      }
      const operationId = operationIdRef.current + 1;
      operationIdRef.current = operationId;
      setWorkflow((current) => startProcessing(current, prepared.taskSource));
      const onProgress = (event: Parameters<typeof mergeProgressEvent>[1]) => {
        if (operationIdRef.current === operationId) {
          setWorkflow((current) => mergeProgressEvent(current, event));
        }
      };
      const result = await processLocalMedia(
        {
          selectionToken: prepared.submission.selectionToken,
          asrModel,
          ...(prepared.submission.title
            ? { title: prepared.submission.title }
            : {}),
        },
        undefined,
        onProgress,
      );
      if (operationIdRef.current !== operationId) {
        return;
      }
      cancellationOperationIdRef.current = null;
      if (result.error?.code === "WORKER_CANCELLED") {
        operationIdRef.current += 1;
        onResetTaskUi();
        setWorkflow((current) => confirmProcessingCancellation(current));
        return;
      }
      const localSelectionToken = prepared.submission.selectionToken;
      setWorkflow((current) => {
        const releaseLocalSelection =
          result.status !== "failed" ||
          (result.error &&
            LOCAL_MEDIA_RESELECTION_ERROR_CODES.has(result.error.code));
        const composerSource =
          releaseLocalSelection &&
          current.composerSource.kind === "local_media" &&
          current.composerSource.selection.selectionToken ===
            localSelectionToken
            ? { kind: "none" as const }
            : current.composerSource;
        return {
          ...summarizeWorkerResult(result),
          composerSource,
          taskSource: current.taskSource ?? prepared.taskSource,
        };
      });
    },
    [
      onResetTaskUi,
      processBlockerMessage,
      ensureAsrModelReady,
      workflow.composerSource,
    ],
  );

  const cancelCurrentProcessing = useCallback(async () => {
    const operationId = operationIdRef.current;
    if (cancellationOperationIdRef.current === operationId) {
      return;
    }

    cancellationOperationIdRef.current = operationId;
    setWorkflow((current) => requestProcessingCancellation(current));
    const result = await cancelProcess();
    if (operationIdRef.current !== operationId) {
      return;
    }
    if (result.status === "failed") {
      cancellationOperationIdRef.current = null;
      setWorkflow((current) =>
        restoreProcessingAfterCancellationFailure(current),
      );
      return;
    }
    // Cancellation accepted: reconcile the workflow state immediately instead
    // of waiting for the worker's terminal promise. The runner may delay its
    // WORKER_CANCELLED result while the OS reaps the child process, and any
    // progress events still buffered in the Tauri event bus can re-flip the
    // stage back to "video_transcribing"/"video_extracting" via
    // mergeProgressEvent, leaving the workspace stuck on the dim "cancelling"
    // spinner. Bumping the operation id invalidates the in-flight progress
    // and terminal callbacks, and confirmProcessingCancellation is idempotent
    // with the WORKER_CANCELLED branch in submitTask/retryInsightGeneration.
    cancellationOperationIdRef.current = null;
    operationIdRef.current += 1;
    onResetTaskUi();
    setWorkflow((current) => confirmProcessingCancellation(current));
  }, [onResetTaskUi]);

  const retryInsightGeneration = useCallback(
    async (
      target: InsightRetryTarget,
      outputLanguage: SupportedLocale,
      preferenceSnapshot: PreferenceSnapshot | null,
      account: AccountStatus,
      openAccountPanel: OpenAccountPanel,
      onRetryCompleted?: () => void,
    ) => {
      if (!workflow.taskId || !workflow.artifacts.transcript_txt) {
        return;
      }
      if (!canGenerateAiWithAccount(account)) {
        openAccountPanel(aiBlockerMessage(account));
        return;
      }

      const taskId = workflow.taskId;
      const operationId = operationIdRef.current + 1;
      operationIdRef.current = operationId;
      onRetryStarted();
      setWorkflow((current) => startInsightRetry(current, target));

      const onProgress = (event: Parameters<typeof mergeProgressEvent>[1]) => {
        if (operationIdRef.current === operationId) {
          setWorkflow((current) => mergeProgressEvent(current, event));
        }
      };

      const result = await retryInsights(
        target === "summary" || target === "dissection"
          ? { taskId, target, outputLanguage }
          : preferenceSnapshot
            ? { taskId, target, outputLanguage, preferenceSnapshot }
            : { taskId, target, outputLanguage },
        undefined,
        onProgress,
      );
      if (operationIdRef.current !== operationId) {
        return;
      }
      cancellationOperationIdRef.current = null;
      if (result.error?.code === "WORKER_CANCELLED") {
        operationIdRef.current += 1;
        onResetTaskUi();
        setWorkflow((current) => confirmProcessingCancellation(current));
        return;
      }
      setWorkflow((current) => ({
        ...finishInsightRetry(
          current,
          {
            ...result,
            task_id: result.task_id ?? current.taskId,
            task_dir: result.task_dir ?? current.taskDir,
            artifacts: {
              ...current.artifacts,
              ...(result.artifacts ?? {}),
            },
            text: result.text || current.text,
            summary: result.summary || current.summary,
            insights: result.insights.length > 0 ? result.insights : current.insights,
            transcript: result.transcript ?? current.transcript,
            dissection: result.dissection ?? current.dissection,
          },
          target,
        ),
      }));
      onRetryCompleted?.();
    },
    [
      aiBlockerMessage,
      onResetTaskUi,
      onRetryStarted,
      workflow.artifacts.transcript_txt,
      workflow.taskId,
    ],
  );

  return {
    workflow,
    canSubmit,
    canRestoreHistory,
    historyRestoreUnavailableMessage: HISTORY_RESTORE_UNAVAILABLE_MESSAGE,
    toolbarNewTaskButtonState,
    cancelCurrentProcessing,
    resetWorkflow,
    setLocalMediaSelection,
    removeLocalMediaSelection,
    applyTranscriptSave,
    applySummarySave,
    completeHistoryTaskDeletion,
    restoreHistoryItem,
    retryInsightGeneration,
    startNewTaskFromToolbar,
    submitTask,
  };
}

type PreparedTaskSubmission = {
  submission: TaskSubmission;
  taskSource: TaskSourceSummary;
};

function prepareTaskSubmission(
  composerSource: TaskComposerSource,
  submission: TaskSubmission,
): PreparedTaskSubmission | null {
  if (
    composerSource.kind !== "local_media" ||
    composerSource.selection.selectionToken !== submission.selectionToken
  ) {
    return null;
  }
  return {
    submission,
    taskSource: {
      kind: "local_file",
      displayName: composerSource.selection.displayName,
      mediaKind: composerSource.selection.mediaKind,
    },
  };
}

function clearComposerSelectionBestEffort(
  composerSource: TaskComposerSource,
): void {
  if (composerSource.kind === "local_media") {
    void clearLocalMediaSelection(composerSource.selection.selectionToken).catch(
      () => undefined,
    );
  }
}
