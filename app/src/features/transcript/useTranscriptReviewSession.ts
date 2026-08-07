import { convertFileSrc } from "@tauri-apps/api/core";
import {
  type ChangeEvent, type CSSProperties, type Dispatch, type SetStateAction,
  useCallback, useEffect, useRef, useState,
} from "react";

import { audioProgressPercent, clampAudioTime } from "../../audioReviewBarState";
import { uiMessage, type UiMessage } from "../../i18n/uiMessage";
import type { TranscriptSegment } from "../../transcriptDetailClient";
import { findActiveTranscriptSegmentId, shouldPauseActiveTranscriptSegment } from "../../transcriptReviewState";

type UseTranscriptReviewSessionOptions = {
  reviewTaskId: string | null;
  audioAssetPath: string | null;
  transcriptSegments: TranscriptSegment[];
  setActionNotice: Dispatch<SetStateAction<UiMessage | null>>;
};

export function useTranscriptReviewSession({
  reviewTaskId,
  audioAssetPath,
  transcriptSegments,
  setActionNotice,
}: UseTranscriptReviewSessionOptions) {
  const [activeTranscriptSegmentId, setActiveTranscriptSegmentId] = useState<string | null>(null);
  const [editingTranscriptSegmentId, setEditingTranscriptSegmentId] = useState<string | null>(null);
  const [transcriptAudioCurrentTime, setTranscriptAudioCurrentTime] = useState(0);
  const [transcriptAudioDuration, setTranscriptAudioDuration] = useState(0);
  const [transcriptAudioPlaying, setTranscriptAudioPlaying] = useState(false);
  const transcriptAudioRef = useRef<HTMLAudioElement | null>(null);
  const transcriptSegmentRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const resumeTranscriptAfterSaveRef = useRef(false);

  const transcriptAudioSrc = audioAssetPath ? convertFileSrc(audioAssetPath) : "";
  const transcriptAudioProgress =
    audioProgressPercent(transcriptAudioCurrentTime, transcriptAudioDuration);
  const transcriptAudioScrubberMax = transcriptAudioDuration > 0
    ? transcriptAudioDuration
    : Math.max(transcriptAudioCurrentTime, 1);
  const transcriptAudioScrubberStyle =
    { "--audio-progress": `${transcriptAudioProgress}%` } as CSSProperties;
  const hasTranscriptSegments = transcriptSegments.length > 0;

  useEffect(() => {
    resumeTranscriptAfterSaveRef.current = false;
    setActiveTranscriptSegmentId(null);
    setEditingTranscriptSegmentId(null);
  }, [reviewTaskId]);

  useEffect(() => {
    if (!activeTranscriptSegmentId) {
      return;
    }
    transcriptSegmentRefs.current[activeTranscriptSegmentId]?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, [activeTranscriptSegmentId]);

  useEffect(() => {
    setTranscriptAudioCurrentTime(0);
    setTranscriptAudioDuration(0);
    setTranscriptAudioPlaying(false);
    if (transcriptAudioRef.current) {
      transcriptAudioRef.current.playbackRate = 1;
    }
  }, [transcriptAudioSrc]);

  const playTranscriptSegment = useCallback(
    async (segment: TranscriptSegment, startTimeSeconds?: number) => {
      if (editingTranscriptSegmentId) {
        return;
      }

      const audio = transcriptAudioRef.current;
      if (!audio || !audioAssetPath) {
        setActiveTranscriptSegmentId(segment.id);
        setActionNotice(uiMessage("transcript.notice.audioUnavailable"));
        return;
      }

      if (startTimeSeconds === undefined && shouldPauseActiveTranscriptSegment(
        activeTranscriptSegmentId,
        segment.id,
        !audio.paused,
      )) {
        audio.pause();
        setTranscriptAudioPlaying(false);
        return;
      }

      setActiveTranscriptSegmentId(segment.id);
      audio.currentTime = startTimeSeconds ?? segment.start_ms / 1000;
      audio.playbackRate = 1;
      setTranscriptAudioCurrentTime(audio.currentTime);
      try {
        await audio.play();
      } catch {
        setActionNotice(uiMessage("transcript.notice.audioAutoplayFailed"));
      }
    },
    [activeTranscriptSegmentId, audioAssetPath, editingTranscriptSegmentId, setActionNotice],
  );

  const syncTranscriptAudioState = useCallback((audio: HTMLAudioElement) => {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    setTranscriptAudioDuration(duration);
    setTranscriptAudioCurrentTime(clampAudioTime(audio.currentTime, duration));
  }, []);

  const handleTranscriptAudioMetadata = useCallback(() => {
    const audio = transcriptAudioRef.current;
    if (!audio) {
      return;
    }
    audio.playbackRate = 1;
    syncTranscriptAudioState(audio);
  }, [syncTranscriptAudioState]);

  const handleTranscriptTimeUpdate = useCallback(() => {
    const audio = transcriptAudioRef.current;
    if (!audio) {
      return;
    }
    syncTranscriptAudioState(audio);
    if (!editingTranscriptSegmentId) {
      const activeId = findActiveTranscriptSegmentId(transcriptSegments, audio.currentTime);
      if (activeId) {
        setActiveTranscriptSegmentId(activeId);
      }
    }
  }, [editingTranscriptSegmentId, syncTranscriptAudioState, transcriptSegments]);

  const toggleTranscriptAudio = useCallback(async () => {
    const audio = transcriptAudioRef.current;
    if (!audio || !audioAssetPath) {
      setActionNotice(uiMessage("transcript.notice.audioUnavailable"));
      return;
    }
    if (!audio.paused) {
      audio.pause();
      return;
    }

    audio.playbackRate = 1;
    try {
      await audio.play();
    } catch {
      setActionNotice(uiMessage("transcript.notice.audioPlaybackFailed"));
    }
  }, [audioAssetPath, setActionNotice]);

  const scrubTranscriptAudio = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const audio = transcriptAudioRef.current;
      const nextTime =
        clampAudioTime(event.currentTarget.valueAsNumber, transcriptAudioDuration);
      if (audio) {
        audio.currentTime = nextTime;
      }
      setTranscriptAudioCurrentTime(nextTime);
      if (!editingTranscriptSegmentId) {
        const activeId = findActiveTranscriptSegmentId(transcriptSegments, nextTime);
        if (activeId) {
          setActiveTranscriptSegmentId(activeId);
        }
      }
    },
    [editingTranscriptSegmentId, transcriptAudioDuration, transcriptSegments],
  );

  const beginTranscriptSegmentEdit = useCallback((segmentId: string) => {
    const audio = transcriptAudioRef.current;
    if (audio && !audio.paused) {
      resumeTranscriptAfterSaveRef.current = true;
      audio.pause();
    }
    setEditingTranscriptSegmentId(segmentId);
    setActiveTranscriptSegmentId(segmentId);
  }, []);

  const endTranscriptSegmentEdit = useCallback(() => {
    resumeTranscriptAfterSaveRef.current = false;
    setEditingTranscriptSegmentId(null);
  }, []);

  const completeSuccessfulSave = useCallback(async () => {
    setEditingTranscriptSegmentId(null);
    if (resumeTranscriptAfterSaveRef.current && transcriptAudioRef.current) {
      resumeTranscriptAfterSaveRef.current = false;
      try {
        await transcriptAudioRef.current.play();
      } catch {
        setActionNotice(uiMessage("transcript.notice.savedAutoplayFailed"));
      }
    }
  }, [setActionNotice]);

  const handleTranscriptAudioPlay = useCallback(() => {
    setTranscriptAudioPlaying(true);
  }, []);

  const handleTranscriptAudioPause = useCallback(() => {
    setTranscriptAudioPlaying(false);
  }, []);

  const prepareTranscriptForTaskDeletion = useCallback(
    (expectedTaskId: string) => {
      if (!reviewTaskId || reviewTaskId !== expectedTaskId) {
        return;
      }
      resumeTranscriptAfterSaveRef.current = false;
      const audio = transcriptAudioRef.current;
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
      setTranscriptAudioPlaying(false);
    },
    [reviewTaskId],
  );

  return {
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
    hasTranscriptSegments,
    playTranscriptSegment,
    handleTranscriptAudioMetadata,
    handleTranscriptTimeUpdate,
    handleTranscriptAudioPlay,
    handleTranscriptAudioPause,
    toggleTranscriptAudio,
    scrubTranscriptAudio,
    beginTranscriptSegmentEdit,
    endTranscriptSegmentEdit,
    prepareTranscriptForTaskDeletion,
    completeSuccessfulSave,
  };
}
