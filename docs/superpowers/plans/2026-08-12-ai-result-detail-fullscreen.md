# 学习整理详情窗口全屏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为学习整理结果详情增加应用内全屏/还原功能，让预览态和编辑态始终共用同一个详情窗口。

**Architecture:** 在 `AiResultDetailSheet` 内维护 `isFullscreen` UI 状态，把状态 class 同时应用到现有遮罩和 dialog section。全屏只改变容器尺寸与边距，不改变 `detailTab`、摘要编辑控制器、保存逻辑或焦点管理；按钮文案由 synthesis i18n 提供。

**Tech Stack:** React 19, TypeScript, lucide-react, CSS, i18next, Vitest。

---

### Task 1: Add failing coverage for the shared fullscreen dialog

**Files:**
- Modify: `app/src/features/results/AiResultDetailSheet.i18n.test.tsx`
- Modify: `app/src/App.css.test.ts`

- [ ] **Step 1: Extend localized detail rendering assertions**

In `AiResultDetailSheet.i18n.test.tsx`, add a `fullscreen` value to each case in the existing localization test and assert `expect(markup).toContain(fullscreen);`.

Use these complete cases:

```tsx
["zh-CN", "学习问题", "换个方向", "匹配理由", "复习与练习问题", "学习用途", "全屏显示"],
["zh-TW", "學習問題", "換個方向", "符合原因", "複習與練習問題", "學習用途", "全螢幕顯示"],
["en-US", "Study Questions", "Try Another Direction", "Why it matches", "Review and practice questions", "Study use", "Enter fullscreen"],
```

Update the callback parameters to include `fullscreen`.

- [ ] **Step 2: Add CSS contract assertions**

In `App.css.test.ts`, add:

```tsx
test("supports an in-app fullscreen result dialog without changing its content mode", () => {
  const fullscreenSheetRule = getRuleBody([".ai-result-detail-sheet.is-fullscreen"]);
  const fullscreenBackdropRule = getRuleBody([".sheet-backdrop.detail-fullscreen-backdrop"]);
  const headerActionsRule = getRuleBody([".modal-header-actions"]);

  expect(fullscreenSheetRule).toContain("height: 100%;");
  expect(fullscreenSheetRule).toContain("max-height: none;");
  expect(fullscreenSheetRule).toContain("max-width: none;");
  expect(fullscreenSheetRule).toContain("border-radius: 0;");
  expect(fullscreenBackdropRule).toContain("padding: 0;");
  expect(headerActionsRule).toContain("display: flex;");
  expect(aiResultDetailSheetTsx).toContain("isFullscreen");
  expect(aiResultDetailSheetTsx).toContain("summaryEditing");
  expect(aiResultDetailSheetTsx).toContain("role=\"dialog\"");
});
```

- [ ] **Step 3: Run the focused tests and confirm the new assertions fail**

Run:

```powershell
npm --prefix app test -- AiResultDetailSheet.i18n.test.tsx App.css.test.ts
```

Expected: FAIL because the new i18n labels and fullscreen CSS selectors do not exist yet.

### Task 2: Implement the shared fullscreen state and controls

**Files:**
- Modify: `app/src/features/results/AiResultDetailSheet.tsx`

- [ ] **Step 1: Add fullscreen icons and local state**

Update the lucide import to include `Maximize2` and `Minimize2`, then add:

```tsx
const [isFullscreen, setIsFullscreen] = useState(false);

useEffect(() => {
  if (!detailTab) {
    setIsFullscreen(false);
  }
}, [detailTab]);
```

- [ ] **Step 2: Put the fullscreen control in the existing dialog header**

Use the existing dialog and close button, adding this action group:

```tsx
<div className="modal-header-actions">
  <button
    className="icon-button"
    type="button"
    onClick={() => setIsFullscreen((current) => !current)}
    aria-label={t(isFullscreen ? "detail.exitFullscreen" : "detail.fullscreen")}
  >
    {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
  </button>
  <button className="icon-button" type="button" onClick={requestCloseDetail} aria-label={t("detail.closeAria")}>
    <X size={18} />
  </button>
</div>
```

Apply the state classes to the existing overlay and dialog section:

```tsx
className={`modal-backdrop sheet-backdrop${isFullscreen ? " detail-fullscreen-backdrop" : ""}`}
```

```tsx
className={`sheet-panel detail-modal ai-result-detail-sheet${isFullscreen ? " is-fullscreen" : ""}`}
```

Keep the existing `role="dialog"`, `aria-modal`, `useModalFocus`, `summaryEditing` branch, and close protection unchanged.

- [ ] **Step 3: Run the focused component test**

Run:

```powershell
npm --prefix app test -- AiResultDetailSheet.i18n.test.tsx
```

Expected: no TypeScript or JSX errors; label and CSS assertions remain pending until Tasks 3 and 4.

### Task 3: Add fullscreen layout styles

**Files:**
- Modify: `app/src/App.css`

- [ ] **Step 1: Add header action grouping styles**

Add near the shared modal header rules:

```css
.modal-header-actions {
  align-items: center;
  display: flex;
  gap: 8px;
}
```

- [ ] **Step 2: Add the in-app fullscreen rules**

Add near `.ai-result-detail-sheet`:

```css
.sheet-backdrop.detail-fullscreen-backdrop {
  padding: 0;
}

.ai-result-detail-sheet.is-fullscreen {
  border-radius: 0;
  height: 100%;
  max-height: none;
  max-width: none;
}
```

Do not change `.modal-content` overflow behavior; Markdown preview and editor must continue scrolling inside the same dialog.

- [ ] **Step 3: Run the CSS contract test**

Run:

```powershell
npm --prefix app test -- App.css.test.ts
```

Expected: PASS for the new fullscreen selector contract and all existing CSS tests.

### Task 4: Add localized fullscreen labels

**Files:**
- Modify: `app/src/i18n/synthesisResources.ts`

- [ ] **Step 1: Add labels to every supported locale**

After `closeAria` in each `detail` resource object, add:

```ts
// zh-CN
fullscreen: "全屏显示",
exitFullscreen: "退出全屏",

// zh-TW
fullscreen: "全螢幕顯示",
exitFullscreen: "退出全螢幕",

// en-US
fullscreen: "Enter fullscreen",
exitFullscreen: "Exit fullscreen",
```

- [ ] **Step 2: Run localized detail tests**

Run:

```powershell
npm --prefix app test -- AiResultDetailSheet.i18n.test.tsx
```

Expected: PASS for zh-CN, zh-TW, and en-US; generated summary/insight content remains unchanged.

### Task 5: Verify the complete frontend change

**Files:**
- Verify: `app/src/features/results/AiResultDetailSheet.tsx`
- Verify: `app/src/App.css`
- Verify: `app/src/i18n/synthesisResources.ts`
- Verify: `app/src/features/results/AiResultDetailSheet.i18n.test.tsx`
- Verify: `app/src/App.css.test.ts`

- [ ] **Step 1: Run all frontend tests**

Run:

```powershell
npm --prefix app test
```

Expected: PASS with no regression in result detail, summary editing, or workspace layout tests.

- [ ] **Step 2: Run TypeScript verification and production build**

Run:

```powershell
npm --prefix app run lint
npm --prefix app run build
```

Expected: both commands exit with code 0.

- [ ] **Step 3: Inspect the final diff**

Run:

```powershell
git diff --check
git diff -- app/src/features/results/AiResultDetailSheet.tsx app/src/App.css app/src/i18n/synthesisResources.ts app/src/features/results/AiResultDetailSheet.i18n.test.tsx app/src/App.css.test.ts
```

Expected: no whitespace errors; diff contains only the fullscreen control, shared-dialog classes, translations, and focused tests.
