from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Literal, TypeGuard

OutputLanguage = Literal["zh-CN", "zh-TW", "en-US"]

SUPPORTED_OUTPUT_LANGUAGES: Final[tuple[OutputLanguage, ...]] = (
    "zh-CN",
    "zh-TW",
    "en-US",
)


@dataclass(frozen=True)
class OutputLanguageSemantics:
    prompt_instruction: str
    summary_title: str
    summary_overview_title: str
    topic_summary_heading: str
    transcript_excerpt_heading: str
    topic_question_constraint: str
    default_match_reason: str
    default_suitable_use: str
    insights_title: str
    insight_item_label: str
    insight_topic_heading: str
    match_reason_heading: str
    follow_up_heading: str
    suitable_use_heading: str
    source_chunk_label: str
    topic_example_title: str
    topic_example_summary: str
    topic_example_excerpt: str
    question_example_topic: str
    question_example_reason: str
    question_example_follow_up: str
    question_example_use: str
    mindmap_example_root: str
    mindmap_example_branch: str
    mindmap_example_point: str


OUTPUT_LANGUAGE_SEMANTICS: Final[dict[OutputLanguage, OutputLanguageSemantics]] = {
    "zh-CN": OutputLanguageSemantics(
        prompt_instruction=(
            "Use Simplified Chinese for every user-visible generated value, Markdown "
            "heading/body, and Mermaid node label. Do not change JSON keys, artifact "
            "schemas, or Mermaid syntax."
        ),
        summary_title="要点总结",
        summary_overview_title="总览",
        topic_summary_heading="话题摘要",
        transcript_excerpt_heading="原文片段",
        topic_question_constraint="只围绕当前话题段生成问题，不要扩展到其他话题段。",
        default_match_reason="来自文字稿相关片段。",
        default_suitable_use="灵感延展",
        insights_title="启发灵感",
        insight_item_label="灵感",
        insight_topic_heading="灵感",
        match_reason_heading="匹配理由",
        follow_up_heading="启发问题",
        suitable_use_heading="适合用途",
        source_chunk_label="来源片段",
        topic_example_title="企业 AI 落地",
        topic_example_summary="讨论企业 AI 落地与流程编排的关系。",
        topic_example_excerpt="企业 AI 落地时，流程编排比单点能力更关键。",
        question_example_topic="为什么流程编排可能比单点模型能力更关键？",
        question_example_reason="这条灵感与文字稿和偏好相符。",
        question_example_follow_up="团队应该先改造哪条流程？",
        question_example_use="内容选题",
        mindmap_example_root="核心主题",
        mindmap_example_branch="主要分支",
        mindmap_example_point="关键要点",
    ),
    "zh-TW": OutputLanguageSemantics(
        prompt_instruction=(
            "Use Traditional Chinese (Taiwan) for every user-visible generated value, "
            "Markdown heading/body, and Mermaid node label; never convert it to "
            "Simplified Chinese. Do not change JSON keys, artifact schemas, or Mermaid syntax."
        ),
        summary_title="重點摘要",
        summary_overview_title="總覽",
        topic_summary_heading="話題摘要",
        transcript_excerpt_heading="逐字稿片段",
        topic_question_constraint="只圍繞目前話題段產生問題，不要擴展到其他話題段。",
        default_match_reason="來自逐字稿的相關片段。",
        default_suitable_use="靈感延伸",
        insights_title="靈感啟發",
        insight_item_label="靈感",
        insight_topic_heading="靈感",
        match_reason_heading="匹配理由",
        follow_up_heading="啟發問題",
        suitable_use_heading="適合用途",
        source_chunk_label="來源片段",
        topic_example_title="企業 AI 落地",
        topic_example_summary="討論企業 AI 落地與流程編排的關係。",
        topic_example_excerpt="企業 AI 落地時，流程編排比單點能力更關鍵。",
        question_example_topic="為什麼流程編排可能比單點模型能力更關鍵？",
        question_example_reason="這則靈感符合逐字稿與偏好。",
        question_example_follow_up="團隊應該先改造哪一條流程？",
        question_example_use="內容選題",
        mindmap_example_root="核心主題",
        mindmap_example_branch="主要分支",
        mindmap_example_point="關鍵要點",
    ),
    "en-US": OutputLanguageSemantics(
        prompt_instruction=(
            "Use clear US English for every user-visible generated value, Markdown "
            "heading/body, and Mermaid node label. Do not change JSON keys, artifact "
            "schemas, or Mermaid syntax."
        ),
        summary_title="Key Summary",
        summary_overview_title="Overview",
        topic_summary_heading="Topic Summary",
        transcript_excerpt_heading="Transcript Passage",
        topic_question_constraint=(
            "Generate questions only about this topic segment; do not expand into other topics."
        ),
        default_match_reason="Based on a relevant transcript passage.",
        default_suitable_use="Idea development",
        insights_title="Inspiration",
        insight_item_label="Inspiration",
        insight_topic_heading="Inspiration",
        match_reason_heading="Match Reason",
        follow_up_heading="Follow-up Questions",
        suitable_use_heading="Suitable Use",
        source_chunk_label="Source Segment",
        topic_example_title="Enterprise AI Adoption",
        topic_example_summary="How orchestration supports enterprise AI adoption.",
        topic_example_excerpt="Workflow orchestration can matter more than one model capability.",
        question_example_topic="Why can workflow orchestration matter more than model capability?",
        question_example_reason="This idea matches the transcript and selected preferences.",
        question_example_follow_up="Which workflow should the team improve first?",
        question_example_use="Content planning",
        mindmap_example_root="Core Topic",
        mindmap_example_branch="Main Branch",
        mindmap_example_point="Key Point",
    ),
}


def is_output_language(value: object) -> TypeGuard[OutputLanguage]:
    return isinstance(value, str) and value in SUPPORTED_OUTPUT_LANGUAGES


def output_language_semantics(
    output_language: OutputLanguage,
) -> OutputLanguageSemantics:
    return OUTPUT_LANGUAGE_SEMANTICS[output_language]
