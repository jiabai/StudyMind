import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";

import type { HistoryListItem } from "../../historyClient";
import { formatDateTime } from "../../i18n/formatters";
import { initializeI18n } from "../../i18n/i18n";
import { LocaleProvider } from "../../i18n/LocaleProvider";
import type { SupportedLocale } from "../../i18n/locale";
import { uiMessage } from "../../i18n/uiMessage";
import { HistorySheet } from "./HistorySheet";
import type { HistoryController } from "./useHistoryController";

function createHistoryItem(overrides: Partial<HistoryListItem> = {}): HistoryListItem {
  return {
    taskId: "history-task",
    id: "history-task",
    createdAt: "2026-07-10T00:00:00.000Z",
    source: {
      kind: "url",
      url: "https://www.example.test/history-video",
    },
    status: "completed",
    taskDir: "D:/StudyMind/outputs/tasks/history-task",
    outputDir: "D:/StudyMind/outputs",
    artifacts: { transcript_txt: "transcript/transcript.txt" },
    error: null,
    textPreview: "history preview",
    insightsCount: 0,
    title: null,
    ...overrides,
  };
}

function createHistoryController(
  historyItems = [createHistoryItem()],
  overrides: Partial<HistoryController> = {},
): HistoryController {
  return {
    historyOpen: true,
    historyItems,
    historyNotice: null,
    historyLoading: false,
    historyDeleteCandidate: null,
    historyDeleting: false,
    closeHistory: vi.fn(),
    openHistory: vi.fn(),
    loadHistory: vi.fn(async () => undefined),
    openHistoryItem: vi.fn(),
    requestHistoryItemDeletion: vi.fn(),
    cancelHistoryItemDeletion: vi.fn(),
    confirmHistoryItemDeletion: vi.fn(),
    ...overrides,
  };
}

function renderHistorySheet(
  props: ComponentProps<typeof HistorySheet>,
  locale: SupportedLocale = "zh-CN",
): string {
  return renderToStaticMarkup(
    <LocaleProvider
      initialOutcome={{
        preference: locale,
        resolvedLocale: locale,
        persistedAnchor: locale,
        notice: null,
      }}
    >
      <HistorySheet {...props} />
    </LocaleProvider>,
  );
}

beforeAll(async () => {
  await initializeI18n("zh-CN");
});

describe("HistorySheet selection accessibility", () => {
  test("renders active-workflow history rows as native disabled buttons with an explanation", () => {
    const markup = renderHistorySheet({
      controller: createHistoryController(),
      selectionDisabled: true,
      selectionDisabledReason: uiMessage("history.disabled.selectionWhileProcessing"),
      deletionDisabled: true,
      deletionDisabledReason: uiMessage("history.disabled.deletionWhileProcessing"),
    });

    expect(markup).toContain('id="history-selection-disabled-reason"');
    expect(markup).toContain("当前任务仍在处理中，完成或取消确认后才能恢复历史任务。");
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('aria-describedby="history-selection-disabled-reason"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
  });

  test("deduplicates equivalent semantic disabled reasons without dangling aria references", () => {
    const markup = renderHistorySheet({
      controller: createHistoryController(),
      selectionDisabled: true,
      selectionDisabledReason: uiMessage("history.notice.detailLoading"),
      deletionDisabled: true,
      deletionDisabledReason: uiMessage("history.notice.detailLoading"),
    });

    expect(markup).toContain('id="history-selection-disabled-reason"');
    expect(markup).not.toContain('id="history-deletion-disabled-reason"');
    expect(markup).toContain('aria-describedby="history-selection-disabled-reason"');
    expect(markup).not.toContain('aria-describedby="history-deletion-disabled-reason"');
  });

  test("marks preview and URL fallback titles while preserving full card values", () => {
    const longChinesePreview = "这是一段很长的中文文字稿预览，用来确认历史任务标题具有明确的信息层级并且保留完整内容";
    const longEnglishPreview =
      "AnEnglishTranscriptPreviewWithOneUnbrokenWordThatMustStillClampReliablyAcrossTwoLines";
    const longYoutubeUrl =
      "https://www.youtube.com/watch?v=abcdefghijk&feature=share&this_is_a_long_safe_parameter=value";
    const longOutputDir =
      "D:/StudyMind/outputs/a-very-long-history-output-directory/with/additional/nested/folders";
    const failedCode = "HISTORY_ARTIFACT_UNAVAILABLE";
    const items = [
      createHistoryItem({ taskId: "zh", id: "zh", textPreview: longChinesePreview }),
      createHistoryItem({ taskId: "en", id: "en", textPreview: longEnglishPreview }),
      createHistoryItem({
        taskId: "url",
        id: "url",
        textPreview: "",
        source: { kind: "url", url: longYoutubeUrl },
      }),
      createHistoryItem({ taskId: "dir", id: "dir", outputDir: longOutputDir }),
      createHistoryItem({
        taskId: "failed",
        id: "failed",
        status: "failed",
        error: { code: failedCode },
      }),
    ];

    const markup = renderHistorySheet({
      controller: createHistoryController(items),
      selectionDisabled: false,
      selectionDisabledReason: uiMessage("history.disabled.selectionWhileProcessing"),
      deletionDisabled: false,
      deletionDisabledReason: uiMessage("history.disabled.deletionWhileProcessing"),
    });

    expect(markup).toContain('class="history-title history-title-preview"');
    expect(markup).toContain('class="history-title history-title-url"');
    expect(markup).toContain(`title="${longChinesePreview}"`);
    expect(markup).toContain(`title="${longEnglishPreview}"`);
    expect(markup).toContain(`title="${longOutputDir}"`);
    expect(markup).toContain(`title="${failedCode}"`);
    expect(markup).toContain('class="history-meta-time"');
    expect(markup).toContain('class="history-meta-output"');
    expect(markup).toContain('class="history-meta-result"');
  });

  test("renders sibling restore and permanent-delete controls without nesting buttons", () => {
    const markup = renderHistorySheet({
      controller: createHistoryController(),
      selectionDisabled: false,
      selectionDisabledReason: uiMessage("history.disabled.selectionWhileProcessing"),
      deletionDisabled: false,
      deletionDisabledReason: uiMessage("history.disabled.deletionWhileProcessing"),
    });

    expect(markup).toContain('class="history-item completed"');
    expect(markup).toContain('class="history-item-select"');
    expect(markup).toContain('class="history-item-delete"');
    expect(markup).toContain('aria-label="永久删除历史任务：history preview"');
    expect(markup).toContain('title="永久删除"');
    const selectMarkup = markup.match(
      /<button class="history-item-select"[\s\S]*?<\/button>/,
    )?.[0];
    expect(selectMarkup?.match(/<button/g)).toHaveLength(1);
    expect(markup).toMatch(/<\/button><button class="history-item-delete"/);
  });

  test("renders an irreversible confirmation with cancel as the safe first action", () => {
    const item = createHistoryItem();
    const markup = renderHistorySheet({
      controller: createHistoryController([item], {
        historyDeleteCandidate: item,
      }),
      selectionDisabled: false,
      selectionDisabledReason: uiMessage("history.disabled.selectionWhileProcessing"),
      deletionDisabled: false,
      deletionDisabledReason: uiMessage("history.disabled.deletionWhileProcessing"),
    });

    expect(markup).toContain('aria-label="确认永久删除历史任务"');
    expect(markup).toContain("视频、音频、文字稿、AI 结果和播放缓存");
    expect(markup).toContain("无法恢复");
    expect(markup.indexOf(">取消<")).toBeLessThan(markup.indexOf(">永久删除<"));
  });

  test("renders the feature terminology and dialog labels in every supported locale", async () => {
    const props: ComponentProps<typeof HistorySheet> = {
      controller: createHistoryController(),
      selectionDisabled: false,
      selectionDisabledReason: uiMessage("history.disabled.selectionWhileProcessing"),
      deletionDisabled: false,
      deletionDisabledReason: uiMessage("history.disabled.deletionWhileProcessing"),
    };

    await initializeI18n("zh-CN");
    const simplified = renderHistorySheet(props, "zh-CN");
    expect(simplified).toContain('aria-label="历史任务"');
    expect(simplified).toContain("永久删除历史任务：history preview");

    await initializeI18n("zh-TW");
    const traditional = renderHistorySheet(props, "zh-TW");
    expect(traditional).toContain('aria-label="歷史任務"');
    expect(traditional).toContain("永久刪除歷史任務：history preview");

    await initializeI18n("en-US");
    const english = renderHistorySheet(props, "en-US");
    expect(english).toContain('aria-label="History"');
    expect(english).toContain(
      'aria-label="Permanently delete history task: history preview"',
    );
  });

  test("pluralizes insight counts with localized numbers", async () => {
    await initializeI18n("en-US");
    const markup = renderHistorySheet(
      {
        controller: createHistoryController([
          createHistoryItem({ taskId: "one", id: "one", insightsCount: 1 }),
          createHistoryItem({ taskId: "many", id: "many", insightsCount: 2000 }),
        ]),
        selectionDisabled: false,
        selectionDisabledReason: uiMessage("history.disabled.selectionWhileProcessing"),
        deletionDisabled: false,
        deletionDisabledReason: uiMessage("history.disabled.deletionWhileProcessing"),
      },
      "en-US",
    );

    expect(markup).toContain("1 insight");
    expect(markup).toContain("2,000 insights");
  });

  test("formats history timestamps with the active locale", async () => {
    const createdAt = "2026-07-10T00:00:00.000Z";
    await initializeI18n("en-US");
    const markup = renderHistorySheet(
      {
        controller: createHistoryController([
          createHistoryItem({ createdAt }),
        ]),
        selectionDisabled: false,
        selectionDisabledReason: uiMessage("history.disabled.selectionWhileProcessing"),
        deletionDisabled: false,
        deletionDisabledReason: uiMessage("history.disabled.deletionWhileProcessing"),
      },
      "en-US",
    );

    expect(markup).toContain(formatDateTime(new Date(createdAt), "en-US"));
  });

  test("shows a localized media-kind label for a safe local-file source", async () => {
    await initializeI18n("en-US");
    const markup = renderHistorySheet(
      {
        controller: createHistoryController([
          createHistoryItem({
            textPreview: "",
            source: {
              kind: "local_file",
              displayName: "Interview.mp3",
              mediaKind: "audio",
            },
          }),
        ]),
        selectionDisabled: false,
        selectionDisabledReason: uiMessage("history.disabled.selectionWhileProcessing"),
        deletionDisabled: false,
        deletionDisabledReason: uiMessage("history.disabled.deletionWhileProcessing"),
      },
      "en-US",
    );

    expect(markup).toContain("Interview.mp3");
    expect(markup).toContain('class="history-source-kind"');
    expect(markup).toContain("Audio file");
    expect(markup).not.toContain("C:\\Users");
  });

  test("rerenders one semantic notice after a locale switch without exposing raw errors", async () => {
    const notice = uiMessage("history.notice.loadFailed");
    const props: ComponentProps<typeof HistorySheet> = {
      controller: createHistoryController([], { historyNotice: notice }),
      selectionDisabled: false,
      selectionDisabledReason: uiMessage("history.disabled.selectionWhileProcessing"),
      deletionDisabled: false,
      deletionDisabledReason: uiMessage("history.disabled.deletionWhileProcessing"),
    };

    await initializeI18n("zh-CN");
    expect(renderHistorySheet(props, "zh-CN")).toContain("无法读取历史任务");
    await initializeI18n("en-US");
    const english = renderHistorySheet(props, "en-US");
    expect(english).toContain("History could not be loaded");
    expect(english).not.toContain("private-token");
    expect(english).toContain('role="status"');
    expect(english).toContain('aria-live="polite"');
  });

  test("gives each delete control an accessible name tied to its task", async () => {
    await initializeI18n("en-US");
    const markup = renderHistorySheet(
      {
        controller: createHistoryController([
          createHistoryItem({ taskId: "alpha", id: "alpha", textPreview: "Alpha transcript" }),
          createHistoryItem({ taskId: "beta", id: "beta", textPreview: "Beta transcript" }),
        ]),
        selectionDisabled: false,
        selectionDisabledReason: uiMessage("history.disabled.selectionWhileProcessing"),
        deletionDisabled: false,
        deletionDisabledReason: uiMessage("history.disabled.deletionWhileProcessing"),
      },
      "en-US",
    );

    expect(markup).toContain(
      'aria-label="Permanently delete history task: Alpha transcript"',
    );
    expect(markup).toContain(
      'aria-label="Permanently delete history task: Beta transcript"',
    );
  });
});
