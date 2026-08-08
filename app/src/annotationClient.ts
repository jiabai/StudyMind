import { invoke } from "@tauri-apps/api/core";
import type { InvokeArgs } from "@tauri-apps/api/core";
import {
  IpcProtocolError,
  readIpcDataArray,
  readIpcDataObject,
} from "./tauriIpcProtocol";

const ANNOTATION_IPC_RESPONSE_INVALID =
  "ANNOTATION_IPC_RESPONSE_INVALID" as const;

export type SummaryAnnotation = {
  id: string;
  target_tab: string;
  text_anchor: string;
  char_index: number;
  content: string;
  color: string | null;
  created_at: string;
  updated_at: string;
};

export type LoadAnnotationsResponse = {
  task_id: string;
  annotations: SummaryAnnotation[];
};

export type SaveAnnotationsResponse = {
  task_id: string;
  annotations: SummaryAnnotation[];
};

export type AnnotationCommandRunner = (
  command: string,
  args: InvokeArgs,
) => Promise<unknown>;

const defaultRunner: AnnotationCommandRunner = (command, args) =>
  invoke(command, args);

export async function loadAnnotations(
  taskId: string,
  runner: AnnotationCommandRunner = defaultRunner,
): Promise<LoadAnnotationsResponse> {
  return parseLoadResponse(
    await runner("load_annotations", {
      request: { task_id: taskId },
    }),
    taskId,
  );
}

export async function saveAnnotations(
  taskId: string,
  annotations: SummaryAnnotation[],
  runner: AnnotationCommandRunner = defaultRunner,
): Promise<SaveAnnotationsResponse> {
  return parseSaveResponse(
    await runner("save_annotations", {
      request: { task_id: taskId, annotations },
    }),
    taskId,
  );
}

function parseLoadResponse(
  value: unknown,
  expectedTaskId: string,
): LoadAnnotationsResponse {
  const response = readIpcDataObject(
    value,
    ["task_id", "annotations"],
    [],
    ANNOTATION_IPC_RESPONSE_INVALID,
  );
  if (response.task_id !== expectedTaskId) {
    throwInvalidResponse();
  }
  return {
    task_id: expectedTaskId,
    annotations: readIpcDataArray(
      response.annotations,
      ANNOTATION_IPC_RESPONSE_INVALID,
    ).map(parseAnnotation),
  };
}

function parseSaveResponse(
  value: unknown,
  expectedTaskId: string,
): SaveAnnotationsResponse {
  const response = readIpcDataObject(
    value,
    ["task_id", "annotations"],
    [],
    ANNOTATION_IPC_RESPONSE_INVALID,
  );
  if (response.task_id !== expectedTaskId) {
    throwInvalidResponse();
  }
  return {
    task_id: expectedTaskId,
    annotations: readIpcDataArray(
      response.annotations,
      ANNOTATION_IPC_RESPONSE_INVALID,
    ).map(parseAnnotation),
  };
}

function parseAnnotation(value: unknown): SummaryAnnotation {
  const response = readIpcDataObject(
    value,
    [
      "id",
      "target_tab",
      "text_anchor",
      "char_index",
      "content",
      "created_at",
      "updated_at",
    ],
    ["color"],
    ANNOTATION_IPC_RESPONSE_INVALID,
  );

  if (
    typeof response.id !== "string" ||
    typeof response.target_tab !== "string" ||
    typeof response.text_anchor !== "string" ||
    typeof response.char_index !== "number" ||
    !Number.isSafeInteger(response.char_index) ||
    response.char_index < 0 ||
    typeof response.content !== "string" ||
    typeof response.created_at !== "string" ||
    typeof response.updated_at !== "string"
  ) {
    throwInvalidResponse();
  }

  return {
    id: response.id,
    target_tab: response.target_tab,
    text_anchor: response.text_anchor,
    char_index: response.char_index,
    content: response.content,
    color: typeof response.color === "string" ? response.color : null,
    created_at: response.created_at,
    updated_at: response.updated_at,
  };
}

function throwInvalidResponse(): never {
  throw new IpcProtocolError(ANNOTATION_IPC_RESPONSE_INVALID);
}
