import { invoke } from "@tauri-apps/api/core";
import type { InvokeArgs } from "@tauri-apps/api/core";
import {
  IpcProtocolError,
  readIpcDataArray,
  readIpcDataObject,
} from "./tauriIpcProtocol";
import type { TranscriptNote } from "./transcriptNotesState";

export type TranscriptNotesResponse = {
  task_id: string;
  notes: TranscriptNote[];
};

export type TranscriptNotesCommandRunner = (
  command: string,
  args: InvokeArgs,
) => Promise<unknown>;

const defaultRunner: TranscriptNotesCommandRunner = (command, args) =>
  invoke(command, args);
const INVALID = "TRANSCRIPT_NOTES_IPC_RESPONSE_INVALID" as const;

export async function loadTranscriptNotes(
  taskId: string,
  runner: TranscriptNotesCommandRunner = defaultRunner,
): Promise<TranscriptNotesResponse> {
  return parseResponse(
    await runner("load_transcript_notes", {
      request: { task_id: taskId },
    }),
    taskId,
  );
}

export async function saveTranscriptNotes(
  taskId: string,
  notes: TranscriptNote[],
  runner: TranscriptNotesCommandRunner = defaultRunner,
): Promise<TranscriptNotesResponse> {
  return parseResponse(
    await runner("save_transcript_notes", {
      request: { task_id: taskId, notes },
    }),
    taskId,
  );
}

function parseResponse(
  value: unknown,
  expectedTaskId: string,
): TranscriptNotesResponse {
  const response = readIpcDataObject(
    value,
    ["task_id", "notes"],
    [],
    INVALID,
  );
  if (typeof response.task_id !== "string" || response.task_id !== expectedTaskId) {
    throwInvalidResponse();
  }

  return {
    task_id: expectedTaskId,
    notes: readIpcDataArray(response.notes, INVALID).map(parseNote),
  };
}

function parseNote(value: unknown): TranscriptNote {
  const note = readIpcDataObject(
    value,
    [
      "id",
      "transcript_segment_id",
      "source_text",
      "content",
      "created_at",
      "updated_at",
    ],
    [],
    INVALID,
  );

  if (
    typeof note.id !== "string" ||
    typeof note.transcript_segment_id !== "string" ||
    typeof note.source_text !== "string" ||
    typeof note.content !== "string" ||
    typeof note.created_at !== "string" ||
    typeof note.updated_at !== "string"
  ) {
    throwInvalidResponse();
  }

  return {
    id: note.id,
    transcript_segment_id: note.transcript_segment_id,
    source_text: note.source_text,
    content: note.content,
    created_at: note.created_at,
    updated_at: note.updated_at,
  };
}

function throwInvalidResponse(): never {
  throw new IpcProtocolError(INVALID);
}
