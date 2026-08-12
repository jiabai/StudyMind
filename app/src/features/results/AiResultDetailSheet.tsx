import { useEffect, useState } from "react";
import { Copy, Download, Eye, Pencil, RotateCcw, Save, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { SummaryAnnotation } from "../../annotationClient";
import { isSupportedLocale } from "../../i18n/locale";
import { renderUiMessage, type UiMessage } from "../../i18n/uiMessage";
import type { WorkflowState } from "../../workflow";
import type { TranscriptDetailController } from "../transcript/useTranscriptDetailController";
import { useModalFocus } from "../modal/useModalFocus";
import { AnnotatedMarkdownContent } from "./AnnotatedMarkdownContent";
import { DissectionReport } from "./DissectionReport";
import { MarkdownContent } from "./MarkdownContent";

type SummaryEditorMode = "edit" | "preview";

type AiResultDetailSheetProps = {
  actionNotice: UiMessage | null;
  controller: TranscriptDetailController;
  workflow: WorkflowState;
  annotations: SummaryAnnotation[];
  annotationsLoading: boolean;
  activeAnnotationId: string | null;
  onAnnotationAdd: (
    targetTab: string,
    textAnchor: string,
    charIndex: number,
    content: string,
    color: string | null,
  ) => void;
  onAnnotationUpdate: (
    id: string,
    content: string,
    color: string | null,
  ) => void;
  onAnnotationDelete: (id: string) => void;
  onOpenDirectionEditor: () => void | Promise<void>;
  onOpenDissectionConfirmation?: () => void;
  onLocateDissectionChunks?: (chunkIds: number[]) => void;
  onAnnotationInteraction?: () => void;
};

export function AiResultDetailSheet({
  actionNotice,
  controller,
  workflow,
  annotations,
  annotationsLoading,
  activeAnnotationId,
  onAnnotationAdd,
  onAnnotationUpdate,
  onAnnotationDelete,
  onOpenDirectionEditor,
  onOpenDissectionConfirmation = () => undefined,
  onLocateDissectionChunks = () => undefined,
}: AiResultDetailSheetProps) {
  const { t, i18n } = useTranslation("synthesis");
  const locale = isSupportedLocale(i18n.resolvedLanguage)
    ? i18n.resolvedLanguage
    : "en-US";
  const renderedActionNotice = renderUiMessage(locale, actionNotice);
  const {
    detailTab,
    closeDetail,
    copyDetail,
    exportDetail,
    exportPath,
    summaryEditing = false,
    summaryDraft = workflow.summary,
    summaryDirty = false,
    summarySaving = false,
    beginSummaryEdit = () => undefined,
    cancelSummaryEdit = () => undefined,
    updateSummaryDraft = () => undefined,
    saveSummaryDraft = () => Promise.resolve(),
  } = controller;
  const [summaryEditorMode, setSummaryEditorMode] = useState<SummaryEditorMode>("preview");
  const hasSummaryArtifact =
    detailTab === "summary" && Boolean(workflow.artifacts.summary);

  useEffect(() => {
    if (!summaryEditing) {
      setSummaryEditorMode("preview");
    }
  }, [summaryEditing]);

  const requestCloseDetail = () => {
    if (
      detailTab === "summary" &&
      summaryEditing &&
      summaryDirty &&
      !window.confirm(t("detail.summaryDiscardConfirm"))
    ) {
      return;
    }
    closeDetail();
  };

  const handleBeginSummaryEdit = () => {
    beginSummaryEdit();
    setSummaryEditorMode("edit");
  };

  const handleCancelSummaryEdit = () => {
    cancelSummaryEdit();
    setSummaryEditorMode("preview");
  };

  const resultDetailModalRef = useModalFocus<HTMLElement>(
    detailTab === "summary" || detailTab === "insights" || detailTab === "dissection",
  );
  if (detailTab !== "summary" && detailTab !== "insights" && detailTab !== "dissection") {
    return null;
  }

  const title = detailTab === "summary"
    ? t("detail.summaryTitle")
    : detailTab === "insights"
      ? t("detail.insightsTitle")
      : t("dissection.card.title");
  const questionList = new Intl.ListFormat(i18n.resolvedLanguage ?? "en-US", {
    style: "long",
    type: "conjunction",
  });

  const tabAnnotationCount = annotations.filter(
    (a) => a.target_tab === detailTab,
  ).length;

  return (
    <div className="modal-backdrop sheet-backdrop" role="presentation" onClick={requestCloseDetail}>
      <section
        ref={resultDetailModalRef}
        className="sheet-panel detail-modal ai-result-detail-sheet"
        aria-label={t("detail.ariaLabel", { title })}
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header sheet-header">
          <div>
            <p className="section-label">{t("detail.sectionLabel")}</p>
            <h2>
              {title}
            {tabAnnotationCount > 0 && (
              <span className="annotation-count-badge">
                📝 {tabAnnotationCount}
              </span>
            )}
            </h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={requestCloseDetail}
            aria-label={t("detail.closeAria")}
          >
            <X size={18} />
          </button>
        </header>
        <div className="modal-tools">
          <span>
            {t("detail.localPreview")}
            {detailTab === "summary" && !summaryEditing && (
              <span className="annotation-hint">
                {annotationsLoading
                  ? t("annotation.loadingHint")
                  : t("annotation.addHint")}
              </span>
            )}
          </span>
          <div className="tool-actions">
            {hasSummaryArtifact && !summaryEditing ? (
              <button type="button" onClick={handleBeginSummaryEdit}>
                <Pencil size={16} />
                <span>{t("detail.edit")}</span>
              </button>
            ) : null}
            <button type="button" onClick={copyDetail} disabled={!controller.detailText}>
              <Copy size={16} />
              <span>{t("detail.copy")}</span>
            </button>
            {detailTab === "insights" ? (
              <button type="button" onClick={() => void onOpenDirectionEditor()}>
                <RotateCcw size={16} />
                <span>{t("detail.tryAnotherDirection")}</span>
              </button>
            ) : null}
            {detailTab === "dissection" ? (
              <button
                type="button"
                data-action="redissection"
                onClick={onOpenDissectionConfirmation}
              >
                <RotateCcw size={16} />
                <span>{t("dissection.report.redissection")}</span>
              </button>
            ) : null}
            <button type="button" onClick={exportDetail} disabled={!exportPath}>
              <Download size={16} />
              <span>{t("detail.export")}</span>
            </button>
          </div>
        </div>
        {renderedActionNotice ? (
          <p className="action-notice" role="status" aria-live="polite">
            {renderedActionNotice}
          </p>
        ) : null}
        <div className="modal-content">
          {detailTab === "summary" ? (
            summaryEditing && hasSummaryArtifact ? (
              <div className="summary-editor">
                <div className="summary-editor-tabs" role="tablist" aria-label={t("detail.summaryEditAria")}>
                  <button
                    className={summaryEditorMode === "edit" ? "selected" : ""}
                    type="button"
                    role="tab"
                    aria-selected={summaryEditorMode === "edit"}
                    onClick={() => setSummaryEditorMode("edit")}
                  >
                    <Pencil size={15} />
                    <span>{t("detail.edit")}</span>
                  </button>
                  <button
                    className={summaryEditorMode === "preview" ? "selected" : ""}
                    type="button"
                    role="tab"
                    aria-selected={summaryEditorMode === "preview"}
                    onClick={() => setSummaryEditorMode("preview")}
                  >
                    <Eye size={15} />
                    <span>{t("detail.preview")}</span>
                  </button>
                </div>
                <p className="summary-editor-hint">{t("detail.summaryEditorHint")}</p>
                {summaryEditorMode === "edit" ? (
                  <textarea
                    className="summary-editor-textarea"
                    aria-label={t("detail.summaryEditAria")}
                    value={summaryDraft}
                    onChange={(event) => updateSummaryDraft(event.target.value)}
                    disabled={summarySaving}
                  />
                ) : (
                  <MarkdownContent
                    markdown={summaryDraft}
                    emptyText={t("detail.summaryEmpty")}
                  />
                )}
                <div className="summary-editor-actions">
                  {summarySaving ? (
                    <span className="summary-editor-status" role="status" aria-live="polite">
                      {t("detail.summarySaving")}
                    </span>
                  ) : null}
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={handleCancelSummaryEdit}
                    disabled={summarySaving}
                  >
                    <X size={16} />
                    <span>{t("detail.cancel")}</span>
                  </button>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => void saveSummaryDraft()}
                    disabled={summarySaving}
                  >
                    <Save size={16} />
                    <span>{summarySaving ? t("detail.summarySaving") : t("detail.save")}</span>
                  </button>
                </div>
              </div>
            ) : (
              <AnnotatedMarkdownContent
                markdown={workflow.summary}
                emptyText={t("detail.summaryEmpty")}
                targetTab="summary"
                annotations={annotations}
                onAddAnnotation={(tab, anchor, idx, content, color) => {
                  onAnnotationAdd(tab, anchor, idx, content, color);
                }}
                onUpdateAnnotation={onAnnotationUpdate}
                onDeleteAnnotation={onAnnotationDelete}
                activeAnnotationId={activeAnnotationId}
              />
            )
          ) : detailTab === "dissection" ? (
            workflow.dissection ? (
              <DissectionReport
                report={workflow.dissection}
                stale={workflow.dissectionStale}
                sourceLocationDisabled={controller.transcriptDirty}
                onLocateChunks={onLocateDissectionChunks}
              />
            ) : (
              <p>{t("detail.dissectionEmpty")}</p>
            )
          ) : workflow.insights.length > 0 ? (
            <ol className="insight-detail-list">
              {workflow.insights.map((insight) => (
                <li className="insight-detail-item" key={insight.id}>
                  <h3>{insight.topic}</h3>
                  <dl>
                    <div><dt>{t("detail.matchReason")}</dt><dd>{insight.matchReason}</dd></div>
                    <div>
                      <dt>{t("detail.questions")}</dt>
                      <dd>{questionList.format(insight.followUpQuestions)}</dd>
                    </div>
                    <div><dt>{t("detail.suitableUse")}</dt><dd>{insight.suitableUse}</dd></div>
                  </dl>
                </li>
              ))}
            </ol>
          ) : (
            <p>{t("detail.insightsEmpty")}</p>
          )}
        </div>
      </section>
    </div>
  );
}
