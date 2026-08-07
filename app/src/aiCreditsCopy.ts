import type { SupportedLocale } from "./i18n/locale";
import { resources } from "./i18n/resources";

function formatNumber(value: number, locale: SupportedLocale): string {
  return new Intl.NumberFormat(locale).format(value);
}

function creditsCopy(locale: SupportedLocale) {
  return resources[locale].synthesis.credits;
}

export function formatAiCreditsBalance(
  credits: number,
  locale: SupportedLocale,
): string {
  return creditsCopy(locale).balance.replace(
    "{{formattedCount}}",
    formatNumber(credits, locale),
  );
}

export function formatAiCreditsAllocation(
  remaining: number,
  limit: number,
  locale: SupportedLocale,
): string {
  return creditsCopy(locale).allocation
    .replace("{{remaining}}", formatNumber(remaining, locale))
    .replace("{{limit}}", formatNumber(limit, locale));
}

export function getAiCreditsCostHint(locale: SupportedLocale): string {
  return creditsCopy(locale).costHint;
}

export function getAiCreditsDisclosureCopy(locale: SupportedLocale): string {
  return creditsCopy(locale).disclosure;
}
