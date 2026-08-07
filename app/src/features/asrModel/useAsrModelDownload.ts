import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type Event } from "@tauri-apps/api/event";

import { parseAsrModelDownloadProgressEvent } from "../../desktopWorkerProtocol";
import { uiMessage, type UiMessage } from "../../i18n/uiMessage";
import { isModelDownloadStalled, shouldApplyModelDownloadUpdate } from "../../modelDownloadState";
import {
  ASR_MODEL_DOWNLOAD_PROGRESS_EVENT,
  cancelAsrModelDownload,
  getAsrModelStatus,
  downloadAsrModel,
  getLlmConfig,
  type AsrModelDownloadProgress,
  type AsrModelStatusResponseView,
} from "../../settingsClient";
import type { AsrModelStatus } from "./types";

const DEFAULT_ASR_MODEL = "iic/SenseVoiceSmall" as const;
const ONNX_ASR_MODEL = "iic/SenseVoiceSmall-onnx" as const;
type SelectableAsrModel = typeof DEFAULT_ASR_MODEL | typeof ONNX_ASR_MODEL;

function progressModel(model: string): SelectableAsrModel {
  return model === ONNX_ASR_MODEL ? ONNX_ASR_MODEL : DEFAULT_ASR_MODEL;
}

function hasTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

function modelDownloadTimeoutNotice(error: unknown): UiMessage | null {
  const code =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : null;
  if (code === "ASR_MODEL_DOWNLOAD_IDLE_TIMEOUT") {
    return uiMessage("asrModel.notice.idleTimeout");
  }
  if (code === "ASR_MODEL_DOWNLOAD_EXECUTION_TIMEOUT") {
    return uiMessage("asrModel.notice.executionTimeout");
  }
  return null;
}

const defaultAsrModelStatus: AsrModelStatus = {
  model: DEFAULT_ASR_MODEL,
  modelDir: "",
  available: false,
  source: "modelscope",
};

export function useAsrModelDownload() {
  const [modelGuideOpen, setModelGuideOpen] = useState(false);
  const [asrModelStatus, setAsrModelStatus] = useState<AsrModelStatus>(defaultAsrModelStatus);
  const [modelDownloadProgress, setModelDownloadProgress] = useState<AsrModelDownloadProgress>({
    phase: "idle",
    wireStatus: null,
    message: null,
    progress: 0,
  });
  const [modelDownloadNotice, setModelDownloadNotice] = useState<UiMessage | null>(null);
  const [modelDownloadStalled, setModelDownloadStalled] = useState(false);
  const modelDownloadOperationIdRef = useRef(0);
  const modelDownloadPhaseRef = useRef<"running" | "cancelling" | "finished">("finished");
  const modelDownloadCancellationIntentOperationIdRef = useRef<number | null>(null);
  const modelDownloadTerminalEventOperationIdRef = useRef<number | null>(null);
  const modelDownloadProgressBeforeCancellationRef = useRef<AsrModelDownloadProgress | null>(null);
  const modelDownloadProgressUpdatedAtRef = useRef(0);
  const modelDownloadActive =
    modelDownloadProgress.phase === "running" ||
    modelDownloadProgress.phase === "cancelling";

  useEffect(() => {
    if (!modelDownloadActive) {
      setModelDownloadStalled(false);
      return;
    }

    const interval = window.setInterval(() => {
      setModelDownloadStalled(
        isModelDownloadStalled({
          active: true,
          lastProgressAtMs: modelDownloadProgressUpdatedAtRef.current,
          nowMs: Date.now(),
        }),
      );
    }, 5_000);

    return () => window.clearInterval(interval);
  }, [modelDownloadActive]);

  const updateAsrModelStatus = useCallback((status: AsrModelStatusResponseView) => {
    setAsrModelStatus({
      model: status.asrModel,
      modelDir: status.asrModelDir,
      available: status.asrModelAvailable,
      source: status.asrModelSource,
    });
  }, []);

  const refreshAsrModelStatus = useCallback(async (
    asrModel: string = DEFAULT_ASR_MODEL,
  ): Promise<AsrModelStatusResponseView> => {
    const status = await getAsrModelStatus(asrModel);
    updateAsrModelStatus(status);
    return status;
  }, [updateAsrModelStatus]);

  async function startAsrModelDownload(asrModel = asrModelStatus.model): Promise<boolean> {
    if (modelDownloadActive) {
      return false;
    }

    const operationId = modelDownloadOperationIdRef.current + 1;
    modelDownloadOperationIdRef.current = operationId;
    modelDownloadPhaseRef.current = "running";
    modelDownloadCancellationIntentOperationIdRef.current = null;
    modelDownloadTerminalEventOperationIdRef.current = null;
    modelDownloadProgressBeforeCancellationRef.current = null;
    setModelGuideOpen(true);
    setModelDownloadNotice(null);
    setModelDownloadStalled(false);
    modelDownloadProgressUpdatedAtRef.current = Date.now();
    setModelDownloadProgress({
      phase: "running",
      wireStatus: null,
      message: {
        messageCode: "model.download.preparing",
        args: { model: progressModel(asrModel) },
      },
      progress: 0,
    });

    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listen(ASR_MODEL_DOWNLOAD_PROGRESS_EVENT, (event: Event<unknown>) => {
        const parsed = parseAsrModelDownloadProgressEvent(event.payload);
        if (parsed.kind === "invalid") {
          console.warn(
            `Dropped invalid model download progress event: ${parsed.diagnosticCode}`,
          );
          return;
        }
        if (parsed.kind === "unknown") {
          console.warn(
            `Unknown model download progress code: ${parsed.diagnosticCode}`,
          );
        }
        const terminal =
          parsed.event.status === "completed" ||
          parsed.event.status === "cancelled";
        if (
          modelDownloadTerminalEventOperationIdRef.current !== operationId &&
          shouldApplyModelDownloadUpdate({
            operationId,
            activeOperationId: modelDownloadOperationIdRef.current,
            phase: modelDownloadPhaseRef.current,
          })
        ) {
          if (terminal) {
            modelDownloadTerminalEventOperationIdRef.current = operationId;
            modelDownloadPhaseRef.current = "finished";
          }
          modelDownloadProgressUpdatedAtRef.current = Date.now();
          setModelDownloadStalled(false);
          const wireProgress: AsrModelDownloadProgress = {
            phase:
              parsed.event.status === "completed"
                ? "completed"
                : parsed.event.status === "cancelled"
                  ? "cancelled"
                  : "running",
            wireStatus: parsed.event.status,
            message: parsed.event.message,
            progress: parsed.event.progress,
            ...(parsed.event.currentFile
              ? { currentFile: parsed.event.currentFile }
              : {}),
          };
          if (modelDownloadPhaseRef.current === "cancelling" && !terminal) {
            modelDownloadProgressBeforeCancellationRef.current = wireProgress;
          }
          setModelDownloadProgress((current) => {
            if (
              modelDownloadPhaseRef.current === "cancelling" &&
              !terminal
            ) {
              return {
                ...wireProgress,
                phase: "cancelling",
                message: current.message,
              };
            }

            return wireProgress;
          });
        }
      });

      if (
        operationId !== modelDownloadOperationIdRef.current ||
        modelDownloadCancellationIntentOperationIdRef.current === operationId ||
        modelDownloadPhaseRef.current !== "running"
      ) {
        if (
          operationId === modelDownloadOperationIdRef.current &&
          modelDownloadCancellationIntentOperationIdRef.current === operationId
        ) {
          modelDownloadPhaseRef.current = "finished";
          modelDownloadTerminalEventOperationIdRef.current = operationId;
          setModelDownloadStalled(false);
          setModelDownloadProgress((current) => ({
            phase: "cancelled",
            wireStatus: current.wireStatus,
            message: { messageCode: "model.download.cancelled", args: {} },
            progress: current.progress,
          }));
          setModelDownloadNotice(uiMessage("asrModel.notice.cancelled"));
        }
        return false;
      }

      const downloadResult = await downloadAsrModel(asrModel);
      if (
        !shouldApplyModelDownloadUpdate({
          operationId,
          activeOperationId: modelDownloadOperationIdRef.current,
          phase: modelDownloadPhaseRef.current,
        })
      ) {
        return false;
      }
      if (downloadResult.status === "cancelled") {
        modelDownloadPhaseRef.current = "finished";
        setModelDownloadStalled(false);
        setModelDownloadProgress((current) => ({
          phase: "cancelled",
          wireStatus: current.wireStatus,
          message: { messageCode: "model.download.cancelled", args: {} },
          progress: current.progress,
        }));
        setModelDownloadNotice(uiMessage("asrModel.notice.cancelled"));
        return false;
      }
      const status = await refreshAsrModelStatus(asrModel);
      if (
        !shouldApplyModelDownloadUpdate({
          operationId,
          activeOperationId: modelDownloadOperationIdRef.current,
          phase: modelDownloadPhaseRef.current,
        })
      ) {
        return false;
      }
      modelDownloadPhaseRef.current = "finished";
      if (status.asrModelAvailable) {
        setModelDownloadStalled(false);
        setModelDownloadProgress((current) => ({
          phase: "completed",
          wireStatus: current.wireStatus,
          message: {
            messageCode: "model.download.completed",
            args: { model: progressModel(asrModel) },
          },
          progress: 100,
        }));
        setModelDownloadNotice(uiMessage("asrModel.notice.available"));
        return true;
      } else {
        setModelDownloadStalled(false);
        setModelDownloadProgress((current) => ({
          phase: "failed",
          wireStatus: current.wireStatus,
          message: { messageCode: "model.download.failed", args: {} },
          progress: current.progress,
        }));
        setModelDownloadNotice(uiMessage("asrModel.notice.incomplete"));
        return false;
      }
    } catch (error) {
      if (
        !shouldApplyModelDownloadUpdate({
          operationId,
          activeOperationId: modelDownloadOperationIdRef.current,
          phase: modelDownloadPhaseRef.current,
        })
      ) {
        return false;
      }
      modelDownloadPhaseRef.current = "finished";
      setModelDownloadStalled(false);
      setModelDownloadProgress((current) => ({
        phase: "failed",
        wireStatus: current.wireStatus,
        message: { messageCode: "model.download.failed", args: {} },
        progress: current.progress,
      }));
      setModelDownloadNotice(
        modelDownloadTimeoutNotice(error) ?? uiMessage("asrModel.notice.downloadFailed"),
      );
      return false;
    } finally {
      if (unlisten) {
        unlisten();
      }
    }
  }

  const ensureAsrModelReady = useCallback(async (): Promise<SelectableAsrModel | null> => {
    if (!hasTauriRuntime()) {
      return DEFAULT_ASR_MODEL;
    }
    try {
      const config = await getLlmConfig();
      const asrModel = progressModel(config.asrModel);
      const status = await refreshAsrModelStatus(asrModel);
      if (status.asrModelAvailable) {
        return asrModel;
      }
      return (await startAsrModelDownload(asrModel)) ? asrModel : null;
    } catch {
      setModelGuideOpen(true);
      setModelDownloadNotice(uiMessage("asrModel.notice.downloadFailed"));
      setModelDownloadProgress((current) => ({
        ...current,
        phase: "failed",
        message: { messageCode: "model.download.failed", args: {} },
      }));
      return null;
    }
  }, [refreshAsrModelStatus, startAsrModelDownload]);

  async function cancelCurrentAsrModelDownload() {
    const operationId = modelDownloadOperationIdRef.current;
    if (modelDownloadPhaseRef.current !== "running") {
      return;
    }

    modelDownloadCancellationIntentOperationIdRef.current = operationId;
    modelDownloadPhaseRef.current = "cancelling";
    modelDownloadProgressBeforeCancellationRef.current = modelDownloadProgress;
    setModelDownloadProgress({
      ...modelDownloadProgress,
      phase: "cancelling",
      message: { messageCode: "model.cancel.requested", args: {} },
    });
    setModelDownloadStalled(false);
    setModelDownloadNotice(uiMessage("asrModel.notice.cancelling"));
    try {
      const result = await cancelAsrModelDownload();
      if (
        operationId !== modelDownloadOperationIdRef.current ||
        modelDownloadPhaseRef.current !== "cancelling" ||
        modelDownloadTerminalEventOperationIdRef.current === operationId
      ) {
        return;
      }
      if (result.status === "failed") {
        modelDownloadPhaseRef.current = "running";
        const previous = modelDownloadProgressBeforeCancellationRef.current;
        setModelDownloadProgress(
          previous
            ? previous
            : {
                phase: "running",
                wireStatus: null,
                message: {
                  messageCode: "model.download.preparing",
                  args: { model: progressModel(asrModelStatus.model) },
                },
                progress: 0,
              },
        );
        setModelDownloadNotice(uiMessage("asrModel.notice.cancelFailed"));
        return;
      }
      setModelDownloadNotice(
        result.status === "not_running"
          ? uiMessage("asrModel.notice.awaitingFinalResult")
          : uiMessage("asrModel.notice.cancelling"),
      );
    } catch {
      if (
        operationId !== modelDownloadOperationIdRef.current ||
        modelDownloadPhaseRef.current !== "cancelling" ||
        modelDownloadTerminalEventOperationIdRef.current === operationId
      ) {
        return;
      }
      modelDownloadPhaseRef.current = "running";
      const previous = modelDownloadProgressBeforeCancellationRef.current;
      if (previous) {
        setModelDownloadProgress(previous);
      }
      setModelDownloadStalled(false);
      setModelDownloadNotice(uiMessage("asrModel.notice.cancelFailed"));
    }
  }

  const openModelGuide = useCallback((notice?: UiMessage) => {
    setModelGuideOpen(true);
    if (notice !== undefined) {
      setModelDownloadNotice(notice);
    }
  }, []);

  return {
    modelGuideOpen,
    setModelGuideOpen,
    openModelGuide,
    asrModelStatus,
    modelDownloadProgress,
    modelDownloadNotice,
    modelDownloadStalled,
    modelDownloadActive,
    refreshAsrModelStatus,
    startAsrModelDownload,
    ensureAsrModelReady,
    cancelCurrentAsrModelDownload,
  };
}
