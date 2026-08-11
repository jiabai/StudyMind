import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import {
  buildPreferenceSnapshot,
  INSIGHT_PREFERENCE_FIELDS,
  PROFILE_FIELD_ORDER,
  isPreferenceOptionId,
  type GenerationPreferences,
  type InspirationProfile,
} from "../insightPreferences";
import { INSIGHT_PREFERENCE_PROMPT_SEMANTICS } from "../insightPreferencePromptSemantics";
import {
  getOutputLanguageName,
  getPreferenceCopy,
  getPreferenceFieldPresentation,
  summarizeGenerationPreferences,
  summarizeInspirationProfile,
} from "./preferencePresentation";
import { SUPPORTED_LOCALES } from "./locale";

const PROFILE: InspirationProfile = {
  role: "student",
  domain: "science_engineering",
  stage: "intermediate",
  learningContext: "lecture",
  knowledgeLevel: "familiar",
  studyMethods: ["note_taking"],
};

const GENERATION_PREFERENCES: GenerationPreferences = {
  goal: "understand_concepts",
  scenario: "class_notes",
  angles: ["core_concepts", "examples_cases"],
  audience: "beginner_learner",
  styles: ["structured"],
  avoid: [],
};

describe("localized preference presentation", () => {
  test("renders independent labels while the canonical prompt snapshot stays byte-identical", () => {
    const labels = SUPPORTED_LOCALES.map(
      (locale) => getPreferenceFieldPresentation(locale, "goal").options[0].label,
    );
    expect(labels).toEqual(["理解核心概念", "理解核心概念", "Understand core concepts"]);

    const serializedSnapshots = SUPPORTED_LOCALES.map((locale) => {
      const roundTripIds = (
        field: keyof typeof INSIGHT_PREFERENCE_FIELDS,
        ids: string[],
      ): string[] => {
        const presentation = getPreferenceFieldPresentation(locale, field);
        const visibleLabels = ids.map(
          (id) => presentation.options.find((option) => option.id === id)?.label,
        );
        return visibleLabels.map((label) => {
          const stableId = presentation.options.find(
            (option) => option.label === label,
          )?.id;
          if (!stableId) {
            throw new Error(`Missing localized option for ${field}`);
          }
          return stableId;
        });
      };

      const generationPreferences: GenerationPreferences = {
        goal: roundTripIds("goal", [GENERATION_PREFERENCES.goal])[0],
        scenario: roundTripIds("scenario", [GENERATION_PREFERENCES.scenario])[0],
        angles: roundTripIds("angles", GENERATION_PREFERENCES.angles),
        audience: roundTripIds("audience", [GENERATION_PREFERENCES.audience])[0],
        styles: roundTripIds("styles", GENERATION_PREFERENCES.styles),
        avoid: roundTripIds("avoid", GENERATION_PREFERENCES.avoid),
      };
      const profile: InspirationProfile = {
        role: roundTripIds("role", [PROFILE.role])[0],
        domain: roundTripIds("domain", [PROFILE.domain])[0],
        stage: roundTripIds("stage", [PROFILE.stage])[0],
        learningContext: roundTripIds("learningContext", [PROFILE.learningContext])[0],
        knowledgeLevel: roundTripIds("knowledgeLevel", [PROFILE.knowledgeLevel])[0],
        studyMethods: roundTripIds("studyMethods", PROFILE.studyMethods),
      };
      expect(generationPreferences).toEqual(GENERATION_PREFERENCES);
      expect(profile).toEqual(PROFILE);

      return JSON.stringify(
        buildPreferenceSnapshot({
          profile,
          profileSkipped: false,
          generationPreferences,
        }),
      );
    });
    expect(new Set(serializedSnapshots)).toHaveLength(1);
    expect(serializedSnapshots[0]).toContain('"label":"本次学习目标"');
    expect(serializedSnapshots[0]).toContain('"label":"理解核心概念"');
  });

  test("summarizes profile and generation choices in the requested UI locale", () => {
    expect(PROFILE_FIELD_ORDER).toEqual([
      "role",
      "domain",
      "stage",
      "learningContext",
      "knowledgeLevel",
      "studyMethods",
    ]);
    for (const locale of SUPPORTED_LOCALES) {
      const summary = summarizeInspirationProfile(PROFILE, locale);
      const allowedLabels = PROFILE_FIELD_ORDER.map(
        (field) => getPreferenceFieldPresentation(locale, field).label,
      );
      expect(summary).not.toHaveLength(0);
      expect(
        summary.every((line) => allowedLabels.some((label) => line.startsWith(label))),
      ).toBe(true);
    }
    expect(summarizeGenerationPreferences(GENERATION_PREFERENCES, "en-US")).toContain(
      "Learning goal: Understand core concepts",
    );
    expect(summarizeInspirationProfile(null, "en-US")).toEqual([
      "Learner Profile is not set up",
    ]);
  });

  test("validates stable ids without consulting localized labels", () => {
    expect(isPreferenceOptionId("role", "teacher")).toBe(true);
    expect(isPreferenceOptionId("role", "教师/培训者")).toBe(false);
    expect(isPreferenceOptionId("role", "教師／培訓者")).toBe(false);
    expect(isPreferenceOptionId("role", "Teacher / trainer")).toBe(false);
  });

  test("localizes all actual output-language names without a system sentinel", () => {
    expect(getOutputLanguageName("zh-CN", "zh-TW")).toBe("繁體中文（台灣）");
    expect(getOutputLanguageName("zh-TW", "zh-CN")).toBe("簡體中文");
    expect(getOutputLanguageName("en-US", "en-US")).toBe("English (US)");
  });

  test("keeps study method labels aligned across locales", () => {
    for (const id of [
      "note_taking",
      "practice_questions",
      "spaced_repetition",
      "discussion",
      "project_application",
    ]) {
      const labels = SUPPORTED_LOCALES.map((locale) =>
        getPreferenceFieldPresentation(locale, "studyMethods").options.find(
          (option) => option.id === id,
        )?.label,
      );
      expect(labels.every((label): label is string => Boolean(label)), id).toBe(true);
      expect(labels.join(" ")).not.toMatch(/Douyin|Bilibili|Podcast|抖音|哔哩哔哩/);
    }
  });

  test("provides singular and plural settings summaries for English counts", () => {
    const settings = getPreferenceCopy("en-US").settings;
    expect(settings.moreItems_one).toBe("{{count}} more item; open Edit to view it");
    expect(settings.moreItems_other).toBe(
      "{{count}} more items; open Edit to view them",
    );
    expect(settings.defaultSaved_one).toContain("{{count}} item)");
    expect(settings.defaultSaved_other).toContain("{{count}} items)");
  });

  test("uses the study synthesis terminology in Credits disclosure", () => {
    expect(getPreferenceCopy("zh-CN").flow.creditsCostHint).toContain("学习整理");
    expect(getPreferenceCopy("zh-TW").flow.creditsCostHint).toContain("學習整理");
    expect(getPreferenceCopy("en-US").flow.creditsCostHint).toContain("study synthesis");
    expect(getPreferenceCopy("zh-CN").flow.quotaDisclosure).toContain("学习整理");
    expect(getPreferenceCopy("zh-TW").flow.quotaDisclosure).toContain("學習整理");
    expect(getPreferenceCopy("en-US").flow.quotaDisclosure).toContain("study synthesis");
  });

  test("keeps business ids, canonical prompt semantics, and localized UI copy separated", () => {
    expect(INSIGHT_PREFERENCE_FIELDS).not.toHaveProperty("defaultStyles");
    expect(INSIGHT_PREFERENCE_FIELDS).not.toHaveProperty("defaultAvoid");
    expect(INSIGHT_PREFERENCE_PROMPT_SEMANTICS).not.toHaveProperty("defaultStyles");
    expect(INSIGHT_PREFERENCE_PROMPT_SEMANTICS).not.toHaveProperty("defaultAvoid");

    for (const [field, config] of Object.entries(INSIGHT_PREFERENCE_FIELDS)) {
      expect(
        Object.keys(
          INSIGHT_PREFERENCE_PROMPT_SEMANTICS[
            field as keyof typeof INSIGHT_PREFERENCE_PROMPT_SEMANTICS
          ].options,
        ),
      ).toEqual(config.options.map(({ id }) => id));

      for (const locale of SUPPORTED_LOCALES) {
        const presentation = getPreferenceFieldPresentation(
          locale,
          field as keyof typeof INSIGHT_PREFERENCE_FIELDS,
        );
        expect(presentation.options.map(({ id }) => id)).toEqual(
          config.options.map(({ id }) => id),
        );
        expect(presentation.label.trim()).not.toBe("");
        expect(presentation.options.every(({ label }) => label.trim() !== "")).toBe(true);
      }
    }

    const businessSource = readFileSync(
      new URL("../insightPreferences.ts", import.meta.url),
      "utf8",
    );
    expect(businessSource).not.toMatch(/[\p{Script=Han}]/u);

    const flowSource = readFileSync(
      new URL("../features/insightPreferences/InsightPreferenceFlow.tsx", import.meta.url),
      "utf8",
    );
    const profileFormSource = readFileSync(
      new URL("../features/insightPreferences/InspirationProfileForm.tsx", import.meta.url),
      "utf8",
    );
    expect(flowSource).not.toMatch(/[\p{Script=Han}]/u);
    expect(profileFormSource).not.toMatch(/[\p{Script=Han}]/u);

    const settingsSource = readFileSync(
      new URL("../features/settings/SettingsSheet.tsx", import.meta.url),
      "utf8",
    );
    const inspirationSection = settingsSource.slice(
      settingsSource.indexOf('settingsCategory === "inspiration"'),
      settingsSource.indexOf('settingsCategory === "storage"'),
    );
    expect(inspirationSection).not.toMatch(/[\p{Script=Han}]/u);
  });
});
