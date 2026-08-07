import { Download, ShieldCheck, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatPercent } from "../../i18n/formatters";
import { useLocale } from "../../i18n/LocaleProvider";
import { renderAsrModelDownloadMessage } from "../../i18n/progressMessages";
import { renderUiMessage, type UiMessage } from "../../i18n/uiMessage";
import type { AsrModelDownloadProgress } from "../../settingsClient";
import { useModalFocus } from "../modal/useModalFocus";
import type { AsrModelStatus } from "./types";

const DEFAULT_MODEL_DIRECTORY = "app-local data/models";

type ModelGuideSheetProps = {
  open: boolean;
  modelDownloadActive: boolean;
  asrModelStatus: AsrModelStatus;
  asrModelLabels: Record<string, string>;
  modelDownloadProgress: AsrModelDownloadProgress;
  modelDownloadNotice: UiMessage | null;
  modelDownloadStalled: boolean;
  onClose: () => void;
  onStartDownload: () => void;
  onCancelDownload: () => void;
};

export function ModelGuideSheet({
  open,
  modelDownloadActive,
  asrModelStatus,
  asrModelLabels,
  modelDownloadProgress,
  modelDownloadNotice,
  modelDownloadStalled,
  onClose,
  onStartDownload,
  onCancelDownload,
}: ModelGuideSheetProps) {
  const { t } = useTranslation("asrModel");
  const { resolvedLocale } = useLocale();
  const modelGuideModalRef = useModalFocus<HTMLElement>(open);
  const progressMessage = renderAsrModelDownloadMessage(
    resolvedLocale,
    modelDownloadProgress,
  );
  const noticeText = renderUiMessage(resolvedLocale, modelDownloadNotice);
  const source =
    asrModelStatus.source === "custom_url"
      ? t("source.customUrl")
      : asrModelStatus.source === "modelscope"
        ? t("source.modelScope")
        : asrModelStatus.source;
  const progressValue = Math.max(0, Math.min(100, modelDownloadProgress.progress));
  const progressPercent = formatPercent(progressValue / 100, resolvedLocale);

  if (!open) {
    return null;
  }

  return (
    <div
      className="modal-backdrop sheet-backdrop"
      role="presentation"
      onClick={() => {
        if (!modelDownloadActive) {
          onClose();
        }
      }}
    >
      <section
        ref={modelGuideModalRef}
        className="sheet-panel detail-modal model-guide-modal model-guide-sheet"
        aria-label={t("guide.ariaLabel")}
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header sheet-header">
          <div>
            <p className="section-label">{t("guide.eyebrow")}</p>
            <h2>{t("guide.title")}</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label={t("guide.close")}
            disabled={modelDownloadActive}
          >
            <X size={18} />
          </button>
        </header>
        <div className="model-guide-content">
          <p className="settings-warning privacy-callout">
            <ShieldCheck size={16} />
            <span>{t("guide.privacy")}</span>
          </p>
          <div className="model-status-card">
            <div>
              <span
                className={`model-status-badge ${asrModelStatus.available ? "ready" : "missing"}`}
              >
                {asrModelStatus.available
                  ? t("guide.status.ready")
                  : t("guide.status.missing")}
              </span>
              <strong>
                {asrModelLabels[asrModelStatus.model] ?? asrModelStatus.model}
              </strong>
              <small>{t("guide.sourceLabel", { source })}</small>
              <small>
                {t("guide.storageLabel", {
                  modelDir:
                    asrModelStatus.modelDir || DEFAULT_MODEL_DIRECTORY,
                })}
              </small>
            </div>
          </div>
          <div
            className="model-download-progress"
            role="progressbar"
            aria-label={t("guide.downloadProgressAria")}
            aria-valuenow={progressValue}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="progress-summary compact">
              <div>
                <span className="progress-value">{progressPercent}</span>
                <p>{progressMessage}</p>
              </div>
              <div className="progress-track">
                <span
                  className="progress-fill video_transcribing"
                  style={{ width: `${progressValue}%` }}
                />
              </div>
            </div>
            {modelDownloadProgress.currentFile ? (
              <small className="model-current-file">
                {modelDownloadProgress.currentFile}
              </small>
            ) : null}
          </div>
          {noticeText ? (
            <p className="action-notice inline-notice" role="status" aria-live="polite">
              {noticeText}
            </p>
          ) : null}
          {!noticeText && modelDownloadStalled ? (
            <p className="action-notice inline-notice" role="status" aria-live="polite">
              {t("guide.stalled")}
            </p>
          ) : null}
        </div>
        <div className="settings-actions sheet-footer">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={modelDownloadActive}
          >
            <span>{t("guide.later")}</span>
          </button>
          {modelDownloadActive ? (
            <button
              type="button"
              className="secondary-button danger-soft"
              onClick={onCancelDownload}
            >
              <X size={16} />
              <span>{t("guide.cancel")}</span>
            </button>
          ) : (
            <button
              className="primary-button"
              type="button"
              onClick={onStartDownload}
              disabled={asrModelStatus.available}
            >
              <Download size={16} />
              <span>
                {asrModelStatus.available
                  ? t("guide.downloaded")
                  : t("guide.download")}
              </span>
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
