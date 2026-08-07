export type ModelDownloadOperationSnapshot = {
  operationId: number;
  activeOperationId: number;
  phase: "running" | "cancelling" | "finished";
};

export type AsrModelDownloadLocalPhase =
  | "idle"
  | "running"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed";

export const MODEL_DOWNLOAD_STALLED_MS = 45_000;

export function shouldApplyModelDownloadUpdate({
  operationId,
  activeOperationId,
  phase,
}: ModelDownloadOperationSnapshot): boolean {
  return operationId === activeOperationId && phase !== "finished";
}

export function isModelDownloadStalled({
  active,
  lastProgressAtMs,
  nowMs,
  thresholdMs = MODEL_DOWNLOAD_STALLED_MS,
}: {
  active: boolean;
  lastProgressAtMs: number;
  nowMs: number;
  thresholdMs?: number;
}): boolean {
  return active && nowMs - lastProgressAtMs >= thresholdMs;
}
