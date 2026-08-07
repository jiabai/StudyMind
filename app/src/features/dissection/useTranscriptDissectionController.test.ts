import { describe, expect, test } from "vitest";

import { createDissectionPreview } from "./useTranscriptDissectionController";

describe("transcript dissection preview", () => {
  test("freezes transcript facts, output language, and call bounds", () => {
    const preview = createDissectionPreview({
      taskTitle: "Interview.mov",
      transcript: "🙂".repeat(2001),
      outputLanguage: "zh-TW",
      quotaRemaining: 3,
    });

    expect(preview).toMatchObject({
      taskTitle: "Interview.mov",
      characterCount: 2001,
      chunkCount: 2,
      minimumCalls: 2,
      maximumCalls: 3,
      outputLanguage: "zh-TW",
      canConfirm: true,
    });
  });

  test("blocks admission when the conservative upper bound exceeds quota", () => {
    expect(createDissectionPreview({
      taskTitle: "task",
      transcript: "x".repeat(2001),
      outputLanguage: "en-US",
      quotaRemaining: 2,
    }).canConfirm).toBe(false);
  });
});
