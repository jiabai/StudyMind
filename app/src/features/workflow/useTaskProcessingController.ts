import { useCallback, useRef, useState } from "react";

import type { AccountStatus } from "../../accountState";
import { canGenerateAiWithAccount, canProcessWithAccount } from "../../accountState";
import { historyItemToWorkerResult, type HistoryItem } from "../../historyClient";
import type { SaveTranscriptEditResponse } from "../../transcriptDetailClient";
import { clearLocalMediaSelection } from "../../localMediaClient";
import type { LocalMediaSelectionView } from "../../localMediaContract";
import {
  canSubmitUrl,
  confirmProcessingCancellation,
  createInitialWorkflow,
  finishInsightRetry,
  getToolbarNewTaskButtonState,
  isProcessingStage,
  mergeProgressEvent,
  normalizeSubmitUrl,
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
  processVideo,
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
    !modelDownloadActive &&
    (workflow.composerSource.kind === "local_media" ||
      canSubmitUrl(workflow.composerSource.urlDraft));
  const toolbarNewTaskButtonState = getToolbarNewTaskButtonState(workflow.stage);
  const canRestoreHistory = !isProcessingStage(workflow.stage);

  const updateUrlDraft = useCallback((url: string) => {
    setWorkflow((current) =>
      current.stage === "waiting_input" &&
      current.composerSource.kind === "url"
        ? {
            ...current,
            composerSource: {
              kind: "url",
              urlDraft: url,
            },
          }
        : current,
    );
  }, []);

  const setLocalMediaSelection = useCallback(
    (selection: LocalMediaSelectionView) => {
      setWorkflow((current) => {
        if (current.stage !== "waiting_input") {
          return current;
        }
        const retainedUrlDraft =
          current.composerSource.kind === "url"
            ? current.composerSource.urlDraft
            : current.composerSource.retainedUrlDraft;
        return {
          ...current,
          composerSource: {
            kind: "local_media",
            selection,
            retainedUrlDraft,
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
            composerSource: {
              kind: "url",
              urlDraft: current.composerSource.retainedUrlDraft,
            },
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
      const composerSource: TaskComposerSource =
        item.source.kind === "url"
          ? { kind: "url", urlDraft: item.source.url }
          : { kind: "url", urlDraft: "" };
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
      setWorkflow((current) =>
        startProcessing(
          prepared.submission.kind === "url"
            ? {
                ...current,
                composerSource: {
                  kind: "url",
                  urlDraft: prepared.submission.url,
                },
              }
            : current,
          prepared.taskSource,
        ),
      );
      const onProgress = (event: Parameters<typeof mergeProgressEvent>[1]) => {
        if (operationIdRef.current === operationId) {
          setWorkflow((current) => mergeProgressEvent(current, event));
        }
      };
      const result =
        prepared.submission.kind === "url"
          ? await processVideo(
              prepared.submission.url,
              asrModel,
              undefined,
              onProgress,
            )
          : await processLocalMedia(
              {
                selectionToken: prepared.submission.selectionToken,
                asrModel,
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
      const localSelectionToken =
        prepared.submission.kind === "local_media"
          ? prepared.submission.selectionToken
          : null;
      setWorkflow((current) => {
        const releaseLocalSelection =
          localSelectionToken !== null &&
          (result.status !== "failed" ||
            (result.error &&
              LOCAL_MEDIA_RESELECTION_ERROR_CODES.has(result.error.code)));
        const composerSource =
          releaseLocalSelection &&
          current.composerSource.kind === "local_media" &&
          current.composerSource.selection.selectionToken ===
            localSelectionToken
            ? {
                kind: "url" as const,
                urlDraft: current.composerSource.retainedUrlDraft,
              }
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
    }
  }, []);

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
    updateUrlDraft,
    setLocalMediaSelection,
    removeLocalMediaSelection,
    applyTranscriptSave,
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
  switch (submission.kind) {
    case "url": {
      const url = normalizeSubmitUrl(submission.url);
      const composerUrl =
        composerSource.kind === "url"
          ? normalizeSubmitUrl(composerSource.urlDraft)
          : null;
      if (!url || composerUrl !== url) {
        return null;
      }
      return {
        submission: { kind: "url", url },
        taskSource: { kind: "url", url },
      };
    }
    case "local_media":
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
