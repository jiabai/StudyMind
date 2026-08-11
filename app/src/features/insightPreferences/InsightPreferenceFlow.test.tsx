import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

import type { InsightPreferenceFlowState } from "../../insightPreferenceFlow";
import { InsightPreferenceFlow } from "./InsightPreferenceFlow";

const FLOW: InsightPreferenceFlowState = {
  screen: "confirmation",
  profile: {
    role: "working_professional",
    domain: "business_management",
    stage: "advanced",
    learningContext: "workplace_training",
    knowledgeLevel: "familiar",
    studyMethods: ["note_taking"],
  },
  profileSkipped: false,
  profileResetRequired: false,
  defaultGenerationPreferences: null,
  generationPreferences: {
    goal: "organize_notes",
    scenario: "work_training",
    angles: ["core_concepts"],
    audience: "beginner_learner",
    styles: ["structured"],
    avoid: [],
  },
  currentStep: "avoid",
  currentStepIndex: 5,
  canAdvance: true,
};

function renderFlow(
  locale: "zh-CN" | "zh-TW" | "en-US",
  options: {
    outputLanguage?: "zh-CN" | "zh-TW" | "en-US";
    busy?: boolean;
    transcriptText?: string;
  } = {},
) {
  return renderToStaticMarkup(
    <InsightPreferenceFlow
      flow={FLOW}
      busy={options.busy ?? false}
      accountQuotaRemaining={19}
      transcriptText={
        options.transcriptText ?? (locale === "en-US" ? "hello world" : "測試逐字稿")
      }
      transcriptPath={null}
      locale={locale}
      outputLanguage={options.outputLanguage ?? locale}
      onFlowChange={vi.fn()}
      onSkipProfile={vi.fn()}
      onSaveProfile={vi.fn()}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
}

describe("InsightPreferenceFlow localization", () => {
  test("renders independently localized confirmation copy and actual output language", () => {
    const traditional = renderFlow("zh-TW");
    expect(traditional).toContain('aria-label="確認學習目標"');
    expect(traditional).toContain('data-output-language="zh-TW"');
    expect(traditional).toContain("本次輸出語言");
    expect(traditional).toContain("商業與管理");
    expect(traditional).toContain("5 字");

    const english = renderFlow("en-US");
    expect(english).toContain('aria-label="Confirm study goals"');
    expect(english).toContain('data-output-language="en-US"');
    expect(english).toContain("Output language for this run");
    expect(english).toContain("Business and management");
    expect(english).toContain("2 words");
    expect(english).not.toContain("11 words");
    expect(english).not.toContain("确认学习目标");
  });

  test("keeps the frozen request language visible while a confirmation is busy", () => {
    const markup = renderFlow("en-US", {
      outputLanguage: "zh-TW",
      busy: true,
    });

    expect(markup).toContain('data-output-language="zh-TW"');
    expect(markup).toContain("Output language for this run");
    expect(markup).toContain("Traditional Chinese (Taiwan)");
    expect(markup).not.toContain('data-output-language="en-US"');
  });

  test.each([
    ["zh-CN", "本次学习偏好", "你的学习背景", "讲解方式", "学习输出中避免"],
    ["zh-TW", "本次學習偏好", "你的學習背景", "講解方式", "學習輸出中避免"],
    ["en-US", "Study preferences for this run", "Your learning background", "Explanation style", "Avoid in the study output"],
  ] as const)(
    "renders current-run preferences before quiet long-term context in %s",
    (locale, currentTitle, contextTitle, styleLabel, avoidLabel) => {
      const markup = renderFlow(locale);

      const currentHeading = `<h3>${currentTitle}</h3>`;
      const contextHeading = `<h3>${contextTitle}</h3>`;

      expect(markup.indexOf(currentHeading)).toBeLessThan(markup.indexOf(contextHeading));
      expect(markup).toContain(`preference-summary-group quiet`);
      const currentGroup = markup.slice(
        markup.indexOf(currentHeading),
        markup.indexOf(contextHeading),
      );
      const contextGroup = markup.slice(markup.indexOf(contextHeading));
      expect(currentGroup).toContain(styleLabel);
      expect(currentGroup).toContain(avoidLabel);
      expect(contextGroup).not.toContain(styleLabel);
      expect(contextGroup).not.toContain(avoidLabel);
    },
  );

  test("renders exactly the six long-term Profile fields in the profile form", () => {
    const markup = renderToStaticMarkup(
      <InsightPreferenceFlow
        flow={{ ...FLOW, screen: "profile_form" }}
        busy={false}
        accountQuotaRemaining={19}
        transcriptText=""
        transcriptPath={null}
        locale="en-US"
        outputLanguage="en-US"
        onFlowChange={vi.fn()}
        onSkipProfile={vi.fn()}
        onSaveProfile={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect((markup.match(/class="preference-field"/g) ?? [])).toHaveLength(6);
    expect(markup).not.toContain("Default style preferences");
    expect(markup).not.toContain("Default directions to avoid");
  });
});
