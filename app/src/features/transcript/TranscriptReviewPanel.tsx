import {
  CheckCircle2,
  Copy,
  Download,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  StickyNote,
} from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { useTranslation } from "react-i18next";

import { clampAudioTime, formatAudioClock } from "../../audioReviewBarState";
import { formatNumber, formatPercent } from "../../i18n/formatters";
import { resolveSystemLocale } from "../../i18n/locale";
import type { TranscriptSourceViewModel } from "../../taskWorkspaceViewModel";
import type { TranscriptSegment } from "../../transcriptDetailClient";
import {
  isTranscriptSegmentEditDisabled,
  transcriptTimeFromTextOffset,
} from "../../transcriptReviewState";
import type { TranscriptDetailController } from "./useTranscriptDetailController";
import type { TranscriptNotesController } from "./useTranscriptNotesController";
import { findTranscriptNoteForSegment } from "../../transcriptNotesState";

const AUDIO_TIME_SEPARATOR = " / ";

type DocumentWithCaretApi = Document & {
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
  caretPositionFromPoint?: (x: number, y: number) => {
    offsetNode: Node;
    offset: number;
  } | null;
};

function transcriptTextOffsetAtPoint(
  element: HTMLButtonElement,
  event: ReactMouseEvent<HTMLButtonElement>,
): number | null {
  const documentWithCaretApi = element.ownerDocument as DocumentWithCaretApi;
  const range = documentWithCaretApi.caretRangeFromPoint?.(
    event.clientX,
    event.clientY,
  );
  if (range) {
    return element.contains(range.startContainer) ? range.startOffset : null;
  }

  const position = documentWithCaretApi.caretPositionFromPoint?.(
    event.clientX,
    event.clientY,
  );
  if (!position || !element.contains(position.offsetNode)) {
    return null;
  }
  return position.offset;
}

function estimatedTranscriptTextTime(
  element: HTMLButtonElement,
  event: ReactMouseEvent<HTMLButtonElement>,
  segment: TranscriptSegment,
): number {
  const textOffset = transcriptTextOffsetAtPoint(element, event);
  return textOffset === null
    ? segment.start_ms / 1000
    : transcriptTimeFromTextOffset(segment, textOffset);
}

type TranscriptReviewPanelProps = {
  transcriptSource: TranscriptSourceViewModel;
  controller: TranscriptDetailController;
  notesController?: TranscriptNotesController;
  editingDisabled: boolean;
  readOnlyReason: string | null;
  artifactToolbar?: ReactNode;
};

function formatSegmentTime(startMs: number, locale: ReturnType<typeof resolveSystemLocale>): string {
  const totalSeconds = Math.max(0, Math.floor(startMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${formatNumber(minutes, locale)}:${formatNumber(seconds, locale, {
    minimumIntegerDigits: 2,
  })}`;
}

export function TranscriptReviewPanel({
  transcriptSource,
  controller,
  notesController,
  editingDisabled,
  readOnlyReason,
  artifactToolbar,
}: TranscriptReviewPanelProps) {
  const { t, i18n } = useTranslation("transcript");
  const locale = resolveSystemLocale([
    i18n.resolvedLanguage ?? i18n.language ?? "en-US",
  ]);
  const {
    transcriptDetail,
    transcriptDraft,
    transcriptSegments,
    transcriptDirty,
    transcriptLoading,
    transcriptSaving,
    locatedTranscriptRange,
    activeTranscriptSegmentId,
    editingTranscriptSegmentId,
    transcriptAudioCurrentTime,
    transcriptAudioDuration,
    transcriptAudioPlaying,
    transcriptAudioRef,
    transcriptSegmentRefs,
    transcriptAudioSrc,
    transcriptAudioProgress,
    transcriptAudioScrubberMax,
    transcriptAudioScrubberStyle,
    copyTranscript,
    exportTranscript,
    saveTranscriptDraft,
    playTranscriptSegment,
    handleTranscriptAudioMetadata,
    handleTranscriptTimeUpdate,
    handleTranscriptAudioPlay,
    handleTranscriptAudioPause,
    toggleTranscriptAudio,
    scrubTranscriptAudio,
    beginTranscriptSegmentEdit,
    endTranscriptSegmentEdit,
    updateTranscriptSegmentDraft,
    updateFullTranscriptDraft,
  } = controller;
  const visibleTranscriptSegments = useMemo(
    () => transcriptSegments.filter(
      (segment) => segment.text.trim().length > 0 || editingTranscriptSegmentId === segment.id,
    ),
    [editingTranscriptSegmentId, transcriptSegments],
  );
  const transcriptEditButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const fullTranscriptRef = useRef<HTMLTextAreaElement | null>(null);
  const locatedSourceText = locatedTranscriptRange
    ? transcriptDraft.slice(locatedTranscriptRange.start, locatedTranscriptRange.end)
    : "";
  const locatedSegmentId = useMemo(
    () => transcriptSegments.find((segment) =>
      locatedSourceText.includes(segment.text.trim()) ||
      segment.text.includes(locatedSourceText.slice(0, 24))
    )?.id ?? null,
    [locatedSourceText, transcriptSegments],
  );
  useEffect(() => {
    if (!locatedTranscriptRange) {
      return;
    }
    if (fullTranscriptRef.current) {
      fullTranscriptRef.current.focus();
      fullTranscriptRef.current.setSelectionRange(
        locatedTranscriptRange.start,
        locatedTranscriptRange.end,
      );
      fullTranscriptRef.current.scrollIntoView({ block: "center" });
      return;
    }
    transcriptSegmentRefs.current[locatedSegmentId ?? ""]?.scrollIntoView({ block: "center" });
  }, [locatedSegmentId, locatedTranscriptRange, transcriptSegmentRefs]);
  const sourceLabel = transcriptSource
    ? transcriptSource.kind === "subtitle"
      ? transcriptSource.language
        ? t("review.source.subtitleWithLanguage", {
            language: transcriptSource.language,
          })
        : t("review.source.subtitle")
      : t("review.source.asr")
    : null;
  const audioProgressText = formatPercent(
    Math.max(0, Math.min(100, transcriptAudioProgress)) / 100,
    locale,
  );

  return (
    <div className="transcript-review-panel">
      {sourceLabel ? <p className="transcript-source">{sourceLabel}</p> : null}
      {readOnlyReason ? (
        <p className="transcript-readonly-notice">{readOnlyReason}</p>
      ) : null}
      {transcriptLoading ? (
        <p className="transcript-status">{t("review.loading")}</p>
      ) : null}

      {transcriptAudioSrc ? (
        <>
          <audio
            ref={transcriptAudioRef}
            className="transcript-audio-engine"
            src={transcriptAudioSrc}
            preload="metadata"
            onLoadedMetadata={handleTranscriptAudioMetadata}
            onDurationChange={handleTranscriptAudioMetadata}
            onTimeUpdate={handleTranscriptTimeUpdate}
            onPlay={handleTranscriptAudioPlay}
            onPause={handleTranscriptAudioPause}
            onEnded={handleTranscriptAudioPause}
          />
          <div className="audio-review-bar" aria-label={t("review.audioToolbar")}>
            <button
              className="audio-play-button"
              type="button"
              onClick={() => void toggleTranscriptAudio()}
              aria-label={
                transcriptAudioPlaying
                  ? t("review.pauseAudio")
                  : t("review.playAudio")
              }
            >
              {transcriptAudioPlaying ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <input
              className="audio-review-scrubber"
              type="range"
              min={0}
              max={transcriptAudioScrubberMax}
              step={0.1}
              style={transcriptAudioScrubberStyle}
              value={clampAudioTime(
                transcriptAudioCurrentTime,
                transcriptAudioScrubberMax,
              )}
              onChange={scrubTranscriptAudio}
              disabled={transcriptAudioDuration <= 0}
              aria-label={t("review.audioProgress")}
              aria-valuetext={t("review.audioProgressValue", {
                time: formatAudioClock(transcriptAudioCurrentTime),
                progress: audioProgressText,
              })}
            />
            <div className="audio-review-clock">
              <span>{formatAudioClock(transcriptAudioCurrentTime)}</span>
              <span aria-hidden="true">{AUDIO_TIME_SEPARATOR}</span>
              <span>{formatAudioClock(transcriptAudioDuration)}</span>
            </div>
          </div>
        </>
      ) : (
        <p className="transcript-status">{t("review.noAudio")}</p>
      )}

      {artifactToolbar}

      <div className="transcript-review-scroll">
        {visibleTranscriptSegments.length > 0 ? (
          <div className="transcript-segments">
            {visibleTranscriptSegments.map((segment) => (
              <div
                key={segment.id}
                ref={(element) => {
                  transcriptSegmentRefs.current[segment.id] = element;
                }}
                className={`transcript-segment ${activeTranscriptSegmentId === segment.id ? "active" : ""} ${editingTranscriptSegmentId === segment.id ? "editing" : ""} ${locatedSegmentId === segment.id ? "dissection-source" : ""}`}
              >
                <div className="transcript-segment-header">
                  <button
                    type="button"
                    className="transcript-segment-time"
                    onClick={() => void playTranscriptSegment(segment)}
                    disabled={
                      !transcriptDetail?.audio_asset_path ||
                      Boolean(editingTranscriptSegmentId)
                    }
                  >
                    <Play size={14} />
                    <span>{formatSegmentTime(segment.start_ms, locale)}</span>
                  </button>
                  <button
                    ref={(element) => {
                      transcriptEditButtonRefs.current[segment.id] = element;
                    }}
                    type="button"
                    className="secondary-button compact-button transcript-segment-edit"
                    onClick={() => beginTranscriptSegmentEdit(segment.id)}
                    disabled={
                      editingDisabled ||
                      isTranscriptSegmentEditDisabled(
                        editingTranscriptSegmentId,
                        segment.id,
                      )
                    }
                    aria-label={t("review.editSegment")}
                    title={t("review.edit")}
                  >
                    <Pencil size={16} />
                  </button>
                  {notesController ? (() => {
                    const segmentNote = findTranscriptNoteForSegment(
                      notesController.notes,
                      segment.id,
                    );
                    const hasNote = segmentNote !== null;
                    return (
                      <button
                        type="button"
                        className={`secondary-button compact-button transcript-segment-note${hasNote ? " inserted" : ""}`}
                        onClick={() => {
                          if (segmentNote) {
                            notesController.focusNoteForSegment(segment.id);
                          } else {
                            notesController.createNoteForSegment(
                              segment.id,
                              segment.text,
                            );
                          }
                        }}
                        disabled={
                          editingDisabled || Boolean(editingTranscriptSegmentId)
                        }
                        aria-label={t(hasNote ? "notes.inserted" : "notes.insert")}
                        title={t(hasNote ? "notes.inserted" : "notes.insert")}
                        aria-pressed={hasNote}
                      >
                        <StickyNote size={16} aria-hidden="true" />
                      </button>
                    );
                  })() : null}
                </div>
                {editingTranscriptSegmentId === segment.id ? (
                  <textarea
                    value={segment.text}
                    onChange={(event) =>
                      updateTranscriptSegmentDraft(
                        segment.id,
                        event.currentTarget.value,
                      )
                    }
                    onKeyDown={(event) => {
                      if (
                        event.key !== "Escape" ||
                        event.nativeEvent.isComposing
                      ) {
                        return;
                      }
                      event.preventDefault();
                      event.stopPropagation();
                      const editButton =
                        transcriptEditButtonRefs.current[segment.id];
                      endTranscriptSegmentEdit();
                      editButton?.focus();
                    }}
                    disabled={editingDisabled}
                    autoFocus
                  />
                ) : (
                  <button
                    type="button"
                    className="transcript-segment-text"
                    onClick={(event) =>
                      void playTranscriptSegment(
                        segment,
                        estimatedTranscriptTextTime(event.currentTarget, event, segment),
                      )
                    }
                  >
                    {segment.text}
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <textarea
            ref={fullTranscriptRef}
            className="transcript-full-editor"
            value={transcriptDraft}
            onFocus={() => beginTranscriptSegmentEdit("full-text")}
            onChange={(event) =>
              updateFullTranscriptDraft(event.currentTarget.value)
            }
            placeholder={t("review.placeholder")}
            disabled={editingDisabled}
          />
        )}
      </div>

      <footer className="transcript-action-bar">
        <button
          type="button"
          className="secondary-button"
          onClick={copyTranscript}
          disabled={!transcriptDraft}
        >
          <Copy size={16} />
          <span>{t("review.copy")}</span>
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={exportTranscript}
          disabled={!controller.currentTranscriptPath}
        >
          <Download size={16} />
          <span>{t("review.export")}</span>
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={saveTranscriptDraft}
          disabled={
            editingDisabled ||
            !transcriptDirty ||
            transcriptSaving
          }
        >
          {transcriptSaving ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <CheckCircle2 size={16} />
          )}
          <span>{transcriptSaving ? t("review.saving") : t("review.save")}</span>
        </button>
      </footer>
    </div>
  );
}
