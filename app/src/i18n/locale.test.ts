import { describe, expect, test, vi } from "vitest";
import {
  SUPPORTED_LOCALES,
  isLanguagePreference,
  isSupportedLocale,
  observeSystemLocale,
  resolveLanguagePreference,
  resolveSystemLocale,
  syncDocumentLocale,
  type SystemLanguageSource,
} from "./locale";

describe("locale resolution", () => {
  test("exposes only the three supported locales", () => {
    expect(SUPPORTED_LOCALES).toEqual(["zh-CN", "zh-TW", "en-US"]);
    expect(isSupportedLocale("zh-CN")).toBe(true);
    expect(isSupportedLocale("zh-HK")).toBe(false);
    expect(isLanguagePreference("system")).toBe(true);
    expect(isLanguagePreference("fr-FR")).toBe(false);
  });

  test.each([
    [["zh-Hant-TW"], "zh-TW"],
    [["zh_hant_hk"], "zh-TW"],
    [["zh-Hant-CN"], "zh-TW"],
    [["zh-MO"], "zh-TW"],
    [["zh-Hans-SG"], "zh-CN"],
    [["zh-Hans-HK"], "zh-CN"],
    [["zh_CN"], "zh-CN"],
    [["zh"], "zh-CN"],
    [["en-GB"], "en-US"],
    [["fr-FR"], "en-US"],
    [[], "en-US"],
  ] as const)("maps navigator languages %j to %s", (languages, expected) => {
    expect(resolveSystemLocale(languages)).toBe(expected);
  });

  test("uses the first supported language in navigator priority order", () => {
    expect(resolveSystemLocale(["fr-CA", "zh-Hant-MO", "en-US"])).toBe("zh-TW");
    expect(resolveSystemLocale(["en-AU", "zh-TW"])).toBe("en-US");
  });

  test("resolves explicit preferences without consulting system languages", () => {
    expect(resolveLanguagePreference("zh-TW", ["en-US"])).toBe("zh-TW");
    expect(resolveLanguagePreference("system", ["zh-Hans-CN"])).toBe("zh-CN");
  });

  test("synchronizes the root document language and direction", () => {
    const root = { lang: "en", dir: "" };
    syncDocumentLocale("zh-TW", root);
    expect(root).toEqual({ lang: "zh-TW", dir: "ltr" });
  });
});

describe("system language observation", () => {
  test("subscribes only while the explicit preference is system", () => {
    let listener: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((next: () => void) => {
      listener = next;
      return unsubscribe;
    });
    const source: SystemLanguageSource = {
      getLanguages: () => ["zh-Hant-HK"],
      subscribe,
    };
    const onLocale = vi.fn();

    expect(observeSystemLocale("en-US", source, onLocale)).toBeUndefined();
    expect(subscribe).not.toHaveBeenCalled();

    const cleanup = observeSystemLocale("system", source, onLocale);
    expect(subscribe).toHaveBeenCalledOnce();
    listener?.();
    expect(onLocale).toHaveBeenCalledWith("zh-TW");

    cleanup?.();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
