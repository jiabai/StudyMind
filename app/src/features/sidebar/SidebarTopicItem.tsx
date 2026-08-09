import { useEffect, useRef, useState } from "react";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { HistoryListItem } from "../../historyClient";
import { formatDateTime } from "../../i18n/formatters";
import { useLocale } from "../../i18n/LocaleProvider";
import type { SupportedLocale } from "../../i18n/locale";

const statusClassMap: Record<HistoryListItem["status"], string> = {
  completed: "completed",
  partial_completed: "partial_completed",
  failed: "failed",
};

const statusLabelKey: Record<
  HistoryListItem["status"],
  "status.completed" | "status.partial_completed" | "status.failed"
> = {
  completed: "status.completed",
  partial_completed: "status.partial_completed",
  failed: "status.failed",
};

const TITLE_MAX_LEN = 80;

function fallbackTopicTitle(item: HistoryListItem): string {
  if (item.source.kind === "url") {
    return item.source.url;
  }
  return item.source.displayName;
}

function displayTopicTitle(item: HistoryListItem): string {
  return item.title ?? fallbackTopicTitle(item);
}

function formatTimestamp(value: string, locale: SupportedLocale): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : formatDateTime(date, locale);
}

type SidebarTopicItemProps = {
  item: HistoryListItem;
  selected: boolean;
  selectionDisabled: boolean;
  deletionDisabled: boolean;
  renaming: boolean;
  onSelect: (item: HistoryListItem) => void;
  onDeleteRequest: (item: HistoryListItem) => void;
  onRenameRequest: (item: HistoryListItem) => void;
  onRenameCommit: (item: HistoryListItem, title: string | null) => Promise<void>;
  onRenameCancel: () => void;
};

export function SidebarTopicItem({
  item,
  selected,
  selectionDisabled,
  deletionDisabled,
  renaming,
  onSelect,
  onDeleteRequest,
  onRenameRequest,
  onRenameCommit,
  onRenameCancel,
}: SidebarTopicItemProps) {
  const { t: tHistory } = useTranslation("history");
  const { t: tSidebar } = useTranslation("sidebar");
  const { resolvedLocale } = useLocale();
  const title = displayTopicTitle(item);
  const statusKey = statusLabelKey[item.status];

  const [draft, setDraft] = useState(title);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) {
      setDraft(title);
      setError(null);
      setSubmitting(false);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [renaming, title]);

  const validate = (value: string): string | null => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return tSidebar("rename.errorEmpty");
    }
    if ([...trimmed].length > TITLE_MAX_LEN) {
      return tSidebar("rename.errorTooLong");
    }
    return null;
  };

  const commit = async () => {
    const trimmed = draft.trim();
    const validationError = validate(draft);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (trimmed === (item.title ?? fallbackTopicTitle(item))) {
      onRenameCancel();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onRenameCommit(item, trimmed);
    } catch {
      setError(tSidebar("rename.errorFailed"));
      setSubmitting(false);
    }
  };

  const cancel = () => {
    setError(null);
    setSubmitting(false);
    onRenameCancel();
  };

  return (
    <li
      className={`sidebar-topic-item ${statusClassMap[item.status]}${selected ? " selected" : ""}${renaming ? " renaming" : ""}`}
      aria-current={selected ? "page" : undefined}
    >
      {renaming ? (
        <div className="sidebar-topic-rename" role="group" aria-label={tSidebar("rename.inputLabel")}>
          <input
            ref={inputRef}
            className="sidebar-topic-rename-input"
            type="text"
            value={draft}
            maxLength={TITLE_MAX_LEN}
            placeholder={tSidebar("rename.placeholder")}
            aria-label={tSidebar("rename.inputLabel")}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "sidebar-rename-error" : undefined}
            disabled={submitting}
            onChange={(e) => {
              setDraft(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              }
            }}
          />
          <div className="sidebar-topic-rename-actions">
            <button
              className="sidebar-topic-rename-confirm"
              type="button"
              onClick={() => void commit()}
              disabled={submitting}
              aria-label={tSidebar("rename.save")}
            >
              <Check size={14} />
            </button>
            <button
              className="sidebar-topic-rename-cancel"
              type="button"
              onClick={cancel}
              disabled={submitting}
              aria-label={tSidebar("rename.cancel")}
            >
              <X size={14} />
            </button>
          </div>
          {error ? (
            <p id="sidebar-rename-error" className="sidebar-topic-rename-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <>
          <button
            className="sidebar-topic-select"
            type="button"
            onClick={() => onSelect(item)}
            disabled={selectionDisabled}
            aria-label={tSidebar("currentTopicAria")}
            title={title}
          >
            <span className="sidebar-topic-title">{title}</span>
            <span className="sidebar-topic-meta">
              <span className="sidebar-topic-time">
                {formatTimestamp(item.createdAt, resolvedLocale)}
              </span>
              <span className={`sidebar-topic-status ${statusClassMap[item.status]}`}>
                {tHistory(statusKey)}
              </span>
            </span>
          </button>
          <div className="sidebar-topic-actions">
            <button
              className="sidebar-topic-action"
              type="button"
              onClick={() => onRenameRequest(item)}
              disabled={selectionDisabled}
              aria-label={tSidebar("rename.actionAria")}
              title={tSidebar("rename.actionTitle")}
            >
              <Pencil size={13} />
            </button>
            <button
              className="sidebar-topic-action"
              type="button"
              onClick={() => onDeleteRequest(item)}
              disabled={deletionDisabled}
              aria-label={tHistory("item.deleteAriaLabel", { title })}
              title={tHistory("item.deleteTitle")}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </>
      )}
    </li>
  );
}

export { displayTopicTitle, fallbackTopicTitle };
