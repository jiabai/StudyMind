from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from studymind_worker.atomic_files import platform_text_bytes
from studymind_worker.insightflow.artifact_storage import commit_insight_payloads
from studymind_worker.insightflow.generator import InsightClient, InsightGenerationError
from studymind_worker.insightflow.prompt import build_mindmap_prompt, build_summary_prompt
from studymind_worker.insightflow.splitter import MarkdownSplitter
from studymind_worker.output_language import OutputLanguage, output_language_semantics


@dataclass(frozen=True)
class SummaryArtifacts:
    summary: str
    mindmap: str
    summary_path: Path
    mindmap_path: Path
    summary_bytes: bytes
    mindmap_bytes: bytes


def generate_summary_from_markdown(
    markdown: str,
    output_dir: Path,
    output_stem: str,
    client: InsightClient,
    output_language: OutputLanguage,
    splitter: MarkdownSplitter | None = None,
    persist: bool = True,
) -> SummaryArtifacts:
    chunks = (splitter or MarkdownSplitter()).split(markdown)
    if not chunks:
        raise InsightGenerationError("INSIGHTFLOW_EMPTY_TRANSCRIPT", "Transcript is empty.")

    raw_mindmap = client.generate(
        build_mindmap_prompt(markdown, output_language=output_language)
    )
    mindmap = normalize_mermaid_mindmap(raw_mindmap)
    raw_summary = client.generate(
        build_summary_prompt(
            markdown,
            mindmap,
            output_language=output_language,
        )
    )
    summary = normalize_summary_markdown(raw_summary, output_language)

    return write_summary_files(
        summary=summary,
        mindmap=mindmap,
        output_dir=output_dir,
        output_stem=output_stem,
        output_language=output_language,
        persist=persist,
    )


def write_summary_files(
    summary: str,
    mindmap: str,
    output_dir: Path,
    output_stem: str,
    output_language: OutputLanguage,
    persist: bool = True,
) -> SummaryArtifacts:
    normalized_summary = normalize_summary_markdown(summary, output_language)
    normalized_mindmap = normalize_mermaid_mindmap(mindmap)
    if not normalized_summary:
        raise InsightGenerationError(
            "INSIGHTFLOW_EMPTY_SUMMARY",
            "InsightFlow returned an empty summary.",
        )
    if not normalized_mindmap:
        raise InsightGenerationError(
            "INSIGHTFLOW_INVALID_MINDMAP",
            "InsightFlow returned an invalid Mermaid mindmap.",
        )

    if output_stem:
        summary_path = output_dir / f"{output_stem}_summary.md"
        mindmap_path = output_dir / f"{output_stem}_mindmap.mmd"
    else:
        summary_path = output_dir / "summary.md"
        mindmap_path = output_dir / "mindmap.mmd"
    summary_bytes = platform_text_bytes(normalized_summary)
    mindmap_bytes = platform_text_bytes(normalized_mindmap)
    if persist:
        commit_insight_payloads(
            output_dir,
            output_stem,
            {
                summary_path: summary_bytes,
                mindmap_path: mindmap_bytes,
            },
        )

    return SummaryArtifacts(
        summary=normalized_summary,
        mindmap=normalized_mindmap,
        summary_path=summary_path,
        mindmap_path=mindmap_path,
        summary_bytes=summary_bytes,
        mindmap_bytes=mindmap_bytes,
    )


def normalize_summary_markdown(
    raw_summary: str,
    output_language: OutputLanguage,
) -> str:
    summary = _strip_code_fence(raw_summary).strip()
    if not summary:
        return ""
    if not summary.startswith("#"):
        title = output_language_semantics(output_language).summary_title
        summary = f"# {title}\n\n{summary}"
    return f"{summary.rstrip()}\n"


def normalize_mermaid_mindmap(raw_mindmap: str) -> str:
    mindmap = _strip_code_fence(raw_mindmap).replace("\r\n", "\n").replace("\r", "\n").strip()
    if not mindmap:
        return ""

    lines = [line.rstrip() for line in mindmap.split("\n") if line.strip()]
    start_index = next(
        (index for index, line in enumerate(lines) if line.strip() == "mindmap"),
        None,
    )
    if start_index is None:
        return ""

    normalized = "\n".join(lines[start_index:]).strip()
    return f"{normalized}\n" if normalized else ""


def _strip_code_fence(text: str) -> str:
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped

    lines = stripped.splitlines()
    if len(lines) >= 2 and lines[-1].strip() == "```":
        return "\n".join(lines[1:-1]).strip()
    return stripped
