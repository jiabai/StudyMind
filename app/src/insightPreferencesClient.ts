import { invoke } from "@tauri-apps/api/core";
import type { InvokeArgs } from "@tauri-apps/api/core";
import {
  isPreferenceOptionId,
  validateGenerationPreferences,
  validateInspirationProfile,
  type GenerationPreferences,
  type InspirationProfile,
} from "./insightPreferences";

export type InsightProfileStatus = "missing" | "valid" | "skipped" | "invalid";

export type LegacyGenerationPreferenceSeed = {
  styles: string[];
  avoid: string[];
};

export type InsightPreferenceState = {
  profile: InspirationProfile | null;
  profileSkipped: boolean;
  profileStatus: InsightProfileStatus;
  profileError: string | null;
  defaultGenerationPreferences: GenerationPreferences | null;
  legacyGenerationPreferenceSeed: LegacyGenerationPreferenceSeed | null;
  preferencesPath: string;
};

export type InsightPreferenceCommandRunner = (
  command: string,
  args: InvokeArgs,
) => Promise<unknown>;

const defaultRunner: InsightPreferenceCommandRunner = (command, args) => invoke(command, args);

export async function getInsightPreferences(
  runner: InsightPreferenceCommandRunner = defaultRunner,
): Promise<InsightPreferenceState> {
  return normalizePreferenceState(await runner("get_insight_preferences", {}));
}

export async function saveInspirationProfile(
  profile: InspirationProfile,
  runner: InsightPreferenceCommandRunner = defaultRunner,
): Promise<InsightPreferenceState> {
  return normalizePreferenceState(await runner("save_inspiration_profile", { profile }));
}

export async function skipInspirationProfile(
  runner: InsightPreferenceCommandRunner = defaultRunner,
): Promise<InsightPreferenceState> {
  return normalizePreferenceState(await runner("skip_inspiration_profile", {}));
}

export async function clearInspirationProfile(
  runner: InsightPreferenceCommandRunner = defaultRunner,
): Promise<InsightPreferenceState> {
  return normalizePreferenceState(await runner("clear_inspiration_profile", {}));
}

export async function saveDefaultGenerationPreferences(
  preferences: GenerationPreferences,
  runner: InsightPreferenceCommandRunner = defaultRunner,
): Promise<InsightPreferenceState> {
  return normalizePreferenceState(
    await runner("save_default_generation_preferences", { preferences }),
  );
}

function normalizePreferenceState(value: unknown): InsightPreferenceState {
  const record = isRecord(value) ? value : {};
  const profile = validateInspirationProfile(record.profile);
  const defaultGenerationPreferences = validateGenerationPreferences(
    record.defaultGenerationPreferences,
  );
  const legacyGenerationPreferenceSeed = normalizeLegacyGenerationPreferenceSeed(
    record.legacyGenerationPreferenceSeed,
  );
  const profileStatus = normalizeProfileStatus(record.profileStatus);

  return {
    profile,
    profileSkipped: record.profileSkipped === true,
    profileStatus,
    profileError: typeof record.profileError === "string" ? record.profileError : null,
    defaultGenerationPreferences,
    legacyGenerationPreferenceSeed,
    preferencesPath: typeof record.preferencesPath === "string" ? record.preferencesPath : "",
  };
}

function normalizeLegacyGenerationPreferenceSeed(
  value: unknown,
): LegacyGenerationPreferenceSeed | null {
  if (!isRecord(value)) {
    return null;
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "avoid" || keys[1] !== "styles") {
    return null;
  }
  const styles = normalizeLegacySeedValues(value.styles, "styles");
  const avoid = normalizeLegacySeedValues(value.avoid, "avoid");
  if (styles === null || avoid === null) {
    return null;
  }
  return { styles, avoid };
}

function normalizeLegacySeedValues(
  value: unknown,
  field: "styles" | "avoid",
): string[] | null {
  if (!Array.isArray(value) || value.length > 3) {
    return null;
  }
  const normalized: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      return null;
    }
    const id: unknown = value[index];
    if (typeof id !== "string" || !isPreferenceOptionId(field, id)) {
      return null;
    }
    normalized.push(id);
  }
  if (new Set(normalized).size !== normalized.length) {
    return null;
  }
  return normalized;
}

function normalizeProfileStatus(value: unknown): InsightProfileStatus {
  return value === "valid" || value === "skipped" || value === "invalid" ? value : "missing";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
