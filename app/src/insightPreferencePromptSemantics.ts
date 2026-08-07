import type { PreferenceField } from "./insightPreferences";

type PromptFieldSemantics = {
  readonly label: string;
  readonly options: Readonly<Record<string, string>>;
};

// This is the one canonical prompt-facing vocabulary. It is deliberately not
// localized: changing UI language must never change the normalized snapshot
// sent to the LLM.
export const INSIGHT_PREFERENCE_PROMPT_SEMANTICS = {
  role: {
    label: "我的角色",
    options: {
      content_creator: "内容创作者",
      product_ops: "产品/运营",
      marketing_sales: "市场/销售",
      entrepreneur: "创业者",
      student_researcher: "学生/研究者",
      teacher_trainer: "教师/培训者",
      investor_business_analyst: "投资/商业分析",
      general_learner: "普通学习者",
      unspecified: "不指定",
    },
  },
  domain: {
    label: "职业领域",
    options: {
      content_media: "内容媒体",
      product_operations: "产品运营",
      marketing_sales: "市场销售",
      education_training: "教育培训",
      technology_rd: "技术研发",
      management_consulting: "管理咨询",
      investment_business: "投资商业",
      freelance: "自由职业",
      general_perspective: "通用视角",
      unspecified: "不指定",
    },
  },
  stage: {
    label: "年龄/阶段",
    options: {
      student: "学生",
      early_career: "职场新人",
      experienced_professional: "成熟职场",
      manager: "管理者",
      entrepreneur_operator: "创业经营者",
      retired: "退休后",
      unspecified: "不指定",
    },
  },
  cityContext: {
    label: "城市语境",
    options: {
      tier1_city: "一线城市",
      new_tier1_city: "新一线城市",
      lower_tier_city: "二三线城市",
      county_township: "县城乡镇",
      overseas: "海外",
      unspecified: "不指定",
    },
  },
  genderPerspective: {
    label: "性别/视角",
    options: {
      unspecified: "不指定",
      female_perspective: "女性视角",
      male_perspective: "男性视角",
      neutral_perspective: "中性视角",
    },
  },
  platforms: {
    label: "常用平台",
    options: {
      douyin: "抖音",
      xiaohongshu: "小红书",
      wechat_channels: "视频号",
      bilibili: "B站",
      wechat_official_account: "公众号",
      podcast: "播客",
      course_community: "课程/社群",
      internal_sharing: "内部分享",
    },
  },
  goal: {
    label: "本次目标",
    options: {
      content_creation: "内容创作",
      learning_understanding: "学习理解",
      review_deconstruction: "复盘拆解",
      business_insight: "商业洞察",
      controversy_discussion: "争议讨论",
      action_advice: "行动建议",
    },
  },
  scenario: {
    label: "使用场景",
    options: {
      personal_notes: "自己记录",
      short_video: "发短视频",
      article_official_account: "写图文/公众号",
      livestream_podcast: "做直播/播客",
      team_sharing: "团队分享",
      client_communication: "客户沟通",
      course_community: "课程/社群",
    },
  },
  angles: {
    label: "关注角度",
    options: {
      topic_angle: "选题角度",
      contrarian_view: "反常识观点",
      audience_pain_point: "人群痛点",
      practical_advice: "实操建议",
      case_analogy: "案例类比",
      risk_controversy: "风险争议",
      trend_judgment: "趋势判断",
      reusable_method: "可复用方法",
      memorable_phrase: "金句表达",
      cognitive_refresh: "认知刷新",
    },
  },
  audience: {
    label: "目标受众",
    options: {
      self: "给自己看",
      beginners: "给新手看",
      peers: "给同行看",
      clients: "给客户看",
      boss_team: "给老板/团队看",
      fans_readers: "给粉丝/读者看",
    },
  },
  styles: {
    label: "表达风格",
    options: {
      direct_sharp: "直接犀利",
      gentle_inspiring: "温和启发",
      professional_analysis: "专业分析",
      grounded: "接地气",
      storytelling: "故事化",
      short_video_friendly: "更适合短视频",
      long_form_friendly: "更适合长文",
    },
  },
  avoid: {
    label: "避免方向",
    options: {
      chicken_soup: "不要太鸡汤",
      academic: "不要太学术",
      vague: "不要太空泛",
      clickbait: "不要标题党",
      commercialized: "不要太商业化",
      negative: "不要太负面",
      grand_narrative: "不要宏大叙事",
    },
  },
} as const satisfies Record<PreferenceField, PromptFieldSemantics>;
