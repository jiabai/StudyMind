import { AlertTriangle, CheckCircle2, CircleDashed, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { renderUiMessage } from "../../i18n/uiMessage";
import { isSupportedLocale } from "../../i18n/locale";
import { renderWorkerProgressMessage } from "../../i18n/progressMessages";
import type { TaskWorkspaceViewModel } from "../../taskWorkspaceViewModel";

type TaskStatusBannerProps = {
  model: TaskWorkspaceViewModel["banner"];
};

export function TaskStatusBanner({ model }: TaskStatusBannerProps) {
  const { t, i18n } = useTranslation("workflow");
  const locale = isSupportedLocale(i18n.resolvedLanguage)
    ? i18n.resolvedLanguage
    : "en-US";
  const message = model.progressMessage
    ? renderWorkerProgressMessage(locale, model.stage, model.progressMessage)
    : renderUiMessage(locale, model.message);

  return (
    <section
      className={`task-status-banner ${model.kind}`}
      aria-label={t("banner.ariaLabel")}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {model.kind === "local_complete" ? (
        <CheckCircle2 size={20} aria-hidden="true" />
      ) : model.kind === "local_failed" ? (
        <AlertTriangle size={20} aria-hidden="true" />
      ) : model.kind === "local_processing" ? (
        <LoaderCircle size={20} className="spin" aria-hidden="true" />
      ) : (
        <CircleDashed size={20} aria-hidden="true" />
      )}
      <div>
        <strong>{t(bannerTitleKey(model.kind))}</strong>
        <span>{message}</span>
      </div>
    </section>
  );
}

function bannerTitleKey(
  kind: TaskWorkspaceViewModel["banner"]["kind"],
):
  | "banner.localCompleteTitle"
  | "banner.localFailedTitle"
  | "banner.localProcessingTitle"
  | "banner.idleTitle" {
  switch (kind) {
    case "local_complete":
      return "banner.localCompleteTitle";
    case "local_failed":
      return "banner.localFailedTitle";
    case "local_processing":
      return "banner.localProcessingTitle";
    default:
      return "banner.idleTitle";
  }
}
