import { describe, expect, test } from "vitest";
import {
  loadTranscriptDetail,
  saveTranscriptEdit,
  type TranscriptDetailCommandRunner,
} from "./transcriptDetailClient";
import { IpcProtocolError } from "./tauriIpcProtocol";

describe("transcript detail client", () => {
  test("loads transcript detail through the Tauri command wire shape", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: TranscriptDetailCommandRunner = async (
      command,
      args,
    ) => {
      calls.push({ command, args });
      return {
        task_id: "task-1",
        text: "transcript",
        segments: [],
        audio_path: "D:\\StudyMind\\outputs\\tasks\\task-1\\media\\audio.wav",
        audio_asset_path: "C:\\Users\\tester\\AppData\\Local\\StudyMind\\cache\\.StudyMind-audio-review\\task-1\\audio.wav",
        has_original_backup: false,
      };
    };

    const detail = await loadTranscriptDetail("task-1", runner);

    expect(detail.task_id).toBe("task-1");
    expect(detail.text).toBe("transcript");
    expect(detail.audio_asset_path).toContain("cache\\.StudyMind-audio-review");
    expect(calls).toEqual([
      {
        command: "load_transcript_detail",
        args: {
          request: {
            task_id: "task-1",
          },
        },
      },
    ]);
  });

  test("saves transcript edits with segment payload", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner = async (command: string, args: unknown) => {
      calls.push({ command, args });
      return {
        task_id: "task-1",
        text: "updated",
        artifacts: {
          transcript_txt: "transcript/transcript.txt",
          transcript_md: "transcript/transcript.md",
          segments: "transcript/segments.json",
        },
        has_original_backup: true,
      };
    };

    await saveTranscriptEdit(
      "task-1",
      "updated",
      [{ id: "seg-0001", start_ms: 0, end_ms: 1200, text: "updated" }],
      runner,
    );

    expect(calls).toEqual([
      {
        command: "save_transcript_edit",
        args: {
          request: {
            task_id: "task-1",
            text: "updated",
            segments: [{ id: "seg-0001", start_ms: 0, end_ms: 1200, text: "updated" }],
          },
        },
      },
    ]);
  });

  test("rejects malformed transcript detail identity and segment timing", async () => {
    await expect(
      loadTranscriptDetail("task-1", async () => ({
        task_id: "different-task",
        text: "private transcript",
        segments: [
          {
            id: "seg-1",
            start_ms: 1200,
            end_ms: 100,
            text: "private transcript",
          },
        ],
        audio_path: null,
        audio_asset_path: null,
        has_original_backup: false,
      })),
    ).rejects.toEqual(
      new IpcProtocolError("TRANSCRIPT_IPC_RESPONSE_INVALID"),
    );

    await expect(
      loadTranscriptDetail("task-1", async () => ({
        task_id: "task-1",
        text: "private transcript",
        segments: [
          {
            id: "seg-1",
            start_ms: 1200,
            end_ms: 100,
            text: "private transcript",
          },
        ],
        audio_path: null,
        audio_asset_path: null,
        has_original_backup: false,
      })),
    ).rejects.toEqual(
      new IpcProtocolError("TRANSCRIPT_IPC_RESPONSE_INVALID"),
    );

    await expect(
      loadTranscriptDetail("task-1", async () => ({
        task_id: "task-1",
        text: "private transcript",
        segments: [
          {
            id: "seg-1",
            start_ms: 0,
            end_ms: 100,
            text: "private transcript",
            speaker: null,
          },
        ],
        audio_path: null,
        audio_asset_path: null,
        has_original_backup: false,
      })),
    ).rejects.toEqual(
      new IpcProtocolError("TRANSCRIPT_IPC_RESPONSE_INVALID"),
    );
  });

  test("rejects accessor-backed transcript segments without evaluating them", async () => {
    let getterCalls = 0;
    const segment = Object.defineProperty(
      {
        id: "seg-1",
        start_ms: 0,
        end_ms: 100,
      },
      "text",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return "private transcript";
        },
      },
    );

    await expect(
      loadTranscriptDetail("task-1", async () => ({
        task_id: "task-1",
        text: "private transcript",
        segments: [segment],
        audio_path: null,
        audio_asset_path: null,
        has_original_backup: false,
      })),
    ).rejects.toEqual(
      new IpcProtocolError("TRANSCRIPT_IPC_RESPONSE_INVALID"),
    );
    expect(getterCalls).toBe(0);
  });

  test("rejects malformed transcript save identity and artifacts", async () => {
    await expect(
      saveTranscriptEdit("task-1", "updated", [], async () => ({
        task_id: "different-task",
        text: "updated",
        artifacts: {
          transcript_txt: "transcript/transcript.txt",
          secret_path: "C:\\Users\\private\\transcript.txt",
        },
        has_original_backup: true,
      })),
    ).rejects.toEqual(
      new IpcProtocolError("TRANSCRIPT_IPC_RESPONSE_INVALID"),
    );

    await expect(
      saveTranscriptEdit("task-1", "updated", [], async () => ({
        task_id: "task-1",
        text: "updated",
        artifacts: {
          transcript_txt: 42,
        },
        has_original_backup: true,
      })),
    ).rejects.toEqual(
      new IpcProtocolError("TRANSCRIPT_IPC_RESPONSE_INVALID"),
    );
  });
});
