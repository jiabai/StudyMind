import type { SupportedLocale } from "./locale";
import { resources } from "./resources";

const DATE_TIME_COMPONENT_KEYS: ReadonlyArray<keyof Intl.DateTimeFormatOptions> = [
  "dateStyle",
  "timeStyle",
  "weekday",
  "era",
  "year",
  "month",
  "day",
  "dayPeriod",
  "hour",
  "minute",
  "second",
  "timeZoneName",
];

export function formatDateTime(
  value: Date | number,
  locale: SupportedLocale,
  options: Intl.DateTimeFormatOptions = {},
): string {
  const hasCustomComponents = DATE_TIME_COMPONENT_KEYS.some(
    (key) => options[key] !== undefined,
  );
  return new Intl.DateTimeFormat(locale, {
    ...(hasCustomComponents ? {} : { dateStyle: "medium", timeStyle: "short" }),
    ...options,
  }).format(value);
}

export function formatNumber(
  value: number,
  locale: SupportedLocale,
  options: Intl.NumberFormatOptions = {},
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatPercent(
  value: number,
  locale: SupportedLocale,
  options: Intl.NumberFormatOptions = {},
): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 0,
    ...options,
  }).format(value);
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(value: number, locale: SupportedLocale): string {
  const bytes = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (bytes < 1024) {
    return `${formatNumber(Math.round(bytes), locale)} B`;
  }

  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    BYTE_UNITS.length - 1,
  );
  const amount = bytes / 1024 ** unitIndex;
  return `${formatNumber(amount, locale, { maximumFractionDigits: 1 })} ${BYTE_UNITS[unitIndex]}`;
}

export function selectPluralCategory(
  value: number,
  locale: SupportedLocale,
): Intl.LDMLPluralRule {
  return new Intl.PluralRules(locale).select(value);
}

export function formatWordCount(value: number, locale: SupportedLocale): string {
  const count = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  const category = selectPluralCategory(count, locale) === "one" ? "one" : "other";
  const template = resources[locale].common[`wordCount_${category}`];
  return template.replace("{{formattedCount}}", formatNumber(count, locale));
}

type WordSegment = { readonly isWordLike?: boolean };
type WordSegmenter = {
  segment(input: string): Iterable<WordSegment>;
};
type WordSegmenterConstructor = new (
  locale: string,
  options: { granularity: "word" },
) => WordSegmenter;

export function countTextUnits(text: string, locale: SupportedLocale): number {
  if (locale !== "en-US") {
    return [...text].filter((character) => !/\s/u.test(character)).length;
  }

  const Segmenter = (Intl as unknown as { Segmenter?: WordSegmenterConstructor })
    .Segmenter;
  if (Segmenter) {
    const segmenter = new Segmenter(locale, { granularity: "word" });
    return [...segmenter.segment(text)].filter((segment) => segment.isWordLike).length;
  }

  return text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

export function formatTextUnitCount(text: string, locale: SupportedLocale): string {
  return formatWordCount(countTextUnits(text, locale), locale);
}
