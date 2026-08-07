import { Clock3, FileText, FolderOpen, Trash2, TriangleAlert, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { HistoryListItem } from "../../historyClient";
import { formatDateTime, formatNumber } from "../../i18n/formatters";
import { useLocale } from "../../i18n/LocaleProvider";
import type { SupportedLocale } from "../../i18n/locale";
import { renderUiMessage, type UiMessage } from "../../i18n/uiMessage";
import { useModalFocus } from "../modal/useModalFocus";
import type { HistoryController } from "./useHistoryController";

const historyStatusKeys: Record<
  HistoryListItem["status"],
  "status.completed" | "status.partial_completed" | "status.failed"
> = {
  completed: "status.completed",
  partial_completed: "status.partial_completed",
  failed: "status.failed",
};

type HistorySheetProps = {
  controller: HistoryController;
  selectionDisabled: boolean;
  selectionDisabledReason: UiMessage;
  deletionDisabled: boolean;
  deletionDisabledReason: UiMessage;
};

function areUiMessagesEqual(left: UiMessage, right: UiMessage): boolean {
  return (
    left.messageCode === right.messageCode &&
    JSON.stringify(left.args ?? {}) === JSON.stringify(right.args ?? {})
  );
}

function formatHistoryTimestamp(
  value: string,
  locale: SupportedLocale,
): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : formatDateTime(date, locale);
}

export function HistorySheet({
  controller,
  selectionDisabled,
  selectionDisabledReason,
  deletionDisabled,
  deletionDisabledReason,
}: HistorySheetProps) {
  const {
    historyOpen,
    historyItems,
    historyNotice,
    historyLoading,
    historyDeleteCandidate,
    historyDeleting,
    closeHistory,
    openHistoryItem,
    requestHistoryItemDeletion,
    cancelHistoryItemDeletion,
    confirmHistoryItemDeletion,
  } = controller;
  const { t } = useTranslation("history");
  const { resolvedLocale } = useLocale();
  const historyModalRef = useModalFocus<HTMLElement>(historyOpen);
  const historyDeleteModalRef = useModalFocus<HTMLElement>(
    Boolean(historyDeleteCandidate),
  );
  const renderedNotice = renderUiMessage(resolvedLocale, historyNotice);
  const renderedSelectionDisabledReason = renderUiMessage(
    resolvedLocale,
    selectionDisabledReason,
  );
  const renderedDeletionDisabledReason = renderUiMessage(
    resolvedLocale,
    deletionDisabledReason,
  );
  const disabledReasonsAreEqual = areUiMessagesEqual(
    selectionDisabledReason,
    deletionDisabledReason,
  );

  if (!historyOpen) {
    return null;
  }

  return (
    <div className="modal-backdrop sheet-backdrop" role="presentation" onClick={closeHistory}>
      <section
        ref={historyModalRef}
        className="sheet-panel detail-modal history-modal history-sheet"
        aria-label={t("sheet.ariaLabel")}
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape" && historyDeleteCandidate) {
            event.preventDefault();
            event.stopPropagation();
            cancelHistoryItemDeletion();
          }
        }}
      >
        <header className="modal-header sheet-header">
          <div>
            <p className="section-label">{t("sheet.eyebrow")}</p>
            <h2>{t("sheet.title")}</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={closeHistory}
            aria-label={t("sheet.closeAriaLabel")}
            disabled={historyDeleting}
          >
            <X size={18} />
          </button>
        </header>
        {renderedNotice ? (
          <p className="action-notice" role="status" aria-live="polite">
            {renderedNotice}
          </p>
        ) : null}
        {selectionDisabled ? (
          <p
            id="history-selection-disabled-reason"
            className="action-notice"
            role="status"
            aria-live="polite"
          >
            {renderedSelectionDisabledReason}
          </p>
        ) : null}
        {deletionDisabled &&
        (!selectionDisabled || !disabledReasonsAreEqual) ? (
          <p
            id="history-deletion-disabled-reason"
            className="action-notice"
            role="status"
            aria-live="polite"
          >
            {renderedDeletionDisabledReason}
          </p>
        ) : null}
        <div className="history-list">
          {historyItems.map((item) => (
            <div
              className={`history-item ${item.status}`}
              key={item.id}
            >
              <button
                className="history-item-select"
                type="button"
                onClick={() => openHistoryItem(item)}
                disabled={selectionDisabled || historyDeleting}
                aria-describedby={
                  selectionDisabled ? "history-selection-disabled-reason" : undefined
                }
              >
                <div className="history-item-main">
                  <span className={`history-status ${item.status}`}>
                    {t(historyStatusKeys[item.status])}
                  </span>
                  <span className="history-title-row">
                    <strong
                      className={`history-title ${
                        item.textPreview ? "history-title-preview" : "history-title-url"
                      }`}
                      title={
                        item.textPreview ||
                        (item.source.kind === "url"
                          ? item.source.url
                          : item.source.displayName)
                      }
                    >
                      {item.textPreview ||
                        (item.source.kind === "url"
                          ? item.source.url
                          : item.source.displayName)}
                    </strong>
                    {item.source.kind === "local_file" ? (
                      <span className="history-source-kind">
                        {t(`item.localSource.${item.source.mediaKind}`)}
                      </span>
                    ) : null}
                  </span>
                </div>
                <div className="history-meta">
                  <span className="history-meta-time">
                    <Clock3 size={13} />
                    <span className="history-meta-value">
                      {formatHistoryTimestamp(item.createdAt, resolvedLocale)}
                    </span>
                  </span>
                  <span
                    className="history-meta-output"
                    title={item.outputDir || t("item.outputFallback")}
                  >
                    <FolderOpen size={13} />
                    <span className="history-meta-value">
                      {item.outputDir || t("item.outputFallback")}
                    </span>
                  </span>
                  <span
                    className="history-meta-result"
                    title={
                      item.error
                        ? item.error.code
                        : t("item.insights", {
                            count: item.insightsCount,
                            formattedCount: formatNumber(item.insightsCount, resolvedLocale),
                          })
                    }
                  >
                    <span className="history-meta-value">
                      {item.error
                        ? item.error.code
                        : t("item.insights", {
                            count: item.insightsCount,
                            formattedCount: formatNumber(item.insightsCount, resolvedLocale),
                          })}
                    </span>
                  </span>
                </div>
              </button>
              <button
                className="history-item-delete"
                type="button"
                onClick={() => requestHistoryItemDeletion(item)}
                disabled={deletionDisabled || historyDeleting}
                aria-label={t("item.deleteAriaLabel", {
                  title:
                    item.textPreview ||
                    (item.source.kind === "url"
                      ? item.source.url
                      : item.source.displayName),
                })}
                title={t("item.deleteTitle")}
                aria-describedby={
                  deletionDisabled
                    ? selectionDisabled && disabledReasonsAreEqual
                      ? "history-selection-disabled-reason"
                      : "history-deletion-disabled-reason"
                    : undefined
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          {!historyLoading && historyItems.length === 0 ? (
            <div className="history-empty">
              <FileText size={18} />
              <span>{t("empty")}</span>
            </div>
          ) : null}
        </div>
        {historyDeleteCandidate ? (
          <div
            className="history-delete-confirm-backdrop"
            role="presentation"
            onClick={historyDeleting ? undefined : cancelHistoryItemDeletion}
          >
            <section
              ref={historyDeleteModalRef}
              className="history-delete-confirm"
              role="alertdialog"
              aria-modal="true"
              aria-label={t("confirm.ariaLabel")}
              onClick={(event) => event.stopPropagation()}
            >
              <TriangleAlert size={22} />
              <div>
                <h3>{t("confirm.title")}</h3>
                <p>{t("confirm.body")}</p>
              </div>
              <div className="history-delete-confirm-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={cancelHistoryItemDeletion}
                  disabled={historyDeleting}
                  autoFocus
                >
                  {t("confirm.cancel")}
                </button>
                <button
                  className="danger-button"
                  type="button"
                  onClick={() => void confirmHistoryItemDeletion()}
                  disabled={historyDeleting}
                >
                  {historyDeleting ? t("confirm.deleting") : t("confirm.delete")}
                </button>
              </div>
            </section>
          </div>
        ) : null}
      </section>
    </div>
  );
}
