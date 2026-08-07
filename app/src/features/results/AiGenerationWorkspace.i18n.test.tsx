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
    ["zh-CN", "智能提炼工作区", "智能提炼", "要点总结", "启发灵感", "文字稿解剖", "AI Credits 余额："],
    ["zh-TW", "AI 提煉工作區", "AI 提煉", "重點摘要", "靈感啟發", "逐字稿解剖", "AI Credits 餘額："],
    ["en-US", "AI Synthesis workspace", "AI Synthesis", "Key Summary", "Inspiration", "Transcript Dissection", "AI Credits balance: 8"],
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
