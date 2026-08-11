import { Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { TranscriptSegment } from "../../transcriptDetailClient";
import type { TranscriptNotesController } from "./useTranscriptNotesController";

type TranscriptNotesPanelProps = {
  controller: TranscriptNotesController;
  transcriptSegments: TranscriptSegment[];
  editingDisabled: boolean;
};

export function TranscriptNotesPanel({
  controller,
  transcriptSegments,
  editingDisabled,
}: TranscriptNotesPanelProps) {
  const { t } = useTranslation("transcript");
  const segmentIds = new Set(transcriptSegments.map((segment) => segment.id));
  const noteRefs = useRef<Record<string, HTMLLIElement | null>>({});

  useEffect(() => {
    if (!controller.focusedNoteId) {
      return;
    }
    noteRefs.current[controller.focusedNoteId]?.scrollIntoView?.({
      block: "nearest",
    });
  }, [controller.focusedNoteId]);

  return (
    <section
      className="task-domain-workspace transcript-notes-workspace"
      aria-label={t("notes.ariaLabel")}
    >
      <header className="domain-workspace-header">
        <h2>{t("notes.title")}</h2>
        <span className="transcript-notes-count">
          {t("notes.count", { count: controller.notes.length })}
        </span>
      </header>

      <div className="transcript-notes-scroll">
        {controller.notesLoading ? (
          <p className="transcript-notes-status" role="status">
            {t("notes.loading")}
          </p>
          ) : controller.notesLoadError ? (
          <div className="transcript-notes-error" role="alert">
            <p>{t("notes.loadError")}</p>
            <button
              type="button"
              className="secondary-button compact-button"
              onClick={controller.retryLoadNotes}
              disabled={controller.notesLoading}
            >
              {t("notes.retry")}
            </button>
          </div>
        ) : controller.notes.length === 0 ? (
          <p className="transcript-notes-empty">{t("notes.empty")}</p>
        ) : (
          <ul className="transcript-notes-list">
            {controller.notes.map((note) => {
              const orphaned = !segmentIds.has(note.transcript_segment_id);
              const editing = controller.editingNoteId === note.id;
              return (
                <li
                  key={note.id}
                  ref={(element) => {
                    noteRefs.current[note.id] = element;
                  }}
                  className={`transcript-note-record${
                    controller.focusedNoteId === note.id ? " focused" : ""
                  }`}
                >
                  <p className="transcript-note-source">“{note.source_text}”</p>
                  {orphaned ? (
                    <p className="transcript-note-orphaned">
                      {t("notes.orphaned")}
                    </p>
                  ) : null}

                  {editing ? (
                    <textarea
                      className="transcript-note-editor"
                      value={controller.editingNoteContent}
                      onChange={(event) =>
                        controller.updateNoteDraft(event.currentTarget.value)
                      }
                      placeholder={t("notes.contentPlaceholder")}
                      aria-label={t("notes.contentPlaceholder")}
                      disabled={editingDisabled}
                      autoFocus
                    />
                  ) : (
                    <p className="transcript-note-content">
                      {note.content || t("notes.blank")}
                    </p>
                  )}

                  <div className="transcript-note-actions">
                    {editing ? (
                      <>
                        <button
                          type="button"
                          className="primary-button compact-button"
                          onClick={() => void controller.saveNote()}
                          disabled={editingDisabled || controller.notesSaving}
                          aria-label={t("notes.save")}
                        >
                          {controller.notesSaving
                            ? t("notes.saving")
                            : t("notes.save")}
                        </button>
                        <button
                          type="button"
                          className="secondary-button compact-button"
                          onClick={controller.cancelNoteEdit}
                          disabled={controller.notesSaving}
                          aria-label={t("notes.cancel")}
                        >
                          {t("notes.cancel")}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="secondary-button compact-button transcript-note-edit"
                          onClick={() => controller.beginNoteEdit(note.id)}
                          disabled={editingDisabled || controller.notesSaving}
                          aria-label={t("notes.edit")}
                          title={t("notes.edit")}
                        >
                          <Pencil size={14} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="secondary-button compact-button transcript-note-delete"
                          onClick={() => void controller.deleteNote(note.id)}
                          disabled={editingDisabled || controller.notesSaving}
                          aria-label={t("notes.delete")}
                          title={t("notes.delete")}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      </>
                    )}
                  </div>
                  {controller.notesSaveError ? (
                    <p className="transcript-notes-save-error" role="alert">
                      {controller.notesSaveError.messageCode.endsWith("deleteFailed")
                        ? t("notes.deleteFailed")
                        : t("notes.saveFailed")}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
