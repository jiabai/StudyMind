import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const sourcePath = (relativePath: string) =>
  fileURLToPath(new URL(relativePath, import.meta.url));
const readSource = (relativePath: string) =>
  readFileSync(sourcePath(relativePath), "utf8");
const physicalLines = (source: string) => source.split(/\r?\n/).length;

describe("frontend transcript controller ownership", () => {
  test("matches the approved private owners and stable consumer surface", () => {
    const expectedOwners = [
      "../results/useArtifactDetailController.ts",
      "./useTranscriptDocumentController.ts",
      "./useTranscriptReviewSession.ts",
    ];
    for (const owner of expectedOwners) {
      expect(existsSync(sourcePath(owner)), owner).toBe(true);
    }

    const root = readSource("./useTranscriptDetailController.ts");
    const artifact = readSource("../results/useArtifactDetailController.ts");
    const document = readSource("./useTranscriptDocumentController.ts");
    const review = readSource("./useTranscriptReviewSession.ts");

    expect(root).toContain("useArtifactDetailController");
    expect(root).toContain("useTranscriptDocumentController");
    expect(root).toContain("useTranscriptReviewSession");
    expect(root).not.toContain("loadTranscriptDetail");
    expect(root).not.toContain("saveTranscriptEdit");
    expect(root).not.toContain("convertFileSrc");
    expect(root).not.toContain("revealItemInDir");

    expect(artifact).toContain("revealItemInDir");
    expect(artifact).toContain("navigator.clipboard.writeText");
    expect(artifact).not.toContain("loadTranscriptDetail");
    expect(artifact).not.toContain("convertFileSrc");

    expect(document).toContain("loadTranscriptDetail");
    expect(document).toContain("saveTranscriptEdit");
    expect(document).not.toContain("convertFileSrc");
    expect(document).not.toContain("revealItemInDir");

    expect(review).toContain("convertFileSrc");
    expect(review).not.toContain("loadTranscriptDetail");
    expect(review).not.toContain("saveTranscriptEdit");
    expect(review).not.toContain("revealItemInDir");

    for (const child of [artifact, document, review]) {
      expect(child).not.toMatch(
        /from ["'][^"']*use(?:ArtifactDetailController|TranscriptDocumentController|TranscriptReviewSession)["']/,
      );
    }

    const consumers = [
      "../../App.tsx",
      "./LocalTranscriptWorkspace.tsx",
      "./TranscriptReviewPanel.tsx",
      "../results/AiResultDetailSheet.tsx",
    ];
    for (const consumer of consumers) {
      const source = readSource(consumer);
      expect(source).not.toContain("useTranscriptDocumentController");
      expect(source).not.toContain("useTranscriptReviewSession");
      expect(source).not.toContain("useArtifactDetailController");
    }

    expect(root).toMatch(
      /export type TranscriptDetailController\s*=\s*ReturnType<\s*typeof useTranscriptDetailController\s*>/,
    );
    expect(physicalLines(root)).toBeLessThanOrEqual(200);
    expect(physicalLines(artifact)).toBeLessThanOrEqual(250);
    expect(physicalLines(document)).toBeLessThanOrEqual(250);
    expect(physicalLines(review)).toBeLessThanOrEqual(250);
  });
});
