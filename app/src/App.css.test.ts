import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

const appCss = readFileSync(new URL("./App.css", import.meta.url), "utf-8");
const appTsx = readFileSync(new URL("./App.tsx", import.meta.url), "utf-8");
const localTranscriptWorkspaceTsx = readFileSync(
  new URL("./features/transcript/LocalTranscriptWorkspace.tsx", import.meta.url),
  "utf-8",
);
const transcriptReviewPanelTsx = readFileSync(
  new URL("./features/transcript/TranscriptReviewPanel.tsx", import.meta.url),
  "utf-8",
);
const aiResultDetailSheetTsx = readFileSync(
  new URL("./features/results/AiResultDetailSheet.tsx", import.meta.url),
  "utf-8",
);
const transcriptReviewSessionTs = readFileSync(
  new URL("./features/transcript/useTranscriptReviewSession.ts", import.meta.url),
  "utf-8",
);
const settingsSheetTsx = readFileSync(
  new URL("./features/settings/SettingsSheet.tsx", import.meta.url),
  "utf-8",
);
const settingsControllerTs = readFileSync(
  new URL("./features/settings/useSettingsController.ts", import.meta.url),
  "utf-8",
);
const browserSmokeSource = readFileSync(
  new URL("../tests/app-input.browser.test.ts", import.meta.url),
  "utf-8",
);

function getRuleBody(selectors: string[]): string {
  const selectorPattern = selectors
    .map((selector) => selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*,\\s*");
  const match = appCss.match(new RegExp(`${selectorPattern}\\s*\\{(?<body>[\\s\\S]*?)\\}`));
  return match?.groups?.body ?? "";
}

describe("App result workspace layout styles", () => {
  test("keeps processing loaders visibly active while respecting reduced motion", () => {
    const spinRule = getRuleBody([".spin"]);

    expect(spinRule).toContain("animation: spin 1s linear infinite;");
    expect(spinRule).toContain("transform-origin: center;");
    expect(appCss).toContain("@keyframes processing-pulse");
    expect(appCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.spin\s*\{[\s\S]*?animation: processing-pulse 1.8s ease-in-out infinite !important;/,
    );
  });

  test("stacks the task banner above a domain-specific workspace grid", () => {
    const activeWorkspaceRule = getRuleBody([".workspace.active-layout"]);
    const taskLayoutRule = getRuleBody([".task-workspace-layout"]);

    expect(activeWorkspaceRule).toContain("display: flex;");
    expect(activeWorkspaceRule).toContain("flex-direction: column;");
    expect(activeWorkspaceRule).toContain("align-items: stretch;");
    expect(taskLayoutRule).toContain("display: grid;");
    expect(taskLayoutRule).toContain("minmax(0, 1.62fr) minmax(360px, 1fr)");
  });

  test("does not retain selectors from the deleted generic result workspace", () => {
    for (const selector of [
      ".result-workspace",
      ".result-card",
      ".result-grid",
      ".result-tile",
      ".result-placeholder",
    ]) {
      expect(appCss).not.toContain(selector);
    }
  });

  test("lets the active workspace expand across maximized desktop windows", () => {
    const activeWorkspaceRule = getRuleBody([".workspace.active-layout"]);
    const taskLayoutRule = getRuleBody([".task-workspace-layout"]);

    expect(activeWorkspaceRule).toContain("justify-content: flex-start;");
    expect(activeWorkspaceRule).not.toContain("1120px");
    expect(taskLayoutRule).not.toContain("max-width");
    expect(taskLayoutRule).toContain("min-width: 0;");
  });

  test("uses restrained shared panel tokens without decorative effects in the new workspaces", () => {
    const rootRule = getRuleBody([":root"]);
    const panelRule = getRuleBody([".task-domain-workspace"]);

    expect(rootRule).toContain("--shadow-panel");
    expect(panelRule).toContain("background: var(--surface-raised);");
    expect(panelRule).toContain("border: 1px solid var(--border);");
    expect(panelRule).toContain("box-shadow: var(--shadow-panel-quiet);");
    expect(panelRule).not.toContain("gradient");
    expect(panelRule).not.toContain("backdrop-filter");
  });

  test("uses clearer secondary typography and a 24-16-12 active workspace rhythm", () => {
    const rootRule = getRuleBody([":root"]);
    const h1Rule = getRuleBody(["h1"]);
    const h2Rule = getRuleBody(["h2"]);
    const h3Rule = getRuleBody(["h3"]);
    const labelRule = getRuleBody([".eyebrow", ".section-label"]);
    const activeWorkspaceRule = getRuleBody([".workspace.active-layout"]);
    const taskLayoutRule = getRuleBody([".task-workspace-layout"]);
    const domainRule = getRuleBody([".task-domain-workspace"]);
    const transcriptPanelRule = getRuleBody([".transcript-review-panel"]);
    const historyListRule = getRuleBody([".history-list"]);
    const historyItemSelectRule = getRuleBody([".history-item-select"]);
    const historyMainRule = getRuleBody([".history-item-main"]);
    const localWorkspaceRule = getRuleBody([".local-transcript-workspace"]);

    expect(rootRule).toContain("--text-soft: #747982;");
    expect(rootRule).toContain("--space-3: 12px;");
    expect(rootRule).toContain("--space-4: 16px;");
    expect(rootRule).toContain("--space-6: 24px;");
    expect(h1Rule).toContain("font-weight: 700;");
    expect(h2Rule).toContain("font-weight: 700;");
    expect(h3Rule).toContain("font-weight: 650;");
    expect(labelRule).toContain("font-weight: 700;");
    expect(activeWorkspaceRule).toContain("gap: var(--space-6);");
    expect(taskLayoutRule).toContain("gap: var(--space-4);");
    expect(domainRule).toContain("gap: var(--space-3);");
    expect(transcriptPanelRule).toContain("gap: var(--space-3);");
    expect(historyListRule).toContain("gap: var(--space-3);");
    expect(historyItemSelectRule).toContain("gap: var(--space-3);");
    expect(historyMainRule).toContain("gap: 8px;");
    expect(localWorkspaceRule).toContain("height: min(760px, calc(100vh - 188px));");
    expect(localWorkspaceRule).toContain("min-height: 520px;");
  });

  test("groups transcript segments and AI targets inside quiet list boundaries", () => {
    const segmentListRule = getRuleBody([".transcript-segments"]);
    const segmentRule = getRuleBody([".transcript-segment"]);
    const segmentDividerRule = getRuleBody([".transcript-segment + .transcript-segment"]);
    const targetListRule = getRuleBody([".ai-target-list"]);
    const targetRule = getRuleBody([".ai-target-card"]);
    const targetDividerRule = getRuleBody([".ai-target-card + .ai-target-card"]);
    const activeTargetRule = getRuleBody([
      ".ai-target-card.generating",
      ".ai-target-card.cancelling",
    ]);
    const failedTargetRule = getRuleBody([".ai-target-card.failed"]);

    expect(segmentListRule).toContain("border: 1px solid var(--border);");
    expect(segmentListRule).toContain("overflow: hidden;");
    expect(segmentListRule).toContain("gap: 0;");
    expect(segmentRule).toContain("background: transparent;");
    expect(segmentRule).toContain("border: 0;");
    expect(segmentRule).toContain("border-radius: 0;");
    expect(segmentDividerRule).toContain("border-top: 1px solid var(--border);");

    expect(targetListRule).toContain("border: 1px solid var(--border);");
    expect(targetListRule).toContain("overflow: hidden;");
    expect(targetListRule).toContain("gap: 0;");
    expect(targetRule).toContain("background: transparent;");
    expect(targetRule).toContain("border: 0;");
    expect(targetRule).toContain("border-radius: 0;");
    expect(targetDividerRule).toContain("border-top: 1px solid var(--border);");
    expect(activeTargetRule).toContain("background: #f7fbff;");
    expect(activeTargetRule).not.toContain("border-color");
    expect(failedTargetRule).toContain("background: #fff8f7;");
    expect(failedTargetRule).not.toContain("border-color");
  });

  test("uses a quiet scoped action before final AI confirmation", () => {
    const actionRule = getRuleBody([".ai-target-action"]);
    const actionFeedbackRule = getRuleBody([
      ".ai-target-action:not(:disabled):hover",
      ".ai-target-action:focus-visible",
    ]);

    expect(actionRule).toContain("background: #eef6ff;");
    expect(actionRule).toContain("box-shadow: none;");
    expect(actionRule).toContain("color: #075c9f;");
    expect(actionFeedbackRule).toContain("border-color: #8cc8ff;");
  });

  test("keeps account status and cancel controls in the desktop toolbar system", () => {
    const activeAccountRule = getRuleBody([".account-chip.active"]);
    const activeAccountIconRule = getRuleBody([".account-chip.active svg"]);
    const dangerButtonRule = getRuleBody([".danger-soft"]);
    const dangerHoverRule = getRuleBody([".danger-soft:hover"]);

    expect(activeAccountRule).toContain(
      "background: rgba(255, 255, 255, 0.62);",
    );
    expect(activeAccountRule).toContain("border-color: var(--border);");
    expect(activeAccountRule).toContain("color: #34363b;");
    expect(activeAccountIconRule).toContain("color: var(--success);");
    expect(dangerButtonRule).toContain(
      "background: linear-gradient(180deg, rgba(255, 255, 255, 0.94), rgba(239, 241, 245, 0.9));",
    );
    expect(dangerButtonRule).toContain("border-color: var(--border);");
    expect(dangerButtonRule).toContain("color: #b42318;");
    expect(dangerHoverRule).toContain("background: #fff7f5;");
  });

  test("groups persistent toolbar utilities and keeps the labelled account chip compact", () => {
    const accountRule = getRuleBody([".account-chip"]);
    const toolGroupRule = getRuleBody([".toolbar-tool-group"]);
    const groupedIconRule = getRuleBody([".toolbar-tool-group .icon-button"]);
    const groupedIconFeedbackRule = getRuleBody([
      ".toolbar-tool-group .icon-button:hover",
      ".toolbar-tool-group .icon-button:focus-visible",
    ]);

    expect(appTsx).toMatch(
      /className="toolbar-tool-group"[\s\S]*?aria-label=\{tCommon\("toolbar\.history"\)\}[\s\S]*?aria-label=\{tCommon\("toolbar\.settings"\)\}[\s\S]*?aria-label=\{toolbarNewTaskAriaLabel\}/,
    );
    expect(appTsx).toContain("<span>{accountChipLabel}</span>");
    expect(accountRule).toContain("min-width: 0;");
    expect(accountRule).toContain("min-height: 32px;");
    expect(accountRule).toContain("padding: 0 9px;");
    expect(accountRule).toContain("box-shadow: none;");
    expect(toolGroupRule).toContain("gap: 2px;");
    expect(toolGroupRule).toContain("padding: 2px;");
    expect(groupedIconRule).toContain("height: 32px;");
    expect(groupedIconRule).toContain("min-height: 32px;");
    expect(groupedIconRule).toContain("width: 32px;");
    expect(groupedIconRule).toContain("box-shadow: none;");
    expect(groupedIconRule).toContain("border-color: transparent;");
    expect(groupedIconFeedbackRule).toContain("background: rgba(255, 255, 255, 0.82);");
  });

  test("uses facade cancellation state for the processing cancel action", () => {
    expect(localTranscriptWorkspaceTsx).toContain('t("workspace.cancelling")');
    expect(localTranscriptWorkspaceTsx).toContain('t("workspace.cancel")');
    expect(localTranscriptWorkspaceTsx).toContain("model.cancellation.visible");
    expect(localTranscriptWorkspaceTsx).toContain("disabled={!model.cancellation.enabled}");
    expect(localTranscriptWorkspaceTsx).toContain("model.cancellation.inProgress");
    expect(localTranscriptWorkspaceTsx).not.toContain("workflow.stage");
  });

  test("routes sign-out cancellation through the workflow controller", () => {
    expect(appTsx).not.toContain("void cancelProcess();");
    expect(appTsx).toContain("void cancelCurrentProcessing();");
  });

  test("keeps history task replacement inside the workflow controller", () => {
    expect(appTsx).toContain("restoreHistoryItem(item);");
    expect(appTsx).toContain("selectionDisabled={!canRestoreHistory}");
    expect(appTsx).not.toContain("setWorkflow({");
  });

  test("clamps history titles and keeps metadata aligned across wide and narrow layouts", () => {
    const listRule = getRuleBody([".history-list"]);
    const sheetRule = getRuleBody([".history-modal", ".history-sheet"]);
    const itemRule = getRuleBody([".history-item"]);
    const selectRule = getRuleBody([".history-item-select"]);
    const deleteRule = getRuleBody([".history-item-delete"]);
    const deleteFeedbackRule = getRuleBody([
      ".history-item-delete:not(:disabled):hover",
      ".history-item-delete:focus-visible",
    ]);
    const mainRule = getRuleBody([".history-item-main"]);
    const titleRule = getRuleBody([".history-title"]);
    const metaRule = getRuleBody([".history-meta"]);
    const outputRule = getRuleBody([".history-meta-output"]);
    const outputValueRule = getRuleBody([".history-meta-output .history-meta-value"]);
    const resultRule = getRuleBody([".history-meta-result"]);
    const confirmRule = getRuleBody([".history-delete-confirm"]);
    const dangerRule = getRuleBody([".history-delete-confirm .danger-button"]);

    expect(listRule).toContain("display: flex;");
    expect(listRule).toContain("flex-direction: column;");
    expect(listRule).toContain("flex: 0 1 auto;");
    expect(listRule).toContain("min-height: 0;");
    expect(listRule).toContain("overflow: auto;");
    expect(sheetRule).not.toMatch(/(?:^|\s)(?:height|min-height):/);
    expect(sheetRule).toContain("position: relative;");
    expect(browserSmokeSource).not.toContain("style.height = '720px'");
    expect(listRule).toContain("align-items: stretch;");
    expect(itemRule).toContain("display: grid;");
    expect(itemRule).toContain("flex: 0 0 auto;");
    expect(itemRule).toContain("grid-template-columns: minmax(0, 1fr) 32px;");
    expect(itemRule).toContain("padding: 0;");
    expect(selectRule).toContain("display: flex;");
    expect(selectRule).toContain("flex-direction: column;");
    expect(selectRule).toContain("min-width: 0;");
    expect(deleteRule).toContain("height: 32px;");
    expect(deleteRule).toContain("width: 32px;");
    expect(deleteRule).toContain("padding: 0;");
    expect(deleteFeedbackRule).toContain("background: #fff3f1;");
    expect(confirmRule).toContain("max-width: 440px;");
    expect(dangerRule).toContain("min-height: 40px;");
    expect(dangerRule).toContain("padding: 0 14px;");
    expect(mainRule).toContain("display: flex;");
    expect(mainRule).toContain("flex-direction: column;");
    expect(titleRule).toContain("-webkit-line-clamp: 2;");
    expect(titleRule).toContain("overflow: hidden;");
    expect(titleRule).toContain("overflow-wrap: anywhere;");
    expect(titleRule).not.toContain("min-height");
    expect(titleRule).not.toContain("max-height");
    expect(metaRule).toContain("display: grid;");
    expect(metaRule).toContain("grid-template-columns: max-content minmax(0, 1fr) max-content;");
    expect(outputRule).toContain("min-width: 0;");
    expect(outputValueRule).toContain("overflow: hidden;");
    expect(outputValueRule).toContain("text-overflow: ellipsis;");
    expect(outputValueRule).toContain("white-space: nowrap;");
    expect(resultRule).toContain("justify-self: end;");
    expect(metaRule).toContain("flex: 0 0 auto;");
    expect(appCss).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.history-meta\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) max-content;[\s\S]*?\.history-meta-output\s*\{[\s\S]*?grid-column: 1 \/ -1;/,
    );
  });

  test("uses a custom compact audio review bar instead of the browser audio controls", () => {
    expect(transcriptReviewPanelTsx).toContain('className="audio-review-bar"');
    expect(transcriptReviewPanelTsx).toContain('className="transcript-audio-engine"');
    expect(transcriptReviewPanelTsx).not.toContain('className="transcript-audio"');
    expect(transcriptReviewPanelTsx).not.toContain("controls\n");
  });

  test("renders summary markdown through the markdown content component", () => {
    const markdownRule = getRuleBody([".markdown-content"]);
    const headingRule = getRuleBody([".markdown-content :is(h1, h2, h3, h4)"]);
    const tableRule = getRuleBody([".markdown-content table"]);

    expect(aiResultDetailSheetTsx).toContain("MarkdownContent");
    expect(aiResultDetailSheetTsx).toContain('markdown={workflow.summary}');
    expect(markdownRule).toContain("white-space: normal;");
    expect(markdownRule).toContain("overflow-wrap: anywhere;");
    expect(headingRule).toContain("line-height: 1.35;");
    expect(tableRule).toContain("overflow-x: auto;");
  });

  test("keeps the transcript audio review bar in the requested single-line player style", () => {
    const barRule = getRuleBody([".audio-review-bar"]);
    const playButtonRule = getRuleBody([".audio-play-button"]);
    const clockRule = getRuleBody([".audio-review-clock"]);
    const scrubberRule = getRuleBody([".audio-review-scrubber"]);
    const webkitTrackRule = getRuleBody([".audio-review-scrubber::-webkit-slider-runnable-track"]);
    const webkitThumbRule = getRuleBody([".audio-review-scrubber::-webkit-slider-thumb"]);

    expect(transcriptReviewPanelTsx).not.toContain('className="audio-review-actions"');
    expect(transcriptReviewPanelTsx).not.toContain('className="audio-review-timeline"');
    expect(transcriptReviewPanelTsx).toMatch(
      /className="audio-review-bar"[\s\S]*?<button[\s\S]*?<\/button>\s*<input[\s\S]*?className="audio-review-scrubber"[\s\S]*?\/>\s*<div className="audio-review-clock">/,
    );
    expect(transcriptReviewPanelTsx).toContain("transcriptAudioScrubberStyle");
    expect(transcriptReviewSessionTs).toContain("--audio-progress");
    expect(barRule).toContain("grid-template-columns: 48px minmax(0, 1fr) max-content;");
    expect(barRule).toContain("align-items: center;");
    expect(barRule).toContain("column-gap: 16px;");
    expect(barRule).toContain("min-height: 72px;");
    expect(barRule).toContain("padding: 12px 16px;");
    expect(playButtonRule).toContain("height: 48px;");
    expect(playButtonRule).toContain("width: 48px;");
    expect(playButtonRule).not.toContain("transform");
    expect(scrubberRule).toContain("display: block;");
    expect(scrubberRule).toContain("min-width: 0;");
    expect(scrubberRule).toContain("align-self: center;");
    expect(clockRule).toContain("justify-self: end;");
    expect(clockRule).toContain("min-width: 0;");
    expect(clockRule).toContain("font-variant-numeric: tabular-nums;");
    expect(clockRule).toContain("line-height: 1;");
    expect(clockRule).not.toContain("min-width: 126px;");
    expect(clockRule).toContain("font-weight: 760;");
    expect(scrubberRule).toContain("appearance: none;");
    expect(webkitTrackRule).toContain("#2388f2");
    expect(webkitTrackRule).toContain("#2fc66d");
    expect(webkitTrackRule).toContain("height: 8px;");
    expect(webkitThumbRule).toContain("background: transparent;");
    expect(webkitThumbRule).toContain("height: 18px;");
    expect(webkitThumbRule).toContain("width: 18px;");
    expect(webkitThumbRule).not.toMatch(/margin(?:-top)?:\s*-/);
  });

  test("uses a dedicated accessible 32px transcript segment edit control", () => {
    const editRule = getRuleBody([".transcript-segment-edit"]);
    const editFeedbackRule = getRuleBody([
      ".transcript-segment-edit:not(:disabled):hover",
      ".transcript-segment-edit:focus-visible",
    ]);

    expect(transcriptReviewPanelTsx).toContain(
      'className="secondary-button compact-button transcript-segment-edit"',
    );
    expect(transcriptReviewPanelTsx).toContain('aria-label={t("review.editSegment")}');
    expect(transcriptReviewPanelTsx).toContain('title={t("review.edit")}');
    expect(editRule).toContain("height: 32px;");
    expect(editRule).toContain("min-height: 32px;");
    expect(editRule).toContain("width: 32px;");
    expect(editRule).toContain("min-width: 32px;");
    expect(editRule).toContain("padding: 0;");
    expect(editRule).toContain("align-items: center;");
    expect(editRule).toContain("justify-content: center;");
    expect(editFeedbackRule).toContain("background: #eef7ff;");
    expect(editFeedbackRule).toContain("border-color: #b8dcff;");
  });

  test("keeps playback, editing, and keyboard focus visually distinct", () => {
    const activeRule = getRuleBody([".transcript-segment.active"]);
    const editingRule = getRuleBody([".transcript-segment.editing"]);

    expect(activeRule).toContain("background: #eef6ff;");
    expect(activeRule).toContain("box-shadow: inset 2px 0 0 var(--primary);");
    expect(activeRule).not.toContain("0 0 0 3px");
    expect(editingRule).toContain("background: #fff;");
    expect(editingRule).toContain("box-shadow: none;");
    expect(appCss).toContain(":focus-visible");
  });

  test("keeps the settings sheet grouped and scannable", () => {
    const settingsModalRule = getRuleBody([".settings-modal", ".settings-sheet"]);
    const layoutRule = getRuleBody([".settings-layout"]);
    const navRule = getRuleBody([".settings-nav"]);
    const navItemRule = getRuleBody([".settings-nav-item"]);
    const selectedNavItemRule = getRuleBody([".settings-nav-item.selected"]);
    const sectionsRule = getRuleBody([".settings-sections"]);
    const privacyCalloutRule = getRuleBody([".settings-warning", ".privacy-callout"]);
    const statusCardRule = getRuleBody([".settings-status-card"]);
    const summaryListRule = getRuleBody([".settings-summary-list"]);
    const inspirationActionsRule = getRuleBody([".inspiration-settings-actions"]);
    const profileEditButtonRule = getRuleBody([".profile-edit-button"]);
    const profileClearButtonRule = getRuleBody([".profile-clear-button"]);

    expect(settingsSheetTsx).toContain('className="settings-layout"');
    expect(settingsSheetTsx).toContain('className="settings-nav"');
    expect(settingsControllerTs).toContain('const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("basic")');
    expect(settingsSheetTsx).toContain('data-settings-category={item.id}');
    expect(settingsSheetTsx).toContain('id="settings-inspiration"');
    expect(settingsSheetTsx).toContain('className="settings-summary-list"');
    expect(settingsSheetTsx).toContain("profile-edit-button");
    expect(settingsSheetTsx).toContain("profile-clear-button");
    expect(settingsSheetTsx).toContain('settingsCategory === "inspiration"');
    expect(settingsModalRule).toContain("max-width: 800px;");
    expect(layoutRule).toContain("grid-template-columns: 176px minmax(0, 1fr);");
    expect(navRule).toContain("border-right: 1px solid var(--border);");
    expect(navItemRule).toContain("box-shadow: none;");
    expect(navItemRule).toContain("display: flex;");
    expect(navItemRule).toContain("flex-direction: column;");
    expect(navItemRule).toContain("height: 64px;");
    expect(navItemRule).toContain("justify-content: center;");
    expect(navItemRule).toContain("padding: 0 14px;");
    expect(navItemRule).toContain("align-items: flex-start;");
    expect(selectedNavItemRule).toContain("background: rgba(255, 255, 255, 0.86);");
    expect(sectionsRule).toContain("overflow: auto;");
    expect(privacyCalloutRule).toContain("background: rgba(248, 249, 252, 0.78);");
    expect(privacyCalloutRule).toContain("color: var(--text-muted);");
    expect(statusCardRule).toContain("box-shadow: none;");
    expect(summaryListRule).toContain("flex-wrap: wrap;");
    expect(inspirationActionsRule).toContain("align-items: center;");
    expect(inspirationActionsRule).toContain("justify-content: flex-start;");
    expect(profileEditButtonRule).toContain("width: auto;");
    expect(profileEditButtonRule).toContain("min-height: 36px;");
    expect(inspirationActionsRule).toContain("display: flex;");
    expect(inspirationActionsRule).toContain("flex-wrap: nowrap;");
    expect(profileClearButtonRule).toContain(
      "background: linear-gradient(180deg, rgba(255, 255, 255, 0.94), rgba(239, 241, 245, 0.9));",
    );
    expect(profileClearButtonRule).toContain("border-color: var(--border);");
    expect(profileClearButtonRule).toContain("color: #34363b;");
    expect(profileClearButtonRule).toContain("min-height: 36px;");
  });

  test("scopes the compact local settings notice to the basic category", () => {
    const basicNoticeRule = getRuleBody([".settings-basic-note"]);

    expect(settingsSheetTsx.match(/className="settings-basic-note"/g)).toHaveLength(1);
    expect(settingsSheetTsx).toMatch(
      /settingsCategory === "basic"[\s\S]*?className="settings-basic-note"[\s\S]*?id="settings-basic"/,
    );
    expect(settingsSheetTsx).toContain('tSettings("basic.privacy")');
    expect(settingsSheetTsx).not.toContain(
      "AI 结果 LLM 由管理员在服务端统一配置，客户端无需手动填写 API Key。",
    );
    expect(basicNoticeRule).toContain("display: flex;");
    expect(basicNoticeRule).toContain("color: var(--text-muted);");
    expect(basicNoticeRule).not.toContain("background");
    expect(basicNoticeRule).not.toContain("border:");
  });
});
