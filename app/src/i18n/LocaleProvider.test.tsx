import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { LanguagePreferenceField } from "../features/settings/LanguagePreferenceField";
import {
  LocaleProvider,
  useLocale,
  type LocalePersistence,
} from "./LocaleProvider";
import { initializeI18n } from "./i18n";
import type { SystemLanguageSource } from "./locale";

function LocaleProbe() {
  const locale = useLocale();
  return <output>{`${locale.preference}|${locale.resolvedLocale}`}</output>;
}

describe("LocaleProvider foundation", () => {
  test("provides the startup locale and renders the language selector without remount keys", async () => {
    await initializeI18n("en-US");
    const languageSource: SystemLanguageSource = {
      getLanguages: () => ["en-US"],
      subscribe: vi.fn(() => () => undefined),
    };
    const persistence: LocalePersistence = {
      read: async () => "en-US",
      save: async (preference) => preference,
    };

    const markup = renderToStaticMarkup(
      <LocaleProvider
        initialOutcome={{
          preference: "en-US",
          resolvedLocale: "en-US",
          persistedAnchor: "en-US",
          notice: null,
        }}
        languageSource={languageSource}
        persistence={persistence}
      >
        <LanguagePreferenceField />
        <LocaleProbe />
      </LocaleProvider>,
    );

    expect(markup).toContain("Interface &amp; AI result language");
    expect(markup).toContain('<option value="system">Use system language</option>');
    expect(markup).toContain('<option value="en-US" selected="">English</option>');
    expect(markup).toContain("en-US|en-US");
  });

  test("renders startup recovery as localized, nonblocking status copy", async () => {
    await initializeI18n("zh-CN");
    const markup = renderToStaticMarkup(
      <LocaleProvider
        initialOutcome={{
          preference: "system",
          resolvedLocale: "zh-CN",
          persistedAnchor: "system",
          notice: { messageCode: "bootstrap.preferencesRecovered" },
        }}
      >
        <span>content remains available</span>
      </LocaleProvider>,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain("语言偏好文件已损坏");
    expect(markup).toContain("content remains available");
  });
});
