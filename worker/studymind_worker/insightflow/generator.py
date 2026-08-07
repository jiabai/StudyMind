from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from studymind_worker.atomic_files import platform_text_bytes
from studymind_worker.insightflow.artifact_storage import commit_insight_payloads
from studymind_worker.insightflow.prompt import build_question_prompt, build_topic_plan_prompt
from studymind_worker.insightflow.splitter import MarkdownSplitter
from studymind_worker.insightflow.utils import extract_json_from_llm_output
from studymind_worker.models import Insight, PreferenceSnapshot
from studymind_worker.output_language import (
    OutputLanguage,
    OutputLanguageSemantics,
    output_language_semantics,
)

QUESTION_GENERATION_LENGTH = 1000
MAX_TOPIC_PLANS = 8
MAX_INSIGHTS = 12
MIN_QUESTIONS_PER_TOPIC = 1
MAX_QUESTIONS_PER_TOPIC = 3


class InsightGenerationError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class InsightClient(Protocol):
    def generate(self, prompt: str) -> str:
        pass


@dataclass(frozen=True)
class InsightArtifacts:
    insights: list[Insight]
    json_path: Path
    md_path: Path
    json_bytes: bytes
    md_bytes: bytes


@dataclass(frozen=True)
class TopicPlan:
    id: int
    title: str
    summary: str
    excerpt: str
    question_count: int


@dataclass(frozen=True)
class InsightDraft:
    topic: str
    match_reason: str
    follow_up_questions: tuple[str, ...]
    suitable_use: str


def generate_insights_from_markdown(
    markdown: str,
    output_dir: Path,
    output_stem: str,
    client: InsightClient,
    output_language: OutputLanguage,
    splitter: MarkdownSplitter | None = None,
    preference_snapshot: PreferenceSnapshot | None = None,
    persist: bool = True,
) -> InsightArtifacts:
    chunks = (splitter or MarkdownSplitter()).split(markdown)
    if not chunks:
        raise InsightGenerationError("INSIGHTFLOW_EMPTY_TRANSCRIPT", "Transcript is empty.")

    insights = _generate_questions_from_topic_plan(
        markdown,
        client,
        output_language,
        preference_snapshot,
    )
    if not insights:
        insights = _generate_questions_from_chunks(
            chunks,
            client,
            output_language,
            preference_snapshot,
        )

    return write_insight_files(
        insights,
        output_dir=output_dir,
        output_stem=output_stem,
        output_language=output_language,
        persist=persist,
    )


def _generate_questions_from_topic_plan(
    markdown: str,
    client: InsightClient,
    output_language: OutputLanguage,
    preference_snapshot: PreferenceSnapshot | None,
) -> list[Insight]:
    plan_prompt = build_topic_plan_prompt(
        markdown,
        output_language=output_language,
        max_topics=MAX_TOPIC_PLANS,
        max_questions=MAX_INSIGHTS,
        preference_snapshot=preference_snapshot,
    )
    parsed = extract_json_from_llm_output(client.generate(plan_prompt))
    topic_plans = _normalize_topic_plans(parsed)
    if not topic_plans:
        return []

    insights: list[Insight] = []
    seen: set[str] = set()
    for topic in topic_plans:
        prompt = build_question_prompt(
            _format_topic_plan_text(topic, output_language),
            number=topic.question_count,
            output_language=output_language,
            question_prompt=output_language_semantics(
                output_language
            ).topic_question_constraint,
            preference_snapshot=preference_snapshot,
        )
        parsed = extract_json_from_llm_output(client.generate(prompt))
        _append_unique_insights(
            insights,
            seen,
            _normalize_insight_drafts(parsed, output_language),
            chunk_id=topic.id,
        )
        if len(insights) >= MAX_INSIGHTS:
            break

    return insights[:MAX_INSIGHTS]


def _generate_questions_from_chunks(
    chunks: list[object],
    client: InsightClient,
    output_language: OutputLanguage,
    preference_snapshot: PreferenceSnapshot | None,
) -> list[Insight]:
    insights: list[Insight] = []
    seen: set[str] = set()
    for chunk in chunks:
        content = str(getattr(chunk, "content", "")).strip()
        if not content:
            continue
        number = calculate_question_count(content)
        prompt = build_question_prompt(
            content,
            number=number,
            output_language=output_language,
            preference_snapshot=preference_snapshot,
        )
        parsed = extract_json_from_llm_output(client.generate(prompt))
        _append_unique_insights(
            insights,
            seen,
            _normalize_insight_drafts(parsed, output_language),
            chunk_id=int(getattr(chunk, "id", len(insights) + 1)),
        )
        if len(insights) >= MAX_INSIGHTS:
            break

    return insights[:MAX_INSIGHTS]


def calculate_question_count(
    text: str,
    question_generation_length: int = QUESTION_GENERATION_LENGTH,
) -> int:
    if question_generation_length <= 0:
        return 1
    return max(1, len(text) // question_generation_length)


def _normalize_topic_plans(parsed: object | None) -> list[TopicPlan]:
    if not isinstance(parsed, list):
        return []

    topic_plans: list[TopicPlan] = []
    remaining_questions = MAX_INSIGHTS
    for item in parsed:
        if not isinstance(item, dict):
            continue

        title = str(item.get("title") or "").strip()
        summary = str(item.get("summary") or "").strip()
        excerpt = str(item.get("excerpt") or "").strip()
        if not title or not (summary or excerpt):
            continue

        question_count = _coerce_question_count(item.get("question_count"))
        question_count = min(question_count, remaining_questions)
        if question_count < MIN_QUESTIONS_PER_TOPIC:
            break

        topic_plans.append(
            TopicPlan(
                id=len(topic_plans) + 1,
                title=title,
                summary=summary,
                excerpt=excerpt,
                question_count=question_count,
            )
        )
        remaining_questions -= question_count
        if len(topic_plans) >= MAX_TOPIC_PLANS or remaining_questions <= 0:
            break

    return topic_plans


def _coerce_question_count(raw_value: object) -> int:
    try:
        question_count = int(str(raw_value).strip())
    except (TypeError, ValueError):
        question_count = MIN_QUESTIONS_PER_TOPIC

    return max(
        MIN_QUESTIONS_PER_TOPIC,
        min(MAX_QUESTIONS_PER_TOPIC, question_count),
    )


def _format_topic_plan_text(
    topic: TopicPlan,
    output_language: OutputLanguage,
) -> str:
    semantics = output_language_semantics(output_language)
    return f"""# {topic.title}

## {semantics.topic_summary_heading}
{topic.summary}

## {semantics.transcript_excerpt_heading}
{topic.excerpt}
"""


def write_insight_files(
    insights: list[Insight],
    output_dir: Path,
    output_stem: str,
    output_language: OutputLanguage,
    persist: bool = True,
) -> InsightArtifacts:
    if not insights:
        raise InsightGenerationError(
            "INSIGHTFLOW_EMPTY_RESULT",
            "InsightFlow returned no insights.",
        )

    if output_stem:
        json_path = output_dir / f"{output_stem}_insights.json"
        md_path = output_dir / f"{output_stem}_insights.md"
    else:
        json_path = output_dir / "insights.json"
        md_path = output_dir / "insights.md"

    payload = {
        "schemaVersion": 1,
        "insights": [insight.to_dict() for insight in insights],
    }
    json_bytes = platform_text_bytes(
        json.dumps(payload, ensure_ascii=False, indent=2)
    )
    md_bytes = platform_text_bytes(
        _format_insights_markdown(insights, output_language)
    )
    if persist:
        commit_insight_payloads(
            output_dir,
            output_stem,
            {
                json_path: json_bytes,
                md_path: md_bytes,
            },
        )

    return InsightArtifacts(
        insights=insights,
        json_path=json_path,
        md_path=md_path,
        json_bytes=json_bytes,
        md_bytes=md_bytes,
    )


def _normalize_insight_drafts(
    parsed: object | None,
    output_language: OutputLanguage,
) -> list[InsightDraft]:
    if not isinstance(parsed, list):
        return []

    semantics = output_language_semantics(output_language)
    drafts: list[InsightDraft] = []
    for item in parsed:
        if isinstance(item, str):
            text = item.strip()
            if text:
                drafts.append(
                    InsightDraft(
                        topic=text,
                        match_reason=semantics.default_match_reason,
                        follow_up_questions=(text,),
                        suitable_use=semantics.default_suitable_use,
                    )
                )
        elif isinstance(item, dict):
            topic = str(
                item.get("topic")
                or item.get("question")
                or item.get("text")
                or ""
            ).strip()
            if not topic:
                continue
            match_reason = str(
                item.get("matchReason")
                or item.get("match_reason")
                or semantics.default_match_reason
            ).strip()
            suitable_use = str(
                item.get("suitableUse")
                or item.get("suitable_use")
                or item.get("label")
                or semantics.default_suitable_use
            ).strip()
            follow_up_questions = _normalize_follow_up_questions(
                item.get("followUpQuestions")
                or item.get("follow_up_questions")
                or item.get("questions")
                or []
            )
            drafts.append(
                InsightDraft(
                    topic=topic,
                    match_reason=match_reason or semantics.default_match_reason,
                    follow_up_questions=follow_up_questions or (topic,),
                    suitable_use=suitable_use or semantics.default_suitable_use,
                )
            )
    return drafts


def _normalize_follow_up_questions(raw_value: object) -> tuple[str, ...]:
    if not isinstance(raw_value, list):
        return ()
    questions = tuple(
        question.strip()
        for question in raw_value
        if isinstance(question, str) and question.strip()
    )
    return questions[:3]


def _append_unique_insights(
    insights: list[Insight],
    seen: set[str],
    drafts: list[InsightDraft],
    chunk_id: int,
) -> None:
    for draft in drafts:
        if len(insights) >= MAX_INSIGHTS:
            break
        dedupe_key = draft.topic.strip()
        if dedupe_key and dedupe_key not in seen:
            seen.add(dedupe_key)
            insights.append(
                Insight(
                    id=len(insights) + 1,
                    topic=dedupe_key,
                    match_reason=draft.match_reason,
                    follow_up_questions=draft.follow_up_questions,
                    suitable_use=draft.suitable_use,
                    source_chunk_id=chunk_id,
                )
            )


def _format_insights_markdown(
    insights: list[Insight],
    output_language: OutputLanguage,
) -> str:
    semantics: OutputLanguageSemantics = output_language_semantics(output_language)
    lines = [f"# {semantics.insights_title}", ""]
    for insight in insights:
        lines.extend(
            [
                f"## {semantics.insight_item_label} {insight.id}",
                "",
                f"### {semantics.insight_topic_heading}",
                insight.topic,
                "",
                f"### {semantics.match_reason_heading}",
                insight.match_reason,
                "",
                f"### {semantics.follow_up_heading}",
                *[f"- {question}" for question in insight.follow_up_questions],
                "",
                f"### {semantics.suitable_use_heading}",
                insight.suitable_use,
            ]
        )
        if insight.source_chunk_id is not None:
            lines.extend(
                ["", f"{semantics.source_chunk_label}: {insight.source_chunk_id}"]
            )
        lines.append("")
    lines.append("")
    return "\n".join(lines)
