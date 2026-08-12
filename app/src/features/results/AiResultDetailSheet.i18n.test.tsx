import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";

import { initializeI18n } from "../../i18n/i18n";
import type { SupportedLocale } from "../../i18n/locale";
import { summarizeWorkerResult } from "../../workflow";
import type { TranscriptDetailController } from "../transcript/useTranscriptDetailController";
import { AiResultDetailSheet } from "./AiResultDetailSheet";

const USER_TOPIC = "Keep 用户原文 unchanged";

function renderSummaryDetails({
  artifacts = { summary: "ai/summary.md" },
  summaryEditing = false,
  summaryDraft = "# Draft summary",
}: {
  artifacts?: Record<string, string>;
  summaryEditing?: boolean;
  summaryDraft?: string;
} = {}) {
  const workflow = summarizeWorkerResult({
    status: "completed",
    task_id: "task-summary",
    task_dir: "D:/StudyMind/tasks/task-summary",
    artifacts,
    text: "Transcript",
    summary: "# Saved summary",
    insights: [],
    transcript: null,
    dissection: null,
    dissection_source_status: null,
    error: null,
  });
  const controller = {
    detailTab: "summary",
    closeDetail: vi.fn(),
    copyDetail: vi.fn(),
    exportDetail: vi.fn(),
    exportPath: "D:/StudyMind/tasks/task-summary/ai/summary.md",
    detailText: workflow.summary,
    summaryEditing,
    summaryDraft,
    summaryDirty: false,
    summarySaving: false,
    beginSummaryEdit: vi.fn(),
    cancelSummaryEdit: vi.fn(),
    updateSummaryDraft: vi.fn(),
    saveSummaryDraft: vi.fn(),
  } as unknown as TranscriptDetailController;

  return renderToStaticMarkup(
    <AiResultDetailSheet
      actionNotice={null}
      controller={controller}
      workflow={workflow}
      annotations={[]}
      annotationsLoading={false}
      activeAnnotationId={null}
      onAnnotationAdd={vi.fn()}
      onAnnotationUpdate={vi.fn()}
      onAnnotationDelete={vi.fn()}
      onOpenDirectionEditor={vi.fn()}
    />
  );
}

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
      annotations={[]}
      annotationsLoading={false}
      activeAnnotationId={null}
      onAnnotationAdd={vi.fn()}
      onAnnotationUpdate={vi.fn()}
      onAnnotationDelete={vi.fn()}
      onOpenDirectionEditor={vi.fn()}
    />,
  );
}

describe("AI result detail localization", () => {
  test.each([
    ["zh-CN", "学习问题", "换个方向", "匹配理由", "复习与练习问题", "学习用途"],
    ["zh-TW", "學習問題", "換個方向", "符合原因", "複習與練習問題", "學習用途"],
    ["en-US", "Study Questions", "Try Another Direction", "Why it matches", "Review and practice questions", "Study use"],
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

  test("shows the local summary edit action only when the summary artifact exists", async () => {
    await initializeI18n("zh-CN");
    expect(renderSummaryDetails()).toContain(">编辑</span>");
    expect(renderSummaryDetails({ artifacts: {} })).not.toContain(">编辑</span>");
  });

  test("renders the draft editor and wires save to the controller", async () => {
    await initializeI18n("en-US");
    const markup = renderSummaryDetails({ summaryEditing: true, summaryDraft: "## Draft" });
    const source = readFileSync(new URL("./AiResultDetailSheet.tsx", import.meta.url), "utf8");

    expect(markup).toContain(">Draft</h2>");
    expect(markup).toContain("Edit");
    expect(markup).toContain("Preview");
    expect(markup).toContain("Save");
    expect(source).toContain("saveSummaryDraft");
    expect(source).toContain("MarkdownContent");
    expect(source).toContain("summaryEditorHint");
  });
});
