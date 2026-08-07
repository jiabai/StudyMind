import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  LOCAL_MEDIA_CONTRACT_VERSION,
  LOCAL_MEDIA_EXTENSIONS,
  parseLocalMediaSelectionView,
  parseProcessLocalMediaRequest,
  type LocalMediaSelectionView,
  type ProcessLocalMediaRequest,
} from "./localMediaContract";

const SELECTION_TOKEN = "01234567-89ab-4def-8abc-0123456789ab";

function validSelection(): LocalMediaSelectionView {
  return {
    selectionToken: SELECTION_TOKEN,
    displayName: "访谈.wmv",
    mediaKind: "video",
    extension: "wmv",
    sizeBytes: 1024,
  };
}

describe("local media frontend-safe contract", () => {
  test("declares v4 kinds and the closed extension map", () => {
    const contract = JSON.parse(
      readFileSync(
        new URL("../../contracts/desktop-worker-contract.json", import.meta.url),
        "utf8",
      ),
    ) as { localMedia: { extensionsByKind: typeof LOCAL_MEDIA_EXTENSIONS } };

    expect(LOCAL_MEDIA_CONTRACT_VERSION).toBe(4);
    expect(LOCAL_MEDIA_EXTENSIONS).toEqual({
      video: ["mp4", "m4v", "mov", "mkv", "avi", "wmv", "webm"],
      audio: ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "wma"],
    });
    expect(LOCAL_MEDIA_EXTENSIONS).toEqual(contract.localMedia.extensionsByKind);
  });

  test("accepts exact frontend selection metadata and token-only IPC intent", () => {
    expect(parseLocalMediaSelectionView(validSelection())).toEqual({
      kind: "valid",
      value: validSelection(),
    });

    const request = {
      selectionToken: SELECTION_TOKEN,
      asrModel: "iic/SenseVoiceSmall-onnx",
    } satisfies ProcessLocalMediaRequest;
    expect(parseProcessLocalMediaRequest(request)).toEqual({
      kind: "valid",
      value: request,
    });
    expect(
      parseLocalMediaSelectionView({ ...validSelection(), sizeBytes: Number.MAX_VALUE }),
    ).toMatchObject({ kind: "valid" });
  });

  test("rejects missing, additional, wrong-type, wrong-kind, and unsafe values", () => {
    const cases: unknown[] = [
      null,
      {},
      { ...validSelection(), selectionToken: 42 },
      { ...validSelection(), selectionToken: "not-a-uuid" },
      { ...validSelection(), displayName: "C:\\Users\\review-secret\\访谈.wmv" },
      { ...validSelection(), mediaKind: "document" },
      { ...validSelection(), mediaKind: "video", extension: "mp3" },
      { ...validSelection(), sizeBytes: "1024" },
      { ...validSelection(), sizeBytes: 0 },
      { ...validSelection(), sourcePath: "C:\\Users\\review-secret\\访谈.wmv" },
    ];

    for (const value of cases) {
      const parsed = parseLocalMediaSelectionView(value);
      expect(parsed).toEqual({
        kind: "invalid",
        errorCode: "LOCAL_MEDIA_SELECTION_INVALID",
      });
      expect(JSON.stringify(parsed)).not.toContain("review-secret");
      expect(JSON.stringify(parsed)).not.toContain("C:\\\\Users");
    }
  });

  test("rejects malformed IPC intent without echoing a token or path", () => {
    const sensitiveToken = "review-secret-selection-token";
    const cases: unknown[] = [
      null,
      {},
      { selectionToken: 42 },
      { selectionToken: sensitiveToken },
      { selectionToken: SELECTION_TOKEN, extra: true },
      {
        selectionToken: SELECTION_TOKEN,
        sourcePath: "C:\\Users\\review-secret\\recording.mp3",
      },
    ];

    for (const value of cases) {
      const parsed = parseProcessLocalMediaRequest(value);
      expect(parsed).toEqual({
        kind: "invalid",
        errorCode: "LOCAL_MEDIA_SELECTION_INVALID",
      });
      const rendered = JSON.stringify(parsed);
      expect(rendered).not.toContain(sensitiveToken);
      expect(rendered).not.toContain("review-secret");
    }
  });

  test("keeps the complete source path out of the frontend-safe module", () => {
    const source = readFileSync(new URL("./localMediaContract.ts", import.meta.url), "utf8");

    expect(source).not.toContain("source_path");
    expect(source).not.toContain("sourcePath");
  });
});
