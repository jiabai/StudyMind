import type { PreferenceSnapshot } from "./insightPreferences";
import { isSupportedLocale, type SupportedLocale } from "./i18n/locale";

export const WORKER_PROGRESS_EVENT = "worker-progress";
export const ASR_MODEL_DOWNLOAD_PROGRESS_EVENT = "asr-model-download-progress";

export const WORKER_PROGRESS_STAGES = [
  "waiting_input",
  "video_extracting",
  "video_transcribing",
  "insights_generating",
  "completed",
  "partial_completed",
  "failed",
] as const;

// `cancelling` is a desktop supervisor/UI state, not a Python worker progress wire stage.
export const WORKFLOW_STAGES = [
  "waiting_input",
  "cancelling",
  ...WORKER_PROGRESS_STAGES.slice(1),
] as const;

export const ASR_MODEL_DOWNLOAD_WIRE_STATUSES = [
  "started",
  "downloading",
  "extracting",
  "completed",
  "cancelled",
] as const;

export const PROGRESS_MESSAGE_MODELS = [
  "iic/SenseVoiceSmall",
  "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
  "iic/SenseVoiceSmall-onnx",
  "iic/speech_fsmn_vad_zh-cn-16k-common-onnx",
] as const;

type ProgressMessageArgKey = "model" | "language" | "attempt" | "total";

export const WORKER_MESSAGE_CODE_RULES = {
  "local.media.validating": { allowedArgs: [] },
  "local.video.copying": { allowedArgs: [] },
  "local.audio.normalizing": { allowedArgs: [] },
  "audio.extract.running": { allowedArgs: [] },
  "audio.extract.reused": { allowedArgs: [] },
  "subtitle.detect.running": { allowedArgs: [] },
  "subtitle.detect.found": { allowedArgs: ["language"] },
  "asr.cache.preparing": { allowedArgs: ["model"] },
  "asr.transcribe.starting": { allowedArgs: [] },
  "asr.transcribe.running": { allowedArgs: [] },
  "ai.generation.running": { allowedArgs: ["attempt", "total"] },
} as const satisfies Record<string, { allowedArgs: readonly ProgressMessageArgKey[] }>;

export const ASR_MODEL_DOWNLOAD_MESSAGE_CODE_RULES = {
  "model.download.preparing": {
    status: "started",
    current_file: "forbidden",
    allowedArgs: ["model"],
  },
  "model.download.completed": {
    status: "completed",
    current_file: "forbidden",
    allowedArgs: ["model"],
  },
  "model.download.cancelled": {
    status: "cancelled",
    current_file: "forbidden",
    allowedArgs: [],
  },
  "model.primary.downloading": {
    status: "downloading",
    current_file: "forbidden",
    allowedArgs: ["model"],
  },
  "model.vad.downloading": {
    status: "downloading",
    current_file: "forbidden",
    allowedArgs: ["model"],
  },
  "model.bpe.downloading": {
    status: "downloading",
    current_file: "forbidden",
    allowedArgs: ["model"],
  },
  "model.archive.extracting": {
    status: "extracting",
    current_file: "forbidden",
    allowedArgs: [],
  },
  "model.archive.reading": {
    status: "downloading",
    current_file: "forbidden",
    allowedArgs: [],
  },
  "model.archive.downloading": {
    status: "downloading",
    current_file: "forbidden",
    allowedArgs: [],
  },
  "model.file.downloading": {
    status: "downloading",
    current_file: "required",
    allowedArgs: [],
  },
  "model.file.completed": {
    status: "downloading",
    current_file: "required",
    allowedArgs: [],
  },
} as const satisfies Record<
  string,
  {
    status: AsrModelDownloadWireStatus;
    current_file: "required" | "forbidden";
    allowedArgs: readonly ProgressMessageArgKey[];
  }
>;

export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];
export type WorkerProgressStage = (typeof WORKER_PROGRESS_STAGES)[number];
export type AsrModelDownloadWireStatus =
  (typeof ASR_MODEL_DOWNLOAD_WIRE_STATUSES)[number];
export type WorkerMessageCode = keyof typeof WORKER_MESSAGE_CODE_RULES;
export type AsrModelDownloadMessageCode =
  keyof typeof ASR_MODEL_DOWNLOAD_MESSAGE_CODE_RULES;

export type ProgressMessageArgs = {
  model?: (typeof PROGRESS_MESSAGE_MODELS)[number];
  language?: string;
  attempt?: number;
  total?: number;
};

export type ProgressMessageDescriptor = {
  messageCode: string;
  args: ProgressMessageArgs;
};

export type WorkerProgressEvent = {
  stage: WorkerProgressStage;
  progress: number;
  message: ProgressMessageDescriptor;
};

export type AsrModelDownloadProgressEvent = {
  status: AsrModelDownloadWireStatus;
  progress: number;
  message: ProgressMessageDescriptor;
  currentFile?: string;
};

export type ProtocolParseResult<T> =
  | { kind: "known"; diagnosticCode: string; event: T }
  | { kind: "unknown"; diagnosticCode: string; event: T }
  | { kind: "invalid"; diagnosticCode: string };

export type RetryInsightsInput =
  | {
      taskId: string;
      target: "summary";
      outputLanguage: SupportedLocale;
      preferenceSnapshot?: never;
    }
  | {
      taskId: string;
      target: "insights";
      outputLanguage: SupportedLocale;
      preferenceSnapshot?: PreferenceSnapshot;
    }
  | {
      taskId: string;
      target: "dissection";
      outputLanguage: SupportedLocale;
      preferenceSnapshot?: never;
    };

export type RetryInsightsWireRequest =
  | {
      task_id: string;
      target: "summary";
      output_language: SupportedLocale;
    }
  | {
      task_id: string;
      target: "insights";
      output_language: SupportedLocale;
      preference_snapshot?: PreferenceSnapshot;
    }
  | {
      task_id: string;
      target: "dissection";
      output_language: SupportedLocale;
    };

export type RetryInsightsParseResult =
  | { kind: "valid"; request: RetryInsightsWireRequest }
  | { kind: "invalid"; taskId: string | null };

const SAFE_CODE_PATTERN =
  /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const LANGUAGE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const PORTABLE_BASENAME_PATTERN =
  /^(?!\.{1,2}$)(?=[A-Za-z0-9._+() -]{1,255}$)(?=.*[A-Za-z0-9])[A-Za-z0-9._+()-](?:[A-Za-z0-9._+() -]{0,253}[A-Za-z0-9_+()-])?$/;
const TASK_ID_PATTERN = /^[0-9A-Za-z_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((field) => hasOwn(value, field)) &&
    Object.keys(value).every((field) => allowed.has(field))
  );
}

function isWorkerProgressStage(value: unknown): value is WorkerProgressStage {
  return (
    typeof value === "string" &&
    (WORKER_PROGRESS_STAGES as readonly string[]).includes(value)
  );
}

function isWireStatus(value: unknown): value is AsrModelDownloadWireStatus {
  return (
    typeof value === "string" &&
    (ASR_MODEL_DOWNLOAD_WIRE_STATUSES as readonly string[]).includes(value)
  );
}

function isProgress(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100;
}

function isSafeCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 96 &&
    SAFE_CODE_PATTERN.test(value)
  );
}

function diagnosticCode(payload: unknown): string {
  if (!isRecord(payload)) {
    return "invalid";
  }
  return isSafeCode(payload.message_code) ? payload.message_code : "invalid";
}

function isKnownWorkerCode(value: string): value is WorkerMessageCode {
  return hasOwn(WORKER_MESSAGE_CODE_RULES, value);
}

function isKnownModelCode(value: string): value is AsrModelDownloadMessageCode {
  return hasOwn(ASR_MODEL_DOWNLOAD_MESSAGE_CODE_RULES, value);
}

function validateMessageArgs(
  value: unknown,
  allowedArgs: readonly ProgressMessageArgKey[],
): ProgressMessageArgs | null {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value) || Object.keys(value).some((key) => !allowedArgs.includes(key as ProgressMessageArgKey))) {
    return null;
  }

  const args: ProgressMessageArgs = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (key === "model") {
      if (
        typeof rawValue !== "string" ||
        !(PROGRESS_MESSAGE_MODELS as readonly string[]).includes(rawValue)
      ) {
        return null;
      }
      args.model = rawValue as ProgressMessageArgs["model"];
    } else if (key === "language") {
      if (
        typeof rawValue !== "string" ||
        rawValue.length < 2 ||
        rawValue.length > 35 ||
        !LANGUAGE_PATTERN.test(rawValue)
      ) {
        return null;
      }
      args.language = rawValue;
    } else if (key === "attempt" || key === "total") {
      if (!Number.isInteger(rawValue) || (rawValue as number) < 1 || (rawValue as number) > 100) {
        return null;
      }
      args[key] = rawValue as number;
    } else {
      return null;
    }
  }

  if (
    args.attempt !== undefined &&
    args.total !== undefined &&
    args.attempt > args.total
  ) {
    return null;
  }
  return args;
}

function validateUnknownArgs(value: unknown): ProgressMessageArgs | null {
  if (value === undefined) {
    return {};
  }
  return isRecord(value) && Object.keys(value).length === 0 ? {} : null;
}

export function parseWorkerProgressEvent(
  payload: unknown,
): ProtocolParseResult<WorkerProgressEvent> {
  const safeDiagnosticCode = diagnosticCode(payload);
  if (
    !isRecord(payload) ||
    !hasExactFields(payload, ["stage", "progress", "message_code"], ["message_args"]) ||
    !isWorkerProgressStage(payload.stage) ||
    !isProgress(payload.progress) ||
    !isSafeCode(payload.message_code)
  ) {
    return { kind: "invalid", diagnosticCode: safeDiagnosticCode };
  }

  const messageCode = payload.message_code;
  let kind: "known" | "unknown";
  let args: ProgressMessageArgs | null;
  if (isKnownWorkerCode(messageCode)) {
    kind = "known";
    args = validateMessageArgs(
      payload.message_args,
      WORKER_MESSAGE_CODE_RULES[messageCode].allowedArgs,
    );
  } else {
    kind = "unknown";
    args = validateUnknownArgs(payload.message_args);
  }
  if (args === null) {
    return { kind: "invalid", diagnosticCode: safeDiagnosticCode };
  }

  return {
    kind,
    diagnosticCode: messageCode,
    event: {
      stage: payload.stage,
      progress: payload.progress,
      message: { messageCode, args },
    },
  };
}

export function parseAsrModelDownloadProgressEvent(
  payload: unknown,
): ProtocolParseResult<AsrModelDownloadProgressEvent> {
  const safeDiagnosticCode = diagnosticCode(payload);
  if (
    !isRecord(payload) ||
    !hasExactFields(
      payload,
      ["status", "progress", "message_code"],
      ["current_file", "message_args"],
    ) ||
    !isWireStatus(payload.status) ||
    !isProgress(payload.progress) ||
    !isSafeCode(payload.message_code)
  ) {
    return { kind: "invalid", diagnosticCode: safeDiagnosticCode };
  }

  const messageCode = payload.message_code;
  let kind: "known" | "unknown";
  let args: ProgressMessageArgs | null;
  if (isKnownModelCode(messageCode)) {
    kind = "known";
    args = validateMessageArgs(
      payload.message_args,
      ASR_MODEL_DOWNLOAD_MESSAGE_CODE_RULES[messageCode].allowedArgs,
    );
  } else {
    kind = "unknown";
    args = validateUnknownArgs(payload.message_args);
  }
  if (args === null) {
    return { kind: "invalid", diagnosticCode: safeDiagnosticCode };
  }

  if (isKnownModelCode(messageCode)) {
    const rule = ASR_MODEL_DOWNLOAD_MESSAGE_CODE_RULES[messageCode];
    if (
      payload.status !== rule.status ||
      (rule.current_file === "required" &&
        (typeof payload.current_file !== "string" ||
          !PORTABLE_BASENAME_PATTERN.test(payload.current_file))) ||
      (rule.current_file === "forbidden" && hasOwn(payload, "current_file"))
    ) {
      return { kind: "invalid", diagnosticCode: safeDiagnosticCode };
    }
  } else if (
    hasOwn(payload, "current_file") &&
    (typeof payload.current_file !== "string" ||
      !PORTABLE_BASENAME_PATTERN.test(payload.current_file))
  ) {
    return { kind: "invalid", diagnosticCode: safeDiagnosticCode };
  }

  const event: AsrModelDownloadProgressEvent = {
    status: payload.status,
    progress: payload.progress,
    message: { messageCode, args },
  };
  if (typeof payload.current_file === "string") {
    event.currentFile = payload.current_file;
  }

  return {
    kind,
    diagnosticCode: messageCode,
    event,
  };
}

export function isKnownWorkerMessageCode(code: string): code is WorkerMessageCode {
  return isKnownWorkerCode(code);
}

export function isKnownAsrModelDownloadMessageCode(
  code: string,
): code is AsrModelDownloadMessageCode {
  return isKnownModelCode(code);
}

export function parseRetryInsightsInput(payload: unknown): RetryInsightsParseResult {
  const taskId =
    isRecord(payload) &&
    typeof payload.taskId === "string" &&
    TASK_ID_PATTERN.test(payload.taskId.trim())
      ? payload.taskId.trim()
      : null;
  if (
    !isRecord(payload) ||
    !hasExactFields(
      payload,
      ["taskId", "target", "outputLanguage"],
      ["preferenceSnapshot"],
    ) ||
    taskId === null ||
    (payload.target !== "summary" &&
      payload.target !== "insights" &&
      payload.target !== "dissection") ||
    !isSupportedLocale(payload.outputLanguage)
  ) {
    return { kind: "invalid", taskId };
  }

  const hasSnapshot = hasOwn(payload, "preferenceSnapshot");
  if (
    (payload.target !== "insights" && hasSnapshot) ||
    (hasSnapshot && !isRecord(payload.preferenceSnapshot))
  ) {
    return { kind: "invalid", taskId };
  }

  if (payload.target === "summary" || payload.target === "dissection") {
    return {
      kind: "valid",
      request: {
        task_id: taskId,
        target: payload.target,
        output_language: payload.outputLanguage,
      },
    };
  }

  const request: RetryInsightsWireRequest = {
    task_id: taskId,
    target: "insights",
    output_language: payload.outputLanguage,
  };
  if (hasSnapshot) {
    request.preference_snapshot = payload.preferenceSnapshot as PreferenceSnapshot;
  }
  return { kind: "valid", request };
}
