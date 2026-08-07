import { INSIGHT_PREFERENCE_PROMPT_SEMANTICS } from "./insightPreferencePromptSemantics";

export type ProfileField =
  | "role"
  | "domain"
  | "stage"
  | "cityContext"
  | "genderPerspective"
  | "platforms";

export type GenerationPreferenceField =
  | "goal"
  | "scenario"
  | "angles"
  | "audience"
  | "styles"
  | "avoid";

export type PreferenceField = ProfileField | GenerationPreferenceField;

export type InspirationProfile = {
  role: string;
  domain: string;
  stage: string;
  cityContext: string;
  genderPerspective: string;
  platforms: string[];
};

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
  "cityContext",
  "genderPerspective",
  "platforms",
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
    options: options("content_creator", "product_ops", "marketing_sales", "entrepreneur", "student_researcher", "teacher_trainer", "investor_business_analyst", "general_learner", "unspecified"),
  },
  domain: {
    mode: "single", min: 1, max: 1,
    options: options("content_media", "product_operations", "marketing_sales", "education_training", "technology_rd", "management_consulting", "investment_business", "freelance", "general_perspective", "unspecified"),
  },
  stage: {
    mode: "single", min: 1, max: 1,
    options: options("student", "early_career", "experienced_professional", "manager", "entrepreneur_operator", "retired", "unspecified"),
  },
  cityContext: {
    mode: "single", min: 1, max: 1,
    options: options("tier1_city", "new_tier1_city", "lower_tier_city", "county_township", "overseas", "unspecified"),
  },
  genderPerspective: {
    mode: "single", min: 1, max: 1,
    options: options("unspecified", "female_perspective", "male_perspective", "neutral_perspective"),
  },
  platforms: {
    mode: "multi", min: 0, max: 3,
    options: options("douyin", "xiaohongshu", "wechat_channels", "bilibili", "wechat_official_account", "podcast", "course_community", "internal_sharing"),
  },
};

const GENERATION_FIELD_CONFIGS: Record<GenerationPreferenceField, FieldConfig> = {
  goal: {
    mode: "single", min: 1, max: 1,
    options: options("content_creation", "learning_understanding", "review_deconstruction", "business_insight", "controversy_discussion", "action_advice"),
  },
  scenario: {
    mode: "single", min: 1, max: 1,
    options: options("personal_notes", "short_video", "article_official_account", "livestream_podcast", "team_sharing", "client_communication", "course_community"),
  },
  angles: {
    mode: "multi", min: 1, max: 3,
    options: options("topic_angle", "contrarian_view", "audience_pain_point", "practical_advice", "case_analogy", "risk_controversy", "trend_judgment", "reusable_method", "memorable_phrase", "cognitive_refresh"),
  },
  audience: {
    mode: "single", min: 1, max: 1,
    options: options("self", "beginners", "peers", "clients", "boss_team", "fans_readers"),
  },
  styles: {
    mode: "multi", min: 1, max: 2,
    options: options("direct_sharp", "gentle_inspiring", "professional_analysis", "grounded", "storytelling", "short_video_friendly", "long_form_friendly"),
  },
  avoid: {
    mode: "multi", min: 0, max: 3,
    options: options("chicken_soup", "academic", "vague", "clickbait", "commercialized", "negative", "grand_narrative"),
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
  const cityContext = validateSingleField(value.cityContext, "cityContext");
  const genderPerspective = validateSingleField(value.genderPerspective, "genderPerspective");
  const platforms = validateMultiField(value.platforms, "platforms");

  if (
    role === null ||
    domain === null ||
    stage === null ||
    cityContext === null ||
    genderPerspective === null ||
    platforms === null
  ) {
    return null;
  }

  return {
    role,
    domain,
    stage,
    cityContext,
    genderPerspective,
    platforms,
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
