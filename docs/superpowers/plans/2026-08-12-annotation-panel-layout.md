# 批注卡片布局调整 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将“批注”卡片放入左侧主工作区的下方布局行，使其位于“学习整理”右侧并与之顶部对齐，同时保留“我的笔记”及批注交互行为。

**Architecture:** 保持现有外层 `task-workspace-layout` 的两列结构不变，让“我的笔记”继续作为右侧卡片与文字稿校对并排。将左侧 `task-workspace-primary-column` 的第二个子区域改为 `task-workspace-learning-row`，由“学习整理”和“批注”组成内部两列；在窄屏断点下该内部布局退化为单列。

**Tech Stack:** React、TypeScript、CSS、Vitest、Vite。

---

### Task 1: 为新的工作区层级增加回归测试

**Files:**
- Modify: `D:\Github\StudyMind\app\src\App.css.test.ts`
- Modify: `D:\Github\StudyMind\app\src\features\results\TaskWorkspaces.test.tsx`

- [x] **Step 1: 写出失败的 CSS 布局测试**

在 `App.css.test.ts` 的工作区布局测试附近增加测试，读取 `.task-workspace-learning-row` 的规则，并断言它使用网格、存在工作区间距和两列；同时断言 `@media (max-width: 1099px)` 中该行退化为单列，并断言批注卡片在该行内取消独立底部的上边距。

```ts
  test("aligns the annotation card beside the learning workspace", () => {
    const learningRowRule = getRuleBody([".task-workspace-learning-row"]);
    const annotationRule = getRuleBody([".task-workspace-learning-row > .annotation-panel"]);

    expect(learningRowRule).toContain("display: grid;");
    expect(learningRowRule).toContain("gap: var(--space-4);");
    expect(learningRowRule).toContain("grid-template-columns:");
    expect(annotationRule).toContain("margin-top: 0;");
    expect(appCss).toMatch(
      /@media \(max-width: 1099px\)[\s\S]*?\.task-workspace-learning-row\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/,
    );
  });
```

- [x] **Step 2: 写出失败的 DOM 结构测试**

在 `TaskWorkspaces.test.tsx` 的布局组合测试中，断言 `AnnotationListPanel` 在 `task-workspace-learning-row` 的 JSX 片段中渲染，并且该片段位于 `AiGenerationWorkspace` 之后、`task-workspace-primary-column` 闭合之前；同时确认“我的笔记”仍属于外层工作区右列，不再要求批注位于“我的笔记”之后。

```ts
    const learningRowStart = appSource.indexOf('className="task-workspace-learning-row"');
    const aiWorkspaceStart = appSource.indexOf("<AiGenerationWorkspace");
    const annotationStart = appSource.indexOf("<AnnotationListPanel");

    expect(learningRowStart).toBeGreaterThan(-1);
    expect(annotationStart).toBeGreaterThan(aiWorkspaceStart);
    expect(annotationStart).toBeGreaterThan(learningRowStart);
    expect(appSource.slice(learningRowStart, annotationStart)).toContain(
      "<AiGenerationWorkspace",
    );
```

- [x] **Step 3: 运行定向测试并确认失败**

Run: `npm.cmd --prefix app test -- src/App.css.test.ts src/features/results/TaskWorkspaces.test.tsx`

Expected: 新增布局测试失败，因为 `.task-workspace-learning-row` 尚未存在且 `AnnotationListPanel` 仍在外层工作区之后。

### Task 2: 将学习整理和批注组合为下方两列布局

**Files:**
- Modify: `D:\Github\StudyMind\app\src\App.tsx:627-684`

- [x] **Step 1: 将批注卡片移动到左侧主列的学习整理行**

保持 `LocalTranscriptWorkspace` 为 `task-workspace-primary-column` 的第一个子项；将现有 `AiGenerationWorkspace` 和完整 `AnnotationListPanel` 包裹进同一个 `div`，其 class 为 `task-workspace-learning-row`。批注卡片的 props、回调和显示状态全部原样保留。

```tsx
                <div className="task-workspace-learning-row">
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
                  <AnnotationListPanel
                    annotations={annotationsController.annotations}
                    colors={[
                      { key: "yellow", label: "重点", className: "color-yellow" },
                      { key: "blue", label: "疑问", className: "color-blue" },
                      { key: "green", label: "已掌握", className: "color-green" },
                      { key: "red", label: "待复习", className: "color-red" },
                    ]}
                    onJumpTo={(annotation) => {
                      openDetailTab(annotation.target_tab as "summary" | "insights" | "dissection");
                      setActiveAnnotationId(annotation.id);
                    }}
                    onEdit={(annotation) => {
                      openDetailTab(annotation.target_tab as "summary" | "insights" | "dissection");
                      setActiveAnnotationId(annotation.id);
                    }}
                    onDelete={(id) => annotationsController.deleteAnnotation(id)}
                    visible={annotationPanelVisible}
                    onToggleVisible={() => setAnnotationPanelVisible(!annotationPanelVisible)}
                  />
                </div>
```

- [x] **Step 2: 删除外层工作区之后的旧批注卡片实例**

确认 `AnnotationListPanel` 只保留在 `task-workspace-learning-row` 内，避免同一批注卡片重复渲染或保留旧的底部位置。

- [x] **Step 3: 运行 DOM 定向测试**

Run: `npm.cmd --prefix app test -- src/features/results/TaskWorkspaces.test.tsx`

Expected: TaskWorkspaces 的布局和渲染测试通过。

### Task 3: 增加两列及窄屏单列样式

**Files:**
- Modify: `D:\Github\StudyMind\app\src\App.css:2425-2435,3108-3125,3944-3965`

- [x] **Step 1: 添加学习整理行的桌面布局样式**

在 `.task-workspace-primary-column` 后添加：

```css
.task-workspace-learning-row {
  display: grid;
  gap: var(--space-4);
  grid-template-columns: minmax(0, 1fr) minmax(260px, 0.72fr);
  min-width: 0;
}

.task-workspace-learning-row > .annotation-panel {
  margin-top: 0;
}
```

这样批注面板在学习整理旁边时顶部对齐，同时不改变批注面板内部展开/收起布局。

- [x] **Step 2: 在现有 1099px 断点添加窄屏规则**

在现有 `@media (max-width: 1099px)` 中添加：

```css
  .task-workspace-learning-row {
    grid-template-columns: minmax(0, 1fr);
  }
```

这样窄屏下不会让学习整理和批注被压缩在同一行；外层“我的笔记”仍沿用已有单列规则。

- [x] **Step 3: 运行 CSS 定向测试**

Run: `npm.cmd --prefix app test -- src/App.css.test.ts`

Expected: CSS 工作区布局测试全部通过。

### Task 4: 完成验证并建立实现提交

**Files:**
- Verify: `D:\Github\StudyMind\app\src\App.tsx`
- Verify: `D:\Github\StudyMind\app\src\App.css`
- Verify: `D:\Github\StudyMind\app\src\App.css.test.ts`
- Verify: `D:\Github\StudyMind\app\src\features\results\TaskWorkspaces.test.tsx`

- [x] **Step 1: 运行相关测试**

Run: `npm.cmd --prefix app test -- src/App.css.test.ts src/features/results/TaskWorkspaces.test.tsx`

Expected: 相关测试文件全部通过。

- [x] **Step 2: 运行前端完整测试**

Run: `npm.cmd --prefix app test`

Expected: 所有前端测试通过，且不修改 `app/src/features/results/AnnotationPopover.tsx`。

- [x] **Step 3: 运行生产构建**

Run: `npm.cmd --prefix app run build`

Expected: Vite 构建成功；若出现已有的大 chunk warning，不作为失败处理。

- [x] **Step 4: 检查差异并提交实现**

Run: `git diff --check`

确认只包含本任务的 `App.tsx`、`App.css` 和相关测试文件；不要暂存或修改用户已有的 `app/src/features/results/AnnotationPopover.tsx`。

```bash
git add app/src/App.tsx app/src/App.css app/src/App.css.test.ts app/src/features/results/TaskWorkspaces.test.tsx
git commit -m "fix: align annotation panel with learning workspace"
```
