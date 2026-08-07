import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

import { initializeI18n } from "../../i18n/i18n";
import type { SupportedLocale } from "../../i18n/locale";
import { summarizeWorkerResult } from "../../workflow";
import type { TranscriptDetailController } from "../transcript/useTranscriptDetailController";
import { AiResultDetailSheet } from "./AiResultDetailSheet";

const USER_TOPIC = "Keep 用户原文 unchanged";

function renderDetails() {
  const workflow = summarizeWorkerResult({
    status: "completed",
    task_id: "task-1",
    task_dir: "D:/StudyMind/tasks/task-1",
    artifacts: { insights: "ai/insights.json" },
    text: "Transcript",
    summary: "",
    insights: [
      {
        id: 1,
        topic: USER_TOPIC,
        matchReason: "User-provided reason",
        followUpQuestions: ["Question A", "Question B"],
        suitableUse: "Newsletter",
        sourceChunkId: 1,
      },
    ],
    transcript: null,
    dissection: null,
    dissection_source_status: null,
    error: null,
  });
  const controller = {
    detailTab: "insights",
    closeDetail: vi.fn(),
    copyDetail: vi.fn(),
    exportDetail: vi.fn(),
    exportPath: "D:/StudyMind/tasks/task-1/ai/insights.md",
    detailText: USER_TOPIC,
  } as unknown as TranscriptDetailController;

  return renderToStaticMarkup(
    <AiResultDetailSheet
      actionNotice={null}
      controller={controller}
      workflow={workflow}
      onOpenDirectionEditor={vi.fn()}
    />,
  );
}

describe("AI result detail localization", () => {
  test.each([
    ["zh-CN", "启发灵感", "换个方向", "匹配理由", "启发问题", "适合用途"],
    ["zh-TW", "靈感啟發", "換個方向", "符合原因", "啟發問題", "適合用途"],
    ["en-US", "Inspiration", "Try Another Direction", "Why it matches", "Questions to explore", "Best use"],
  ] as const)(
    "localizes UI copy in %s without translating generated content",
    async (locale, title, retry, reason, questions, use) => {
      await initializeI18n(locale as SupportedLocale);
      const markup = renderDetails();

      expect(markup).toContain(`>${title}</h2>`);
      expect(markup).toContain(retry);
      expect(markup).toContain(reason);
      expect(markup).toContain(questions);
      expect(markup).toContain(use);
      expect(markup).toContain(USER_TOPIC);
      expect(markup).toContain("User-provided reason");
      expect(markup).toContain("Question A");
      expect(markup).toContain("Question B");
    },
  );
});
