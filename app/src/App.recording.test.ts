import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const appSidebarSource = readFileSync(
  new URL("./features/sidebar/AppSidebar.tsx", import.meta.url),
  "utf8",
);
const userMenuSource = readFileSync(
  new URL("./features/sidebar/SidebarUserMenu.tsx", import.meta.url),
  "utf8",
);

function waitingInputSource(): string {
  const start = appSource.indexOf('{workflow.stage === "waiting_input" ? (');
  const end = appSource.indexOf("\n          ) : (", start);
  return start >= 0 && end >= 0 ? appSource.slice(start, end) : "";
}

describe("App recording entry integration", () => {
  test("renders upload and recording cards together for waiting input", () => {
    const source = waitingInputSource();

    expect(source).toContain('className="workflow-entry-grid"');
    expect(source).toContain("<HeroUploadZone");
    expect(source).toContain("<RecordingCard");
  });

  test("hands recording output to the existing local media selection flow", () => {
    expect(appSource).toMatch(
      /useRecordingController\(\{[\s\S]*?onLocalMediaSelected:\s*setLocalMediaSelection[\s\S]*?\}\)/,
    );
  });

  test("disables upload while recording is starting, recording, or stopping", () => {
    expect(appSource).toMatch(
      /const recordingActive\s*=\s*\["starting",\s*"recording",\s*"stopping"\][\s\S]*?\.includes\(\s*recordingController\.session\.status\s*,?\s*\)/,
    );
    expect(waitingInputSource()).toContain("disabled={recordingActive}");
  });

  test("does not pass raw recording details into entry UI", () => {
    const source = waitingInputSource();

    expect(source).not.toMatch(/(?:rawError|sourcePath|selectionToken|accessToken|sessionToken)/);
    expect(source).not.toMatch(/(?:error|path|token)={/i);
  });

  test("guards app-level topic navigation, deletion, and sign-out callbacks", () => {
    expect(appSource).toContain("recordingActiveRef.current = recordingActive");
    expect(appSource).toMatch(/if \(recordingActiveRef\.current\)/);
    expect(appSource).toMatch(/handleHistoryItemSelected[\s\S]*?if \(recordingActiveRef\.current\)/);
    expect(appSource).toMatch(/handleHistoryItemDeleted[\s\S]*?if \(recordingActiveRef\.current\)/);
    expect(appSource).toMatch(/handleNewTopic[\s\S]*?if \(recordingActiveRef\.current\)/);
    expect(appSource).toMatch(/handleSignOut[\s\S]*?if \(recordingActiveRef\.current\)/);
    expect(appSource).toContain("selectionDisabled={!canRestoreHistory}");
    expect(appSource).toContain("deletionDisabled={!canDeleteHistory}");
    expect(appSource).toContain("newTopicDisabled={toolbarNewTaskButtonState.disabled}");
    expect(appSource).toContain("signOutDisabled={recordingActive}");
  });

  test("does not hide the recording entry while account state changes during recording", () => {
    expect(appSource).toMatch(/const loginGuideVisible =[^;]*!recordingActive/);
    expect(waitingInputSource()).toContain("startDisabled={accountLoading}");
    expect(appSource).toMatch(/<AccountSheet[\s\S]*?recordingActive=\{recordingActive\}/);
  });

  test("propagates recording sign-out lock through the sidebar menu", () => {
    expect(appSource).toContain("recordingActive={recordingActive}");
    expect(appSidebarSource).toContain("recordingActive: boolean");
    expect(appSidebarSource).toContain("signOutDisabled={signOutDisabled}");
    expect(userMenuSource).toContain("signOutDisabled: boolean");
    expect(userMenuSource).toContain("disabled={!signedIn || signOutDisabled}");
  });
});
