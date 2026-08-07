export const SUPPORTED_LOCALES = ["zh-CN", "zh-TW", "en-US"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export type LanguagePreference = "system" | SupportedLocale;

export interface SystemLanguageSource {
  getLanguages(): readonly string[];
  subscribe(listener: () => void): () => void;
}

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === "string" && SUPPORTED_LOCALES.includes(value as SupportedLocale);
}

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === "system" || isSupportedLocale(value);
}

function mapLanguageTag(languageTag: string): SupportedLocale | undefined {
  const normalized = languageTag.trim().replace(/_/g, "-").toLowerCase();
  if (!normalized) {
    return undefined;
  }

  const subtags = normalized.split("-");
  if (subtags[0] === "zh") {
    if (subtags.includes("hant")) {
      return "zh-TW";
    }
    if (subtags.includes("hans")) {
      return "zh-CN";
    }
    if (subtags.some((subtag) => ["tw", "hk", "mo"].includes(subtag))) {
      return "zh-TW";
    }
    return "zh-CN";
  }

  if (subtags[0] === "en") {
    return "en-US";
  }

  return undefined;
}

export function resolveSystemLocale(languages: readonly string[]): SupportedLocale {
  for (const language of languages) {
    const mapped = mapLanguageTag(language);
    if (mapped) {
      return mapped;
    }
  }
  return "en-US";
}

export function resolveLanguagePreference(
  preference: LanguagePreference,
  systemLanguages: readonly string[],
): SupportedLocale {
  return preference === "system" ? resolveSystemLocale(systemLanguages) : preference;
}

export const navigatorLanguageSource: SystemLanguageSource = {
  getLanguages(): readonly string[] {
    if (typeof navigator === "undefined") {
      return [];
    }
    if (navigator.languages.length > 0) {
      return navigator.languages;
    }
    return navigator.language ? [navigator.language] : [];
  },
  subscribe(listener: () => void): () => void {
    if (typeof window === "undefined") {
      return () => undefined;
    }
    window.addEventListener("languagechange", listener);
    return () => window.removeEventListener("languagechange", listener);
  },
};

export function observeSystemLocale(
  preference: LanguagePreference,
  source: SystemLanguageSource,
  onLocale: (locale: SupportedLocale) => void,
): (() => void) | undefined {
  if (preference !== "system") {
    return undefined;
  }

  return source.subscribe(() => {
    onLocale(resolveSystemLocale(source.getLanguages()));
  });
}

export function syncDocumentLocale(
  locale: SupportedLocale,
  root: Pick<HTMLElement, "lang" | "dir"> | undefined =
    typeof document === "undefined" ? undefined : document.documentElement,
): void {
  if (!root) {
    return;
  }
  root.lang = locale;
  root.dir = "ltr";
}
