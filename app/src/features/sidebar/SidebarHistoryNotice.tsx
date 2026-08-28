import { useEffect } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useLocale } from "../../i18n/LocaleProvider";
import { renderUiMessage, type UiMessage } from "../../i18n/uiMessage";

type SidebarHistoryNoticeProps = {
  notice: UiMessage | null;
  onClose: () => void;
  onRetry?: () => void;
};

export const NOTICE_AUTO_DISMISS_MS = 3000;

export function historyNoticeTone(
  messageCode: string,
): "danger" | "success" | "info" {
  if (messageCode.includes("Failed")) {
    return "danger";
  }
  if (messageCode.endsWith(".deleted")) {
    return "success";
  }
  return "info";
}

export function shouldAutoDismissNotice(messageCode: string): boolean {
  return messageCode.endsWith(".deleted");
}

export function SidebarHistoryNotice({
  notice,
  onClose,
  onRetry,
}: SidebarHistoryNoticeProps) {
  const { t } = useTranslation("sidebar");
  const { resolvedLocale } = useLocale();

  useEffect(() => {
    if (!notice || !shouldAutoDismissNotice(notice.messageCode)) {
      return;
    }
    const timer = setTimeout(onClose, NOTICE_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [notice, onClose]);

  if (!notice) {
    return null;
  }

  return (
    <div
      className={`sidebar-history-notice ${historyNoticeTone(notice.messageCode)}`}
      role="status"
      aria-live="polite"
    >
      <span className="sidebar-history-notice-text">
        {renderUiMessage(resolvedLocale, notice)}
      </span>
      {onRetry && notice.messageCode === "history.notice.loadFailed" ? (
        <button
          type="button"
          className="sidebar-history-notice-retry"
          onClick={onRetry}
        >
          {t("noticeRetry")}
        </button>
      ) : null}
      {notice.messageCode !== "history.notice.loadFailed" ? (
        <button
          type="button"
          className="sidebar-history-notice-close"
          onClick={onClose}
          aria-label={t("noticeCloseAria")}
        >
          <X size={13} />
        </button>
      ) : null}
    </div>
  );
}
