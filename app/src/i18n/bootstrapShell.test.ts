import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const indexHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
const settingsSource = readFileSync(
  new URL("../features/settings/SettingsSheet.tsx", import.meta.url),
  "utf8",
);
const languageFieldSource = readFileSync(
  new URL("../features/settings/LanguagePreferenceField.tsx", import.meta.url),
  "utf8",
);

describe("localized application bootstrap", () => {
  test("shows only a neutral StudyMind shell while preferences race the 1.5 second deadline", () => {
    expect(indexHtml).toContain('<html lang="en-US" dir="ltr">');
    expect(indexHtml).toContain("<title>StudyMind</title>");
    expect(indexHtml).toMatch(/<div id="root">[\s\S]*?StudyMind[\s\S]*?<\/div>/);
    expect(indexHtml).not.toContain("Tauri + React + Typescript");
  });

  test("runs the startup race outside React and mounts one unkeyed App tree", () => {
    expect(mainSource).toContain("startLocalizedApplication({");
    expect(mainSource.indexOf("startLocalizedApplication({")).toBeLessThan(
      mainSource.indexOf("ReactDOM.createRoot"),
    );
    expect(mainSource.match(/ReactDOM\.createRoot/g)).toHaveLength(1);
    expect(mainSource).toContain("<LocaleProvider initialOutcome={outcome}>");
    expect(mainSource).toContain("<App />");
    expect(mainSource).not.toMatch(/<App\s+key=/);
  });

  test("places the independent language selector first in Basic settings", () => {
    const fieldPosition = settingsSource.indexOf("<LanguagePreferenceField />");
    const basicNoticePosition = settingsSource.indexOf('className="settings-basic-note"');
    const asrPosition = settingsSource.indexOf("settingsDraft.asrModel");
    expect(fieldPosition).toBeGreaterThan(-1);
    expect(fieldPosition).toBeLessThan(basicNoticePosition);
    expect(fieldPosition).toBeLessThan(asrPosition);
    expect(languageFieldSource).not.toContain("settingsDraft");
    expect(languageFieldSource).not.toContain("asrModel");
    expect(languageFieldSource).not.toContain("outputDir");
  });
});
