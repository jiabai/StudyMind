import type { Insight } from "./insightPreferences";
import { uiMessage, type UiMessage } from "./i18n/uiMessage";
import type {
  ProgressMessageDescriptor,
  WorkerProgressEvent,
  WorkflowStage,
} from "./desktopWorkerProtocol";
import {
  LOCAL_MEDIA_EXTENSIONS,
  type LocalMediaKind,
  type LocalMediaSelectionView,
} from "./localMediaContract";

export type {
  ProgressMessageDescriptor,
  WorkerProgressEvent,
  WorkflowStage,
} from "./desktopWorkerProtocol";

export type ProgressStepState = "pending" | "active" | "complete";

export type ProgressStep = {
  id: WorkflowStage;
  state: ProgressStepState;
};
export type TaskArtifactKey =
  | "video"
  | "audio"
  | "transcript_txt"
  | "transcript_md"
  | "segments"
  | "summary"
  | "mindmap"
  | "insights"
  | "insights_md"
  | "preference_snapshot"
  | "dissection"
  | "dissection_md";

export type TaskArtifacts = Partial<Record<TaskArtifactKey, string>>;

export type TranscriptMetadata = {
  source: "asr" | "subtitle";
  language: string | null;
  engine: string | null;
};

export type DissectionSourceChunk = {
  id: number;
  startByte: number;
  endByte: number;
  sha256: string;
};

export type DissectionNarrative = {
  openingHook: string | null;
  structureType: string;
  turningPoint: string | null;
  closingType: string | null;
};

export type DissectionSegment = {
  id: number;
  title: string;
  sourceChunkIds: number[];
  coreClaim: string;
  supportingPoints: string[];
  rhetoricalDevices: string[];
  rhythmNote: string;
  reusablePattern: string;
  riskFlags: string[];
};

export type TranscriptDissection = {
  schemaVersion: 1;
  sourceTranscriptSha256: string;
  sourceLanguage: string | null;
  sourceChunks: DissectionSourceChunk[];
  overallNarrative: DissectionNarrative;
  segments: DissectionSegment[];
  highlights: string[];
  reusableTemplate: { name: string; skeleton: string[] };
  audienceFit: Array<{
    audience: string;
    fit: "high" | "medium" | "low";
    note: string;
  }>;
  strengths: string[];
  weaknesses: string[];
};

export type TaskSubmission =
  | { kind: "local_media"; selectionToken: string };

export type TaskSourceSummary =
  | { kind: "url"; url: string }
  | {
      kind: "local_file";
      displayName: string;
      mediaKind: LocalMediaKind;
    };

export type TaskComposerSource =
  | { kind: "none" }
  | {
      kind: "local_media";
      selection: LocalMediaSelectionView;
    };

const UNSAFE_SOURCE_NAME_PATTERN =
  /[\/\\\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export function parseTaskSourceSummary(value: unknown): TaskSourceSummary | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  if (
    hasExactKeys(value, ["kind", "url"]) &&
    value.kind === "url" &&
    typeof value.url === "string" &&
    value.url.length > 0
  ) {
    return { kind: "url", url: value.url };
  }
  if (
    !hasExactKeys(value, ["kind", "displayName", "mediaKind"]) ||
    value.kind !== "local_file" ||
    (value.mediaKind !== "video" && value.mediaKind !== "audio") ||
    typeof value.displayName !== "string" ||
    value.displayName.trim().length === 0 ||
    Array.from(value.displayName).length > 160 ||
    value.displayName === "." ||
    value.displayName === ".." ||
    UNSAFE_SOURCE_NAME_PATTERN.test(value.displayName)
  ) {
    return null;
  }
  const extension = value.displayName.split(".").pop()?.toLocaleLowerCase("en-US");
  if (
    !extension ||
    !(LOCAL_MEDIA_EXTENSIONS[value.mediaKind] as readonly string[]).includes(extension)
  ) {
    return null;
  }
  return {
    kind: "local_file",
    displayName: value.displayName,
    mediaKind: value.mediaKind,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

export type WorkerResult = {
  status: "completed" | "partial_completed" | "failed";
  task_id: string | null;
  task_dir: string | null;
  artifacts: TaskArtifacts;
  text: string;
  summary: string;
  insights: Insight[];
  transcript: TranscriptMetadata | null;
  dissection: TranscriptDissection | null;
  dissection_source_status: "current" | "stale" | null;
  error: WorkerErrorResult | null;
};

export type WorkerErrorResult = {
  code: string;
  message: string;
  stage: WorkflowStage;
};

export type InsightRetryTarget = "summary" | "insights" | "dissection";

export type ToolbarNewTaskButtonState = {
  disabled: boolean;
  ariaLabel: UiMessage;
  title: UiMessage;
};

export type WorkflowState = {
  stage: WorkflowStage;
  cancellingFromStage: Exclude<WorkflowStage, "waiting_input" | "cancelling" | "completed" | "partial_completed" | "failed"> | null;
  activeAiTarget: InsightRetryTarget | null;
  aiErrorTarget: InsightRetryTarget | null;
  aiTargetErrors: Partial<Record<InsightRetryTarget, WorkerErrorResult>>;
  composerSource: TaskComposerSource;
  taskSource: TaskSourceSummary | null;
  statusMessage: UiMessage | null;
  progressMessage: ProgressMessageDescriptor | null;
  progressPercent: number;
  text: string;
  summary: string;
  insights: Insight[];
  taskId: string | null;
  taskDir: string | null;
  artifacts: TaskArtifacts;
  transcript: TranscriptMetadata | null;
  dissection: TranscriptDissection | null;
  dissectionStale: boolean;
  error: WorkerErrorResult | null;
};
export function createInitialWorkflow(): WorkflowState {
  return {
    stage: "waiting_input",
    cancellingFromStage: null,
    activeAiTarget: null,
    aiErrorTarget: null,
    aiTargetErrors: {},
    composerSource: { kind: "none" },
    taskSource: null,
    statusMessage: null,
    progressMessage: null,
    progressPercent: 0,
    text: "",
    summary: "",
    insights: [],
    taskId: null,
    taskDir: null,
    artifacts: {},
    transcript: null,
    dissection: null,
    dissectionStale: false,
    error: null,
  };
}
export function startProcessing(
  state: WorkflowState,
  taskSource: TaskSourceSummary,
): WorkflowState {
  return {
    ...state,
    stage: "video_extracting",
    cancellingFromStage: null,
    activeAiTarget: null,
    aiErrorTarget: null,
    aiTargetErrors: {},
    taskSource,
    statusMessage: null,
    progressMessage: {
      messageCode:
        taskSource.kind === "local_file"
          ? "local.media.validating"
          : "video.download.preparing",
      args: {},
    },
    progressPercent: 12,
    text: "",
    summary: "",
    insights: [],
    taskId: null,
    taskDir: null,
    artifacts: {},
    dissection: null,
    dissectionStale: false,
    error: null,
  };
}

export function startInsightRetry(state: WorkflowState, target: InsightRetryTarget): WorkflowState {
  const aiTargetErrors = { ...state.aiTargetErrors };
  delete aiTargetErrors[target];
  return {
    ...state,
    stage: "insights_generating",
    cancellingFromStage: null,
    activeAiTarget: target,
    aiErrorTarget: state.aiErrorTarget === target ? null : state.aiErrorTarget,
    aiTargetErrors,
    statusMessage: null,
    progressMessage: {
      messageCode:
        target === "summary"
          ? "insights.summary.generating"
          : "insights.topics.generating",
      args: {},
    },
    progressPercent: 88,
    error: null,
  };
}

export function cancelProcessing(state: WorkflowState): WorkflowState {
  return confirmProcessingCancellation(state);
}

export function requestProcessingCancellation(state: WorkflowState): WorkflowState {
  const cancellingFromStage = state.stage;
  if (
    cancellingFromStage !== "video_extracting" &&
    cancellingFromStage !== "video_transcribing" &&
    cancellingFromStage !== "insights_generating"
  ) {
    return state;
  }

  return {
    ...state,
    stage: "cancelling",
    cancellingFromStage,
    statusMessage: null,
    progressMessage: { messageCode: "task.cancel.requested", args: {} },
    error: null,
  };
}

export function restoreProcessingAfterCancellationFailure(
  state: WorkflowState,
): WorkflowState {
  const stage = state.cancellingFromStage ?? "video_extracting";
  return {
    ...state,
    stage,
    cancellingFromStage: null,
    statusMessage: uiMessage("workflow.cancellation.failed"),
    progressMessage: null,
  };
}

export function confirmProcessingCancellation(state: WorkflowState): WorkflowState {
  if (
    state.cancellingFromStage === "insights_generating" &&
    state.activeAiTarget !== null &&
    state.taskId !== null
  ) {
    return {
      ...state,
      stage: Object.keys(state.aiTargetErrors).length > 0
        ? "partial_completed"
        : "completed",
      cancellingFromStage: null,
      activeAiTarget: null,
      statusMessage: null,
      progressMessage: null,
      progressPercent: 100,
      error: null,
    };
  }
  return {
    ...createInitialWorkflow(),
    composerSource: state.composerSource,
  };
}

export function isProcessingStage(stage: WorkflowStage): boolean {
  return (
    stage === "video_extracting" ||
    stage === "video_transcribing" ||
    stage === "insights_generating" ||
    stage === "cancelling"
  );
}

export function getToolbarNewTaskButtonState(stage: WorkflowStage): ToolbarNewTaskButtonState {
  if (isProcessingStage(stage)) {
    return {
      disabled: true,
      ariaLabel: uiMessage("workflow.toolbar.newTaskUnavailable"),
      title: uiMessage("workflow.toolbar.newTaskUnavailable"),
    };
  }

  return {
    disabled: false,
    ariaLabel: uiMessage("workflow.toolbar.newTask"),
    title: uiMessage("workflow.toolbar.newTask"),
  };
}
export function getVisibleWorkflowError(state: WorkflowState): WorkerErrorResult | null {
  if (!state.error) {
    return null;
  }

  return state.stage === "failed" || state.stage === "partial_completed" ? state.error : null;
}

export function summarizeWorkerResult(
  result: WorkerResult,
  failedAiTarget: InsightRetryTarget | null = null,
): WorkflowState {
  return {
    ...createInitialWorkflow(),
    stage: result.status,
    statusMessage: null,
    progressMessage: null,
    progressPercent: result.status === "failed" ? 35 : 100,
    text: result.text,
    summary: result.summary,
    insights: result.insights,
    taskId: result.task_id,
    taskDir: result.task_dir,
    artifacts: result.artifacts ?? {},
    transcript: result.transcript ?? null,
    dissection: result.dissection,
    dissectionStale: result.dissection_source_status === "stale",
    error: result.error,
    aiErrorTarget:
      result.error?.stage === "insights_generating" ? failedAiTarget : null,
    aiTargetErrors:
      result.error?.stage === "insights_generating" && failedAiTarget
        ? { [failedAiTarget]: result.error }
        : {},
  };
}

export function finishInsightRetry(
  state: WorkflowState,
  result: WorkerResult,
  target: InsightRetryTarget,
): WorkflowState {
  const next = summarizeWorkerResult(result);
  const aiTargetErrors = { ...state.aiTargetErrors };
  if (result.error?.stage === "insights_generating") {
    aiTargetErrors[target] = result.error;
  } else {
    delete aiTargetErrors[target];
  }
  return {
    ...next,
    composerSource: state.composerSource,
    taskSource: state.taskSource,
    aiErrorTarget: result.error?.stage === "insights_generating" ? target : null,
    aiTargetErrors,
    dissection:
      target === "dissection" && result.error && result.dissection === null
        ? state.dissection
        : next.dissection,
    dissectionStale:
      target === "dissection"
        ? result.error
          ? state.dissectionStale
          : result.dissection
            ? false
            : next.dissectionStale
        : state.dissectionStale,
  };
}

export function getTranscriptSourceLabel(state: WorkflowState): UiMessage | null {
  if (!state.transcript) {
    return null;
  }
  if (state.transcript.source === "subtitle") {
    return state.transcript.language
      ? uiMessage("transcript.review.source.subtitleWithLanguage", {
          language: state.transcript.language,
        })
      : uiMessage("transcript.review.source.subtitle");
  }
  return uiMessage("transcript.review.source.asr");
}

export function mergeProgressEvent(
  state: WorkflowState,
  event: WorkerProgressEvent,
): WorkflowState {
  return {
    ...state,
    stage: event.stage,
    progressMessage: event.message,
    progressPercent: event.progress,
  };
}
