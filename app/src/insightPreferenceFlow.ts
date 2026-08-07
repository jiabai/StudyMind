import {
  isPreferenceOptionId,
  type GenerationPreferenceField,
  type GenerationPreferences,
  type InspirationProfile,
} from "./insightPreferences";
import type { InsightPreferenceState } from "./insightPreferencesClient";
import { getAiCreditsDisclosureCopy } from "./aiCreditsCopy";
import type { SupportedLocale } from "./i18n/locale";

export type InsightPreferenceFlowScreen =
  | "profile_intro"
  | "profile_form"
  | "default_summary"
  | "generation_step"
  | "confirmation";

export type InsightPreferenceFlowState = {
  screen: InsightPreferenceFlowScreen;
  profile: InspirationProfile | null;
  profileSkipped: boolean;
  profileResetRequired: boolean;
  defaultGenerationPreferences: GenerationPreferences | null;
  generationPreferences: GenerationPreferences;
  currentStep: GenerationPreferenceField;
  currentStepIndex: number;
  canAdvance: boolean;
};

const GENERATION_STEPS: GenerationPreferenceField[] = [
  "goal",
  "scenario",
  "angles",
  "audience",
  "styles",
  "avoid",
];

const EMPTY_GENERATION_PREFERENCES: GenerationPreferences = {
  goal: "",
  scenario: "",
  angles: [],
  audience: "",
  styles: [],
  avoid: [],
};

export function createInsightPreferenceFlow(
  state: InsightPreferenceState,
): InsightPreferenceFlowState {
  const hasCompletedProfileIntro =
    (state.profileStatus === "valid" && state.profile !== null) ||
    state.profileSkipped ||
    state.profileStatus === "skipped";
  const profileResetRequired = state.profileStatus === "invalid";
  const generationPreferences = state.defaultGenerationPreferences
    ? state.defaultGenerationPreferences
    : {
        ...EMPTY_GENERATION_PREFERENCES,
        styles: [...(state.legacyGenerationPreferenceSeed?.styles ?? [])],
        avoid: [...(state.legacyGenerationPreferenceSeed?.avoid ?? [])],
      };
  const screen =
    profileResetRequired || !hasCompletedProfileIntro
      ? "profile_intro"
      : state.defaultGenerationPreferences
        ? "default_summary"
        : "generation_step";

  return withDerivedState({
    screen,
    profile: state.profile,
    profileSkipped: state.profileSkipped || state.profileStatus === "skipped",
    profileResetRequired,
    defaultGenerationPreferences: state.defaultGenerationPreferences,
    generationPreferences,
    currentStep: "goal",
    currentStepIndex: 0,
    canAdvance: false,
  });
}

export function getQuotaDisclosureCopy(locale: SupportedLocale): string {
  return getAiCreditsDisclosureCopy(locale);
}

export function skipProfileSetupInFlow(
  flow: InsightPreferenceFlowState,
): InsightPreferenceFlowState {
  return withDerivedState({
    ...flow,
    screen: "generation_step",
    profile: null,
    profileSkipped: true,
    profileResetRequired: false,
    currentStep: "goal",
    currentStepIndex: 0,
  });
}

export function startProfileSetupInFlow(
  flow: InsightPreferenceFlowState,
): InsightPreferenceFlowState {
  return withDerivedState({
    ...flow,
    screen: "profile_form",
  });
}

export function cancelProfileSetupInFlow(
  flow: InsightPreferenceFlowState,
): InsightPreferenceFlowState | null {
  const profileSetupRequired = flow.profileResetRequired || (!flow.profile && !flow.profileSkipped);
  if (profileSetupRequired) {
    return withDerivedState({
      ...flow,
      screen: "profile_intro",
      currentStep: "goal",
      currentStepIndex: 0,
    });
  }

  if (flow.defaultGenerationPreferences) {
    return withDerivedState({
      ...flow,
      screen: "default_summary",
      currentStep: "goal",
      currentStepIndex: 0,
    });
  }

  return null;
}

export function startGenerationPreferenceEditing(
  flow: InsightPreferenceFlowState,
): InsightPreferenceFlowState {
  return withDerivedState({
    ...flow,
    screen: "generation_step",
    currentStep: "goal",
    currentStepIndex: 0,
  });
}

export function useDefaultGenerationPreferences(
  flow: InsightPreferenceFlowState,
): InsightPreferenceFlowState {
  if (!flow.defaultGenerationPreferences) {
    return startGenerationPreferenceEditing(flow);
  }

  return withDerivedState({
    ...flow,
    screen: "confirmation",
    generationPreferences: flow.defaultGenerationPreferences,
  });
}

export function selectGenerationOption(
  flow: InsightPreferenceFlowState,
  field: GenerationPreferenceField,
  id: string,
): InsightPreferenceFlowState {
  if (!isPreferenceOptionId(field, id)) {
    return flow;
  }

  const generationPreferences = { ...flow.generationPreferences };
  if (field === "goal" || field === "scenario" || field === "audience") {
    generationPreferences[field] = id;
  } else {
    generationPreferences[field] = toggleMultiValue(
      generationPreferences[field],
      id,
      maxSelectionForField(field),
    );
  }

  return withDerivedState({
    ...flow,
    generationPreferences,
  });
}

export function advanceGenerationStep(
  flow: InsightPreferenceFlowState,
): InsightPreferenceFlowState {
  if (flow.screen !== "generation_step" || !flow.canAdvance) {
    return flow;
  }
  if (flow.currentStepIndex >= GENERATION_STEPS.length - 1) {
    return withDerivedState({
      ...flow,
      screen: "confirmation",
    });
  }

  const nextIndex = flow.currentStepIndex + 1;
  return withDerivedState({
    ...flow,
    currentStepIndex: nextIndex,
    currentStep: GENERATION_STEPS[nextIndex],
  });
}

export function backGenerationStep(
  flow: InsightPreferenceFlowState,
): InsightPreferenceFlowState {
  if (flow.screen !== "generation_step" || flow.currentStepIndex <= 0) {
    return flow;
  }

  const previousIndex = flow.currentStepIndex - 1;
  return withDerivedState({
    ...flow,
    currentStepIndex: previousIndex,
    currentStep: GENERATION_STEPS[previousIndex],
  });
}

function withDerivedState(flow: InsightPreferenceFlowState): InsightPreferenceFlowState {
  return {
    ...flow,
    canAdvance:
      flow.screen === "generation_step"
        ? canAdvanceGenerationStep(flow.generationPreferences, flow.currentStep)
        : false,
  };
}

function canAdvanceGenerationStep(
  preferences: GenerationPreferences,
  step: GenerationPreferenceField,
): boolean {
  if (step === "goal" || step === "scenario" || step === "audience") {
    return Boolean(preferences[step] && isPreferenceOptionId(step, preferences[step]));
  }
  if (step === "angles") {
    return preferences.angles.length >= 1 && preferences.angles.length <= 3;
  }
  if (step === "styles") {
    return preferences.styles.length >= 1 && preferences.styles.length <= 2;
  }
  return preferences.avoid.length <= 3;
}

function toggleMultiValue(values: string[], id: string, max: number): string[] {
  if (values.includes(id)) {
    return values.filter((value) => value !== id);
  }
  if (values.length >= max) {
    return values;
  }
  return [...values, id];
}

function maxSelectionForField(field: GenerationPreferenceField): number {
  if (field === "styles") {
    return 2;
  }
  return 3;
}
