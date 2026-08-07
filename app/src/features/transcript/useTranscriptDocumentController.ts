import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { uiMessage, type UiMessage } from "../../i18n/uiMessage";
import {
  loadTranscriptDetail,
  saveTranscriptEdit,
  type SaveTranscriptEditResponse,
  type TranscriptDetailResponse,
  type TranscriptSegment,
} from "../../transcriptDetailClient";
import {
  transcriptTextFromSegments,
  updateTranscriptSegmentText,
} from "../../transcriptReviewState";
import type { WorkflowState } from "../../workflow";
import { utf8ByteRangeToTextRange, type TranscriptTextRange } from "./transcriptByteRange";

type UseTranscriptDocumentControllerOptions = {
  workflow: WorkflowState;
  applyTranscriptSave: (
    expectedTaskId: string | null,
    saved: SaveTranscriptEditResponse,
  ) => void;
  setActionNotice: Dispatch<SetStateAction<UiMessage | null>>;
};

type CompleteSuccessfulSave = () => Promise<void>;

export function useTranscriptDocumentController({
  workflow,
  applyTranscriptSave,
  setActionNotice,
}: UseTranscriptDocumentControllerOptions) {
  const [transcriptDetail, setTranscriptDetail] =
    useState<TranscriptDetailResponse | null>(null);
  const [transcriptDraft, setTranscriptDraft] = useState("");
  const [transcriptSegments, setTranscriptSegments] =
    useState<TranscriptSegment[]>([]);
  const [transcriptDirty, setTranscriptDirty] = useState(false);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptSaving, setTranscriptSaving] = useState(false);
  const [locatedTranscriptRange, setLocatedTranscriptRange] = useState<TranscriptTextRange | null>(null);
  const transcriptLoadTaskIdRef = useRef<string | null>(null);
  const currentTaskIdRef = useRef(workflow.taskId);
  currentTaskIdRef.current = workflow.taskId;

  useEffect(() => {
    if (!workflow.taskId || !workflow.artifacts.transcript_txt) {
      transcriptLoadTaskIdRef.current = null;
      setTranscriptDetail(null);
      setTranscriptDraft(workflow.text);
      setTranscriptSegments([]);
      setTranscriptDirty(false);
      setLocatedTranscriptRange(null);
      return;
    }

    if (transcriptLoadTaskIdRef.current === workflow.taskId) {
      return;
    }
    transcriptLoadTaskIdRef.current = workflow.taskId;

    let cancelled = false;
    setTranscriptLoading(true);
    setTranscriptDetail(null);
    setTranscriptDraft(workflow.text);
    setTranscriptSegments([]);
    setTranscriptDirty(false);
    setLocatedTranscriptRange(null);
    const taskId = workflow.taskId;

    async function loadDetail() {
      try {
        const detail = await loadTranscriptDetail(taskId);
        if (cancelled) {
          return;
        }
        setTranscriptDetail(detail);
        setTranscriptDraft(detail.text || workflow.text);
        setTranscriptSegments(detail.segments);
        setActionNotice(
          detail.audio_asset_path
            ? null
            : uiMessage("transcript.notice.audioUnavailableEdit"),
        );
      } catch {
        if (cancelled) {
          return;
        }
        setTranscriptDetail(null);
        setTranscriptDraft(workflow.text);
        setTranscriptSegments([]);
        setActionNotice(uiMessage("transcript.notice.detailLoadFallback"));
      } finally {
        if (!cancelled) {
          setTranscriptLoading(false);
        }
      }
    }

    void loadDetail();
    return () => {
      cancelled = true;
    };
  }, [
    setActionNotice,
    workflow.artifacts.transcript_txt,
    workflow.taskId,
    workflow.text,
  ]);

  useEffect(() => setLocatedTranscriptRange(null), [workflow.text]);

  const updateTranscriptSegmentDraft = useCallback(
    (segmentId: string, text: string) => {
      setTranscriptSegments((current) => {
        const next = updateTranscriptSegmentText(current, segmentId, text);
        setTranscriptDraft(transcriptTextFromSegments(next));
        return next;
      });
      setTranscriptDirty(true);
    },
    [],
  );

  const updateFullTranscriptDraft = useCallback((text: string) => {
    setTranscriptDraft(text);
    setTranscriptDirty(true);
  }, []);

  const locateTranscriptByteRange = useCallback((startByte: number, endByte: number) => {
    const range = utf8ByteRangeToTextRange(transcriptDraft, startByte, endByte);
    setLocatedTranscriptRange(range);
    return range !== null;
  }, [transcriptDraft]);

  const saveTranscriptDocument = useCallback(
    async (completeSuccessfulSave: CompleteSuccessfulSave) => {
      if (
        !workflow.taskId ||
        !workflow.artifacts.transcript_txt ||
        transcriptSaving
      ) {
        return;
      }

      const expectedTaskId = workflow.taskId;
      setTranscriptSaving(true);
      try {
        const saved = await saveTranscriptEdit(
          expectedTaskId,
          transcriptDraft,
          transcriptSegments,
        );
        if (
          currentTaskIdRef.current !== expectedTaskId ||
          saved.task_id !== expectedTaskId
        ) {
          return;
        }
        setTranscriptDraft(saved.text);
        setTranscriptDirty(false);
        setTranscriptDetail((current) =>
          current
            ? {
                ...current,
                text: saved.text,
                has_original_backup: saved.has_original_backup,
              }
            : current,
        );
        applyTranscriptSave(expectedTaskId, saved);
        setActionNotice(uiMessage("transcript.notice.saved"));
        await completeSuccessfulSave();
      } catch {
        setActionNotice(uiMessage("transcript.notice.saveFailed"));
      } finally {
        setTranscriptSaving(false);
      }
    },
    [
      applyTranscriptSave,
      setActionNotice,
      transcriptDraft,
      transcriptSaving,
      transcriptSegments,
      workflow.artifacts.transcript_txt,
      workflow.taskId,
    ],
  );

  return {
    transcriptDetail,
    transcriptDraft,
    transcriptSegments,
    transcriptDirty,
    transcriptLoading,
    transcriptSaving,
    locatedTranscriptRange,
    saveTranscriptDocument,
    updateTranscriptSegmentDraft,
    updateFullTranscriptDraft,
    locateTranscriptByteRange,
  };
}
