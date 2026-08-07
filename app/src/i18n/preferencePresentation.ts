import {
  GENERATION_FIELD_ORDER,
  INSIGHT_PREFERENCE_FIELDS,
  PROFILE_FIELD_ORDER,
  isPreferenceOptionId,
  type GenerationPreferences,
  type InspirationProfile,
  type PreferenceField,
} from "../insightPreferences";
import type { SupportedLocale } from "./locale";
import { preferenceResources } from "./preferenceResources";

export type LocalizedPreferenceField = {
  label: string;
  options: Array<{ id: string; label: string }>;
};

export function getPreferenceCopy(locale: SupportedLocale) {
  return preferenceResources[locale];
}

export function getPreferenceFieldPresentation(
  locale: SupportedLocale,
  field: PreferenceField,
): LocalizedPreferenceField {
  const presentation = preferenceResources[locale].fields[field] as {
    readonly label: string;
    readonly options: Readonly<Record<string, string>>;
  };
  return {
    label: presentation.label,
    options: INSIGHT_PREFERENCE_FIELDS[field].options.map(({ id }) => ({
      id,
      label: presentation.options[id],
    })),
  };
}

export function getOutputLanguageName(
  displayLocale: SupportedLocale,
  outputLanguage: SupportedLocale,
): string {
  const names = preferenceResources[displayLocale].outputLanguage.names;
  if (outputLanguage === "zh-CN") {
    return names.zhCN;
  }
  if (outputLanguage === "zh-TW") {
    return names.zhTW;
  }
  return names.enUS;
}

export function summarizeInspirationProfile(
  profile: InspirationProfile | null,
  locale: SupportedLocale,
): string[] {
  if (!profile) {
    return [preferenceResources[locale].summary.profileNotSet];
  }
  return summarizeFields(PROFILE_FIELD_ORDER, profile, locale, {
    skipUnspecifiedSingles: true,
    skipEmptyMulti: true,
  });
}

export function summarizeGenerationPreferences(
  preferences: GenerationPreferences,
  locale: SupportedLocale,
): string[] {
  return summarizeFields(GENERATION_FIELD_ORDER, preferences, locale, {
    skipUnspecifiedSingles: false,
    skipEmptyMulti: false,
  });
}

export function interpolatePreferenceCopy(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/{{(\w+)}}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  );
}

function summarizeFields(
  fields: readonly PreferenceField[],
  values: Record<string, string | string[]>,
  locale: SupportedLocale,
  options: { skipUnspecifiedSingles: boolean; skipEmptyMulti: boolean },
): string[] {
  const copy = preferenceResources[locale];
  const lines: string[] = [];
  for (const field of fields) {
    const config = INSIGHT_PREFERENCE_FIELDS[field];
    const presentation = getPreferenceFieldPresentation(locale, field);
    const labelsById = new Map(presentation.options.map((option) => [option.id, option.label]));
    const rawValue = values[field];

    if (config.mode === "single") {
      if (typeof rawValue !== "string" || !isPreferenceOptionId(field, rawValue)) {
        continue;
      }
      if (options.skipUnspecifiedSingles && rawValue === "unspecified") {
        continue;
      }
      lines.push(
        `${presentation.label}${copy.summary.separator}${labelsById.get(rawValue)}`,
      );
      continue;
    }

    if (!Array.isArray(rawValue)) {
      continue;
    }
    const selectedLabels = rawValue
      .filter((id) => isPreferenceOptionId(field, id))
      .map((id) => labelsById.get(id))
      .filter((label): label is string => Boolean(label));
    if (selectedLabels.length === 0 && options.skipEmptyMulti) {
      continue;
    }
    const renderedValues =
      selectedLabels.length > 0
        ? selectedLabels.join(copy.summary.valueSeparator)
        : copy.summary.unspecified;
    lines.push(`${presentation.label}${copy.summary.separator}${renderedValues}`);
  }
  return lines;
}
