import { ListMusic, RefreshCw } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useLocale } from "../../i18n/LocaleProvider";
import { formatBytes, formatDateTime } from "../../i18n/formatters";
import { formatClockDuration } from "./formatClockDuration";
import type { RecordingLibraryController } from "./useRecordingLibrary";

export type RecordingLibraryPanelProps = {
  controller: RecordingLibraryController;
};

export function RecordingLibraryPanel({
  controller,
}: RecordingLibraryPanelProps) {
  const { t } = useTranslation("workflow");
  const { resolvedLocale } = useLocale();
  const scope = "input.recordingLibrary";
  const panelRef = useRef<HTMLElement>(null);

  // 新保存的录音出现时把列表滚进视野。只滚动，不自动导入，也不把焦点移到导入按钮。
  useEffect(() => {
    if (!controller.highlightedId) {
      return;
    }
    panelRef.current?.scrollIntoView({ block: "nearest" });
  }, [controller.highlightedId]);

  return (
    <section
      className="recording-library-card"
      aria-label={t(`${scope}.title`)}
      ref={panelRef}
    >
      <header className="recording-library-header">
        <span className="recording-library-icon" aria-hidden="true">
          <ListMusic size={18} />
        </span>
        <div className="recording-library-headings">
          <h2>{t(`${scope}.title`)}</h2>
          <p className="recording-library-subtitle">{t(`${scope}.subtitle`)}</p>
        </div>
        <button
          type="button"
          className="recording-library-refresh"
          onClick={() => void controller.refresh()}
          aria-label={t(`${scope}.refreshAria`)}
        >
          <RefreshCw size={16} aria-hidden="true" />
        </button>
      </header>

      {controller.status === "loading" ? (
        <p className="recording-library-note">{t(`${scope}.loading`)}</p>
      ) : null}

      {controller.status === "error" ? (
        <div className="recording-library-error">
          <p className="recording-library-note">{t(`${scope}.error`)}</p>
          <button
            type="button"
            className="recording-library-retry"
            onClick={() => void controller.refresh()}
          >
            {t(`${scope}.retry`)}
          </button>
        </div>
      ) : null}

      {controller.status === "ready" && controller.entries.length === 0 ? (
        <p className="recording-library-note">{t(`${scope}.empty`)}</p>
      ) : null}

      {controller.status === "ready" && controller.entries.length > 0 ? (
        <>
          <p className="recording-library-summary">
            {t(`${scope}.summary`, {
              count: controller.entries.length,
              size: formatBytes(controller.totalBytes, resolvedLocale),
            })}
          </p>
          <ul className="recording-library-list" aria-label={t(`${scope}.listAria`)}>
            {controller.entries.map((entry) => (
              <li
                className={`recording-library-item${
                  entry.recordingId === controller.highlightedId
                    ? " recording-library-item-highlight"
                    : ""
                }`}
                key={entry.recordingId}
              >
                <span className="recording-library-item-name">
                  {entry.displayName}
                </span>
                <span className="recording-library-item-meta">
                  {t(`${scope}.entryMeta`, {
                    time: formatDateTime(entry.createdAtMs, resolvedLocale),
                    duration: formatClockDuration(entry.durationMs),
                    size: formatBytes(entry.sizeBytes, resolvedLocale),
                  })}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
