import { CheckCircle2, Circle, FileAudio, Film, LoaderCircle, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { isSupportedLocale } from "../../i18n/locale";
import { renderUiMessage, type UiMessage } from "../../i18n/uiMessage";
import type { TaskWorkspaceViewModel } from "../../taskWorkspaceViewModel";
import type { TaskArtifactKey } from "../../workflow";
import { TranscriptReviewPanel } from "./TranscriptReviewPanel";
import type { TranscriptDetailController } from "./useTranscriptDetailController";
import { WorkerErrorNotice } from "../results/WorkerErrorNotice";

type LocalTranscriptWorkspaceProps = {
  model: TaskWorkspaceViewModel["local"];
  controller: TranscriptDetailController;
  actionNotice: UiMessage | null;
  onLocateArtifact: (artifact: Extract<TaskArtifactKey, "video" | "audio">) => void;
  onCancel: () => void;
};

export function LocalTranscriptWorkspace({
  model,
  controller,
  actionNotice,
  onLocateArtifact,
  onCancel,
}: LocalTranscriptWorkspaceProps) {
  const { t, i18n } = useTranslation("transcript");
  const locale = isSupportedLocale(i18n.resolvedLanguage)
    ? i18n.resolvedLanguage
    : "en-US";
  const renderedActionNotice = renderUiMessage(locale, actionNotice);

  return (
    <section
      className="task-domain-workspace local-transcript-workspace"
      aria-label={t("workspace.ariaLabel")}
      data-task-id={model.taskId ?? undefined}
    >
      <header className="domain-workspace-header">
        <div>
          <h2>
            {model.phase === "ready"
              ? t("workspace.reviewTitle")
              : t("workspace.transcriptionTitle")}
          </h2>
        </div>
        {model.phase !== "ready" ? (
          <span className={`workspace-status-badge ${model.phase}`}>
            {t(localStatusKey(model.phase))}
          </span>
        ) : null}
      </header>

      {model.phase === "processing" ? (
        <div className="local-progress" aria-label={t("workspace.progressLabel")}>
          {model.progressSteps.map((step) => (
            <span className={step.state} key={step.id}>
              {step.state === "complete" ? (
                <CheckCircle2 size={16} aria-hidden="true" />
              ) : step.state === "active" ? (
                <LoaderCircle size={16} className="spin" aria-hidden="true" />
              ) : (
                <Circle size={16} aria-hidden="true" />
              )}
              {t(localProgressStepKey(step.id, model.sourceMediaKind))}
            </span>
          ))}
          {model.cancellation.visible ? (
            <button
              className="secondary-button danger-soft"
              type="button"
              onClick={onCancel}
              disabled={!model.cancellation.enabled}
            >
              <X size={16} />
              <span>
                {model.cancellation.inProgress
                  ? t("workspace.cancelling")
                  : t("workspace.cancel")}
              </span>
            </button>
          ) : null}
        </div>
      ) : null}

      {renderedActionNotice ? (
        <p className="action-notice" role="status" aria-live="polite">
          {renderedActionNotice}
        </p>
      ) : null}

      {model.canReview ? (
        <TranscriptReviewPanel
          transcriptSource={model.transcriptSource}
          controller={controller}
          editingDisabled={!model.canEdit}
          readOnlyReason={
            model.readOnly ? t("review.readOnlyDuringAi") : null
          }
          artifactToolbar={model.artifactActions.locateVideo.visible ||
            model.artifactActions.locateAudio.visible ? (
            <div
              className="local-artifact-toolbar"
              aria-label={t("workspace.artifactActions")}
            >
              {model.artifactActions.locateVideo.visible ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => onLocateArtifact("video")}
                  disabled={!model.artifactActions.locateVideo.enabled}
                >
                  <Film size={16} />
                  <span>{t("workspace.locateVideo")}</span>
                </button>
              ) : null}
              {model.artifactActions.locateAudio.visible ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => onLocateArtifact("audio")}
                  disabled={!model.artifactActions.locateAudio.enabled}
                >
                  <FileAudio size={16} />
                  <span>{t("workspace.locateAudio")}</span>
                </button>
              ) : null}
            </div>
          ) : undefined}
        />
      ) : model.phase !== "processing" ? (
        <p className="workspace-empty-copy">{t("workspace.empty")}</p>
      ) : null}

      {model.error ? (
        <WorkerErrorNotice
          error={model.error}
          locale={locale}
          className="local-workspace-error"
        />
      ) : null}
    </section>
  );
}

function localStatusKey(
  phase: TaskWorkspaceViewModel["local"]["phase"],
):
  | "workspace.status.processing"
  | "workspace.status.ready"
  | "workspace.status.failed"
  | "workspace.status.waiting" {
  switch (phase) {
    case "processing":
      return "workspace.status.processing";
    case "ready":
      return "workspace.status.ready";
    case "failed":
      return "workspace.status.failed";
    default:
      return "workspace.status.waiting";
  }
}

function localProgressStepKey(
  stage: TaskWorkspaceViewModel["local"]["progressSteps"][number]["id"],
  sourceMediaKind: TaskWorkspaceViewModel["local"]["sourceMediaKind"],
):
  | "workspace.progressSteps.videoExtracting"
  | "workspace.progressSteps.audioPreparing"
  | "workspace.progressSteps.videoTranscribing" {
  if (stage === "video_transcribing") {
    return "workspace.progressSteps.videoTranscribing";
  }
  return sourceMediaKind === "audio"
    ? "workspace.progressSteps.audioPreparing"
    : "workspace.progressSteps.videoExtracting";
}
