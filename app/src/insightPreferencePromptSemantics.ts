import type { PreferenceField } from "./insightPreferences";

type PromptFieldSemantics = {
  readonly label: string;
  readonly options: Readonly<Record<string, string>>;
};

// Canonical learning vocabulary sent to the LLM. It is deliberately stable
// across UI languages so the same preferences produce the same intent.
export const INSIGHT_PREFERENCE_PROMPT_SEMANTICS = {
  role: {
    label: "学习者身份",
    options: {
      student: "学生",
      working_professional: "职场学习者",
      teacher: "教师/培训者",
      researcher: "研究者",
      lifelong_learner: "终身学习者",
      unspecified: "不指定",
    },
  },
  domain: {
    label: "学习领域",
    options: {
      science_engineering: "科学与工程",
      business_management: "商业与管理",
      languages: "语言学习",
      social_sciences: "社会科学",
      humanities: "人文艺术",
      education: "教育培训",
      exam_prep: "考试与资格认证",
      general_knowledge: "通识知识",
      unspecified: "不指定",
    },
  },
  stage: {
    label: "学习阶段",
    options: {
      beginner: "入门",
      intermediate: "有基础",
      advanced: "进阶",
      professional: "专业深化",
      unspecified: "不指定",
    },
  },
  learningContext: {
    label: "学习情境",
    options: {
      classroom: "课堂学习",
      lecture: "课程 / 讲座",
      self_study: "自主学习",
      exam_preparation: "备考复习",
      workplace_training: "工作培训",
      reading_group: "读书 / 研讨",
      unspecified: "不指定",
    },
  },
  knowledgeLevel: {
    label: "对主题的熟悉度",
    options: {
      new_to_topic: "刚接触",
      familiar: "基本熟悉",
      advanced: "已有深入基础",
      unspecified: "不指定",
    },
  },
  studyMethods: {
    label: "偏好的学习方式",
    options: {
      note_taking: "整理笔记",
      practice_questions: "练习提问",
      spaced_repetition: "间隔复习",
      discussion: "讨论讲解",
      project_application: "项目应用",
      teach_back: "费曼复述",
    },
  },
  goal: {
    label: "本次学习目标",
    options: {
      understand_concepts: "理解核心概念",
      prepare_for_exam: "准备考试",
      organize_notes: "整理学习笔记",
      apply_in_practice: "联系实际应用",
      build_connections: "建立知识联系",
      review_weak_points: "复习薄弱点",
    },
  },
  scenario: {
    label: "本次学习场景",
    options: {
      class_notes: "整理课堂笔记",
      self_study: "自主学习",
      exam_review: "考前复习",
      work_training: "工作培训",
      reading_review: "阅读回顾",
      teach_someone: "准备讲给别人听",
    },
  },
  angles: {
    label: "希望重点理解",
    options: {
      core_concepts: "核心概念",
      key_definitions: "定义与术语",
      cause_effect: "因果关系",
      steps_process: "步骤与过程",
      examples_cases: "例子与案例",
      compare_contrast: "比较与区别",
      common_misconceptions: "常见误区",
      practice_questions: "练习问题",
      evidence_reasoning: "证据与推理",
      connections: "知识关联",
    },
  },
  audience: {
    label: "内容面向",
    options: {
      self: "我自己",
      beginner_learner: "刚入门的学习者",
      study_group: "学习小组",
      classmate: "同学",
      teacher: "老师 / 导师",
      future_self: "未来复习时的自己",
    },
  },
  styles: {
    label: "讲解方式",
    options: {
      structured: "结构清晰",
      clear_concise: "简洁易懂",
      deep_explanation: "深入解释",
      examples_first: "先讲例子",
      socratic: "循序提问",
      exam_focused: "突出考试重点",
      action_oriented: "强调实践步骤",
    },
  },
  avoid: {
    label: "学习输出中避免",
    options: {
      unsupported_claims: "无依据的结论",
      overly_abstract: "过于抽象",
      too_much_detail: "无关的细枝末节",
      repetition: "重复堆叠",
      unexplained_jargon: "未解释的术语",
      off_topic: "偏离文字稿",
      unverified: "把不确定内容说成事实",
    },
  },
} as const satisfies Record<PreferenceField, PromptFieldSemantics>;
