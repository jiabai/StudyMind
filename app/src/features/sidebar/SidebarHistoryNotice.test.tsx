import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, test, vi } from "vitest";

import { initializeI18n } from "../../i18n/i18n";
import { LocaleProvider } from "../../i18n/LocaleProvider";
import type { SupportedLocale } from "../../i18n/locale";
import { uiMessage } from "../../i18n/uiMessage";
import {
  historyNoticeTone,
  NOTICE_AUTO_DISMISS_MS,
  shouldAutoDismissNotice,
  SidebarHistoryNotice,
} from "./SidebarHistoryNotice";

function createProps(
  overrides: Partial<ComponentProps<typeof SidebarHistoryNotice>> = {},
): ComponentProps<typeof SidebarHistoryNotice> {
  return {
    notice: uiMessage("history.notice.loadFailed"),
    onClose: () => undefined,
    onRetry: () => undefined,
    ...overrides,
  };
}

function renderNotice(
  props: ComponentProps<typeof SidebarHistoryNotice>,
  locale: SupportedLocale,
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
      <SidebarHistoryNotice {...props} />
    </LocaleProvider>,
  );
}

beforeAll(async () => {
  await initializeI18n("zh-CN");
});

describe("SidebarHistoryNotice", () => {
  test("renders the localized notice text and a dismiss control", async () => {
    await initializeI18n("zh-CN");
    const simplified = renderNotice(
      createProps({ notice: uiMessage("history.notice.loadFailed") }),
      "zh-CN",
    );
    expect(simplified).toContain("无法读取历史任务，请稍后重试。");
    expect(simplified).toContain('class="sidebar-history-notice danger"');
    expect(simplified).toContain("重试");
    expect(simplified).toContain('role="status"');
    expect(simplified).toContain('aria-live="polite"');

    await initializeI18n("zh-TW");
    const traditional = renderNotice(
      createProps({ notice: uiMessage("history.notice.deleteFailed") }),
      "zh-TW",
    );
    expect(traditional).toContain("無法完整刪除任務");
    expect(traditional).toContain('aria-label="關閉提示"');

    await initializeI18n("en-US");
    const english = renderNotice(
      createProps({ notice: uiMessage("history.notice.deleted") }),
      "en-US",
    );
    expect(english).toContain("The task was permanently deleted.");
    expect(english).toContain('class="sidebar-history-notice success"');
    expect(english).toContain('aria-label="Dismiss notice"');

    const englishFailure = renderNotice(
      createProps({ notice: uiMessage("history.notice.loadFailed") }),
      "en-US",
    );
    expect(englishFailure).toContain("Retry");
  });

  test("does not render retry for non-load notices", async () => {
    await initializeI18n("en-US");
    const markup = renderNotice(
      createProps({ notice: uiMessage("history.notice.deleted") }),
      "en-US",
    );

    expect(markup).not.toContain("Retry");
  });

  test("invokes the dismiss callback from the close control", () => {
    const onClose = vi.fn();
    const markup = renderNotice(
      createProps({ notice: uiMessage("history.notice.deleted"), onClose }),
      "en-US",
    );

    expect(markup).toContain('class="sidebar-history-notice-close"');
    expect(onClose).not.toHaveBeenCalled();
  });

  test("renders nothing when there is no notice", () => {
    const markup = renderNotice(createProps({ notice: null }), "en-US");

    expect(markup).toBe("");
  });

  test("classifies notice tones by message code", () => {
    expect(historyNoticeTone("history.notice.loadFailed")).toBe("danger");
    expect(historyNoticeTone("history.notice.deleteFailed")).toBe("danger");
    expect(historyNoticeTone("history.notice.detailFailed")).toBe("danger");
    expect(historyNoticeTone("history.notice.deleted")).toBe("success");
    expect(historyNoticeTone("history.notice.deleting")).toBe("info");
    expect(historyNoticeTone("history.notice.detailLoading")).toBe("info");
  });

  test("auto-dismisses only success notices after a fixed delay", () => {
    expect(shouldAutoDismissNotice("history.notice.deleted")).toBe(true);
    expect(shouldAutoDismissNotice("history.notice.loadFailed")).toBe(false);
    expect(shouldAutoDismissNotice("history.notice.deleteFailed")).toBe(false);
    expect(shouldAutoDismissNotice("history.notice.detailFailed")).toBe(false);
    expect(shouldAutoDismissNotice("history.notice.deleting")).toBe(false);
    expect(shouldAutoDismissNotice("history.notice.detailLoading")).toBe(false);
    expect(NOTICE_AUTO_DISMISS_MS).toBe(3000);
  });
});
