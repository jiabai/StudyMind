import { INSIGHT_PREFERENCE_PROMPT_SEMANTICS } from "./insightPreferencePromptSemantics";

export type ProfileField =
  | "role"
  | "domain"
  | "stage"
  | "learningContext"
  | "knowledgeLevel"
  | "studyMethods";

export type GenerationPreferenceField =
  | "goal"
  | "scenario"
  | "angles"
  | "audience"
  | "styles"
  | "avoid";

export type PreferenceField = ProfileField | GenerationPreferenceField;

export type LearnerProfile = {
  role: string;
  domain: string;
  stage: string;
  learningContext: string;
  knowledgeLevel: string;
  studyMethods: string[];
};

/** @deprecated Use LearnerProfile. Kept as an API alias for existing callers. */
export type InspirationProfile = LearnerProfile;

export type GenerationPreferences = {
  goal: string;
  scenario: string;
  angles: string[];
  audience: string;
  styles: string[];
  avoid: string[];
};

export type Insight = {
  id: number;
  topic: string;
  matchReason: string;
  followUpQuestions: string[];
  suitableUse: string;
  sourceChunkId: number | null;
};

export type PreferenceLabelValue = {
  id: string;
  label: string;
};

export type PreferenceLabelSnapshotItem = {
  field: PreferenceField;
  label: string;
  values: PreferenceLabelValue[];
};

export type PreferenceSnapshot = {
  profile: InspirationProfile | null;
  profileSkipped: boolean;
  generationPreferences: GenerationPreferences;
  labelSnapshot: {
    profile: PreferenceLabelSnapshotItem[];
    generationPreferences: PreferenceLabelSnapshotItem[];
  };
};

export type OptionDefinition = {
  id: string;
};

export type FieldConfig = {
  mode: "single" | "multi";
  min: number;
  max: number;
  options: readonly OptionDefinition[];
};

export const PROFILE_FIELD_ORDER: ProfileField[] = [
  "role",
  "domain",
  "stage",
  "learningContext",
  "knowledgeLevel",
  "studyMethods",
];

export const GENERATION_FIELD_ORDER: GenerationPreferenceField[] = [
  "goal",
  "scenario",
  "angles",
  "audience",
  "styles",
  "avoid",
];

function options(...ids: string[]): OptionDefinition[] {
  return ids.map((id) => ({ id }));
}

const PROFILE_FIELD_CONFIGS: Record<ProfileField, FieldConfig> = {
  role: {
    mode: "single", min: 1, max: 1,
    options: options("student", "working_professional", "teacher", "researcher", "lifelong_learner", "unspecified"),
  },
  domain: {
    mode: "single", min: 1, max: 1,
    options: options("science_engineering", "business_management", "languages", "social_sciences", "humanities", "education", "exam_prep", "general_knowledge", "unspecified"),
  },
  stage: {
    mode: "single", min: 1, max: 1,
    options: options("beginner", "intermediate", "advanced", "professional", "unspecified"),
  },
  learningContext: {
    mode: "single", min: 1, max: 1,
    options: options("classroom", "lecture", "self_study", "exam_preparation", "workplace_training", "reading_group", "unspecified"),
  },
  knowledgeLevel: {
    mode: "single", min: 1, max: 1,
    options: options("new_to_topic", "familiar", "advanced", "unspecified"),
  },
  studyMethods: {
    mode: "multi", min: 0, max: 3,
    options: options("note_taking", "practice_questions", "spaced_repetition", "discussion", "project_application", "teach_back"),
  },
};

const GENERATION_FIELD_CONFIGS: Record<GenerationPreferenceField, FieldConfig> = {
  goal: {
    mode: "single", min: 1, max: 1,
    options: options("understand_concepts", "prepare_for_exam", "organize_notes", "apply_in_practice", "build_connections", "review_weak_points"),
  },
  scenario: {
    mode: "single", min: 1, max: 1,
    options: options("class_notes", "self_study", "exam_review", "work_training", "reading_review", "teach_someone"),
  },
  angles: {
    mode: "multi", min: 1, max: 3,
    options: options("core_concepts", "key_definitions", "cause_effect", "steps_process", "examples_cases", "compare_contrast", "common_misconceptions", "practice_questions", "evidence_reasoning", "connections"),
  },
  audience: {
    mode: "single", min: 1, max: 1,
    options: options("self", "beginner_learner", "study_group", "classmate", "teacher", "future_self"),
  },
  styles: {
    mode: "multi", min: 1, max: 2,
    options: options("structured", "clear_concise", "deep_explanation", "examples_first", "socratic", "exam_focused", "action_oriented"),
  },
  avoid: {
    mode: "multi", min: 0, max: 3,
    options: options("unsupported_claims", "overly_abstract", "too_much_detail", "repetition", "unexplained_jargon", "off_topic", "unverified"),
  },
};

export const INSIGHT_PREFERENCE_FIELDS: Record<PreferenceField, FieldConfig> = {
  ...PROFILE_FIELD_CONFIGS,
  ...GENERATION_FIELD_CONFIGS,
};

export function validateInspirationProfile(value: unknown): InspirationProfile | null {
  if (!isRecord(value)) {
    return null;
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...PROFILE_FIELD_ORDER].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    return null;
  }

  const role = validateSingleField(value.role, "role");
  const domain = validateSingleField(value.domain, "domain");
  const stage = validateSingleField(value.stage, "stage");
  const learningContext = validateSingleField(value.learningContext, "learningContext");
  const knowledgeLevel = validateSingleField(value.knowledgeLevel, "knowledgeLevel");
  const studyMethods = validateMultiField(value.studyMethods, "studyMethods");

  if (
    role === null ||
    domain === null ||
    stage === null ||
    learningContext === null ||
    knowledgeLevel === null ||
    studyMethods === null
  ) {
    return null;
  }

  return {
    role,
    domain,
    stage,
    learningContext,
    knowledgeLevel,
    studyMethods,
  };
}

export function validateGenerationPreferences(value: unknown): GenerationPreferences | null {
  if (!isRecord(value)) {
    return null;
  }

  const goal = validateSingleField(value.goal, "goal");
  const scenario = validateSingleField(value.scenario, "scenario");
  const angles = validateMultiField(value.angles, "angles");
  const audience = validateSingleField(value.audience, "audience");
  const styles = validateMultiField(value.styles, "styles");
  const avoid = validateMultiField(value.avoid, "avoid");

  if (
    goal === null ||
    scenario === null ||
    angles === null ||
    audience === null ||
    styles === null ||
    avoid === null
  ) {
    return null;
  }

  return {
    goal,
    scenario,
    angles,
    audience,
    styles,
    avoid,
  };
}

export function isPreferenceOptionId(field: PreferenceField, id: string): boolean {
  return INSIGHT_PREFERENCE_FIELDS[field].options.some((option) => option.id === id);
}

export function buildPreferenceSnapshot(input: {
  profile: InspirationProfile | null;
  profileSkipped: boolean;
  generationPreferences: GenerationPreferences;
}): PreferenceSnapshot {
  return {
    profile: input.profile,
    profileSkipped: input.profileSkipped,
    generationPreferences: input.generationPreferences,
    labelSnapshot: {
      profile: input.profile
        ? createLabelSnapshot(PROFILE_FIELD_ORDER, input.profile, {
            skipUnspecifiedSingles: true,
            skipEmptyMulti: true,
          })
        : [],
      generationPreferences: createLabelSnapshot(
        GENERATION_FIELD_ORDER,
        input.generationPreferences,
        {
          skipUnspecifiedSingles: false,
          skipEmptyMulti: false,
        },
      ),
    },
  };
}

function validateSingleField(value: unknown, field: PreferenceField): string | null {
  const config = INSIGHT_PREFERENCE_FIELDS[field];
  if (config.mode !== "single" || typeof value !== "string") {
    return null;
  }
  return isPreferenceOptionId(field, value) ? value : null;
}

function validateMultiField(value: unknown, field: PreferenceField): string[] | null {
  const config = INSIGHT_PREFERENCE_FIELDS[field];
  if (config.mode !== "multi" || !Array.isArray(value)) {
    return null;
  }
  if (value.length < config.min || value.length > config.max) {
    return null;
  }
  if (!value.every((item): item is string => typeof item === "string")) {
    return null;
  }
  if (new Set(value).size !== value.length) {
    return null;
  }
  if (!value.every((id) => isPreferenceOptionId(field, id))) {
    return null;
  }
  return [...value];
}

function getOption(field: PreferenceField, id: string): OptionDefinition | null {
  return INSIGHT_PREFERENCE_FIELDS[field].options.find((option) => option.id === id) ?? null;
}

function getCanonicalPromptLabel(field: PreferenceField, id: string): string {
  const labels = INSIGHT_PREFERENCE_PROMPT_SEMANTICS[field].options as Readonly<
    Record<string, string>
  >;
  const label = labels[id];
  if (!label) {
    throw new Error(`Missing canonical prompt label for ${field}.${id}`);
  }
  return label;
}

function createLabelSnapshot(
  fields: readonly PreferenceField[],
  values: Record<string, string | string[]>,
  options: {
    skipUnspecifiedSingles: boolean;
    skipEmptyMulti: boolean;
  },
): PreferenceLabelSnapshotItem[] {
  const items: PreferenceLabelSnapshotItem[] = [];
  for (const field of fields) {
    const config = INSIGHT_PREFERENCE_FIELDS[field];
    const rawValue = values[field];
    if (config.mode === "single") {
      if (typeof rawValue !== "string") {
        continue;
      }
      if (options.skipUnspecifiedSingles && rawValue === "unspecified") {
        continue;
      }
      const option = getOption(field, rawValue);
      if (option) {
        items.push({
          field,
          label: INSIGHT_PREFERENCE_PROMPT_SEMANTICS[field].label,
          values: [{ id: option.id, label: getCanonicalPromptLabel(field, option.id) }],
        });
      }
      continue;
    }

    if (!Array.isArray(rawValue)) {
      continue;
    }
    const selected = rawValue
      .map((id) => getOption(field, id))
      .filter((option): option is OptionDefinition => option !== null)
      .map((option) => ({
        id: option.id,
        label: getCanonicalPromptLabel(field, option.id),
      }));
    if (selected.length > 0 || !options.skipEmptyMulti) {
      items.push({
        field,
        label: INSIGHT_PREFERENCE_PROMPT_SEMANTICS[field].label,
        values: selected,
      });
    }
  }
  return items;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
