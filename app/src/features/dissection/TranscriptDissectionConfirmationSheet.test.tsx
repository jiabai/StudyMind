import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { initializeI18n } from "../../i18n/i18n";
import { TranscriptDissectionConfirmationSheet } from "./TranscriptDissectionConfirmationSheet";

describe("TranscriptDissectionConfirmationSheet", () => {
  test("shows frozen facts without exposing transcript content", async () => {
    await initializeI18n("en-US");
    const markup = renderToStaticMarkup(
      <TranscriptDissectionConfirmationSheet
        preview={{
          taskTitle: "Interview.mov",
          characterCount: 4001,
          chunkCount: 3,
          minimumCalls: 2,
          maximumCalls: 3,
          hardMaximumCalls: 6,
          outputLanguage: "en-US",
          quotaRemaining: 8,
          eligible: true,
          canConfirm: true,
        }}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    expect(markup).toContain("Interview.mov");
    expect(markup).toContain("4,001");
    expect(markup).toContain("2–3");
    expect(markup).toContain("English");
    expect(markup).toContain("source URL");
    expect(markup).not.toContain("secret transcript content");
  });

  test.each([
    ["zh-CN", "确认解剖这份文字稿", "简体中文"],
    ["zh-TW", "確認解剖這份逐字稿", "繁體中文"],
    ["en-US", "Confirm this transcript dissection", "English"],
  ] as const)("localizes the frozen confirmation in %s", async (locale, title, language) => {
    await initializeI18n(locale);
    const markup = renderToStaticMarkup(
      <TranscriptDissectionConfirmationSheet
        preview={{
          taskTitle: "task",
          characterCount: 1,
          chunkCount: 1,
          minimumCalls: 2,
          maximumCalls: 3,
          hardMaximumCalls: 6,
          outputLanguage: locale,
          quotaRemaining: 3,
          eligible: true,
          canConfirm: true,
        }}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    expect(markup).toContain(title);
    expect(markup).toContain(language);
  });
});
