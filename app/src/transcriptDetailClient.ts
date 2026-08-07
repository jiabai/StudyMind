import { invoke } from "@tauri-apps/api/core";
import type { InvokeArgs } from "@tauri-apps/api/core";
import {
  IpcProtocolError,
  readIpcDataArray,
  readIpcDataObject,
} from "./tauriIpcProtocol";
import { TASK_ARTIFACT_KEYS } from "./workerResultProtocol";
import type {
  TaskArtifacts,
  TaskArtifactKey,
} from "./workflow";

export type TranscriptSegment = {
  id: string;
  start_ms: number;
  end_ms: number;
  text: string;
  speaker?: string | null;
};

export type TranscriptDetailResponse = {
  task_id: string;
  text: string;
  segments: TranscriptSegment[];
  audio_path: string | null;
  audio_asset_path: string | null;
  has_original_backup: boolean;
};

export type SaveTranscriptEditResponse = {
  task_id: string;
  text: string;
  artifacts: TaskArtifacts;
  has_original_backup: boolean;
};

export type TranscriptDetailCommandRunner = (
  command: string,
  args: InvokeArgs,
) => Promise<unknown>;

const defaultDetailRunner: TranscriptDetailCommandRunner = (command, args) =>
  invoke(command, args);
const TRANSCRIPT_IPC_RESPONSE_INVALID =
  "TRANSCRIPT_IPC_RESPONSE_INVALID" as const;

export async function loadTranscriptDetail(
  taskId: string,
  runner: TranscriptDetailCommandRunner = defaultDetailRunner,
): Promise<TranscriptDetailResponse> {
  return parseTranscriptDetailResponse(
    await runner("load_transcript_detail", {
      request: {
        task_id: taskId,
      },
    }),
    taskId,
  );
}

export async function saveTranscriptEdit(
  taskId: string,
  text: string,
  segments: TranscriptSegment[],
  runner: TranscriptDetailCommandRunner = defaultDetailRunner,
): Promise<SaveTranscriptEditResponse> {
  return parseSaveTranscriptEditResponse(
    await runner("save_transcript_edit", {
      request: {
        task_id: taskId,
        text,
        segments,
      },
    }),
    taskId,
  );
}

function parseTranscriptDetailResponse(
  value: unknown,
  expectedTaskId: string,
): TranscriptDetailResponse {
  const response = readIpcDataObject(
    value,
    [
      "task_id",
      "text",
      "segments",
      "audio_path",
      "audio_asset_path",
      "has_original_backup",
    ],
    [],
    TRANSCRIPT_IPC_RESPONSE_INVALID,
  );
  if (
    response.task_id !== expectedTaskId ||
    typeof response.text !== "string" ||
    !isNullableString(response.audio_path) ||
    !isNullableString(response.audio_asset_path) ||
    typeof response.has_original_backup !== "boolean"
  ) {
    throwInvalidTranscriptResponse();
  }
  return {
    task_id: expectedTaskId,
    text: response.text,
    segments: readIpcDataArray(
      response.segments,
      TRANSCRIPT_IPC_RESPONSE_INVALID,
    ).map(parseTranscriptSegment),
    audio_path: response.audio_path,
    audio_asset_path: response.audio_asset_path,
    has_original_backup: response.has_original_backup,
  };
}

function parseTranscriptSegment(value: unknown): TranscriptSegment {
  const response = readIpcDataObject(
    value,
    ["id", "start_ms", "end_ms", "text"],
    ["speaker"],
    TRANSCRIPT_IPC_RESPONSE_INVALID,
  );
  const hasSpeaker = Object.prototype.hasOwnProperty.call(
    response,
    "speaker",
  );
  if (
    typeof response.id !== "string" ||
    !isSafeUnsignedInteger(response.start_ms) ||
    !isSafeUnsignedInteger(response.end_ms) ||
    response.end_ms < response.start_ms ||
    typeof response.text !== "string"
  ) {
    throwInvalidTranscriptResponse();
  }
  const segment = {
    id: response.id,
    start_ms: response.start_ms,
    end_ms: response.end_ms,
    text: response.text,
  };
  if (!hasSpeaker) {
    return segment;
  }
  if (typeof response.speaker !== "string") {
    throwInvalidTranscriptResponse();
  }
  return { ...segment, speaker: response.speaker };
}

function parseSaveTranscriptEditResponse(
  value: unknown,
  expectedTaskId: string,
): SaveTranscriptEditResponse {
  const response = readIpcDataObject(
    value,
    ["task_id", "text", "artifacts", "has_original_backup"],
    [],
    TRANSCRIPT_IPC_RESPONSE_INVALID,
  );
  if (
    response.task_id !== expectedTaskId ||
    typeof response.text !== "string" ||
    typeof response.has_original_backup !== "boolean"
  ) {
    throwInvalidTranscriptResponse();
  }
  return {
    task_id: expectedTaskId,
    text: response.text,
    artifacts: parseTranscriptArtifacts(response.artifacts),
    has_original_backup: response.has_original_backup,
  };
}

function parseTranscriptArtifacts(value: unknown): TaskArtifacts {
  const response = readIpcDataObject(
    value,
    [],
    TASK_ARTIFACT_KEYS,
    TRANSCRIPT_IPC_RESPONSE_INVALID,
  );
  const artifacts: TaskArtifacts = {};
  for (const [key, artifact] of Object.entries(response)) {
    if (
      !isOneOf(key, TASK_ARTIFACT_KEYS) ||
      typeof artifact !== "string"
    ) {
      throwInvalidTranscriptResponse();
    }
    artifacts[key as TaskArtifactKey] = artifact;
  }
  return artifacts;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isSafeUnsignedInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isOneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return (
    typeof value === "string" &&
    values.includes(value as Values[number])
  );
}

function throwInvalidTranscriptResponse(): never {
  throw new IpcProtocolError(TRANSCRIPT_IPC_RESPONSE_INVALID);
}
