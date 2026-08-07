import { describe, expect, test, vi } from "vitest";

import {
  clearLocalMediaSelection,
  selectLocalMedia,
  type LocalMediaCommandRunner,
} from "./localMediaClient";

const SELECTION_TOKEN = "01234567-89ab-4def-8abc-0123456789ab";
const VALID_SELECTION = {
  selectionToken: SELECTION_TOKEN,
  displayName: "Interview.wmv",
  mediaKind: "video",
  extension: "wmv",
  sizeBytes: 1024,
} as const;

describe("local media client", () => {
  test("selects one file through the native picker and returns only validated metadata", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: LocalMediaCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return VALID_SELECTION;
    };

    await expect(selectLocalMedia(runner)).resolves.toEqual(VALID_SELECTION);
    expect(calls).toEqual([{ command: "select_local_media", args: {} }]);
    expect(JSON.stringify(calls)).not.toContain("sourcePath");
  });

  test("treats native picker cancellation as a side-effect-free null result", async () => {
    await expect(selectLocalMedia(async () => null)).resolves.toBeNull();
  });

  test("rejects malformed picker responses without echoing unsafe fields", async () => {
    const response = {
      ...VALID_SELECTION,
      sourcePath: "C:\\Users\\review-secret\\Interview.wmv",
    };

    await expect(selectLocalMedia(async () => response)).rejects.toThrow(
      "LOCAL_MEDIA_SELECTION_INVALID",
    );
  });

  test("clears only the exact opaque selection token", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: LocalMediaCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return true;
    };

    await expect(clearLocalMediaSelection(SELECTION_TOKEN, runner)).resolves.toBe(true);
    expect(calls).toEqual([
      {
        command: "clear_local_media_selection",
        args: { selectionToken: SELECTION_TOKEN },
      },
    ]);
  });

  test("rejects malformed clear intent and response before leaking caller values", async () => {
    const runner = vi.fn<LocalMediaCommandRunner>();

    await expect(
      clearLocalMediaSelection("C:\\Users\\review-secret\\Interview.wmv", runner),
    ).rejects.toThrow("LOCAL_MEDIA_SELECTION_INVALID");
    expect(runner).not.toHaveBeenCalled();

    await expect(
      clearLocalMediaSelection(SELECTION_TOKEN, async () => ({
        cleared: true,
        sourcePath: "C:\\Users\\review-secret\\Interview.wmv",
      })),
    ).rejects.toThrow("LOCAL_MEDIA_SELECTION_INVALID");
  });
});
