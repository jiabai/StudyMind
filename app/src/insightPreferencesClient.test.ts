import { describe, expect, test } from "vitest";
import {
  clearInspirationProfile,
  getInsightPreferences,
  saveDefaultGenerationPreferences,
  saveInspirationProfile,
  skipInspirationProfile,
  type InsightPreferenceCommandRunner,
} from "./insightPreferencesClient";
import { createInsightPreferenceFlow } from "./insightPreferenceFlow";
import type { GenerationPreferences, InspirationProfile } from "./insightPreferences";

const PROFILE: InspirationProfile = {
  role: "marketing_sales",
  domain: "marketing_sales",
  stage: "manager",
  cityContext: "new_tier1_city",
  genderPerspective: "unspecified",
  platforms: ["douyin"],
};

const GENERATION_PREFERENCES: GenerationPreferences = {
  goal: "content_creation",
  scenario: "short_video",
  angles: ["topic_angle"],
  audience: "beginners",
  styles: ["direct_sharp"],
  avoid: [],
};

describe("insight preferences client", () => {
  test("invokes preference commands with stable Tauri payloads", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: InsightPreferenceCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return preferenceState();
    };

    await getInsightPreferences(runner);
    await saveInspirationProfile(PROFILE, runner);
    await skipInspirationProfile(runner);
    await clearInspirationProfile(runner);
    await saveDefaultGenerationPreferences(GENERATION_PREFERENCES, runner);

    expect(calls).toEqual([
      { command: "get_insight_preferences", args: {} },
      { command: "save_inspiration_profile", args: { profile: PROFILE } },
      { command: "skip_inspiration_profile", args: {} },
      { command: "clear_inspiration_profile", args: {} },
      {
        command: "save_default_generation_preferences",
        args: { preferences: GENERATION_PREFERENCES },
      },
    ]);
  });

  test("normalizes missing response fields to a safe local state", async () => {
    const runner: InsightPreferenceCommandRunner = async () => ({});

    await expect(getInsightPreferences(runner)).resolves.toEqual({
      profile: null,
      profileSkipped: false,
      profileStatus: "missing",
      profileError: null,
      defaultGenerationPreferences: null,
      legacyGenerationPreferenceSeed: null,
      preferencesPath: "",
    });
  });

  test("decodes a valid legacy generation preference seed", async () => {
    const runner: InsightPreferenceCommandRunner = async () => ({
      ...preferenceState(),
      defaultGenerationPreferences: null,
      legacyGenerationPreferenceSeed: {
        styles: ["direct_sharp", "storytelling", "grounded"],
        avoid: ["clickbait"],
      },
    });

    await expect(getInsightPreferences(runner)).resolves.toMatchObject({
      defaultGenerationPreferences: null,
      legacyGenerationPreferenceSeed: {
        styles: ["direct_sharp", "storytelling", "grounded"],
        avoid: ["clickbait"],
      },
    });
  });

  test.each([
    { styles: ["unknown_style"], avoid: [] },
    { styles: ["direct_sharp", "direct_sharp"], avoid: [] },
    { styles: ["direct_sharp", "storytelling", "grounded", "professional_analysis"], avoid: [] },
    { styles: [], avoid: ["clickbait", "clickbait"] },
    { styles: [], avoid: ["clickbait", "academic", "vague", "negative"] },
    { styles: [], avoid: ["unknown_avoid"] },
    { styles: [], avoid: [], extra: true },
    { styles: [] },
  ])("fails closed for malformed legacy generation preference seeds: %o", async (seed) => {
    const runner: InsightPreferenceCommandRunner = async () => ({
      ...preferenceState(),
      legacyGenerationPreferenceSeed: seed,
    });

    await expect(getInsightPreferences(runner)).resolves.toMatchObject({
      legacyGenerationPreferenceSeed: null,
    });
  });

  test.each([
    { styles: Array(1), avoid: [] },
    { styles: [], avoid: ["clickbait", , "academic"] },
    { styles: ["direct_sharp", , "storytelling"], avoid: [] },
  ])("rejects sparse legacy seed arrays and never prefills them: %o", async (seed) => {
    const runner: InsightPreferenceCommandRunner = async () => ({
      ...preferenceState(),
      defaultGenerationPreferences: null,
      legacyGenerationPreferenceSeed: seed,
    });

    const state = await getInsightPreferences(runner);
    expect(state.legacyGenerationPreferenceSeed).toBeNull();
    expect(createInsightPreferenceFlow(state).generationPreferences).toEqual({
      goal: "",
      scenario: "",
      angles: [],
      audience: "",
      styles: [],
      avoid: [],
    });
  });
});

function preferenceState() {
  return {
    profile: PROFILE,
    profileSkipped: false,
    profileStatus: "valid",
    profileError: null,
    defaultGenerationPreferences: GENERATION_PREFERENCES,
    legacyGenerationPreferenceSeed: null,
    preferencesPath: "D:/StudyMind/insight-preferences.json",
  };
}
