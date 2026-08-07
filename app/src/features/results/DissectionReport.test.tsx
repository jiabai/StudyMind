import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { TranscriptDissection } from "../../workflow";
import { DissectionReport } from "./DissectionReport";

const report: TranscriptDissection = {
  schemaVersion: 1,
  sourceTranscriptSha256: "a".repeat(64),
  sourceLanguage: "zh",
  sourceChunks: [{ id: 1, startByte: 0, endByte: 3, sha256: "b".repeat(64) }],
  overallNarrative: {
    openingHook: "A question",
    structureType: "problem-solution",
    turningPoint: "The evidence changes",
    closingType: "call to action",
  },
  segments: [{
    id: 1,
    title: "Opening",
    sourceChunkIds: [1],
    coreClaim: "The central claim",
    supportingPoints: ["Evidence"],
    rhetoricalDevices: ["Contrast"],
    rhythmNote: "Fast",
    reusablePattern: "Question then answer",
    riskFlags: ["Verify the statistic"],
  }],
  highlights: Array.from({ length: 9 }, (_, index) => `Highlight ${index + 1}`),
  reusableTemplate: { name: "Template", skeleton: ["Hook", "Evidence", "Close"] },
  audienceFit: [{ audience: "Creators", fit: "high", note: "Actionable" }],
  strengths: Array.from({ length: 7 }, (_, index) => `Strength ${index + 1}`),
  weaknesses: ["Limited evidence"],
};

describe("DissectionReport", () => {
  test("renders escaped structured content with display bounds and source actions", () => {
    const markup = renderToStaticMarkup(
      <DissectionReport report={report} stale={false} onLocateChunks={() => undefined} />,
    );

    expect(markup).toContain("The central claim");
    expect(markup).toContain("Highlight 8");
    expect(markup).not.toContain("Highlight 9");
    expect(markup).toContain("Strength 6");
    expect(markup).not.toContain("Strength 7");
    expect(markup).toContain("data-source-chunks=\"1\"");
  });

  test("disables source location for a stale report", () => {
    const markup = renderToStaticMarkup(
      <DissectionReport report={report} stale onLocateChunks={() => undefined} />,
    );
    expect(markup).toContain("disabled=\"\"");
  });
});
