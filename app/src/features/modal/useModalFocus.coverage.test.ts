import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const MODAL_SOURCES = [
  ["../../App.tsx", 1],
  ["../account/AccountSheet.tsx", 1],
  ["../asrModel/ModelGuideSheet.tsx", 1],
  ["../history/HistorySheet.tsx", 2],
  ["../insightPreferences/InsightPreferenceFlow.tsx", 1],
  ["../results/AiResultDetailSheet.tsx", 1],
  ["../settings/SettingsSheet.tsx", 1],
] as const;

describe("modal focus integration", () => {
  test.each(MODAL_SOURCES)(
    "connects every aria-modal scope in %s to the shared focus manager",
    (relativePath, expectedCount) => {
      const source = readFileSync(
        fileURLToPath(new URL(relativePath, import.meta.url)),
        "utf8",
      );

      expect(source.match(/aria-modal="true"/g) ?? []).toHaveLength(expectedCount);
      expect(source.match(/useModalFocus<HTMLElement>/g) ?? []).toHaveLength(
        expectedCount,
      );
      expect(source.match(/ref=\{\w*ModalRef\}/g) ?? []).toHaveLength(
        expectedCount,
      );
    },
  );
});
