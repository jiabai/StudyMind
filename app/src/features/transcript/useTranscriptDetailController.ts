import {
  type Dispatch,
  type SetStateAction,
  useCallback,
} from "react";

import type { SupportedLocale } from "../../i18n/locale";
import type { UiMessage } from "../../i18n/uiMessage";
import type { SaveSummaryEditResponse } from "../../summaryClient";
import type { SaveTranscriptEditResponse } from "../../transcriptDetailClient";
import type { WorkflowState } from "../../workflow";
import { useArtifactDetailController } from "../results/useArtifactDetailController";
import { useSummaryEditorController } from "../results/useSummaryEditorController";
import { useTranscriptDocumentController } from "./useTranscriptDocumentController";
import { useTranscriptReviewSession } from "./useTranscriptReviewSession";

type UseTranscriptDetailControllerOptions = {
  workflow: WorkflowState;
  locale: SupportedLocale;
  applyTranscriptSave: (
    expectedTaskId: string | null,
    saved: SaveTranscriptEditResponse,
  ) => void;
  applySummarySave: (
    expectedTaskId: string | null,
    saved: SaveSummaryEditResponse,
  ) => void;
  setActionNotice: Dispatch<SetStateAction<UiMessage | null>>;
};

export function useTranscriptDetailController({
  workflow,
  locale,
  applyTranscriptSave,
  applySummarySave,
  setActionNotice,
}: UseTranscriptDetailControllerOptions) {
  const transcriptDocument = useTranscriptDocumentController({
    workflow,
    applyTranscriptSave,
    setActionNotice,
  });
  const artifactDetail = useArtifactDetailController({
    workflow,
    locale,
    transcriptDraft: transcriptDocument.transcriptDraft,
    transcriptDirty: transcriptDocument.transcriptDirty,
    setActionNotice,
  });
  const summaryEditor = useSummaryEditorController({
    workflow,
    applySummarySave,
    setActionNotice,
  });
  const reviewTaskId =
    workflow.taskId && workflow.artifacts.transcript_txt
      ? workflow.taskId
      : null;
  const transcriptReview = useTranscriptReviewSession({
    reviewTaskId,
    audioAssetPath:
      transcriptDocument.transcriptDetail?.audio_asset_path ?? null,
    transcriptSegments: transcriptDocument.transcriptSegments,
    setActionNotice,
  });
  const saveTranscriptDraft = useCallback(
    () =>
      transcriptDocument.saveTranscriptDocument(
        transcriptReview.completeSuccessfulSave,
      ),
    [
      transcriptDocument.saveTranscriptDocument,
      transcriptReview.completeSuccessfulSave,
    ],
  );

  return {
    detailTab: artifactDetail.detailTab,
    openDetailTab: artifactDetail.openDetailTab,
    closeDetail: artifactDetail.closeDetail,
    detailText: artifactDetail.detailText,
    exportPath: artifactDetail.exportPath,
    currentTranscriptPath: artifactDetail.currentTranscriptPath,
    transcriptDetail: transcriptDocument.transcriptDetail,
    transcriptDraft: transcriptDocument.transcriptDraft,
    transcriptSegments: transcriptDocument.transcriptSegments,
    transcriptDirty: transcriptDocument.transcriptDirty,
    transcriptLoading: transcriptDocument.transcriptLoading,
    transcriptSaving: transcriptDocument.transcriptSaving,
    summaryEditing: summaryEditor.summaryEditing,
    summaryDraft: summaryEditor.summaryDraft,
    summaryDirty: summaryEditor.summaryDirty,
    summarySaving: summaryEditor.summarySaving,
    locatedTranscriptRange: transcriptDocument.locatedTranscriptRange,
    activeTranscriptSegmentId:
      transcriptReview.activeTranscriptSegmentId,
    editingTranscriptSegmentId:
      transcriptReview.editingTranscriptSegmentId,
    transcriptAudioCurrentTime:
      transcriptReview.transcriptAudioCurrentTime,
    transcriptAudioDuration: transcriptReview.transcriptAudioDuration,
    transcriptAudioPlaying: transcriptReview.transcriptAudioPlaying,
    transcriptAudioRef: transcriptReview.transcriptAudioRef,
    transcriptSegmentRefs: transcriptReview.transcriptSegmentRefs,
    transcriptAudioSrc: transcriptReview.transcriptAudioSrc,
    transcriptAudioProgress: transcriptReview.transcriptAudioProgress,
    transcriptAudioScrubberMax:
      transcriptReview.transcriptAudioScrubberMax,
    transcriptAudioScrubberStyle:
      transcriptReview.transcriptAudioScrubberStyle,
    hasTranscriptSegments: transcriptReview.hasTranscriptSegments,
    copyDetail: artifactDetail.copyDetail,
    copyTranscript: artifactDetail.copyTranscript,
    exportDetail: artifactDetail.exportDetail,
    exportTranscript: artifactDetail.exportTranscript,
    saveTranscriptDraft,
    beginSummaryEdit: summaryEditor.beginSummaryEdit,
    cancelSummaryEdit: summaryEditor.cancelSummaryEdit,
    updateSummaryDraft: summaryEditor.updateSummaryDraft,
    saveSummaryDraft: summaryEditor.saveSummaryDraft,
    playTranscriptSegment: transcriptReview.playTranscriptSegment,
    handleTranscriptAudioMetadata:
      transcriptReview.handleTranscriptAudioMetadata,
    handleTranscriptTimeUpdate:
      transcriptReview.handleTranscriptTimeUpdate,
    handleTranscriptAudioPlay:
      transcriptReview.handleTranscriptAudioPlay,
    handleTranscriptAudioPause:
      transcriptReview.handleTranscriptAudioPause,
    toggleTranscriptAudio: transcriptReview.toggleTranscriptAudio,
    scrubTranscriptAudio: transcriptReview.scrubTranscriptAudio,
    beginTranscriptSegmentEdit:
      transcriptReview.beginTranscriptSegmentEdit,
    endTranscriptSegmentEdit: transcriptReview.endTranscriptSegmentEdit,
    prepareTranscriptForTaskDeletion:
      transcriptReview.prepareTranscriptForTaskDeletion,
    updateTranscriptSegmentDraft:
      transcriptDocument.updateTranscriptSegmentDraft,
    updateFullTranscriptDraft:
      transcriptDocument.updateFullTranscriptDraft,
    locateTranscriptByteRange: transcriptDocument.locateTranscriptByteRange,
  };
}

export type TranscriptDetailController = ReturnType<
  typeof useTranscriptDetailController
>;
