import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

import { initializeI18n } from "../../i18n/i18n";
import type { TranscriptNote } from "../../transcriptNotesState";
import type { TranscriptNotesController } from "./useTranscriptNotesController";
import { TranscriptNotesPanel } from "./TranscriptNotesPanel";

const note: TranscriptNote = {
  id: "note-1",
  transcript_segment_id: "segment-1",
  source_text: "原文字块",
  content: "课堂重点",
  created_at: "2026-08-11T10:00:00+00:00",
  updated_at: "2026-08-11T10:00:00+00:00",
};

function controllerFixture(
  overrides: Partial<TranscriptNotesController> = {},
): TranscriptNotesController {
  return {
    activeTaskId: "task-1",
    notes: [],
    notesLoading: false,
    notesLoadError: null,
    notesSaving: false,
    notesSaveError: null,
    editingNoteId: null,
    editingNoteContent: "",
    focusedNoteId: null,
    retryLoadNotes: vi.fn(),
    createNoteForSegment: vi.fn(),
    focusNoteForSegment: vi.fn(),
    beginNoteEdit: vi.fn(),
    updateNoteDraft: vi.fn(),
    cancelNoteEdit: vi.fn(),
    saveNote: vi.fn(),
    deleteNote: vi.fn(),
    clearFocusedNote: vi.fn(),
    ...overrides,
  } as TranscriptNotesController;
}

async function markup(
  controller: TranscriptNotesController,
  editingDisabled = false,
) {
  await initializeI18n("zh-CN");
  return renderToStaticMarkup(
    <TranscriptNotesPanel
      controller={controller}
      transcriptSegments={[
        { id: "segment-1", start_ms: 0, end_ms: 1000, text: "原文字块" },
      ]}
      editingDisabled={editingDisabled}
    />,
  );
}

describe("TranscriptNotesPanel", () => {
  test("renders the empty card with its accessible label and count", async () => {
    const html = await markup(controllerFixture());
    expect(html).toContain('aria-label="我的笔记卡片"');
    expect(html).toContain("我的笔记");
    expect(html).toContain("0 条");
    expect(html).toContain("点击文字稿中的插入笔记图标");
  });

  test("renders source quote, blank content, edit/delete controls, and orphan label", async () => {
    const html = await markup(
      controllerFixture({ notes: [{ ...note, content: "" }, { ...note, id: "orphan", transcript_segment_id: "missing", content: "" }] }),
    );
    expect(html).toContain("原文字块");
    expect(html).toContain("暂未填写笔记");
    expect(html).toContain("编辑笔记");
    expect(html).toContain("删除笔记");
    expect(html).toContain("原文字块已不可用");
  });

  test("renders inline editor with save and cancel while editing", async () => {
    const html = await markup(
      controllerFixture({
        notes: [note],
        editingNoteId: note.id,
        editingNoteContent: "草稿",
      }),
    );
    expect(html).toContain("textarea");
    expect(html).toContain("草稿");
    expect(html).toContain("保存");
    expect(html).toContain("取消");
  });

  test("renders loading and error states with retry and disables mutations", async () => {
    const loading = await markup(
      controllerFixture({ notes: [note], notesLoading: true }),
      true,
    );
    expect(loading).toContain("正在读取笔记");

    const error = await markup(
      controllerFixture({
        notesLoadError: { messageCode: "transcript.notes.loadError" },
      }),
      true,
    );
    expect(error).toContain("笔记读取失败");
    expect(error).toContain("重试");
  });
});
