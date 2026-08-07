import { ShieldCheck, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { getOutputLanguageName } from "../../i18n/preferencePresentation";
import { useModalFocus } from "../modal/useModalFocus";
import type { DissectionPreview } from "./useTranscriptDissectionController";

type Props = {
  preview: DissectionPreview;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
};

export function TranscriptDissectionConfirmationSheet({
  preview,
  onCancel,
  onConfirm,
}: Props) {
  const { t, i18n } = useTranslation("synthesis");
  const modalRef = useModalFocus<HTMLElement>(true);
  const number = new Intl.NumberFormat(i18n.resolvedLanguage ?? "en-US");
  const blockReason = !preview.eligible
    ? t("dissection.confirmation.tooLong")
    : !preview.canConfirm
      ? t("dissection.confirmation.insufficientQuota")
      : null;

  return (
    <div className="modal-backdrop sheet-backdrop" role="presentation" onClick={onCancel}>
      <section
        ref={modalRef}
        className="sheet-panel detail-modal dissection-confirmation-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t("dissection.confirmation.ariaLabel")}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header sheet-header">
          <div>
            <p className="section-label">{t("dissection.confirmation.sectionLabel")}</p>
            <h2>{t("dissection.confirmation.title")}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onCancel} aria-label={t("dissection.confirmation.closeAria")}>
            <X size={18} />
          </button>
        </header>
        <div className="preference-flow-content">
          <p className="settings-warning privacy-callout">
            <ShieldCheck size={16} />
            <span>{t("dissection.confirmation.privacy")}</span>
          </p>
          <dl className="dissection-preview-grid">
            <div><dt>{t("dissection.confirmation.task")}</dt><dd>{preview.taskTitle}</dd></div>
            <div><dt>{t("dissection.confirmation.characters")}</dt><dd>{number.format(preview.characterCount)}</dd></div>
            <div><dt>{t("dissection.confirmation.chunks")}</dt><dd>{number.format(preview.chunkCount)}</dd></div>
            <div><dt>{t("dissection.confirmation.language")}</dt><dd>{getOutputLanguageName(preview.outputLanguage, preview.outputLanguage)}</dd></div>
            <div>
              <dt>{t("dissection.confirmation.calls")}</dt>
              <dd>{t("dissection.confirmation.callRange", {
                minimum: number.format(preview.minimumCalls),
                maximum: number.format(preview.maximumCalls),
                hardMaximum: number.format(preview.hardMaximumCalls),
              })}</dd>
            </div>
            <div><dt>{t("dissection.confirmation.quota")}</dt><dd>{number.format(preview.quotaRemaining)}</dd></div>
          </dl>
          <p className="dissection-credit-disclosure">{t("dissection.confirmation.creditDisclosure")}</p>
          {blockReason ? <p className="ai-availability-blocker" role="status">{blockReason}</p> : null}
          <div className="settings-actions sheet-footer">
            <button type="button" className="secondary-button" onClick={onCancel}>{t("dissection.confirmation.cancel")}</button>
            <button type="button" className="primary-button" onClick={() => void onConfirm()} disabled={!preview.canConfirm}>
              <Sparkles size={16} />
              <span>{t("dissection.confirmation.confirm")}</span>
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
