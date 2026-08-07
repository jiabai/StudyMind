import {
  FileAudio,
  FileVideo,
  LoaderCircle,
  Paperclip,
  Play,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { formatBytes } from "../../i18n/formatters";
import { useLocale } from "../../i18n/LocaleProvider";
import { selectLocalMedia } from "../../localMediaClient";
import type { LocalMediaSelectionView } from "../../localMediaContract";
import type { TaskComposerSource, TaskSubmission } from "../../workflow";

type TaskComposerProps = {
  source: TaskComposerSource;
  canSubmit: boolean;
  statusBody: string;
  onUrlDraftChange: (url: string) => void;
  onLocalMediaSelected: (selection: LocalMediaSelectionView) => void;
  onRemoveLocalMedia: () => Promise<boolean>;
  onSubmit: (submission: TaskSubmission) => void;
};

export function TaskComposer({
  source,
  canSubmit,
  statusBody,
  onUrlDraftChange,
  onLocalMediaSelected,
  onRemoveLocalMedia,
  onSubmit,
}: TaskComposerProps) {
  const { t } = useTranslation("workflow");
  const { resolvedLocale } = useLocale();
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [localFeedbackKey, setLocalFeedbackKey] = useState<
    | "input.attachment.pickerFailed"
    | "input.attachment.removeFailed"
    | null
  >(null);
  const attachmentControlRef = useRef<HTMLDivElement>(null);
  const attachmentTriggerRef = useRef<HTMLButtonElement>(null);
  const attachmentMenuItemRef = useRef<HTMLButtonElement>(null);
  const localMediaRemoveRef = useRef<HTMLButtonElement>(null);
  const pendingFocusRef = useRef<"attachment" | "remove" | null>(null);

  useEffect(() => {
    if (!attachmentMenuOpen) {
      return;
    }

    attachmentMenuItemRef.current?.focus();
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !attachmentControlRef.current?.contains(event.target)
      ) {
        setAttachmentMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      setAttachmentMenuOpen(false);
      attachmentTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [attachmentMenuOpen]);

  useEffect(() => {
    if (pickerBusy || removing || !pendingFocusRef.current) {
      return;
    }
    if (pendingFocusRef.current === "attachment") {
      pendingFocusRef.current = null;
      attachmentTriggerRef.current?.focus();
      return;
    }
    if (pendingFocusRef.current === "remove" && source.kind === "local_media") {
      pendingFocusRef.current = null;
      localMediaRemoveRef.current?.focus();
    }
  }, [pickerBusy, removing, source.kind]);

  async function pickLocalMedia() {
    setAttachmentMenuOpen(false);
    setPickerBusy(true);
    setLocalFeedbackKey(null);
    try {
      const selection = await selectLocalMedia();
      if (!selection) {
        pendingFocusRef.current = "attachment";
        return;
      }
      onLocalMediaSelected(selection);
      pendingFocusRef.current = "remove";
    } catch {
      setLocalFeedbackKey("input.attachment.pickerFailed");
      pendingFocusRef.current = "attachment";
    } finally {
      setPickerBusy(false);
    }
  }

  async function removeLocalMedia() {
    setRemoving(true);
    setLocalFeedbackKey(null);
    const removed = await onRemoveLocalMedia();
    setRemoving(false);
    if (!removed) {
      setLocalFeedbackKey("input.attachment.removeFailed");
      pendingFocusRef.current = "remove";
      return;
    }
    pendingFocusRef.current = "attachment";
  }

  function submitCurrentSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (source.kind === "url") {
      onSubmit({ kind: "url", url: source.urlDraft });
      return;
    }
    onSubmit({
      kind: "local_media",
      selectionToken: source.selection.selectionToken,
    });
  }

  return (
    <form className="command-panel input-pane" onSubmit={submitCurrentSource}>
      <div className="panel-heading">
        <div>
          <p className="section-label">{t("input.sectionLabel")}</p>
          <h2>{t("input.title")}</h2>
        </div>
      </div>

      <div className="task-composer-row">
        <div className="attachment-control" ref={attachmentControlRef}>
          <button
            ref={attachmentTriggerRef}
            className="attachment-trigger"
            type="button"
            aria-label={t("input.attachment.openAria")}
            aria-haspopup="menu"
            aria-expanded={attachmentMenuOpen}
            aria-controls={
              attachmentMenuOpen ? "local-media-attachment-menu" : undefined
            }
            aria-busy={pickerBusy}
            disabled={pickerBusy || removing}
            onClick={() => {
              setLocalFeedbackKey(null);
              setAttachmentMenuOpen((open) => !open);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && !attachmentMenuOpen) {
                event.preventDefault();
                setAttachmentMenuOpen(true);
              }
            }}
          >
            {pickerBusy ? (
              <LoaderCircle className="spin" size={18} aria-hidden="true" />
            ) : (
              <Paperclip size={18} aria-hidden="true" />
            )}
          </button>
          {attachmentMenuOpen ? (
            <div
              id="local-media-attachment-menu"
              className="attachment-menu"
              role="menu"
              aria-label={t("input.attachment.menuLabel")}
            >
              <button
                ref={attachmentMenuItemRef}
                className="attachment-menu-item"
                type="button"
                role="menuitem"
                onClick={() => void pickLocalMedia()}
              >
                <FileVideo size={17} aria-hidden="true" />
                <span>{t("input.attachment.selectFile")}</span>
              </button>
            </div>
          ) : null}
        </div>

        {source.kind === "url" ? (
          <input
            id="video-url"
            aria-label={t("input.urlAria")}
            value={source.urlDraft}
            onChange={(event) => onUrlDraftChange(event.currentTarget.value)}
            placeholder={t("input.placeholder")}
          />
        ) : (
          <div
            className="local-media-chip"
            data-media-kind={source.selection.mediaKind}
            role="group"
            aria-label={t("input.attachment.selectedAria")}
          >
            {source.selection.mediaKind === "video" ? (
              <FileVideo size={20} aria-hidden="true" />
            ) : (
              <FileAudio size={20} aria-hidden="true" />
            )}
            <span className="local-media-chip-copy">
              <strong title={source.selection.displayName}>
                {source.selection.displayName}
              </strong>
              <small>
                {t("input.attachment.details", {
                  kind: t(`input.attachment.kind.${source.selection.mediaKind}`),
                  size: formatBytes(source.selection.sizeBytes, resolvedLocale),
                })}
              </small>
            </span>
            <button
              ref={localMediaRemoveRef}
              className="local-media-remove"
              type="button"
              aria-label={t("input.attachment.removeAria", {
                name: source.selection.displayName,
              })}
              disabled={removing || pickerBusy}
              onClick={() => void removeLocalMedia()}
            >
              {removing ? (
                <LoaderCircle className="spin" size={16} aria-hidden="true" />
              ) : (
                <X size={16} aria-hidden="true" />
              )}
            </button>
          </div>
        )}

        <button
          className="primary-button"
          type="submit"
          disabled={!canSubmit || pickerBusy || removing}
        >
          <Play size={17} aria-hidden="true" />
          <span>{t("input.confirm")}</span>
        </button>
      </div>
      {localFeedbackKey ? (
        <p className="action-notice composer-notice" role="alert">
          {t(localFeedbackKey)}
        </p>
      ) : null}
      <p className="status-line" aria-live="polite">
        {pickerBusy ? t("input.attachment.pickerBusy") : statusBody}
      </p>
    </form>
  );
}
