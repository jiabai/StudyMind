import { ListMusic, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useLocale } from "../../i18n/LocaleProvider";
import { formatBytes, formatDateTime } from "../../i18n/formatters";
import { formatClockDuration } from "./formatClockDuration";
import type {
  RecordingEntryState,
  RecordingLibraryController,
} from "./useRecordingLibrary";

export type RecordingLibraryPanelProps = {
  controller: RecordingLibraryController;
  /** 录音进行中时其他输入入口都被锁住，导入按钮同样让位。 */
  disabled?: boolean;
  /** 当前已选中的本地媒体名；有值时提示导入会替换它。 */
  selectedMediaName?: string | null;
};

// 未进入过导入流程的条目没有状态记录，一律按「未导入」渲染。
const SAVED_ENTRY_STATE: RecordingEntryState = { status: "saved" };

// 四种状态各自的文案键、标记类与按钮动作，集中在一处，避免同一个判别式散落三遍。
// 文案键保持字面量联合，i18next 的键类型校验才认得出来。
type EntryStatusKey =
  | "status.saved"
  | "status.importing"
  | "status.imported"
  | "status.importFailed";
type EntryActionKey = "action.import" | "action.importing" | "action.retry";

const ENTRY_STATUS_VIEWS: Record<
  RecordingEntryState["status"],
  { statusKey: EntryStatusKey; modifier: string; actionKey: EntryActionKey }
> = {
  saved: { statusKey: "status.saved", modifier: "is-saved", actionKey: "action.import" },
  importing: {
    statusKey: "status.importing",
    modifier: "is-importing",
    actionKey: "action.importing",
  },
  imported: {
    statusKey: "status.imported",
    modifier: "is-imported",
    actionKey: "action.import",
  },
  importFailed: {
    statusKey: "status.importFailed",
    modifier: "is-import-failed",
    actionKey: "action.retry",
  },
};

export function RecordingLibraryPanel({
  controller,
  disabled = false,
  selectedMediaName = null,
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
            {controller.entries.map((entry) => {
              const state =
                controller.entryStates[entry.recordingId] ?? SAVED_ENTRY_STATE;
              const view = ENTRY_STATUS_VIEWS[state.status];
              const importing = state.status === "importing";
              const createdAt = formatDateTime(
                entry.createdAtMs,
                resolvedLocale,
              );
              // 再次导入同一条录音只是重选同一个文件，不必提示替换它自己。
              const replacesOtherMedia =
                selectedMediaName !== null &&
                selectedMediaName !== entry.displayName;
              return (
                <li
                  className={`recording-library-item${
                    entry.recordingId === controller.highlightedId
                      ? " recording-library-item-highlight"
                      : ""
                  }`}
                  key={entry.recordingId}
                >
                  <div className="recording-library-item-main">
                    <span className="recording-library-item-name">
                      {entry.displayName}
                    </span>
                    <span className="recording-library-item-meta">
                      {t(`${scope}.entryMeta`, {
                        time: createdAt,
                        duration: formatClockDuration(entry.durationMs),
                        size: formatBytes(entry.sizeBytes, resolvedLocale),
                      })}
                    </span>
                  </div>
                  <span
                    className={`recording-library-item-status ${view.modifier}`}
                  >
                    <span>{t(`${scope}.${view.statusKey}`)}</span>
                    {state.status === "importFailed" && state.errorCode ? (
                      <span className="recording-library-item-status-code">
                        {t(`${scope}.importErrorCode`, {
                          code: state.errorCode,
                        })}
                      </span>
                    ) : null}
                  </span>
                  <div className="recording-library-item-actions">
                    {/* 导入中只加 aria-disabled，不加原生 disabled：原生禁用的按钮会立刻
                        失焦，而这里要求按钮在导入期间保留焦点；失败后同一个节点就是
                        「重试」，焦点不回跳。 */}
                    <button
                      type="button"
                      className="recording-library-import"
                      aria-label={t(`${scope}.actionAria`, {
                        name: entry.displayName,
                        time: createdAt,
                      })}
                      aria-disabled={importing ? "true" : undefined}
                      disabled={disabled}
                      onClick={() => {
                        if (disabled || importing) {
                          return;
                        }
                        void controller.importEntry(entry);
                      }}
                    >
                      {importing ? (
                        <LoaderCircle
                          className="spin"
                          size={14}
                          aria-hidden="true"
                        />
                      ) : null}
                      <span>{t(`${scope}.${view.actionKey}`)}</span>
                    </button>
                    {replacesOtherMedia ? (
                      <p className="recording-library-replace-hint">
                        {t(`${scope}.replaceHint`, { name: selectedMediaName })}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </section>
  );
}
