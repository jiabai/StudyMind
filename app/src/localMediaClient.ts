import { invoke } from "@tauri-apps/api/core";
import type { InvokeArgs } from "@tauri-apps/api/core";

import {
  parseLocalMediaSelectionView,
  parseProcessLocalMediaRequest,
  type LocalMediaSelectionView,
} from "./localMediaContract";

export type LocalMediaCommandRunner = (
  command: string,
  args: InvokeArgs,
) => Promise<unknown>;

const defaultLocalMediaRunner: LocalMediaCommandRunner = (command, args) =>
  invoke(command, args);

export async function selectLocalMedia(
  runner: LocalMediaCommandRunner = defaultLocalMediaRunner,
): Promise<LocalMediaSelectionView | null> {
  const response = await runner("select_local_media", {});
  if (response === null) {
    return null;
  }
  const parsed = parseLocalMediaSelectionView(response);
  if (parsed.kind === "invalid") {
    throw new Error(parsed.errorCode);
  }
  return parsed.value;
}

export async function selectLocalMediaByPath(
  path: string,
  runner: LocalMediaCommandRunner = defaultLocalMediaRunner,
): Promise<LocalMediaSelectionView> {
  const response = await runner("select_local_media_by_path", { path });
  const parsed = parseLocalMediaSelectionView(response);
  if (parsed.kind === "invalid") {
    throw new Error(parsed.errorCode);
  }
  return parsed.value;
}

export async function clearLocalMediaSelection(
  selectionToken: string,
  runner: LocalMediaCommandRunner = defaultLocalMediaRunner,
): Promise<boolean> {
  const parsed = parseProcessLocalMediaRequest({
    selectionToken,
    asrModel: "iic/SenseVoiceSmall",
  });
  if (parsed.kind === "invalid") {
    throw new Error(parsed.errorCode);
  }
  const response = await runner("clear_local_media_selection", {
    selectionToken: parsed.value.selectionToken,
  });
  if (typeof response !== "boolean") {
    throw new Error("LOCAL_MEDIA_SELECTION_INVALID");
  }
  return response;
}
