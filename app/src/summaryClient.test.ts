import { describe, expect, test } from "vitest";
import {
  saveSummaryEdit,
  type SummaryCommandRunner,
} from "./summaryClient";

const INVALID_RESPONSE_CODE = "SUMMARY_IPC_RESPONSE_INVALID";

describe("summary client", () => {
  test("saves a summary edit and returns the validated response", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: SummaryCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return { task_id: "task-1", summary: "edited summary" };
    };

    await expect(saveSummaryEdit("task-1", "edited summary", runner)).resolves.toEqual({
      task_id: "task-1",
      summary: "edited summary",
    });
    expect(calls).toEqual([
      {
        command: "save_summary_edit",
        args: {
          request: { task_id: "task-1", summary: "edited summary" },
        },
      },
    ]);
  });

  test.each([
    ["mismatched task id", { task_id: "task-2", summary: "edited summary" }],
    ["missing task id", { summary: "edited summary" }],
    ["missing summary", { task_id: "task-1" }],
    ["non-string task id", { task_id: 1, summary: "edited summary" }],
    ["non-string summary", { task_id: "task-1", summary: 42 }],
    [
      "extra field",
      { task_id: "task-1", summary: "edited summary", updated_at: "now" },
    ],
  ])("rejects %s responses with the stable protocol error", async (_name, response) => {
    await expect(
      saveSummaryEdit("task-1", "edited summary", async () => response),
    ).rejects.toMatchObject({
      name: "IpcProtocolError",
      message: INVALID_RESPONSE_CODE,
      code: INVALID_RESPONSE_CODE,
    });
  });
});
