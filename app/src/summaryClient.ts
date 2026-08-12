import { invoke } from "@tauri-apps/api/core";
import type { InvokeArgs } from "@tauri-apps/api/core";
import {
  IpcProtocolError,
  readIpcDataObject,
} from "./tauriIpcProtocol";

export type SaveSummaryEditResponse = {
  task_id: string;
  summary: string;
};

export type SummaryCommandRunner = (
  command: string,
  args: InvokeArgs,
) => Promise<unknown>;

const SUMMARY_IPC_RESPONSE_INVALID = "SUMMARY_IPC_RESPONSE_INVALID" as const;

const defaultRunner: SummaryCommandRunner = (command, args) =>
  invoke(command, args);

export async function saveSummaryEdit(
  taskId: string,
  summary: string,
  runner: SummaryCommandRunner = defaultRunner,
): Promise<SaveSummaryEditResponse> {
  const response = readIpcDataObject(
    await runner("save_summary_edit", {
      request: { task_id: taskId, summary },
    }),
    ["task_id", "summary"],
    [],
    SUMMARY_IPC_RESPONSE_INVALID,
  );

  if (
    typeof response.task_id !== "string" ||
    response.task_id !== taskId ||
    typeof response.summary !== "string"
  ) {
    throw new IpcProtocolError(SUMMARY_IPC_RESPONSE_INVALID);
  }

  return {
    task_id: response.task_id,
    summary: response.summary,
  };
}
