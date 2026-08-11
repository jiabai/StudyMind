import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

import { createGuestAccountStatus } from "../../accountState";
import { initializeI18n } from "../../i18n/i18n";
import type { SupportedLocale } from "../../i18n/locale";
import { createTaskWorkspaceViewModel } from "../../taskWorkspaceViewModel";
import { summarizeWorkerResult } from "../../workflow";
import { AiGenerationWorkspace } from "./AiGenerationWorkspace";

function renderWorkspace() {
  const workflow = summarizeWorkerResult({
    status: "completed",
    task_id: "task-1",
    task_dir: "D:/StudyMind/tasks/task-1",
    artifacts: { transcript_txt: "transcript/transcript.txt" },
    text: "User transcript content",
    summary: "",
    insights: [],
    transcript: { source: "asr", language: "en", engine: "SenseVoice" },
    dissection: null,
    dissection_source_status: null,
    error: null,
  });
  const account = {
    ...createGuestAccountStatus(),
    authenticated: true,
    entitlementStatus: "active" as const,
    llmConfigured: true,
    llmQuotaLimit: 12,
    llmQuotaUsed: 4,
    llmQuotaRemaining: 8,
    canProcess: true,
    canGenerateAi: true,
  };
  return renderToStaticMarkup(
    <AiGenerationWorkspace
      model={createTaskWorkspaceViewModel(workflow, account).ai}
      quotaRemaining={8}
      onSummaryAction={vi.fn()}
      onInsightsAction={vi.fn()}
      onDissectionAction={vi.fn()}
      onViewTarget={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
}

describe("AI Synthesis workspace localization", () => {
  test.each([
    ["zh-CN", "学习整理工作区", "学习整理", "知识结构", "学习问题", "文字稿解剖", "AI Credits 余额："],
    ["zh-TW", "學習整理工作區", "學習整理", "知識結構", "學習問題", "逐字稿解剖", "AI Credits 餘額："],
    ["en-US", "AI Synthesis workspace", "Study Synthesis", "Knowledge Structure", "Study Questions", "Transcript Dissection", "AI Credits balance: 8"],
  ] as const)(
    "renders locked terminology and controls in %s",
    async (locale, ariaLabel, title, summary, insights, dissection, balance) => {
      await initializeI18n(locale as SupportedLocale);
      const markup = renderWorkspace();
      expect(markup).toContain(`aria-label="${ariaLabel}"`);
      expect(markup).toContain(`>${title}</h2>`);
      expect(markup).toContain(summary);
      expect(markup).toContain(insights);
      expect(markup).toContain(dissection);
      expect(markup).toContain(balance);
      expect(markup).toContain("AI Credits");
      expect(markup).toContain("Mermaid");
    },
  );
});
