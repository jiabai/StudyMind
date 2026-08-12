# 文字稿笔记与工作区布局实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为有分段数据的 Transcript 增加按文字块关联的 Task 笔记，并将【我的笔记】放在【文字稿校对】右侧、【学习整理】放在其下方。

**Architecture:** 新增独立的 TranscriptNote 前端状态、IPC 客户端、Tauri Task 存储和面板组件，与 AI 结果生成和展示流程解耦。App 负责组合三张工作区卡片；TranscriptReviewPanel 只展示文字块笔记入口；笔记以版本化 JSON 按 Task 保存，文字稿 Artifact 和 Worker 不变。

**Tech Stack:** React 19、TypeScript、react-i18next、lucide-react、Tauri 2、Rust/serde、Vitest、Cargo test。

---

## 文件变更地图

### 新建

- `app/src/transcriptNotesState.ts`：TranscriptNote 类型、唯一关联、更新、删除和孤儿判断的纯函数。
- `app/src/transcriptNotesState.test.ts`：笔记状态纯函数测试。
- `app/src/transcriptNotesClient.ts`：加载/保存笔记的 Tauri IPC 客户端和响应解析。
- `app/src/transcriptNotesClient.test.ts`：IPC 请求形状和不合法响应测试。
- `app/src/features/transcript/useTranscriptNotesController.ts`：Task 生命周期、编辑草稿、保存失败和焦点定位。
- `app/src/features/transcript/useTranscriptNotesController.test.ts`：控制器行为测试。
- `app/src/features/transcript/TranscriptNotesPanel.tsx`：【我的笔记】卡片、空状态、列表和内联编辑。
- `app/src/features/transcript/TranscriptNotesPanel.test.tsx`：面板结构、文案、状态和按钮可访问性测试。
- `app/src-tauri/src/transcript_notes_storage.rs`：Task 笔记 JSON 存储、版本校验、原子写入和 Tauri commands。

### 修改

- `app/src/App.tsx`：挂载笔记控制器、组合左列工作区、显示右侧笔记卡片。
- `app/src/features/transcript/LocalTranscriptWorkspace.tsx`：接收并传递笔记控制器。
- `app/src/features/transcript/TranscriptReviewPanel.tsx`：在每个文字块操作区增加笔记图标。
- `app/src/features/results/TaskWorkspaces.test.tsx`：覆盖文字稿、我的笔记和学习整理的组合渲染。
- `app/src/i18n/transcriptResources.ts`：补齐 zh-CN、zh-TW、en-US 的笔记文案。
- `app/src/App.css`：三卡片布局、笔记卡片、记录、内联编辑和图标状态样式。
- `app/src/App.css.test.ts`：布局、图标状态、滚动和可访问性 CSS 约束。
- `app/src-tauri/src/lib.rs`：注册 `transcript_notes_storage` 模块和两个 IPC commands。

实现时只触碰以上文件；仓库中已有的 `docs/transcript-dissection-explainer.html` 和 `docs/transcript-dissection-learning-scenarios.html` 不属于本功能，必须保持未修改。

## Task 1: 建立前端 TranscriptNote 领域类型与 IPC 客户端

**Files:**
- Create: `app/src/transcriptNotesState.ts`
- Create: `app/src/transcriptNotesState.test.ts`
- Create: `app/src/transcriptNotesClient.ts`
- Create: `app/src/transcriptNotesClient.test.ts`

- [ ] **Step 1: Write failing pure-state tests for one-to-one associations**

在 `app/src/transcriptNotesState.test.ts` 写入以下测试骨架，覆盖空正文、重复创建、更新、删除和孤儿判断：

```ts
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

describe("transcript note state", () => {
  test("creates an empty note with a source snapshot", () => {
    expect(createTranscriptNote("segment-1", "第一段原文", "2026-08-11T10:00:00+00:00")).toEqual(NOTE);
  });

  test("does not append a second note for the same segment", () => {
    expect(appendTranscriptNote([NOTE], NOTE)).toEqual([NOTE]);
  });

  test("finds, updates, removes, and detects orphaned notes", () => {
    expect(findTranscriptNoteForSegment([NOTE], "segment-1")).toEqual(NOTE);
    expect(updateTranscriptNote([NOTE], "note-1", "课堂重点", "2026-08-11T10:01:00+00:00")[0]?.content).toBe("课堂重点");
    expect(removeTranscriptNote([NOTE], "note-1")).toEqual([]);
    expect(isTranscriptNoteOrphaned(NOTE, new Set(["segment-2"]))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the pure-state test to verify it fails**

Run: `npm --prefix app test -- src/transcriptNotesState.test.ts`

Expected: FAIL because `transcriptNotesState.ts` and its exported functions do not exist yet.

- [ ] **Step 3: Implement the pure-state module**

在 `app/src/transcriptNotesState.ts` 实现稳定的数据结构和不可变操作：

```ts
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
  return notes.some((candidate) => candidate.transcript_segment_id === note.transcript_segment_id)
    ? notes
    : [...notes, note];
}

export function findTranscriptNoteForSegment(
  notes: TranscriptNote[],
  segmentId: string,
): TranscriptNote | null {
  return notes.find((note) => note.transcript_segment_id === segmentId) ?? null;
}

export function updateTranscriptNote(
  notes: TranscriptNote[],
  noteId: string,
  content: string,
  now: string,
): TranscriptNote[] {
  return notes.map((note) => note.id === noteId ? { ...note, content, updated_at: now } : note);
}

export function removeTranscriptNote(notes: TranscriptNote[], noteId: string): TranscriptNote[] {
  return notes.filter((note) => note.id !== noteId);
}

export function isTranscriptNoteOrphaned(
  note: TranscriptNote,
  segmentIds: ReadonlySet<string>,
): boolean {
  return !segmentIds.has(note.transcript_segment_id);
}
```

保持 ID 生成、时间戳生成和状态变更集中在此模块，避免组件各自实现唯一性规则。

- [ ] **Step 4: Run the pure-state tests to verify they pass**

Run: `npm --prefix app test -- src/transcriptNotesState.test.ts`

Expected: PASS with all one-to-one, empty-content, update, remove, and orphan assertions passing.

- [ ] **Step 5: Write failing IPC client tests**

在 `app/src/transcriptNotesClient.test.ts` 覆盖命令参数、正常解析和不合法响应：

```ts
import { IpcProtocolError } from "./tauriIpcProtocol";
import { loadTranscriptNotes, saveTranscriptNotes } from "./transcriptNotesClient";

const note = {
  id: "note-1",
  transcript_segment_id: "segment-1",
  source_text: "原文",
  content: "",
  created_at: "2026-08-11T10:00:00+00:00",
  updated_at: "2026-08-11T10:00:00+00:00",
};

test("loads and saves transcript notes with task identity", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const runner = async (command: string, args: unknown) => {
    calls.push({ command, args });
    return { task_id: "task-1", notes: [note] };
  };

  await expect(loadTranscriptNotes("task-1", runner)).resolves.toEqual({ task_id: "task-1", notes: [note] });
  await expect(saveTranscriptNotes("task-1", [note], runner)).resolves.toEqual({ task_id: "task-1", notes: [note] });
  expect(calls).toEqual([
    { command: "load_transcript_notes", args: { request: { task_id: "task-1" } } },
    { command: "save_transcript_notes", args: { request: { task_id: "task-1", notes: [note] } } },
  ]);
});

test("rejects a response for another task", async () => {
  await expect(loadTranscriptNotes("task-1", async () => ({ task_id: "task-2", notes: [] })))
    .rejects.toEqual(new IpcProtocolError("TRANSCRIPT_NOTES_IPC_RESPONSE_INVALID"));
});
```

- [ ] **Step 6: Run the IPC client tests to verify they fail**

Run: `npm --prefix app test -- src/transcriptNotesClient.test.ts`

Expected: FAIL because the client and response parser are not implemented.

- [ ] **Step 7: Implement the IPC client and strict response parser**

在 `app/src/transcriptNotesClient.ts` 遵循 `transcriptDetailClient.ts` 的 runner 约定：

```ts
import { invoke } from "@tauri-apps/api/core";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { IpcProtocolError, readIpcDataArray, readIpcDataObject } from "./tauriIpcProtocol";
import type { TranscriptNote } from "./transcriptNotesState";

export type TranscriptNotesResponse = { task_id: string; notes: TranscriptNote[] };
export type TranscriptNotesCommandRunner = (command: string, args: InvokeArgs) => Promise<unknown>;
const defaultRunner: TranscriptNotesCommandRunner = (command, args) => invoke(command, args);
const INVALID = "TRANSCRIPT_NOTES_IPC_RESPONSE_INVALID" as const;

export function loadTranscriptNotes(taskId: string, runner = defaultRunner): Promise<TranscriptNotesResponse> {
  return parseResponse(runner("load_transcript_notes", { request: { task_id: taskId } }), taskId);
}

export function saveTranscriptNotes(taskId: string, notes: TranscriptNote[], runner = defaultRunner): Promise<TranscriptNotesResponse> {
  return parseResponse(runner("save_transcript_notes", { request: { task_id: taskId, notes } }), taskId);
}

async function parseResponse(valuePromise: Promise<unknown>, expectedTaskId: string): Promise<TranscriptNotesResponse> {
  const response = readIpcDataObject(await valuePromise, ["task_id", "notes"], [], INVALID);
  if (response.task_id !== expectedTaskId) throw new IpcProtocolError(INVALID);
  const notes = readIpcDataArray(response.notes, INVALID).map(parseNote);
  return { task_id: expectedTaskId, notes };
}

function parseNote(value: unknown): TranscriptNote {
  const note = readIpcDataObject(value, ["id", "transcript_segment_id", "source_text", "content", "created_at", "updated_at"], [], INVALID);
  if (Object.values(note).some((field) => typeof field !== "string")) throw new IpcProtocolError(INVALID);
  return note as unknown as TranscriptNote;
}
```

The production implementation must keep the parser explicit enough to reject missing keys and non-string values; do not return an unchecked `unknown as TranscriptNote` without validating every required field.

- [ ] **Step 8: Run both frontend contract test files**

Run: `npm --prefix app test -- src/transcriptNotesState.test.ts src/transcriptNotesClient.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit the frontend domain and client seam**

```bash
git add app/src/transcriptNotesState.ts app/src/transcriptNotesState.test.ts app/src/transcriptNotesClient.ts app/src/transcriptNotesClient.test.ts
git commit -m "feat: add transcript note domain and IPC client"
```

## Task 2: Add versioned Tauri Task storage and IPC commands

**Files:**
- Create: `app/src-tauri/src/transcript_notes_storage.rs`
- Modify: `app/src-tauri/src/lib.rs`

- [ ] **Step 1: Add failing Rust storage tests**

在新模块的 `#[cfg(test)] mod tests` 中先加入以下行为测试：

```rust
#[test]
fn load_missing_notes_returns_empty() {
    let output_root = temp_dir("load_missing_notes");
    create_supported_task(&output_root, "task-1");
    let result = load_transcript_notes_from_output_root(
        &output_root,
        LoadTranscriptNotesRequest { task_id: "task-1".to_string() },
    ).expect("load notes");
    assert!(result.notes.is_empty());
}

#[test]
fn save_and_load_notes_roundtrip_preserves_empty_content_and_source_snapshot() {
    let output_root = temp_dir("save_load_notes");
    create_supported_task(&output_root, "task-1");
    let notes = vec![TranscriptNote {
        id: "note-1".to_string(),
        transcript_segment_id: "segment-1".to_string(),
        source_text: "原文字块".to_string(),
        content: String::new(),
        created_at: "2026-08-11T10:00:00+00:00".to_string(),
        updated_at: "2026-08-11T10:00:00+00:00".to_string(),
    }];
    save_transcript_notes_to_output_root(
        &output_root,
        SaveTranscriptNotesRequest { task_id: "task-1".to_string(), notes: notes.clone() },
    ).expect("save notes");
    let loaded = load_transcript_notes_from_output_root(
        &output_root,
        LoadTranscriptNotesRequest { task_id: "task-1".to_string() },
    ).expect("load notes");
    assert_eq!(loaded.notes, notes);
}

#[test]
fn empty_content_and_schema_mismatch_are_rejected() {
    let output_root = temp_dir("invalid_notes");
    create_supported_task(&output_root, "task-1");
    let path = notes_path(&output_root, "task-1");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "").unwrap();
    assert!(load_transcript_notes_from_output_root(&output_root, LoadTranscriptNotesRequest { task_id: "task-1".into() }).is_err());
    fs::write(&path, r#"{"schema_version":99,"notes":[]}"#).unwrap();
    assert!(load_transcript_notes_from_output_root(&output_root, LoadTranscriptNotesRequest { task_id: "task-1".into() }).is_err());
}
```

`create_supported_task` and `notes_path` should be small test-only helpers that create the same minimal `StudyMind-task.json` shape used by the storage module tests.

- [ ] **Step 2: Run the focused Rust tests to verify they fail**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml transcript_notes_storage`

Expected: FAIL because the storage module and its structs/functions do not exist.

- [ ] **Step 3: Implement the storage schema and path**

在 `app/src-tauri/src/transcript_notes_storage.rs` 实现：

```rust
use crate::{atomic_files::atomic_write, ensure_runtime_dirs, resolve_runtime_paths, task_manifest};
use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}};
use tauri::AppHandle;

const TRANSCRIPT_NOTES_FILE_NAME: &str = "notes.json";
const TRANSCRIPT_NOTES_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct TranscriptNote {
    pub(crate) id: String,
    pub(crate) transcript_segment_id: String,
    pub(crate) source_text: String,
    pub(crate) content: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
struct TranscriptNotesPayload {
    schema_version: u32,
    notes: Vec<TranscriptNote>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct LoadTranscriptNotesRequest {
    #[serde(alias = "taskId")]
    task_id: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SaveTranscriptNotesRequest {
    #[serde(alias = "taskId")]
    task_id: String,
    notes: Vec<TranscriptNote>,
}
```

Store the sidecar at `task.task_dir().join("transcript").join("notes.json")`. This keeps note data with the Task and outside the transcript text/segments Artifact fields.

- [ ] **Step 4: Implement load/save helpers with exact error rules**

Implement `load_transcript_notes_from_output_root` and `save_transcript_notes_to_output_root` with these rules:

```rust
pub(crate) fn load_transcript_notes_from_output_root(
    output_root: &Path,
    request: LoadTranscriptNotesRequest,
) -> Result<LoadTranscriptNotesResult, String>;

pub(crate) fn save_transcript_notes_to_output_root(
    output_root: &Path,
    request: SaveTranscriptNotesRequest,
) -> Result<SaveTranscriptNotesResult, String>;
```

- Open the Task through `task_manifest::SupportedTask::open` so an unknown Task ID is rejected.
- A missing file returns an empty list.
- An existing empty file, malformed JSON, or schema version other than `1` returns a stable error string.
- Save serializes `{ "schema_version": 1, "notes": [...] }` with a trailing newline and calls `atomic_write`.
- Return the request Task ID and the saved notes after a successful write.
- Do not silently drop malformed records; serde parsing failure must surface as an error.

- [ ] **Step 5: Expose the Tauri commands and register them**

Add command wrappers:

```rust
#[tauri::command]
pub(crate) fn load_transcript_notes(
    app: AppHandle,
    request: LoadTranscriptNotesRequest,
) -> Result<LoadTranscriptNotesResult, String> {
    let paths = resolve_runtime_paths(&app)?;
    ensure_runtime_dirs(&paths)?;
    let output_root = task_manifest::configured_output_root(&paths)?;
    load_transcript_notes_from_output_root(&output_root, request)
}

#[tauri::command]
pub(crate) fn save_transcript_notes(
    app: AppHandle,
    request: SaveTranscriptNotesRequest,
) -> Result<SaveTranscriptNotesResult, String> {
    let paths = resolve_runtime_paths(&app)?;
    ensure_runtime_dirs(&paths)?;
    let output_root = task_manifest::configured_output_root(&paths)?;
    save_transcript_notes_to_output_root(&output_root, request)
}
```

In `app/src-tauri/src/lib.rs`, add `mod transcript_notes_storage;` beside `mod transcript_detail;` and register both commands beside the existing transcript commands:

```rust
transcript_notes_storage::load_transcript_notes,
transcript_notes_storage::save_transcript_notes,
```

- [ ] **Step 6: Run Rust format and focused tests**

Run: `cargo fmt --manifest-path app/src-tauri/Cargo.toml -- --check`
Run: `cargo test --manifest-path app/src-tauri/Cargo.toml transcript_notes_storage`

Expected: formatting check and all focused storage tests PASS.

- [ ] **Step 7: Commit the storage seam**

```bash
git add app/src-tauri/src/transcript_notes_storage.rs app/src-tauri/src/lib.rs
git commit -m "feat: persist transcript notes per task"
```

## Task 3: Add localized copy for the notes surface

**Files:**
- Modify: `app/src/i18n/transcriptResources.ts`
- Test: `app/src/i18n/resources.test.ts`

- [ ] **Step 1: Add the complete notes key set to zh-CN**

Add a `notes` object to the zh-CN transcript resources with these keys and meanings:

```ts
notes: {
  ariaLabel: "我的笔记卡片",
  title: "我的笔记",
  count: "{{count}} 条",
  empty: "点击文字稿中的插入笔记图标，开始记录课堂内容。",
  loading: "正在读取笔记…",
  loadError: "笔记读取失败，请重试。",
  retry: "重试",
  insert: "插入笔记",
  inserted: "已插入笔记",
  edit: "编辑笔记",
  delete: "删除笔记",
  blank: "暂未填写笔记",
  orphaned: "原文字块已不可用",
  save: "保存",
  cancel: "取消",
  saving: "保存中",
  saveFailed: "笔记保存失败，请重试。",
  deleteFailed: "笔记删除失败，请重试。",
  contentPlaceholder: "写下你的笔记…",
},
```

- [ ] **Step 2: Add equivalent zh-TW and en-US translations**

Keep the same key names and semantic distinctions in both remaining locales. Do not add fallback-only keys; every locale must contain the full `notes` object so `resources.test.ts` can validate parity.

- [ ] **Step 3: Add a resource parity assertion**

In `app/src/i18n/resources.test.ts`, assert that the transcript resource tree contains the same `notes` keys in all supported locales, including `ariaLabel`, `insert`, `inserted`, `edit`, `delete`, `save`, `cancel`, `orphaned`, and `contentPlaceholder`.

- [ ] **Step 4: Run i18n tests**

Run: `npm --prefix app test -- src/i18n/resources.test.ts`

Expected: PASS for all three locales.

- [ ] **Step 5: Commit the localized copy**

```bash
git add app/src/i18n/transcriptResources.ts app/src/i18n/resources.test.ts
git commit -m "feat: add transcript note copy"
```

## Task 4: Implement the Task-scoped notes controller

**Files:**
- Create: `app/src/features/transcript/useTranscriptNotesController.ts`
- Create: `app/src/features/transcript/useTranscriptNotesController.test.ts`

- [ ] **Step 1: Write failing controller tests for load and Task switching**

Mock `loadTranscriptNotes` and `saveTranscriptNotes` at the module boundary. Cover these observable behaviors:

```ts
test("loads notes for the active task and resets notes when the task changes", async () => {
  const taskA = noteResponse("task-a", [note("note-a", "segment-a", "A")]);
  const taskB = noteResponse("task-b", []);
  mocks.loadTranscriptNotes.mockResolvedValueOnce(taskA).mockResolvedValueOnce(taskB);
  const { render, setWorkflow } = await createController("task-a");

  await vi.waitFor(() => expect(render().notes).toEqual(taskA.notes));
  setWorkflow(readyWorkflow("task-b"));
  await vi.waitFor(() => expect(render().notes).toEqual([]));
  expect(mocks.loadTranscriptNotes).toHaveBeenLastCalledWith("task-b");
});

test("ignores a late save from the previous task", async () => {
  const lateSave = deferred<TranscriptNotesResponse>();
  mocks.saveTranscriptNotes.mockReturnValueOnce(lateSave.promise);
  const { render, setWorkflow } = await createController("task-a");
  render().createNoteForSegment("segment-a", "原文 A");
  setWorkflow(readyWorkflow("task-b"));
  lateSave.resolve(noteResponse("task-a", [note("note-a", "segment-a", "")]))
  await vi.waitFor(() => expect(render().activeTaskId).toBe("task-b"));
  expect(render().notes).toEqual([]);
});
```

- [ ] **Step 2: Write failing controller tests for creation, duplicate prevention, edit, cancel and delete**

Assert that creation appends an empty record and calls save immediately; creating the same segment twice leaves one record; edit updates only after save; cancel restores the original content; delete removes the record and calls save.

- [ ] **Step 3: Write failing controller tests for load/save failures**

Assert that a load rejection exposes `notesLoadError` and `retryLoadNotes`; a save rejection keeps the note/draft in memory, exposes `notesSaveError`, and does not mark the operation successful.

- [ ] **Step 4: Run the controller tests to verify they fail**

Run: `npm --prefix app test -- src/features/transcript/useTranscriptNotesController.test.ts`

Expected: FAIL because the controller and its state shape do not exist.

- [ ] **Step 5: Implement the controller state and Task lifecycle**

Use this public shape so the panel and TranscriptReviewPanel share one stable seam:

```ts
type UseTranscriptNotesControllerOptions = {
  workflow: WorkflowState;
  setActionNotice: Dispatch<SetStateAction<UiMessage | null>>;
};

export type TranscriptNotesController = ReturnType<typeof useTranscriptNotesController>;

return {
  activeTaskId: workflow.taskId,
  notes,
  notesLoading,
  notesLoadError,
  notesSaving,
  notesSaveError,
  editingNoteId,
  editingNoteContent,
  focusedNoteId,
  retryLoadNotes,
  createNoteForSegment,
  focusNoteForSegment,
  beginNoteEdit,
  updateNoteDraft,
  cancelNoteEdit,
  saveNote,
  deleteNote,
  clearFocusedNote,
};
```

The load effect must clear old notes on Task change, reset edit/focus state, and ignore late responses by comparing the response Task ID to a `currentTaskIdRef`, matching the existing transcript controller pattern.

- [ ] **Step 6: Implement create/edit/delete persistence rules**

- `createNoteForSegment(segmentId, sourceText)` finds an existing note first; if one exists, it calls `focusNoteForSegment` and returns without saving a duplicate.
- New notes use `createTranscriptNote`, append locally, then call `saveTranscriptNotes` immediately.
- `beginNoteEdit` copies the current `content` into one controller draft.
- `saveNote` updates `updated_at`, persists the complete list, and exits edit mode only after a successful response.
- `cancelNoteEdit` drops the draft and leaves the saved note unchanged.
- `deleteNote` persists the list without the selected note; on failure it restores the in-memory list and keeps the note visible.
- A failed save keeps local data and exposes a retryable error instead of clearing the record.

- [ ] **Step 7: Run the controller tests to verify they pass**

Run: `npm --prefix app test -- src/features/transcript/useTranscriptNotesController.test.ts`

Expected: PASS for Task isolation, late response protection, one-to-one creation, edit/cancel/delete, and save failure behavior.

- [ ] **Step 8: Commit the controller seam**

```bash
git add app/src/features/transcript/useTranscriptNotesController.ts app/src/features/transcript/useTranscriptNotesController.test.ts
git commit -m "feat: manage task scoped transcript notes"
```

## Task 5: Build the 【我的笔记】 card with inline editing

**Files:**
- Create: `app/src/features/transcript/TranscriptNotesPanel.tsx`
- Create: `app/src/features/transcript/TranscriptNotesPanel.test.tsx`

- [ ] **Step 1: Write failing static-markup tests for the empty and populated card**

Use `renderToStaticMarkup` and `initializeI18n("zh-CN")`, matching the project’s existing workspace tests. Verify the card has `aria-label="我的笔记卡片"`, the count, empty state, source quote, blank placeholder, edit/delete buttons, and the orphaned label.

- [ ] **Step 2: Write failing static-markup tests for inline edit and loading/error states**

Render a controller fixture with `editingNoteId` set and assert the record contains a textarea, `保存`, and `取消`; render `notesLoading` and `notesLoadError` fixtures and assert loading/error/retry copy plus disabled mutation controls.

- [ ] **Step 3: Run the panel tests to verify they fail**

Run: `npm --prefix app test -- src/features/transcript/TranscriptNotesPanel.test.tsx`

Expected: FAIL because the panel component does not exist.

- [ ] **Step 4: Implement the panel structure**

Use this component boundary:

```tsx
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
  const segmentById = new Map(transcriptSegments.map((segment) => [segment.id, segment]));

  return (
    <section className="task-domain-workspace transcript-notes-workspace" aria-label={t("notes.ariaLabel")}>
      <header className="domain-workspace-header">
        <h2>{t("notes.title")}</h2>
        <span className="transcript-notes-count">{t("notes.count", { count: controller.notes.length })}</span>
      </header>
      <div className="transcript-notes-scroll">
        {/* loading, error, empty and records are rendered here */}
      </div>
    </section>
  );
}
```

Render records in persisted array order. Each record shows `source_text`, current content or `notes.blank`, and an orphan label when its segment ID is not in `segmentIds`.

- [ ] **Step 5: Implement inline edit, focus and button behavior**

- Keep one `ref` per note record and scroll the `focusedNoteId` record into view in an effect.
- Clicking an existing segment’s note icon calls `focusNoteForSegment`; the card scrolls and applies a temporary focus class.
- The edit button calls `beginNoteEdit`; the textarea uses `editingNoteContent`; save calls `saveNote`; cancel calls `cancelNoteEdit`.
- Delete calls `deleteNote` and is disabled when `editingDisabled || controller.notesSaving`.
- All buttons use translated `aria-label`/`title` values and explicit `type="button"`.
- Preserve an empty `content` record; never filter it out of the list.

- [ ] **Step 6: Run the panel tests to verify they pass**

Run: `npm --prefix app test -- src/features/transcript/TranscriptNotesPanel.test.tsx`

Expected: PASS for empty, populated, editing, loading, error, orphan, disabled, and accessible states.

- [ ] **Step 7: Commit the panel**

```bash
git add app/src/features/transcript/TranscriptNotesPanel.tsx app/src/features/transcript/TranscriptNotesPanel.test.tsx
git commit -m "feat: add transcript notes card"
```

## Task 6: Add the per-segment note icon and wire the local transcript workspace

**Files:**
- Modify: `app/src/features/transcript/TranscriptReviewPanel.tsx`
- Modify: `app/src/features/transcript/LocalTranscriptWorkspace.tsx`
- Modify: `app/src/features/results/TaskWorkspaces.test.tsx`

- [ ] **Step 1: Add the notes controller prop to LocalTranscriptWorkspace**

Extend `LocalTranscriptWorkspaceProps` with:

```ts
import type { TranscriptNotesController } from "./useTranscriptNotesController";

type LocalTranscriptWorkspaceProps = {
  // existing props
  notesController: TranscriptNotesController;
};
```

Pass `notesController` and `editingDisabled={!model.canEdit}` into `TranscriptReviewPanel`.

- [ ] **Step 2: Add note props to TranscriptReviewPanel**

Extend the panel props with the controller type and use `controller.transcriptSegments` as the source of visible segments. The note action must receive the current segment’s `id` and `text` snapshot.

- [ ] **Step 3: Write the failing segment-icon assertions**

In `TaskWorkspaces.test.tsx`, render a ready local workspace with two segments and a fixture controller containing one note for `segment-1`. Assert:

```ts
expect(markup.match(/class="[^"]*transcript-segment-note/g)).toHaveLength(2);
expect(markup).toContain('aria-label="已插入笔记"');
expect(markup).toContain('aria-label="插入笔记"');
expect(markup).toMatch(/transcript-segment-note inserted/);
```

Also assert that when `editingDisabled` is true, both note buttons are disabled.

- [ ] **Step 4: Run the workspace test to verify it fails**

Run: `npm --prefix app test -- src/features/results/TaskWorkspaces.test.tsx`

Expected: FAIL because the new prop and icon are not rendered.

- [ ] **Step 5: Implement the note icon next to the edit button**

Import `StickyNote` from `lucide-react` and add this button after the existing edit button in `.transcript-segment-header`:

```tsx
const segmentNote = findTranscriptNoteForSegment(notesController.notes, segment.id);
const hasNote = segmentNote !== null;

<button
  type="button"
  className={`secondary-button compact-button transcript-segment-note${hasNote ? " inserted" : ""}`}
  onClick={() => {
    if (segmentNote) {
      notesController.focusNoteForSegment(segment.id);
    } else {
      notesController.createNoteForSegment(segment.id, segment.text);
    }
  }}
  disabled={editingDisabled || Boolean(editingTranscriptSegmentId)}
  aria-label={t(hasNote ? "notes.inserted" : "notes.insert")}
  title={t(hasNote ? "notes.inserted" : "notes.insert")}
  aria-pressed={hasNote}
>
  <StickyNote size={16} aria-hidden="true" />
</button>
```

Use `findTranscriptNoteForSegment` rather than checking `content`, so an empty note is still treated as inserted.

- [ ] **Step 6: Run the workspace tests to verify they pass**

Run: `npm --prefix app test -- src/features/results/TaskWorkspaces.test.tsx`

Expected: PASS with exactly one inserted and one uninserted visual state, plus the existing workspace assertions unchanged.

- [ ] **Step 7: Commit the transcript entry point**

```bash
git add app/src/features/transcript/TranscriptReviewPanel.tsx app/src/features/transcript/LocalTranscriptWorkspace.tsx app/src/features/results/TaskWorkspaces.test.tsx
git commit -m "feat: add note actions to transcript segments"
```

## Task 7: Recompose App layout with notes on the right and learning below

**Files:**
- Modify: `app/src/App.tsx`
- Modify: `app/src/features/results/TaskWorkspaces.test.tsx`

- [ ] **Step 1: Mount the notes controller in App**

Import and call the hook beside the other task-scoped controllers:

```tsx
import { useTranscriptNotesController } from "./features/transcript/useTranscriptNotesController";
import { TranscriptNotesPanel } from "./features/transcript/TranscriptNotesPanel";

const transcriptNotesController = useTranscriptNotesController({
  workflow,
  setActionNotice,
});
```

The notes controller owns its own save lifecycle.

- [ ] **Step 2: Wrap the local and AI workspaces into a primary column**

Replace the current direct siblings with this structure:

```tsx
<div className={`task-workspace-layout${taskWorkspaceModel.local.canReview ? "" : " transcript-only"}`}>
  <div className="task-workspace-primary-column">
    <LocalTranscriptWorkspace
      model={taskWorkspaceModel.local}
      controller={transcriptDetailController}
      notesController={transcriptNotesController}
      actionNotice={aiActionNotice ? null : actionNotice}
      onLocateArtifact={(artifact) => void locateArtifact(artifact)}
      onCancel={() => void cancelCurrentProcessing()}
    />
    {taskWorkspaceModel.ai.visible ? (
      <AiGenerationWorkspace
        model={taskWorkspaceModel.ai}
        quotaRemaining={account.llmQuotaRemaining}
        notice={aiActionNotice}
        onSummaryAction={openSummaryConfirmation}
        onInsightsAction={() => void openInsightPreferenceFlow()}
        onDissectionAction={dissectionController.openConfirmation}
        onViewTarget={(target) => {
          setActionNotice(null);
          openDetailTab(target);
        }}
        onCancel={() => void cancelCurrentProcessing()}
      />
    ) : null}
  </div>
  {taskWorkspaceModel.local.canReview ? (
    <TranscriptNotesPanel
      controller={transcriptNotesController}
      transcriptSegments={transcriptDetailController.transcriptSegments}
      editingDisabled={!taskWorkspaceModel.local.canEdit}
    />
  ) : null}
</div>
```

Keep the transcript notes panel in the workspace layout without coupling it to AI result rendering.

- [ ] **Step 3: Add a layout assertion without changing existing workspace semantics**

Extend the workspace markup test or add a focused structural test that reads `App.tsx` as the existing CSS tests do. Assert the presence and order of `task-workspace-primary-column`, `TranscriptNotesPanel`, and `notesController`, and assert that the removed AI-result annotation surface is not mounted.

- [ ] **Step 4: Run the workspace tests**

Run: `npm --prefix app test -- src/features/results/TaskWorkspaces.test.tsx`

Expected: PASS; existing `学习整理` target-card assertions remain valid because its component behavior is unchanged.

- [ ] **Step 5: Commit the App composition**

```bash
git add app/src/App.tsx app/src/features/results/TaskWorkspaces.test.tsx
git commit -m "feat: compose transcript notes workspace layout"
```

## Task 8: Add CSS for the two-column card layout and note states

**Files:**
- Modify: `app/src/App.css`
- Modify: `app/src/App.css.test.ts`

- [ ] **Step 1: Write failing CSS contract assertions**

Add tests in `app/src/App.css.test.ts` that extract rule bodies and assert:

```ts
const primaryColumnRule = getRuleBody([".task-workspace-primary-column"]);
const notesWorkspaceRule = getRuleBody([".transcript-notes-workspace"]);
const notesScrollRule = getRuleBody([".transcript-notes-scroll"]);
const noteButtonRule = getRuleBody([".transcript-segment-note"]);
const insertedButtonRule = getRuleBody([".transcript-segment-note.inserted"]);

expect(primaryColumnRule).toContain("display: grid;");
expect(primaryColumnRule).toContain("gap: var(--space-4);");
expect(notesWorkspaceRule).toContain("height: min(760px, calc(100vh - 188px));");
expect(notesScrollRule).toContain("overflow-y: auto;");
expect(noteButtonRule).toContain("width: 32px;");
expect(insertedButtonRule).toContain("color: var(--primary);");
expect(appCss).toMatch(/@media \(max-width: 1099px\)[\s\S]*?\.task-workspace-layout\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
```

- [ ] **Step 2: Run the CSS test to verify it fails**

Run: `npm --prefix app test -- src/App.css.test.ts`

Expected: FAIL because the new rules do not exist.

- [ ] **Step 3: Implement the primary column and notes card rules**

Add CSS after `.task-workspace-layout` and the existing workspace rules:

```css
.task-workspace-primary-column {
  display: grid;
  gap: var(--space-4);
  min-width: 0;
}

.transcript-notes-workspace {
  height: min(760px, calc(100vh - 188px));
  min-height: 520px;
}

.transcript-notes-scroll {
  flex: 1 1 auto;
  min-height: 180px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 2px 4px 2px 2px;
}

.transcript-notes-count {
  color: var(--text-muted);
  font-size: 0.8rem;
  white-space: nowrap;
}
```

Keep `.local-transcript-workspace` at the existing fixed review height so the notes card and transcript card align; the primary column grows downward when the AI workspace renders below it.

- [ ] **Step 4: Implement note record and inline editor styles**

Add styles for `.transcript-note-list`, `.transcript-note-record`, `.transcript-note-record.focused`, `.transcript-note-source`, `.transcript-note-content`, `.transcript-note-placeholder`, `.transcript-note-orphaned`, `.transcript-note-actions`, `.transcript-note-editor`, and `.transcript-note-editor-actions`.

Required behavior:

- Record uses a left border in the existing green primary family.
- Source quote is muted, wraps long text, and is never horizontally clipped.
- Content and placeholder are visually distinct.
- Editor textarea fills the record width and can resize vertically.
- Focused record has a non-color-only outline or box-shadow.
- Delete uses the existing danger treatment.

- [ ] **Step 5: Implement uninserted/inserted icon styles and responsive layout**

Add:

```css
.transcript-segment-note {
  color: var(--text-muted);
}

.transcript-segment-note.inserted {
  background: #edf7f0;
  border-color: rgba(77, 122, 94, 0.28);
  color: var(--primary);
}

.transcript-segment-note:not(:disabled):hover,
.transcript-segment-note:focus-visible {
  background: #edf0e2;
  border-color: #c8d6bc;
}

@media (max-width: 1099px) {
  .task-workspace-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .transcript-notes-workspace {
    height: 680px;
    max-height: none;
  }
}
```

The existing `.task-workspace-layout.transcript-only` one-column behavior remains for processing states without a notes card.

- [ ] **Step 6: Run CSS tests to verify they pass**

Run: `npm --prefix app test -- src/App.css.test.ts`

Expected: PASS for two-column layout, inner scroll, icon states, focus feedback, and responsive stacking.

- [ ] **Step 7: Commit the styles**

```bash
git add app/src/App.css app/src/App.css.test.ts
git commit -m "feat: style transcript notes workspace"
```

## Task 9: Run focused verification and final integration checks

**Files:**
- Modify only files from Tasks 1–8 if a verification failure requires a targeted correction.

- [ ] **Step 1: Run all frontend tests**

Run: `npm --prefix app test`

Expected: PASS with no snapshot or existing workspace regression failures.

- [ ] **Step 2: Run the TypeScript build**

Run: `npm --prefix app run build`

Expected: PASS with no missing translation keys, prop mismatches, or strict TypeScript errors.

- [ ] **Step 3: Run the Rust formatter and all Rust tests**

Run: `cargo fmt --manifest-path app/src-tauri/Cargo.toml -- --check`
Run: `cargo test --manifest-path app/src-tauri/Cargo.toml`

Expected: PASS, including existing storage and transcript tests.

- [ ] **Step 4: Run the Rust type check**

Run: `cargo check --manifest-path app/src-tauri/Cargo.toml`

Expected: PASS with both transcript note commands registered in the Tauri handler.

- [ ] **Step 5: Run the final user-flow checklist**

Manually verify one completed Task:

1. Confirm 【我的笔记】 is right of 【文字稿校对】 and 【学习整理】 is below it.
2. Click an uninserted segment icon and confirm exactly one blank record appears.
3. Click the icon again and confirm the existing record is focused instead of duplicated.
4. Enter edit mode, save non-empty content, cancel another edit, and confirm both behaviors.
5. Delete the record and confirm the segment icon returns to the neutral state.
6. Switch Tasks and confirm notes are isolated; switch back and confirm persistence.
7. Edit the transcript and confirm the note still follows its segment ID and preserves its source snapshot.
8. Confirm a missing segment produces an orphan record rather than silent deletion.
9. Confirm no note insertion controls appear in full-transcript mode without segments.
10. Confirm AI generation makes notes read-only while keeping records visible.

- [ ] **Step 6: Commit the verified implementation**

```bash
git add app/src app/src-tauri/src
git commit -m "feat: add task scoped transcript notes"
```

## Plan self-review

- Design coverage: layout, unique segment association, blank creation, second-click editing, inline save/cancel, deletion, orphan retention, Task persistence, full-editor boundary, read-only AI state, IPC storage, localization, accessibility, responsive layout, and tests are each assigned to a task above.
- Type consistency: `TranscriptNote` is defined once in `app/src/transcriptNotesState.ts`; the IPC client, controller, panel, and segment icon all consume that type. Rust uses the same six serialized field names and the same schema version.
- Placeholder scan: the plan contains no `TBD`, `TODO`, or unspecified implementation step. Every verification command names an exact command and expected result.
- Scope check: no Worker changes, no AI prompt changes, and no cross-Task notes are included.
- Safety check: only the new Task notes sidecar is written; Transcript Artifact and AI result generation remain untouched.
