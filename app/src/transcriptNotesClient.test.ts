import { describe, expect, test } from "vitest";
import { IpcProtocolError } from "./tauriIpcProtocol";
import {
  loadTranscriptNotes,
  saveTranscriptNotes,
  type TranscriptNotesCommandRunner,
} from "./transcriptNotesClient";

const note = {
  id: "note-1",
  transcript_segment_id: "segment-1",
  source_text: "原文",
  content: "",
  created_at: "2026-08-11T10:00:00+00:00",
  updated_at: "2026-08-11T10:00:00+00:00",
};

describe("transcript notes client", () => {
  test("loads and saves transcript notes with task identity", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: TranscriptNotesCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return { task_id: "task-1", notes: [note] };
    };

    await expect(loadTranscriptNotes("task-1", runner)).resolves.toEqual({
      task_id: "task-1",
      notes: [note],
    });
    await expect(saveTranscriptNotes("task-1", [note], runner)).resolves.toEqual({
      task_id: "task-1",
      notes: [note],
    });
    expect(calls).toEqual([
      {
        command: "load_transcript_notes",
        args: { request: { task_id: "task-1" } },
      },
      {
        command: "save_transcript_notes",
        args: { request: { task_id: "task-1", notes: [note] } },
      },
    ]);
  });

  test("rejects mismatched, missing, and malformed responses", async () => {
    const invalid = new IpcProtocolError(
      "TRANSCRIPT_NOTES_IPC_RESPONSE_INVALID",
    );

    await expect(
      loadTranscriptNotes("task-1", async () => ({
        task_id: "task-2",
        notes: [],
      })),
    ).rejects.toEqual(invalid);
    await expect(
      loadTranscriptNotes("task-1", async () => ({
        task_id: "task-1",
        notes: [{ ...note, content: 42 }],
      })),
    ).rejects.toEqual(invalid);
    await expect(
      loadTranscriptNotes("task-1", async () => ({
        task_id: "task-1",
        notes: [{ ...note, updated_at: undefined }],
      })),
    ).rejects.toEqual(invalid);
    await expect(
      loadTranscriptNotes("task-1", async () => ({
        task_id: "task-1",
        notes: {},
      })),
    ).rejects.toEqual(invalid);
  });
});
