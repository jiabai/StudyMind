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
  role: "content_creator",
  domain: "content_media",
  stage: "experienced_professional",
  cityContext: "new_tier1_city",
  genderPerspective: "unspecified",
  platforms: ["douyin"],
};

const GENERATION_PREFERENCES: GenerationPreferences = {
  goal: "content_creation",
  scenario: "short_video",
  angles: ["topic_angle", "practical_advice"],
  audience: "beginners",
  styles: ["direct_sharp"],
  avoid: [],
};

describe("localized preference presentation", () => {
  test("renders independent labels while the canonical prompt snapshot stays byte-identical", () => {
    const labels = SUPPORTED_LOCALES.map(
      (locale) => getPreferenceFieldPresentation(locale, "goal").options[0].label,
    );
    expect(labels).toEqual(["内容创作", "內容創作", "Content creation"]);

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
        cityContext: roundTripIds("cityContext", [PROFILE.cityContext])[0],
        genderPerspective: roundTripIds("genderPerspective", [
          PROFILE.genderPerspective,
        ])[0],
        platforms: roundTripIds("platforms", PROFILE.platforms),
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
    expect(serializedSnapshots[0]).toContain('"label":"本次目标"');
    expect(serializedSnapshots[0]).toContain('"label":"内容创作"');
  });

  test("summarizes profile and generation choices in the requested UI locale", () => {
    expect(PROFILE_FIELD_ORDER).toEqual([
      "role",
      "domain",
      "stage",
      "cityContext",
      "genderPerspective",
      "platforms",
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
      "Goal: Content creation",
    );
    expect(summarizeInspirationProfile(null, "en-US")).toEqual([
      "Inspiration Profile is not set up",
    ]);
  });

  test("validates stable ids without consulting localized labels", () => {
    expect(isPreferenceOptionId("role", "marketing_sales")).toBe(true);
    expect(isPreferenceOptionId("role", "市场/销售")).toBe(false);
    expect(isPreferenceOptionId("role", "市場／銷售")).toBe(false);
    expect(isPreferenceOptionId("role", "Marketing / sales")).toBe(false);
  });

  test("localizes all actual output-language names without a system sentinel", () => {
    expect(getOutputLanguageName("zh-CN", "zh-TW")).toBe("繁體中文（台灣）");
    expect(getOutputLanguageName("zh-TW", "zh-CN")).toBe("簡體中文");
    expect(getOutputLanguageName("en-US", "en-US")).toBe("English (US)");
  });

  test("keeps platform brand labels unchanged across locales", () => {
    for (const id of [
      "douyin",
      "xiaohongshu",
      "wechat_channels",
      "bilibili",
      "wechat_official_account",
    ]) {
      const labels = SUPPORTED_LOCALES.map((locale) =>
        getPreferenceFieldPresentation(locale, "platforms").options.find(
          (option) => option.id === id,
        )?.label,
      );
      expect(new Set(labels), id).toHaveLength(1);
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

  test("uses the locked AI Synthesis terminology in Credits disclosure", () => {
    expect(getPreferenceCopy("zh-CN").flow.creditsCostHint).toContain("智能提炼");
    expect(getPreferenceCopy("zh-TW").flow.creditsCostHint).toContain("AI 提煉");
    expect(getPreferenceCopy("en-US").flow.creditsCostHint).toContain("AI Synthesis");
    expect(getPreferenceCopy("zh-CN").flow.quotaDisclosure).toContain("智能提炼");
    expect(getPreferenceCopy("zh-TW").flow.quotaDisclosure).toContain("AI 提煉");
    expect(getPreferenceCopy("en-US").flow.quotaDisclosure).toContain("AI Synthesis");
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
