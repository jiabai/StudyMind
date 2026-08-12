# 知识结构本地预览编辑设计

## 状态

已获用户确认。范围限定为知识结构结果的 Markdown 正文编辑与本地持久化。

## 目标

在学习整理卡片的“知识结构”查看结果中，允许用户直接编辑本地 Markdown 预览，并把保存后的内容写回当前任务的 `ai/summary.md`。编辑不会修改 Mermaid 思维导图 `ai/mindmap.mmd`，不会重新调用云端 LLM，也不会改变文字稿或其他 AI 产物。

## 非目标

- 不编辑或重建 `mindmap.mmd`。
- 不编辑学习问题、文字稿解剖或文字稿。
- 不把编辑后的 Summary 作为下一次 AI 生成的输入。
- 不提供任意本地路径写入能力。
- 不引入通用的多产物编辑协议。

## 用户体验

1. 用户在学习整理卡片点击“查看结果”，打开“知识结构”详情。
2. 详情工具栏显示“编辑”操作；进入编辑态后，Markdown 正文显示在多行编辑框中。
3. 用户可以在“编辑”和“预览”之间切换。预览继续使用现有的安全 Markdown 渲染器。
4. 编辑态提供“取消”和“保存”。取消恢复到进入编辑态时的已保存内容。
5. 保存期间编辑框与保存按钮不可用；成功后回到预览态，显示保存后的内容，并同步当前任务状态。
6. 空白内容不能保存，并通过本地化提示说明原因。
7. 关闭详情或切换任务时，如果存在未保存修改，先要求确认丢弃；保存中的请求不能被旧任务结果覆盖。
8. 复制操作复制当前编辑草稿，预览态复制已保存的 Summary；导出仍定位磁盘上的正式 `summary.md`。

## 架构与数据流

### 前端

- 新增 `app/src/summaryClient.ts`，封装 `save_summary_edit` Tauri 调用、请求参数和严格响应解析。
- 新增 `app/src/features/results/useSummaryEditorController.ts`，只负责 Summary 编辑草稿、dirty 状态、保存并发保护和保存结果回调。
- `useTranscriptDetailController` 组合 Summary 编辑控制器，维持现有详情控制器的扁平公开接口。
- `AiResultDetailSheet` 仅在 `detailTab === "summary"` 时显示编辑操作和编辑/预览内容；insights、dissection 的展示路径保持不变。
- `useTaskProcessingController` 新增 `applySummarySave`，仅当返回的 `task_id` 仍是当前任务时更新 `workflow.summary`。保存结果不会改变 artifacts 路径。

### Tauri/Rust

- 新增 `app/src-tauri/src/summary_detail.rs` 并注册 `save_summary_edit` 命令。
- 命令请求只包含 `task_id` 与 `summary`。
- Rust 根据应用配置的 output root 打开受支持任务，要求 manifest 已声明且磁盘上存在 `summary` Artifact，再通过现有任务路径校验确认目标是任务目录内的普通文件；不接受前端传入路径。
- 对 `summary.trim()` 为空的请求返回安全错误；非空内容以 UTF-8 写入，并保持 Markdown 文件以换行结束。
- 使用现有原子写入能力保存文件。Summary 产物路径没有变化，因此不需要修改 manifest；历史详情下次读取时会自然获得新内容。
- 响应返回 `task_id` 与规范化后的 `summary`，不返回原始错误详情。

### 数据流

```text
workflow.summary
      │
      ▼
Summary editor draft ── save_summary_edit(task_id, summary) ──▶ Rust
      │                                                        │
      │                                                        ├─ validate task + declared summary artifact
      │                                                        └─ atomic write ai/summary.md
      ◀────────────── { task_id, summary } ────────────────────┘
      │
      └─ applySummarySave → workflow.summary → Markdown preview
```

## 安全与错误处理

- IPC 客户端拒绝缺字段、额外字段、错误 task id 或非字符串 Summary，统一转换为 `SUMMARY_IPC_RESPONSE_INVALID`。
- Rust 不回显路径、用户内容以外的内部错误或敏感配置；前端只显示本地化的保存失败/空内容提示。
- 保存前拒绝符号链接、junction、缺失 Artifact 和越出任务目录的路径。
- 保存失败时保留编辑草稿并退出保存中状态，用户可以重试；不更新 `workflow.summary`。
- 任务切换、重置或重新生成开始时，现有 UI 重置流程关闭详情并丢弃编辑控制器状态；异步旧响应通过 task id 守卫忽略。

## 测试策略

- `app/src/summaryClient.test.ts`：先验证新响应解析测试失败，再实现严格解析；覆盖成功响应、task id 不一致、缺失/额外字段和非字符串 Summary。
- `app/src/features/results/useSummaryEditorController.test.ts`：覆盖进入编辑、更新草稿、取消恢复、空白保存阻止、成功保存回调、保存失败保留草稿、保存期间防重复提交和任务切换后的旧响应忽略。
- `app/src/features/results/AiResultDetailSheet.i18n.test.tsx` 或 `TaskWorkspaces.test.tsx`：覆盖知识结构详情显示编辑入口、编辑态控件和本地化文案；确认其他详情类型没有编辑入口，生成内容不会被翻译。
- `app/src-tauri/src/summary_detail.rs` 内单元测试：覆盖 Summary 保存 round-trip、空白拒绝、未声明/缺失 Artifact 拒绝、链接目标拒绝、原子写失败保留原文件，并确认历史详情读取到保存后的正文。
- `app/src-tauri/src/lib.rs`：确认命令注册；运行 Rust 单测与 `cargo check`。
- 最终运行前端相关 Vitest、`npm --prefix app run build`、Rust 测试/检查以及仓库要求的 Python linter/test 命令，按实际改动范围汇报结果。

## 兼容性与边界

- 旧任务只要已有合法 `summary` Artifact，就可以直接编辑；没有 Summary 的任务不显示编辑入口。
- 编辑后的 Markdown 可能包含用户自定义标题、列表和表格；预览继续经过 `react-markdown + remark-gfm + rehype-sanitize`，不执行 HTML 或脚本。
- 重新生成知识结构会按现有 InsightFlow 流程覆盖 `summary.md` 与 `mindmap.mmd`，这是用户主动触发的既有行为，不在本功能中增加合并逻辑。
