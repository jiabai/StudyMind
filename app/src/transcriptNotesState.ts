export type TranscriptNote = {
  id: string;
  transcript_segment_id: string;
  source_text: string;
  content: string;
  created_at: string;
  updated_at: string;
};

export function createTranscriptNote(
  segmentId: string,
  sourceText: string,
  now: string,
): TranscriptNote {
  return {
    id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    transcript_segment_id: segmentId,
    source_text: sourceText,
    content: "",
    created_at: now,
    updated_at: now,
  };
}

export function appendTranscriptNote(
  notes: TranscriptNote[],
  note: TranscriptNote,
): TranscriptNote[] {
  return notes.some(
    (candidate) =>
      candidate.transcript_segment_id === note.transcript_segment_id,
  )
    ? notes
    : [...notes, note];
}

export function findTranscriptNoteForSegment(
  notes: TranscriptNote[],
  segmentId: string,
): TranscriptNote | null {
  return (
    notes.find((note) => note.transcript_segment_id === segmentId) ?? null
  );
}

export function updateTranscriptNote(
  notes: TranscriptNote[],
  noteId: string,
  content: string,
  now: string,
): TranscriptNote[] {
  return notes.map((note) =>
    note.id === noteId ? { ...note, content, updated_at: now } : note,
  );
}

export function removeTranscriptNote(
  notes: TranscriptNote[],
  noteId: string,
): TranscriptNote[] {
  return notes.filter((note) => note.id !== noteId);
}

export function isTranscriptNoteOrphaned(
  note: TranscriptNote,
  segmentIds: ReadonlySet<string>,
): boolean {
  return !segmentIds.has(note.transcript_segment_id);
}
