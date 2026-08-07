export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "ready_to_restart"
  | "up_to_date"
  | "failed"
  | "postponed";

export type UpdateState = {
  status: UpdateStatus;
  availableVersion: string | null;
  notes: string;
  message: UiMessage | null;
  progress: number;
  downloadedBytes: number;
  totalBytes: number | null;
  postponedUntil: number | null;
  error: SafeTechnicalDetails | null;
};

export type UpdateInfo = {
  version: string;
  notes?: string;
};

export type UpdateDownloadEvent =
  | {
      event: "Started";
      data: {
        contentLength?: number;
      };
    }
  | {
      event: "Progress";
      data: {
        chunkLength?: number;
      };
    }
  | {
      event: "Finished";
      data?: unknown;
    };

export function createInitialUpdateState(): UpdateState {
  return {
    status: "idle",
    availableVersion: null,
    notes: "",
    message: null,
    progress: 0,
    downloadedBytes: 0,
    totalBytes: null,
    postponedUntil: null,
    error: null,
  };
}

export function markUpdateAvailable(state: UpdateState, update: UpdateInfo): UpdateState {
  return {
    ...state,
    status: "available",
    availableVersion: update.version,
    notes: update.notes ?? "",
    message: uiMessage("updates.state.available", { version: update.version }),
    progress: 0,
    downloadedBytes: 0,
    totalBytes: null,
    postponedUntil: null,
    error: null,
  };
}

export function startUpdateCheck(state: UpdateState): UpdateState {
  return {
    ...state,
    status: "checking",
    message: uiMessage("updates.state.checking"),
    error: null,
  };
}

export function markUpdateUpToDate(state: UpdateState): UpdateState {
  return {
    ...state,
    status: "up_to_date",
    message: uiMessage("updates.state.upToDate"),
    progress: 0,
    downloadedBytes: 0,
    totalBytes: null,
    error: null,
  };
}

export function startUpdateDownload(state: UpdateState): UpdateState {
  return {
    ...state,
    status: "downloading",
    message: uiMessage("updates.state.downloading"),
    progress: 0,
    downloadedBytes: 0,
    totalBytes: null,
    error: null,
  };
}

export function applyUpdateDownloadEvent(
  state: UpdateState,
  event: UpdateDownloadEvent,
): UpdateState {
  if (event.event === "Started") {
    const totalBytes = normalizeByteCount(event.data.contentLength);
    return {
      ...state,
      status: "downloading",
      totalBytes,
      downloadedBytes: 0,
      progress: 0,
      message: uiMessage("updates.state.downloading"),
    };
  }

  if (event.event === "Progress") {
    const downloadedBytes =
      state.downloadedBytes + normalizeByteCount(event.data.chunkLength);
    return {
      ...state,
      status: "downloading",
      downloadedBytes,
      progress: calculateProgress(downloadedBytes, state.totalBytes),
      message: uiMessage("updates.state.downloading"),
    };
  }

  return {
    ...state,
    status: "installing",
    progress: 100,
    message: uiMessage("updates.state.installing"),
  };
}

export function markUpdateReadyToRestart(state: UpdateState): UpdateState {
  return {
    ...state,
    status: "ready_to_restart",
    progress: 100,
    message: uiMessage("updates.state.readyToRestart"),
    error: null,
  };
}

export function failUpdate(state: UpdateState, error: unknown): UpdateState {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ...state,
    status: "failed",
    message: uiMessage("updates.state.failed"),
    error: extractSafeTechnicalDetails({ message }),
  };
}

export function postponeUpdate(
  state: UpdateState,
  durationMs: number,
  nowMs = Date.now(),
): UpdateState {
  return {
    ...state,
    status: "postponed",
    message: uiMessage("updates.state.postponed"),
    postponedUntil: nowMs + durationMs,
  };
}

export function isUpdateInstallBlocked(input: {
  processingActive: boolean;
  modelDownloadActive: boolean;
}): boolean {
  return input.processingActive || input.modelDownloadActive;
}

export function shouldShowToolbarUpdateReminder(state: UpdateState, nowMs = Date.now()): boolean {
  if (state.status === "available" || state.status === "ready_to_restart") {
    return true;
  }

  if (state.status === "postponed") {
    return Boolean(state.postponedUntil && nowMs >= state.postponedUntil);
  }

  return state.status === "downloading" || state.status === "installing";
}

function normalizeByteCount(value: number | undefined): number {
  return Number.isFinite(value) && value && value > 0 ? value : 0;
}

function calculateProgress(downloadedBytes: number, totalBytes: number | null): number {
  if (!totalBytes || totalBytes <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)));
}
import { uiMessage, type UiMessage } from "./i18n/uiMessage";
import {
  extractSafeTechnicalDetails,
  type SafeTechnicalDetails,
} from "./safeTechnicalDetails";
