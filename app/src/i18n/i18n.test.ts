import { describe, expect, test } from "vitest";
import { StudyMindI18n, initializeI18n } from "./i18n";

describe("offline i18n instance", () => {
  test("initializes from bundled namespaced resources and switches locales", async () => {
    await initializeI18n("zh-TW");
    expect(StudyMindI18n.isInitialized).toBe(true);
    expect(StudyMindI18n.t("language.title", { ns: "settings" })).toBe(
      "介面與 AI 結果語言",
    );

    await initializeI18n("en-US");
    expect(StudyMindI18n.t("language.options.system", { ns: "settings" })).toBe(
      "Use system language",
    );
    expect(Object.keys(StudyMindI18n.store.data).sort()).toEqual([
      "en-US",
      "zh-CN",
      "zh-TW",
    ]);
  });
});
