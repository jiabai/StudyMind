import type { TranscriptSegment } from "./transcriptDetailClient";

export function findActiveTranscriptSegmentId(
  segments: TranscriptSegment[],
  currentTimeSeconds: number,
): string | null {
  if (segments.length === 0 || !Number.isFinite(currentTimeSeconds)) {
    return null;
  }

  const currentMs = Math.max(0, Math.floor(currentTimeSeconds * 1000));
  const active = segments.find(
    (segment) => currentMs >= segment.start_ms && currentMs < segment.end_ms,
  );
  if (active) {
    return active.id;
  }

  const last = segments[segments.length - 1];
  return currentMs === last.end_ms ? last.id : null;
}

export function updateTranscriptSegmentText(
  segments: TranscriptSegment[],
  segmentId: string,
  text: string,
): TranscriptSegment[] {
  return segments.map((segment) =>
    segment.id === segmentId ? { ...segment, text } : segment,
  );
}

export function transcriptTextFromSegments(segments: TranscriptSegment[]): string {
  return segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

export function isTranscriptSegmentEditDisabled(
  editingSegmentId: string | null,
  segmentId: string,
): boolean {
  return editingSegmentId !== null && editingSegmentId !== segmentId;
}

export function shouldPauseActiveTranscriptSegment(
  activeSegmentId: string | null,
  clickedSegmentId: string,
  audioPlaying: boolean,
): boolean {
  return audioPlaying && activeSegmentId === clickedSegmentId;
}

/**
 * Estimate the playback position for a character offset inside a segment.
 * Word-level timestamps are not available in the transcript contract, so the
 * offset is mapped proportionally across the segment's start/end interval.
 */
export function transcriptTimeFromTextOffset(
  segment: TranscriptSegment,
  textOffset: number,
): number {
  const textLength = segment.text.length;
  const durationMs = Math.max(0, segment.end_ms - segment.start_ms);
  if (textLength === 0 || !Number.isFinite(textOffset)) {
    return Math.max(0, segment.start_ms) / 1000;
  }

  const ratio = Math.max(0, Math.min(1, textOffset / textLength));
  return (Math.max(0, segment.start_ms) + durationMs * ratio) / 1000;
}
