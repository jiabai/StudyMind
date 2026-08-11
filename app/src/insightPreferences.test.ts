import { describe, expect, test } from "vitest";
import {
  buildPreferenceSnapshot,
  isPreferenceOptionId,
  validateGenerationPreferences,
  validateInspirationProfile,
  type GenerationPreferences,
  type InspirationProfile,
} from "./insightPreferences";
import {
  getPreferenceFieldPresentation,
  summarizeGenerationPreferences,
  summarizeInspirationProfile,
} from "./i18n/preferencePresentation";

const PROFILE_V2: InspirationProfile = {
  role: "student",
  domain: "science_engineering",
  stage: "intermediate",
  learningContext: "lecture",
  knowledgeLevel: "familiar",
  studyMethods: ["note_taking"],
};

const VALID_GENERATION_PREFERENCES: GenerationPreferences = {
  goal: "understand_concepts",
  scenario: "class_notes",
  angles: ["core_concepts", "examples_cases"],
  audience: "beginner_learner",
  styles: ["structured"],
  avoid: [],
};

describe("insight preferences", () => {
  test("accepts a learner profile without creator-platform fields", () => {
    const learnerProfile = {
      role: "student",
      domain: "science_engineering",
      stage: "intermediate",
      learningContext: "lecture",
      knowledgeLevel: "familiar",
      studyMethods: ["note_taking", "practice_questions"],
    };

    expect(validateInspirationProfile(learnerProfile)).toEqual(learnerProfile);
    expect(validateInspirationProfile({
      ...learnerProfile,
      platforms: ["douyin"],
    })).toBeNull();
    expect(getPreferenceFieldPresentation("zh-CN", "learningContext").options).toContainEqual({
      id: "lecture",
      label: "课程 / 讲座",
    });
  });

  test("validates a complete inspiration profile with field-scoped option ids", () => {
    expect(validateInspirationProfile(PROFILE_V2)).toEqual(PROFILE_V2);
    expect(isPreferenceOptionId("role", "teacher")).toBe(true);
    expect(getPreferenceFieldPresentation("zh-CN", "role").options).toContainEqual({
      id: "teacher",
      label: "教师/培训者",
    });
    expect(getPreferenceFieldPresentation("zh-CN", "domain").options).toContainEqual({
      id: "science_engineering",
      label: "科学与工程",
    });
  });

  test("rejects invalid inspiration profiles instead of silently defaulting them", () => {
    expect(validateInspirationProfile({ ...PROFILE_V2, role: "content_creation" })).toBeNull();
    expect(
      validateInspirationProfile({
        ...PROFILE_V2,
        studyMethods: ["note_taking", "practice_questions", "discussion", "teach_back"],
      }),
    ).toBeNull();
    expect(
      validateInspirationProfile({ ...PROFILE_V2, defaultStyles: ["direct_sharp"] }),
    ).toBeNull();

    const missingRole = { ...PROFILE_V2 } as Partial<InspirationProfile>;
    delete missingRole.role;
    expect(validateInspirationProfile(missingRole)).toBeNull();
  });

  test("validates per-run generation preferences and count limits", () => {
    expect(validateGenerationPreferences(VALID_GENERATION_PREFERENCES)).toEqual(
      VALID_GENERATION_PREFERENCES,
    );
    expect(validateGenerationPreferences({ ...VALID_GENERATION_PREFERENCES, angles: [] })).toBeNull();
    expect(
      validateGenerationPreferences({
        ...VALID_GENERATION_PREFERENCES,
        styles: ["structured", "clear_concise", "deep_explanation"],
      }),
    ).toBeNull();
    expect(
      validateGenerationPreferences({
        ...VALID_GENERATION_PREFERENCES,
        avoid: ["overly_abstract", "repetition", "off_topic", "unverified"],
      }),
    ).toBeNull();
  });

  test("rejects display labels used as persisted values", () => {
    expect(
      validateGenerationPreferences({
        ...VALID_GENERATION_PREFERENCES,
        goal: "内容创作",
      }),
    ).toBeNull();
  });

  test("renders concise summaries from current option labels", () => {
    expect(summarizeInspirationProfile(PROFILE_V2, "zh-CN")).toEqual([
      "学习者身份：学生",
      "学习领域：科学与工程",
      "学习阶段：有基础",
      "学习情境：课程 / 讲座",
      "对主题的熟悉度：基本熟悉",
      "偏好的学习方式：整理笔记",
    ]);

    expect(summarizeGenerationPreferences(VALID_GENERATION_PREFERENCES, "zh-CN")).toEqual([
      "本次学习目标：理解核心概念",
      "本次学习场景：整理课堂笔记",
      "希望重点理解：核心概念、例子与案例",
      "内容面向：刚入门的学习者",
      "讲解方式：结构清晰",
      "学习输出中避免：不指定",
    ]);
  });

  test("builds a preference snapshot with ids and separate label snapshots", () => {
    const snapshot = buildPreferenceSnapshot({
      profile: PROFILE_V2,
      profileSkipped: false,
      generationPreferences: VALID_GENERATION_PREFERENCES,
    });

    expect(snapshot.profile).toEqual(PROFILE_V2);
    expect(JSON.stringify(snapshot)).not.toMatch(/defaultStyles|defaultAvoid/);
    expect(snapshot.generationPreferences.goal).toBe("understand_concepts");
    expect(JSON.stringify(snapshot.generationPreferences)).not.toContain("理解核心概念");
    expect(snapshot.labelSnapshot.generationPreferences).toContainEqual({
      field: "goal",
      label: "本次学习目标",
      values: [{ id: "understand_concepts", label: "理解核心概念" }],
    });
    expect(snapshot.labelSnapshot.profile).toContainEqual({
      field: "studyMethods",
      label: "偏好的学习方式",
      values: [
        { id: "note_taking", label: "整理笔记" },
      ],
    });
  });
});
