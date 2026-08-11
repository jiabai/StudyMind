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
  role: "working_professional",
  domain: "business_management",
  stage: "advanced",
  learningContext: "workplace_training",
  knowledgeLevel: "familiar",
  studyMethods: ["note_taking"],
};

const GENERATION_PREFERENCES: GenerationPreferences = {
  goal: "organize_notes",
  scenario: "work_training",
  angles: ["core_concepts"],
  audience: "beginner_learner",
  styles: ["structured"],
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
        styles: ["structured", "examples_first", "clear_concise"],
        avoid: ["unsupported_claims"],
      },
    });

    await expect(getInsightPreferences(runner)).resolves.toMatchObject({
      defaultGenerationPreferences: null,
      legacyGenerationPreferenceSeed: {
        styles: ["structured", "examples_first", "clear_concise"],
        avoid: ["unsupported_claims"],
      },
    });
  });

  test.each([
    { styles: ["unknown_style"], avoid: [] },
    { styles: ["structured", "structured"], avoid: [] },
    { styles: ["structured", "examples_first", "clear_concise", "deep_explanation"], avoid: [] },
    { styles: [], avoid: ["unsupported_claims", "unsupported_claims"] },
    { styles: [], avoid: ["unsupported_claims", "overly_abstract", "off_topic", "unverified"] },
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
    { styles: [], avoid: ["unsupported_claims", , "overly_abstract"] },
    { styles: ["structured", , "examples_first"], avoid: [] },
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
