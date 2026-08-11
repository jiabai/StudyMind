import { afterEach, describe, expect, test, vi } from "vitest";
import {
  appendTranscriptNote,
  createTranscriptNote,
  findTranscriptNoteForSegment,
  isTranscriptNoteOrphaned,
  removeTranscriptNote,
  updateTranscriptNote,
  type TranscriptNote,
} from "./transcriptNotesState";

const NOTE: TranscriptNote = {
  id: "note-1",
  transcript_segment_id: "segment-1",
  source_text: "第一段原文",
  content: "",
  created_at: "2026-08-11T10:00:00+00:00",
  updated_at: "2026-08-11T10:00:00+00:00",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("transcript note state", () => {
  test("creates an empty note with a source snapshot", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_234_567_890);
    vi.spyOn(Math, "random").mockReturnValue(0.123456);

    expect(
      createTranscriptNote(
        "segment-1",
        "第一段原文",
        "2026-08-11T10:00:00+00:00",
      ),
    ).toEqual({
      ...NOTE,
      id: "note_1234567890_4fzyo8",
    });
  });

  test("does not append a second note for the same segment", () => {
    expect(appendTranscriptNote([NOTE], NOTE)).toEqual([NOTE]);
    expect(appendTranscriptNote([NOTE], { ...NOTE, id: "note-2" })).toEqual([
      NOTE,
    ]);
  });

  test("finds, updates, removes, and detects orphaned notes", () => {
    expect(findTranscriptNoteForSegment([NOTE], "segment-1")).toEqual(NOTE);
    expect(findTranscriptNoteForSegment([NOTE], "segment-2")).toBeNull();

    const updated = updateTranscriptNote(
      [NOTE],
      "note-1",
      "课堂重点",
      "2026-08-11T10:01:00+00:00",
    );
    expect(updated).toEqual([
      {
        ...NOTE,
        content: "课堂重点",
        updated_at: "2026-08-11T10:01:00+00:00",
      },
    ]);
    expect(NOTE).toEqual({
      ...NOTE,
      content: "",
      updated_at: "2026-08-11T10:00:00+00:00",
    });
    expect(removeTranscriptNote(updated, "note-1")).toEqual([]);
    expect(isTranscriptNoteOrphaned(NOTE, new Set(["segment-2"]))).toBe(true);
    expect(isTranscriptNoteOrphaned(NOTE, new Set(["segment-1"]))).toBe(
      false,
    );
  });
});
