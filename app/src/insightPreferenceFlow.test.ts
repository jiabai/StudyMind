import { describe, expect, test } from "vitest";
import {
  advanceGenerationStep,
  backGenerationStep,
  cancelProfileSetupInFlow,
  createInsightPreferenceFlow,
  getQuotaDisclosureCopy,
  selectGenerationOption,
  skipProfileSetupInFlow,
  startProfileSetupInFlow,
  startGenerationPreferenceEditing,
  useDefaultGenerationPreferences,
} from "./insightPreferenceFlow";
import type { GenerationPreferences, InspirationProfile } from "./insightPreferences";
import type { InsightPreferenceState } from "./insightPreferencesClient";

const PROFILE: InspirationProfile = {
  role: "working_professional",
  domain: "business_management",
  stage: "advanced",
  learningContext: "workplace_training",
  knowledgeLevel: "familiar",
  studyMethods: ["note_taking"],
};

const DEFAULT_GENERATION: GenerationPreferences = {
  goal: "organize_notes",
  scenario: "work_training",
  angles: ["core_concepts"],
  audience: "beginner_learner",
  styles: ["structured"],
  avoid: [],
};

describe("insight preference flow", () => {
  test("starts with profile setup when no valid profile or skip state exists", () => {
    const flow = createInsightPreferenceFlow(preferenceState({
      profile: null,
      profileSkipped: false,
      profileStatus: "missing",
      defaultGenerationPreferences: null,
    }));

    expect(flow.screen).toBe("profile_intro");
    expect(flow.profileResetRequired).toBe(false);
  });

  test("marks invalid profiles as reset-required before generation can continue", () => {
    const flow = createInsightPreferenceFlow(preferenceState({
      profile: null,
      profileSkipped: false,
      profileStatus: "invalid",
      profileError: "学习档案需要重新设置",
      defaultGenerationPreferences: DEFAULT_GENERATION,
    }));

    expect(flow.screen).toBe("profile_intro");
    expect(flow.profileResetRequired).toBe(true);
    expect(flow.generationPreferences).toEqual(DEFAULT_GENERATION);
  });

  test("shows default summary for returning users with valid defaults", () => {
    const flow = createInsightPreferenceFlow(preferenceState({
      profile: PROFILE,
      profileSkipped: false,
      profileStatus: "valid",
      defaultGenerationPreferences: DEFAULT_GENERATION,
    }));

    expect(flow.screen).toBe("default_summary");
    expect(useDefaultGenerationPreferences(flow).screen).toBe("confirmation");
  });

  test("complete defaults win over a legacy edit-only seed", () => {
    const flow = createInsightPreferenceFlow(preferenceState({
      profile: PROFILE,
      profileStatus: "valid",
      defaultGenerationPreferences: DEFAULT_GENERATION,
      legacyGenerationPreferenceSeed: {
        styles: ["examples_first"],
        avoid: ["unsupported_claims"],
      },
    }));

    expect(flow.screen).toBe("default_summary");
    expect(flow.generationPreferences).toEqual(DEFAULT_GENERATION);
  });

  test("prefills only styles and avoid from a legacy seed without completing the draft", () => {
    const flow = createInsightPreferenceFlow(preferenceState({
      profile: PROFILE,
      profileStatus: "valid",
      defaultGenerationPreferences: null,
      legacyGenerationPreferenceSeed: {
        styles: ["structured"],
        avoid: ["unsupported_claims"],
      },
    }));

    expect(flow.screen).toBe("generation_step");
    expect(flow.currentStep).toBe("goal");
    expect(flow.canAdvance).toBe(false);
    expect(flow.generationPreferences).toEqual({
      goal: "",
      scenario: "",
      angles: [],
      audience: "",
      styles: ["structured"],
      avoid: ["unsupported_claims"],
    });
    expect(flow.defaultGenerationPreferences).toBeNull();
  });

  test("preserves three seeded styles and blocks the style step until one is deselected", () => {
    let flow = createInsightPreferenceFlow(preferenceState({
      profile: PROFILE,
      profileStatus: "valid",
      legacyGenerationPreferenceSeed: {
        styles: ["structured", "examples_first", "clear_concise"],
        avoid: [],
      },
    }));

    flow = advanceGenerationStep(selectGenerationOption(flow, "goal", "understand_concepts"));
    flow = advanceGenerationStep(selectGenerationOption(flow, "scenario", "class_notes"));
    flow = advanceGenerationStep(selectGenerationOption(flow, "angles", "core_concepts"));
    flow = advanceGenerationStep(selectGenerationOption(flow, "audience", "beginner_learner"));

    expect(flow.currentStep).toBe("styles");
    expect(flow.generationPreferences.styles).toEqual([
      "structured",
      "examples_first",
      "clear_concise",
    ]);
    expect(flow.canAdvance).toBe(false);
    expect(advanceGenerationStep(flow).currentStep).toBe("styles");

    flow = selectGenerationOption(flow, "styles", "examples_first");
    expect(flow.generationPreferences.styles).toEqual(["structured", "clear_concise"]);
    expect(flow.canAdvance).toBe(true);
  });

  test("skipping profile setup moves directly to the six-step preference flow", () => {
    const flow = createInsightPreferenceFlow(preferenceState({
      profile: null,
      profileSkipped: false,
      profileStatus: "missing",
      defaultGenerationPreferences: null,
    }));

    const skipped = skipProfileSetupInFlow(flow);

    expect(skipped.screen).toBe("generation_step");
    expect(skipped.profileSkipped).toBe(true);
    expect(skipped.currentStep).toBe("goal");
  });

  test("can enter profile setup form from the intro screen", () => {
    const flow = createInsightPreferenceFlow(preferenceState({
      profile: null,
      profileSkipped: false,
      profileStatus: "missing",
      defaultGenerationPreferences: null,
    }));

    expect(startProfileSetupInFlow(flow).screen).toBe("profile_form");
  });

  test("cancelling required profile setup returns to the intro without skipping", () => {
    const flow = startProfileSetupInFlow(
      createInsightPreferenceFlow(preferenceState({
        profile: null,
        profileSkipped: false,
        profileStatus: "missing",
        defaultGenerationPreferences: null,
      })),
    );

    const cancelled = cancelProfileSetupInFlow(flow);

    expect(cancelled?.screen).toBe("profile_intro");
    expect(cancelled?.profileSkipped).toBe(false);
    expect(cancelled?.profileResetRequired).toBe(false);
  });

  test("cancelling invalid profile reset does not continue to generation", () => {
    const flow = startProfileSetupInFlow(
      createInsightPreferenceFlow(preferenceState({
        profile: null,
        profileSkipped: false,
        profileStatus: "invalid",
        profileError: "学习档案需要重新设置",
        defaultGenerationPreferences: DEFAULT_GENERATION,
      })),
    );

    const cancelled = cancelProfileSetupInFlow(flow);

    expect(cancelled?.screen).toBe("profile_intro");
    expect(cancelled?.profileResetRequired).toBe(true);
    expect(cancelled?.generationPreferences).toEqual(DEFAULT_GENERATION);
  });

  test("requires selections before advancing required generation steps", () => {
    const flow = startGenerationPreferenceEditing(
      createInsightPreferenceFlow(preferenceState({
        profile: null,
        profileSkipped: true,
        profileStatus: "skipped",
        defaultGenerationPreferences: null,
      })),
    );

    expect(flow.currentStep).toBe("goal");
    expect(flow.canAdvance).toBe(false);

    const withGoal = selectGenerationOption(flow, "goal", "understand_concepts");
    expect(withGoal.canAdvance).toBe(true);

    const scenarioStep = advanceGenerationStep(withGoal);
    expect(scenarioStep.screen).toBe("generation_step");
    expect(scenarioStep.currentStep).toBe("scenario");
    expect(scenarioStep.canAdvance).toBe(false);
    expect(backGenerationStep(scenarioStep).currentStep).toBe("goal");
  });

  test("allows avoid step to finish without any selected avoid options", () => {
    let flow = startGenerationPreferenceEditing(
      createInsightPreferenceFlow(preferenceState({
        profile: PROFILE,
        profileSkipped: false,
        profileStatus: "valid",
        defaultGenerationPreferences: null,
      })),
    );

    flow = advanceGenerationStep(selectGenerationOption(flow, "goal", "understand_concepts"));
    flow = advanceGenerationStep(selectGenerationOption(flow, "scenario", "class_notes"));
    flow = advanceGenerationStep(selectGenerationOption(flow, "angles", "core_concepts"));
    flow = advanceGenerationStep(selectGenerationOption(flow, "audience", "beginner_learner"));
    flow = advanceGenerationStep(selectGenerationOption(flow, "styles", "structured"));

    expect(flow.currentStep).toBe("avoid");
    expect(flow.canAdvance).toBe(true);
    expect(advanceGenerationStep(flow).screen).toBe("confirmation");
  });

  test("confirmation Credits copy explains variable per-call cost", () => {
    const copy = getQuotaDisclosureCopy("zh-CN");

    expect(copy).toContain("1 AI Credit = 1 次云端 LLM API 调用尝试");
    expect(copy).toContain("一次学习整理可能消耗多个 Credits");
    expect(copy).toContain("按实际云端 LLM API 调用扣除 Credits");
    expect(copy).toContain("失败、超时或部分失败的已发起调用仍会扣除 Credits");
    expect(copy).not.toContain("次额度");
    expect(copy).not.toContain("确认后消耗 1 次");
  });
});

function preferenceState(overrides: Partial<InsightPreferenceState>): InsightPreferenceState {
  return {
    profile: null,
    profileSkipped: false,
    profileStatus: "missing",
    profileError: null,
    defaultGenerationPreferences: null,
    legacyGenerationPreferenceSeed: null,
    preferencesPath: "",
    ...overrides,
  };
}
