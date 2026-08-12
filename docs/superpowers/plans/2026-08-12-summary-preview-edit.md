# 知识结构本地预览编辑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ] ) syntax for tracking.

**Goal:** 在学习整理卡片的知识结构详情中增加 Markdown 编辑、取消、预览和持久化保存能力，将内容安全写回当前任务的 ai/summary.md。

**Architecture:** 前端用专用 Summary 编辑控制器维护草稿与 dirty/saving 状态，通过 summaryClient.ts 调用新增的 Tauri save_summary_edit 命令。Rust 端只根据 task_id 解析已声明的 Summary Artifact，校验普通文件并原子写入；保存成功后由任务处理控制器按 task id 守卫更新 workflow.summary。思维导图和其他产物不参与此流程。

**Tech Stack:** React 19, TypeScript, Vitest, Tauri 2, Rust, serde, existing atomic file and task-manifest services, react-markdown.

---

## 文件地图

- Create: app/src/summaryClient.ts — Summary 保存 IPC 的类型、调用和严格响应解析。
- Create: app/src/summaryClient.test.ts — Summary IPC 的成功与拒绝用例。
- Create: app/src/features/results/useSummaryEditorController.ts — Summary 草稿、dirty、保存并发和回调编排。
- Create: app/src/features/results/useSummaryEditorController.test.ts — 编辑控制器行为测试。
- Create: app/src-tauri/src/summary_detail.rs — Summary 保存命令、任务路径校验、原子写入和 Rust 单测。
- Modify: app/src/tauriIpcProtocol.ts — 添加 SUMMARY_IPC_RESPONSE_INVALID 错误码。
- Modify: app/src/tauriIpcProtocol.test.ts — 保持 IPC 错误码覆盖完整。
- Modify: app/src/features/transcript/useTranscriptDetailController.ts — 组合 Summary 编辑控制器并暴露扁平接口。
- Modify: app/src/features/transcript/useTranscriptDetailController.test.ts — 更新公开接口断言并覆盖组合结果。
- Modify: app/src/features/results/AiResultDetailSheet.tsx — 知识结构编辑/预览 UI、工具栏动作和关闭保护。
- Modify: app/src/features/results/AiResultDetailSheet.i18n.test.tsx — 验证知识结构编辑文案与其他结果不显示编辑入口。
- Modify: app/src/features/results/TaskWorkspaces.test.tsx — 验证知识结构详情的编辑入口与编辑态结构。
- Modify: app/src/features/workflow/useTaskProcessingController.ts — 添加 task id 守卫的 applySummarySave。
- Modify: app/src/features/workflow/useTaskProcessingController.test.ts — 覆盖当前任务更新和旧任务响应忽略。
- Modify: app/src/App.tsx — 传入 applySummarySave，并让 Escape 关闭路径使用本地化的未保存确认。
- Modify: app/src/i18n/synthesisResources.ts — 添加编辑、保存、取消、未保存确认和失败提示的 zh-CN/zh-TW/en-US 文案。
- Modify: app/src/App.css — 增加 Summary 编辑器的 textarea、编辑态工具栏和移动端布局。
- Modify: app/src/App.css.test.ts — 验证编辑器类名对应的样式和安全 Markdown 渲染仍存在。
- Modify: app/src-tauri/src/lib.rs — 注册 summary_detail::save_summary_edit。
- Modify: app/src-tauri/src/task_manifest/access.rs or app/src-tauri/src/task_manifest/schema.rs only if the existing Summary Artifact accessors cannot expose the required safe path; prefer no manifest refactor and reuse existing TaskArtifact::Summary APIs.

## Task 1: Add the Summary IPC contract

**Files:**
- Create: app/src/summaryClient.test.ts
- Create: app/src/summaryClient.ts
- Modify: app/src/tauriIpcProtocol.ts
- Test: app/src/tauriIpcProtocol.test.ts

- [ ] Step 1: Write the failing response parser tests

Add tests that define the public behavior before implementation:

~~~ts
test("saves a summary and returns the normalized saved content", async () => {
  const runner = vi.fn().mockResolvedValue({
    task_id: "task-1",
    summary: "# Knowledge Structure\n",
  });

  await expect(
    saveSummaryEdit("task-1", "# Knowledge Structure", runner),
  ).resolves.toEqual({
    task_id: "task-1",
    summary: "# Knowledge Structure\n",
  });

  expect(runner).toHaveBeenCalledWith("save_summary_edit", {
    request: { task_id: "task-1", summary: "# Knowledge Structure" },
  });
});

test.each([
  { task_id: "other-task", summary: "# Summary\n" },
  { task_id: "task-1" },
  { task_id: "task-1", summary: 42 },
  { task_id: "task-1", summary: "# Summary\n", extra: true },
])("rejects an invalid save response: %j", async (response) => {
  await expect(
    saveSummaryEdit("task-1", "# Summary", vi.fn().mockResolvedValue(response)),
  ).rejects.toMatchObject({
    code: "SUMMARY_IPC_RESPONSE_INVALID",
  });
});
~~~

- [ ] Step 2: Run the focused tests and verify RED

Run: npm --prefix app exec vitest run src/summaryClient.test.ts

Expected: FAIL because app/src/summaryClient.ts and the SUMMARY_IPC_RESPONSE_INVALID protocol code do not exist.

- [ ] Step 3: Implement the minimal IPC client

Define:

~~~ts
export type SaveSummaryEditResponse = {
  task_id: string;
  summary: string;
};

export type SummaryCommandRunner = (
  command: string,
  args: InvokeArgs,
) => Promise<unknown>;

export async function saveSummaryEdit(
  taskId: string,
  summary: string,
  runner: SummaryCommandRunner = defaultRunner,
): Promise<SaveSummaryEditResponse>;
~~~

Call runner("save_summary_edit", { request: { task_id: taskId, summary } }). Parse the response with readIpcDataObject, requiring exactly task_id and summary, and throw IpcProtocolError("SUMMARY_IPC_RESPONSE_INVALID") for task mismatch or non-string values. Add the new code to IpcProtocolErrorCode.

- [ ] Step 4: Run the focused tests and verify GREEN

Run: npm --prefix app exec vitest run src/summaryClient.test.ts src/tauriIpcProtocol.test.ts

Expected: PASS with zero failures.

- [ ] Step 5: Commit the IPC contract

~~~bash
git add app/src/summaryClient.ts app/src/summaryClient.test.ts app/src/tauriIpcProtocol.ts app/src/tauriIpcProtocol.test.ts
git commit -m "feat: add summary save IPC client"
~~~

## Task 2: Add the Rust Summary persistence command

**Files:**
- Create: app/src-tauri/src/summary_detail.rs
- Modify: app/src-tauri/src/lib.rs
- Test: app/src-tauri/src/summary_detail.rs

- [ ] Step 1: Write Rust tests for the storage boundary

Add unit tests around save_summary_edit_to_output_root using a temporary supported task fixture containing ai/summary.md and a manifest artifact entry:

~~~rust
#[test]
fn save_summary_edit_round_trips_normalized_markdown() {
    let output_root = temp_dir("summary-save");
    write_supported_task_with_summary(&output_root, "task-1", "# Old summary\n");

    let result = save_summary_edit_to_output_root(
        &output_root,
        SaveSummaryEditRequest {
            task_id: "task-1".to_string(),
            summary: "# New summary".to_string(),
        },
    )
    .expect("save summary");

    assert_eq!(result.task_id, "task-1");
    assert_eq!(result.summary, "# New summary\n");
    assert_eq!(
        fs::read_to_string(output_root.join("tasks/task-1/ai/summary.md"))
            .expect("read summary"),
        "# New summary\n"
    );
}

#[test]
fn save_summary_edit_rejects_blank_content_and_invalid_summary_targets() {
    let output_root = temp_dir("summary-reject");
    write_supported_task_with_summary(&output_root, "task-1", "# Old summary\n");

    assert!(save_summary_edit_to_output_root(
        &output_root,
        SaveSummaryEditRequest {
            task_id: "task-1".to_string(),
            summary: " \n\t".to_string(),
        },
    ).is_err());

    let missing_summary_root = temp_dir("summary-missing");
    write_supported_task_without_summary(&missing_summary_root, "task-2");
    assert!(save_summary_edit_to_output_root(
        &missing_summary_root,
        SaveSummaryEditRequest {
            task_id: "task-2".to_string(),
            summary: "# New summary".to_string(),
        },
    ).is_err());
}
~~~

Also add a regression test for a linked ai/summary.md target, and a failure-injection test that confirms the previous bytes remain after atomic_write fails. Reuse the repository's supported-task fixture shape and crate::atomic_files::fail_next_install_for_test pattern.

- [ ] Step 2: Run the Rust target and verify RED

Run: cargo test --manifest-path app/src-tauri/Cargo.toml summary_detail

Expected: FAIL because the command, request/result types, and implementation do not exist.

- [ ] Step 3: Implement the safe save command

Create:

~~~rust
#[derive(Debug, Deserialize)]
pub(crate) struct SaveSummaryEditRequest {
    #[serde(alias = "taskId")]
    pub(crate) task_id: String,
    pub(crate) summary: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub(crate) struct SaveSummaryEditResult {
    pub(crate) task_id: String,
    pub(crate) summary: String,
}

#[tauri::command]
pub(crate) fn save_summary_edit(
    app: AppHandle,
    request: SaveSummaryEditRequest,
) -> Result<SaveSummaryEditResult, String>;
~~~

Resolve the configured output root exactly as transcript_detail::save_transcript_edit does. In save_summary_edit_to_output_root, open the task with task_manifest::SupportedTask::open, convert it to TaskEditSession, request TaskArtifact::Summary with required_existing_artifact_path, validate the existing path against the task directory, reject symlinks/junctions and non-regular files, normalize request.summary.trim() and append one newline, then call crate::atomic_files::atomic_write. Map all filesystem and validation errors to safe fixed messages. Do not accept a path from the request and do not update the manifest.

Register summary_detail::save_summary_edit in tauri::generate_handler!.

- [ ] Step 4: Run Rust tests and check the build

Run: cargo test --manifest-path app/src-tauri/Cargo.toml summary_detail

Expected: PASS, including blank, missing-artifact, linked-target, round-trip, and atomic-failure cases.

Run: cargo check --manifest-path app/src-tauri/Cargo.toml

Expected: exit code 0.

- [ ] Step 5: Commit the Rust persistence boundary

~~~bash
git add app/src-tauri/src/summary_detail.rs app/src-tauri/src/lib.rs
git commit -m "feat: persist edited summaries locally"
~~~

## Task 3: Add task-state synchronization

**Files:**
- Modify: app/src/features/workflow/useTaskProcessingController.ts
- Modify: app/src/features/workflow/useTaskProcessingController.test.ts

- [ ] Step 1: Write the failing task-state tests

Add a test beside the existing transcript-save task identity tests:

~~~ts
test("applies a summary save only to the still-current task", async () => {
  const first = createHistoryItem({ taskId: "first-task", summary: "first" });
  const second = createHistoryItem({ taskId: "second-task", summary: "second" });
  const { render } = await createController();

  let controller = render();
  expect(controller.restoreHistoryItem(first)).toBe(true);
  controller = render();
  expect(controller.restoreHistoryItem(second)).toBe(true);
  controller = render();

  controller.applySummarySave("first-task", {
    task_id: "first-task",
    summary: "late first edit\n",
  });
  controller = render();
  expect(controller.workflow.taskId).toBe("second-task");
  expect(controller.workflow.summary).toBe("second");

  controller.applySummarySave("second-task", {
    task_id: "second-task",
    summary: "second edit\n",
  });
  controller = render();
  expect(controller.workflow.summary).toBe("second edit\n");
});
~~~

Also assert the controller exposes applySummarySave and that an unrelated artifact map remains unchanged.

- [ ] Step 2: Run the focused test and verify RED

Run: npm --prefix app exec vitest run src/features/workflow/useTaskProcessingController.test.ts

Expected: FAIL because applySummarySave is not returned.

- [ ] Step 3: Implement the guarded updater

Import SaveSummaryEditResponse, define:

~~~ts
const applySummarySave = useCallback(
  (expectedTaskId: string | null, saved: SaveSummaryEditResponse) => {
    setWorkflow((current) => {
      if (
        !expectedTaskId ||
        current.taskId !== expectedTaskId ||
        saved.task_id !== expectedTaskId
      ) {
        return current;
      }
      return { ...current, summary: saved.summary };
    });
  },
  [],
);
~~~

Return it from useTaskProcessingController.

- [ ] Step 4: Run the focused test and verify GREEN

Run: npm --prefix app exec vitest run src/features/workflow/useTaskProcessingController.test.ts

Expected: PASS with all existing workflow tests passing.

- [ ] Step 5: Commit the state synchronization

~~~bash
git add app/src/features/workflow/useTaskProcessingController.ts app/src/features/workflow/useTaskProcessingController.test.ts
git commit -m "feat: sync saved summaries into workflow state"
~~~

## Task 4: Build the Summary editor controller

**Files:**
- Create: app/src/features/results/useSummaryEditorController.test.ts
- Create: app/src/features/results/useSummaryEditorController.ts

- [ ] Step 1: Write the failing controller tests

Use the repository's hook harness style and mock saveSummaryEdit. Cover one behavior per test:

~~~ts
test("starts with the saved summary and enters edit mode", () => {
  const controller = render();
  expect(controller.summaryEditing).toBe(false);

  controller.beginSummaryEdit();
  controller = render();
  expect(controller.summaryEditing).toBe(true);
  expect(controller.summaryDraft).toBe("# Saved summary\n");
  expect(controller.summaryDirty).toBe(false);
});

test("cancels back to the saved summary", () => {
  let controller = render();
  controller.beginSummaryEdit();
  controller = render();
  controller.updateSummaryDraft("# Draft\n");
  controller = render();

  controller.cancelSummaryEdit();
  controller = render();
  expect(controller.summaryEditing).toBe(false);
  expect(controller.summaryDraft).toBe("# Saved summary\n");
});

test("does not submit blank content", async () => {
  let controller = render();
  controller.beginSummaryEdit();
  controller = render();
  controller.updateSummaryDraft(" \n");
  controller = render();

  await controller.saveSummaryDraft();
  expect(saveSummaryEditMock).not.toHaveBeenCalled();
  expect(setActionNotice).toHaveBeenLastCalledWith({
    messageCode: "synthesis.detail.summaryEmptySave",
  });
});
~~~

Add tests for successful save (calls IPC, invokes applySummarySave, exits edit mode, clears dirty), save failure (keeps draft and edit mode), duplicate save suppression, and a late response ignored after task id changes.

- [ ] Step 2: Run the focused controller tests and verify RED

Run: npm --prefix app exec vitest run src/features/results/useSummaryEditorController.test.ts

Expected: FAIL because the hook and its returned API do not exist.

- [ ] Step 3: Implement the minimal controller

Use useState, useCallback, useEffect, and a ref holding the current task id. The options must be:

~~~ts
type UseSummaryEditorControllerOptions = {
  workflow: WorkflowState;
  applySummarySave: (
    expectedTaskId: string | null,
    saved: SaveSummaryEditResponse,
  ) => void;
  setActionNotice: Dispatch<SetStateAction<UiMessage | null>>;
};
~~~

Return exactly these fields:

~~~ts
{
  summaryEditing,
  summaryDraft,
  summaryDirty,
  summarySaving,
  beginSummaryEdit,
  cancelSummaryEdit,
  updateSummaryDraft,
  saveSummaryDraft,
}
~~~

Initialize the draft from workflow.summary. Reset draft/edit state when workflow.taskId changes. In saveSummaryDraft, reject missing task id, missing Summary Artifact, blank trimmed content, and an already-saving request. Set summarySaving, call saveSummaryEdit(taskId, summaryDraft), ignore the response when the current task ref no longer matches, otherwise call applySummarySave, set draft to the returned normalized Summary, clear dirty/editing state, and set a localized success notice. Catch failures with a localized save-failed notice while retaining the draft.

- [ ] Step 4: Run the focused controller tests and verify GREEN

Run: npm --prefix app exec vitest run src/features/results/useSummaryEditorController.test.ts

Expected: PASS with the full controller behavior covered.

- [ ] Step 5: Commit the Summary editor controller

~~~bash
git add app/src/features/results/useSummaryEditorController.ts app/src/features/results/useSummaryEditorController.test.ts
git commit -m "feat: add summary editor state controller"
~~~

## Task 5: Compose the controller and preserve public boundaries

**Files:**
- Modify: app/src/features/transcript/useTranscriptDetailController.ts
- Modify: app/src/features/transcript/useTranscriptDetailController.test.ts

- [ ] Step 1: Extend the boundary test before implementation

Update the exact public-key assertion to include the Summary fields beginSummaryEdit, cancelSummaryEdit, summaryDraft, summaryDirty, summaryEditing, summarySaving, saveSummaryDraft, and updateSummaryDraft. Add a test that a workflow with summary "# Summary\n" and a declared summary artifact exposes that content as the initial editor draft.

- [ ] Step 2: Run the focused boundary tests and verify RED

Run: npm --prefix app exec vitest run src/features/transcript/useTranscriptDetailController.test.ts

Expected: FAIL because the root controller does not accept applySummarySave and does not expose the Summary editor fields.

- [ ] Step 3: Compose the editor controller

Add applySummarySave to UseTranscriptDetailControllerOptions, call useSummaryEditorController({ workflow, applySummarySave, setActionNotice }), and spread its eight fields into the returned flat controller. Keep useTranscriptDetailController free of direct saveSummaryEdit imports, just as it is free of direct transcript IPC imports.

Update all test harness calls to provide a no-op applySummarySave.

- [ ] Step 4: Run focused boundary tests and the static boundary check

Run: npm --prefix app exec vitest run src/features/transcript/useTranscriptDetailController.test.ts src/features/transcript/transcriptControllerBoundary.test.ts

Expected: PASS, including the existing owner/consumer boundary assertions.

- [ ] Step 5: Commit controller composition

~~~bash
git add app/src/features/transcript/useTranscriptDetailController.ts app/src/features/transcript/useTranscriptDetailController.test.ts
git commit -m "feat: compose summary editor into detail controller"
~~~

## Task 6: Add the localized Summary edit UI

**Files:**
- Modify: app/src/features/results/AiResultDetailSheet.tsx
- Modify: app/src/features/results/AiResultDetailSheet.i18n.test.tsx
- Modify: app/src/features/results/TaskWorkspaces.test.tsx
- Modify: app/src/i18n/synthesisResources.ts
- Modify: app/src/App.css
- Modify: app/src/App.css.test.ts

- [ ] Step 1: Add localization and style assertions

Add the following semantic keys to all three synthesis resource locales:

~~~text
detail.edit
detail.preview
detail.save
detail.cancel
detail.summaryEditAria
detail.summaryEditorHint
detail.summarySaved
detail.summarySaveFailed
detail.summaryEmptySave
detail.summaryDiscardConfirm
detail.summarySaving
~~~

Use Chinese copy equivalent to “编辑、预览、保存、取消、知识结构 Markdown 编辑器、保存失败、内容不能为空、放弃未保存修改吗？”，and clear English equivalents.

Before changing the component, add assertions that the summary detail renders the edit label, textarea label, preview label, save, and cancel text in each locale. Add a test that the insights and dissection detail markup does not contain the summary edit controls. Extend App.css.test.ts with checks for .summary-editor, .summary-editor textarea, and disabled/save styling while retaining the existing sanitized Markdown assertions.

- [ ] Step 2: Run the UI tests and verify RED

Run: npm --prefix app exec vitest run src/features/results/AiResultDetailSheet.i18n.test.tsx src/features/results/TaskWorkspaces.test.tsx src/App.css.test.ts

Expected: FAIL because the new labels, controls, and styles do not exist.

- [ ] Step 3: Implement the summary detail UI

In AiResultDetailSheet, read the Summary editor fields from controller. Add a toolbar button with data-action="edit-summary" only for detailTab === "summary" and an artifact-backed Summary. In edit mode render:

~~~tsx
<div className="summary-editor">
  <div className="summary-editor-tabs" role="tablist">
    <button type="button" aria-selected={summaryEditorMode === "edit"}>...</button>
    <button type="button" aria-selected={summaryEditorMode === "preview"}>...</button>
  </div>
  {summaryEditorMode === "edit" ? (
    <textarea
      aria-label={t("detail.summaryEditAria")}
      value={controller.summaryDraft}
      onChange={(event) => controller.updateSummaryDraft(event.target.value)}
      disabled={controller.summarySaving}
      placeholder={t("detail.summaryEditorHint")}
    />
  ) : (
    <MarkdownContent
      markdown={controller.summaryDraft}
      emptyText={t("detail.summaryEmpty")}
    />
  )}
  <div className="summary-editor-actions">
    <button type="button" onClick={controller.cancelSummaryEdit} disabled={controller.summarySaving}>
      {t("detail.cancel")}
    </button>
    <button type="button" onClick={() => void controller.saveSummaryDraft()} disabled={controller.summarySaving || !controller.summaryDirty}>
      {controller.summarySaving ? t("detail.summarySaving") : t("detail.save")}
    </button>
  </div>
</div>
~~~

Use the existing MarkdownContent component for preview rather than duplicating ReactMarkdown configuration. Keep the original summary read-only rendering path when not editing. Make the close handler call the controller's dirty-close guard with window.confirm(t("detail.summaryDiscardConfirm")); task reset paths may discard without prompting.

- [ ] Step 4: Implement CSS without changing the existing visual system

Add scoped rules for .summary-editor, .summary-editor-tabs, .summary-editor textarea, and .summary-editor-actions using existing variables, borders, shadows, radii, and button classes. Make the textarea fill the available modal height, preserve monospace-friendly Markdown editing, allow vertical scrolling, and use a mobile breakpoint that stacks the controls. Do not weaken rehype-sanitize or add raw HTML rendering.

- [ ] Step 5: Run the UI tests and verify GREEN

Run: npm --prefix app exec vitest run src/features/results/AiResultDetailSheet.i18n.test.tsx src/features/results/TaskWorkspaces.test.tsx src/App.css.test.ts

Expected: PASS, with edit controls only on Summary detail and localized generated content unchanged.

- [ ] Step 6: Commit the localized UI

~~~bash
git add app/src/features/results/AiResultDetailSheet.tsx app/src/features/results/AiResultDetailSheet.i18n.test.tsx app/src/features/results/TaskWorkspaces.test.tsx app/src/i18n/synthesisResources.ts app/src/App.css app/src/App.css.test.ts
git commit -m "feat: add summary preview editing UI"
~~~

## Task 7: Wire the application-level save callback and close behavior

**Files:**
- Modify: app/src/App.tsx
- Modify: app/src/features/workflow/useTaskProcessingController.ts
- Modify: app/src/features/workflow/useTaskProcessingController.test.ts
- Modify: app/src/features/transcript/useTranscriptDetailController.ts

- [ ] Step 1: Write the failing integration assertions

Add assertions that App.tsx passes applySummarySave into useTranscriptDetailController, and that the Escape close path invokes the localized discard confirmation when Summary editing is dirty. The component-level tests should assert the close handler is passed to the modal through the existing controller surface.

- [ ] Step 2: Run the focused integration tests and verify RED

Run: npm --prefix app exec vitest run src/features/results/TaskWorkspaces.test.tsx src/features/workflow/useTaskProcessingController.test.ts

Expected: FAIL because App currently only passes applyTranscriptSave and Escape calls the unguarded close function.

- [ ] Step 3: Wire the state callback

Destructure applySummarySave from useTaskProcessingController and pass it into useTranscriptDetailController. Update useTranscriptDetailController.closeDetail to accept an optional discard-confirmation callback; if Summary is editing and dirty, return without closing when the callback returns false, otherwise cancel the edit and close the detail tab. Use the callback from AiResultDetailSheet and from App's Escape handler with window.confirm(tSynthesis("detail.summaryDiscardConfirm")). Keep reset/task-change cleanup paths unconditional.

- [ ] Step 4: Run focused integration tests and verify GREEN

Run: npm --prefix app exec vitest run src/features/results/TaskWorkspaces.test.tsx src/features/workflow/useTaskProcessingController.test.ts src/features/transcript/useTranscriptDetailController.test.ts

Expected: PASS, including old task response protection and clean task reset behavior.

- [ ] Step 5: Commit application wiring

~~~bash
git add app/src/App.tsx app/src/features/workflow/useTaskProcessingController.ts app/src/features/workflow/useTaskProcessingController.test.ts app/src/features/transcript/useTranscriptDetailController.ts
git commit -m "feat: wire guarded summary editing into app"
~~~

## Task 8: Run the complete verification set

**Files:**
- No source changes unless a verification command identifies a concrete failure.

- [ ] Step 1: Run all frontend tests

Run: npm --prefix app test

Expected: exit code 0 with all frontend Vitest tests passing.

- [ ] Step 2: Run the frontend production build

Run: npm --prefix app run build

Expected: exit code 0 with TypeScript and Vite build completing successfully.

- [ ] Step 3: Run Rust tests and type checking

Run:

~~~bash
cargo test --manifest-path app/src-tauri/Cargo.toml
cargo check --manifest-path app/src-tauri/Cargo.toml
~~~

Expected: both commands exit 0.

- [ ] Step 4: Run repository Python verification

Run:

~~~bash
uv run ruff check worker
uv run pytest worker/tests
~~~

Expected: both commands exit 0; the feature must not add Python regressions.

- [ ] Step 5: Inspect the final diff and workspace safety

Run: git diff --check HEAD~8..HEAD and git status --short.

Confirm the feature commits contain only the planned files and that pre-existing unrelated working-tree modifications remain untouched.

- [ ] Step 6: Report evidence

Record the exact test/build/check commands and their exit codes before claiming completion. If a command fails, fix the concrete failure with a new red test when behavior is involved, rerun the focused command, then rerun the complete affected suite.
