from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from studymind_worker.atomic_files import platform_text_bytes
from studymind_worker.desktop_contract import ProgressCallback
from studymind_worker.insightflow.prompt import (
    build_dissection_map_prompt,
    build_dissection_reduce_prompt,
    build_dissection_repair_prompt,
)
from studymind_worker.insightflow.splitter import MarkdownChunk, MarkdownSplitter
from studymind_worker.insightflow.utils import extract_json_from_llm_output
from studymind_worker.output_language import OutputLanguage
from studymind_worker.progress_events import build_worker_progress_event

DISSECTION_CALL_PLAN_VERSION = 1
CHUNKS_PER_MAP_CALL = 4
REDUCE_CALLS = 1
MAX_REPAIR_CALLS = 1
MAX_TOTAL_CALLS = 6
MAX_CHUNKS = (MAX_TOTAL_CALLS - REDUCE_CALLS - MAX_REPAIR_CALLS) * CHUNKS_PER_MAP_CALL


class DissectionGenerationError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        repair_category: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.repair_category = repair_category


@dataclass(frozen=True)
class DissectionCallPlan:
    version: int
    map_batches: tuple[tuple[int, ...], ...]
    reduce_calls: int
    max_repair_calls: int
    minimum_calls: int
    maximum_calls: int


class DissectionClient(Protocol):
    def generate(self, prompt: str) -> str: ...


@dataclass(frozen=True)
class DissectionSourceChunk:
    id: int
    start_byte: int
    end_byte: int
    sha256: str

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "startByte": self.start_byte,
            "endByte": self.end_byte,
            "sha256": self.sha256,
        }


@dataclass(frozen=True)
class DissectionNarrative:
    opening_hook: str | None
    structure_type: str
    turning_point: str | None
    closing_type: str | None

    def to_dict(self) -> dict[str, object]:
        return {
            "openingHook": self.opening_hook,
            "structureType": self.structure_type,
            "turningPoint": self.turning_point,
            "closingType": self.closing_type,
        }


@dataclass(frozen=True)
class DissectionSegment:
    id: int
    title: str
    source_chunk_ids: tuple[int, ...]
    core_claim: str
    supporting_points: tuple[str, ...]
    rhetorical_devices: tuple[str, ...]
    rhythm_note: str
    reusable_pattern: str
    risk_flags: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "title": self.title,
            "sourceChunkIds": list(self.source_chunk_ids),
            "coreClaim": self.core_claim,
            "supportingPoints": list(self.supporting_points),
            "rhetoricalDevices": list(self.rhetorical_devices),
            "rhythmNote": self.rhythm_note,
            "reusablePattern": self.reusable_pattern,
            "riskFlags": list(self.risk_flags),
        }


@dataclass(frozen=True)
class DissectionTemplate:
    name: str
    skeleton: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        return {"name": self.name, "skeleton": list(self.skeleton)}


@dataclass(frozen=True)
class DissectionAudienceFit:
    audience: str
    fit: str
    note: str

    def to_dict(self) -> dict[str, str]:
        return {"audience": self.audience, "fit": self.fit, "note": self.note}


@dataclass(frozen=True)
class TranscriptDissection:
    source_transcript_sha256: str
    source_language: str | None
    source_chunks: tuple[DissectionSourceChunk, ...]
    overall_narrative: DissectionNarrative
    segments: tuple[DissectionSegment, ...]
    highlights: tuple[str, ...]
    reusable_template: DissectionTemplate
    audience_fit: tuple[DissectionAudienceFit, ...]
    strengths: tuple[str, ...]
    weaknesses: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "schemaVersion": 1,
            "sourceTranscriptSha256": self.source_transcript_sha256,
            "sourceLanguage": self.source_language,
            "sourceChunks": [chunk.to_dict() for chunk in self.source_chunks],
            "overallNarrative": self.overall_narrative.to_dict(),
            "segments": [segment.to_dict() for segment in self.segments],
            "highlights": list(self.highlights),
            "reusableTemplate": self.reusable_template.to_dict(),
            "audienceFit": [fit.to_dict() for fit in self.audience_fit],
            "strengths": list(self.strengths),
            "weaknesses": list(self.weaknesses),
        }


@dataclass(frozen=True)
class DissectionArtifacts:
    report: TranscriptDissection
    json_path: Path
    markdown_path: Path
    json_bytes: bytes
    markdown_bytes: bytes


def build_dissection_call_plan(chunk_count: int) -> DissectionCallPlan:
    if chunk_count < 1:
        raise DissectionGenerationError(
            "DISSECTION_EMPTY_TRANSCRIPT",
            "The saved transcript is empty.",
        )
    if chunk_count > MAX_CHUNKS:
        raise DissectionGenerationError(
            "DISSECTION_TRANSCRIPT_TOO_LARGE",
            "The saved transcript exceeds the bounded dissection call plan.",
        )

    chunk_ids = tuple(range(1, chunk_count + 1))
    map_batches = tuple(
        chunk_ids[index : index + CHUNKS_PER_MAP_CALL]
        for index in range(0, chunk_count, CHUNKS_PER_MAP_CALL)
    )
    minimum_calls = len(map_batches) + REDUCE_CALLS
    return DissectionCallPlan(
        version=DISSECTION_CALL_PLAN_VERSION,
        map_batches=map_batches,
        reduce_calls=REDUCE_CALLS,
        max_repair_calls=MAX_REPAIR_CALLS,
        minimum_calls=minimum_calls,
        maximum_calls=minimum_calls + MAX_REPAIR_CALLS,
    )


def parse_dissection_report(
    payload: object,
    *,
    transcript: str,
    chunks: list[MarkdownChunk],
    source_language: str | None,
) -> TranscriptDissection:
    try:
        report = _parse_semantic_report(payload, transcript, {chunk.id for chunk in chunks})
    except (KeyError, TypeError, ValueError) as exc:
        raise DissectionGenerationError(
            "DISSECTION_INVALID_RESULT",
            "The dissection response did not match the required structure.",
            repair_category=_repair_category(exc),
        ) from exc

    return TranscriptDissection(
        source_transcript_sha256=hashlib.sha256(transcript.encode("utf-8")).hexdigest(),
        source_language=source_language,
        source_chunks=tuple(
            DissectionSourceChunk(
                id=chunk.id,
                start_byte=chunk.start_byte,
                end_byte=chunk.end_byte,
                sha256=chunk.sha256,
            )
            for chunk in chunks
        ),
        **report,
    )


def parse_persisted_dissection(
    payload: object,
    *,
    transcript: str,
) -> TranscriptDissection:
    try:
        root = _closed_object(
            payload,
            {
                "schemaVersion",
                "sourceTranscriptSha256",
                "sourceLanguage",
                "sourceChunks",
                "overallNarrative",
                "segments",
                "highlights",
                "reusableTemplate",
                "audienceFit",
                "strengths",
                "weaknesses",
            },
        )
        if root["schemaVersion"] != 1 or type(root["schemaVersion"]) is not int:
            raise ValueError("schema version")
        source_language = root["sourceLanguage"]
        if source_language is not None and (
            not isinstance(source_language, str) or not source_language.strip()
        ):
            raise ValueError("source language")
        semantic_payload = {
            key: root[key]
            for key in (
                "overallNarrative",
                "segments",
                "highlights",
                "reusableTemplate",
                "audienceFit",
                "strengths",
                "weaknesses",
            )
        }
        report = parse_dissection_report(
            semantic_payload,
            transcript=transcript,
            chunks=MarkdownSplitter().split(transcript),
            source_language=source_language,
        )
        if report.to_dict() != root:
            raise ValueError("provenance")
        return report
    except (KeyError, TypeError, ValueError) as exc:
        raise DissectionGenerationError(
            "DISSECTION_INVALID_RESULT",
            "The saved dissection artifact is invalid.",
        ) from exc


def generate_transcript_dissection(
    transcript: str,
    *,
    client: DissectionClient,
    output_language: OutputLanguage,
    source_language: str | None,
    cancel_check=lambda: False,
    progress_callback: ProgressCallback | None = None,
) -> TranscriptDissection:
    chunks = MarkdownSplitter().split(transcript)
    plan = build_dissection_call_plan(len(chunks))
    by_id = {chunk.id: chunk for chunk in chunks}
    map_results: list[dict[str, object]] = []
    attempt = 0
    for batch in plan.map_batches:
        attempt += 1
        parsed = _generate_json(
            client,
            build_dissection_map_prompt([by_id[chunk_id] for chunk_id in batch], output_language),
            cancel_check,
            progress_callback=progress_callback,
            attempt=attempt,
            total=plan.maximum_calls,
        )
        if not isinstance(parsed, dict):
            raise DissectionGenerationError(
                "DISSECTION_INVALID_RESULT",
                "The dissection response did not match the required structure.",
            )
        map_results.append(parsed)

    attempt += 1
    candidate = _generate_json(
        client,
        build_dissection_reduce_prompt(map_results, output_language),
        cancel_check,
        progress_callback=progress_callback,
        attempt=attempt,
        total=plan.maximum_calls,
    )
    try:
        return parse_dissection_report(
            candidate,
            transcript=transcript,
            chunks=chunks,
            source_language=source_language,
        )
    except DissectionGenerationError as validation_error:
        attempt += 1
        repaired = _generate_json(
            client,
            build_dissection_repair_prompt(
                candidate,
                output_language,
                valid_chunk_ids=tuple(sorted(by_id)),
                validation_category=(
                    validation_error.repair_category or "schema_shape"
                ),
            ),
            cancel_check,
            progress_callback=progress_callback,
            attempt=attempt,
            total=plan.maximum_calls,
        )
        return parse_dissection_report(
            repaired,
            transcript=transcript,
            chunks=chunks,
            source_language=source_language,
        )


def build_dissection_artifacts(
    report: TranscriptDissection,
    *,
    output_dir: Path,
    output_language: OutputLanguage,
) -> DissectionArtifacts:
    json_path = output_dir / "dissection.json"
    markdown_path = output_dir / "dissection.md"
    return DissectionArtifacts(
        report=report,
        json_path=json_path,
        markdown_path=markdown_path,
        json_bytes=platform_text_bytes(
            json.dumps(report.to_dict(), ensure_ascii=False, indent=2)
        ),
        markdown_bytes=platform_text_bytes(
            format_dissection_markdown(report, output_language)
        ),
    )


def format_dissection_markdown(
    report: TranscriptDissection,
    output_language: OutputLanguage,
) -> str:
    labels = {
        "zh-CN": {
            "title": "文字稿解剖",
            "narrative": "整体叙事",
            "opening_hook": "开头钩子",
            "structure_type": "推进结构",
            "turning_point": "转折",
            "closing_type": "收尾",
            "segments": "分段结构",
            "core_claim": "核心论点",
            "supporting_points": "支撑点",
            "rhetorical_devices": "表达手法",
            "rhythm": "节奏",
            "reusable_pattern": "可复用模式",
            "risk_flags": "风险标记",
            "source_chunks": "引用片段",
            "template": "可复用骨架",
            "highlights": "亮点",
            "audience_fit": "受众适配",
            "fit": "适配度",
            "note": "说明",
            "strengths": "优势",
            "weaknesses": "不足",
            "fit_high": "高",
            "fit_medium": "中",
            "fit_low": "低",
            "separator": "：",
        },
        "zh-TW": {
            "title": "逐字稿解剖",
            "narrative": "整體敘事",
            "opening_hook": "開頭鉤子",
            "structure_type": "推進結構",
            "turning_point": "轉折",
            "closing_type": "收尾",
            "segments": "分段結構",
            "core_claim": "核心論點",
            "supporting_points": "支持點",
            "rhetorical_devices": "表達手法",
            "rhythm": "節奏",
            "reusable_pattern": "可重用模式",
            "risk_flags": "風險標記",
            "source_chunks": "引用片段",
            "template": "可重用骨架",
            "highlights": "亮點",
            "audience_fit": "受眾適配",
            "fit": "適配度",
            "note": "說明",
            "strengths": "優勢",
            "weaknesses": "不足",
            "fit_high": "高",
            "fit_medium": "中",
            "fit_low": "低",
            "separator": "：",
        },
        "en-US": {
            "title": "Transcript Dissection",
            "narrative": "Overall Narrative",
            "opening_hook": "Opening hook",
            "structure_type": "Structure",
            "turning_point": "Turning point",
            "closing_type": "Closing",
            "segments": "Segments",
            "core_claim": "Core claim",
            "supporting_points": "Supporting points",
            "rhetorical_devices": "Rhetorical devices",
            "rhythm": "Rhythm",
            "reusable_pattern": "Reusable pattern",
            "risk_flags": "Risk flags",
            "source_chunks": "Source chunks",
            "template": "Reusable template",
            "highlights": "Highlights",
            "audience_fit": "Audience fit",
            "fit": "Fit",
            "note": "Note",
            "strengths": "Strengths",
            "weaknesses": "Weaknesses",
            "fit_high": "High",
            "fit_medium": "Medium",
            "fit_low": "Low",
            "separator": ": ",
        },
    }[output_language]
    narrative = report.overall_narrative
    lines = [f"# {labels['title']}", "", f"## {labels['narrative']}", ""]
    _append_markdown_field(
        lines, labels["opening_hook"], narrative.opening_hook, labels["separator"]
    )
    _append_markdown_field(
        lines, labels["structure_type"], narrative.structure_type, labels["separator"]
    )
    _append_markdown_field(
        lines, labels["turning_point"], narrative.turning_point, labels["separator"]
    )
    _append_markdown_field(
        lines, labels["closing_type"], narrative.closing_type, labels["separator"]
    )
    lines.extend(["", f"## {labels['segments']}", ""])
    for segment in report.segments:
        lines.extend(
            [
                f"### {segment.id}. {segment.title}",
                "",
            ]
        )
        _append_markdown_field(
            lines, labels["core_claim"], segment.core_claim, labels["separator"]
        )
        _append_markdown_list(lines, labels["supporting_points"], segment.supporting_points, 4)
        _append_markdown_list(lines, labels["rhetorical_devices"], segment.rhetorical_devices, 4)
        _append_markdown_field(
            lines, labels["rhythm"], segment.rhythm_note, labels["separator"]
        )
        _append_markdown_field(
            lines,
            labels["reusable_pattern"],
            segment.reusable_pattern,
            labels["separator"],
        )
        _append_markdown_list(lines, labels["risk_flags"], segment.risk_flags, 4)
        _append_markdown_field(
            lines,
            labels["source_chunks"],
            ", ".join(map(str, segment.source_chunk_ids)),
            labels["separator"],
        )
        lines.append("")

    lines.extend(
        [
            f"## {labels['template']}",
            "",
            f"**{report.reusable_template.name}**",
            "",
            *[
                f"{index}. {step}"
                for index, step in enumerate(report.reusable_template.skeleton, start=1)
            ],
            "",
        ]
    )
    _append_markdown_list(lines, labels["highlights"], report.highlights, 2)
    if report.audience_fit:
        lines.extend([f"## {labels['audience_fit']}", ""])
        for item in report.audience_fit:
            lines.extend(
                [
                    f"### {item.audience}",
                    "",
                    f"- {labels['fit']}{labels['separator']}{labels[f'fit_{item.fit}']}",
                    f"- {labels['note']}{labels['separator']}{item.note}",
                    "",
                ]
            )
    _append_markdown_list(lines, labels["strengths"], report.strengths, 2)
    _append_markdown_list(lines, labels["weaknesses"], report.weaknesses, 2)
    return "\n".join(lines).rstrip() + "\n"


def _append_markdown_field(
    lines: list[str], label: str, value: str | None, separator: str
) -> None:
    if value is not None:
        lines.append(f"- {label}{separator}{value}")


def _append_markdown_list(
    lines: list[str],
    heading: str,
    values: tuple[str, ...],
    heading_level: int,
) -> None:
    if values:
        lines.extend(
            [f"{'#' * heading_level} {heading}", "", *[f"- {value}" for value in values], ""]
        )


def _generate_json(
    client: DissectionClient,
    prompt: str,
    cancel_check,
    *,
    progress_callback: ProgressCallback | None = None,
    attempt: int | None = None,
    total: int | None = None,
) -> object:
    if cancel_check():
        raise DissectionGenerationError("DISSECTION_CANCELLED", "Dissection was cancelled.")
    if progress_callback is not None and attempt is not None and total is not None:
        progress_callback(
            build_worker_progress_event(
                "ai.generation.running",
                stage="insights_generating",
                progress=70 + ((attempt - 1) * 20 // total),
                message_args={"attempt": attempt, "total": total},
            )
        )
    response = client.generate(prompt)
    if cancel_check():
        raise DissectionGenerationError("DISSECTION_CANCELLED", "Dissection was cancelled.")
    parsed = extract_json_from_llm_output(response)
    if parsed is None:
        raise DissectionGenerationError(
            "DISSECTION_INVALID_RESULT",
            "The dissection response did not match the required structure.",
        )
    return parsed


def _parse_semantic_report(
    payload: object,
    transcript: str,
    valid_chunk_ids: set[int],
) -> dict[str, object]:
    root = _closed_object(
        payload,
        {
            "overallNarrative",
            "segments",
            "highlights",
            "reusableTemplate",
            "audienceFit",
            "strengths",
            "weaknesses",
        },
    )
    narrative_raw = _closed_object(
        root["overallNarrative"],
        {"openingHook", "structureType", "turningPoint", "closingType"},
    )
    narrative = DissectionNarrative(
        opening_hook=_optional_text(narrative_raw["openingHook"]),
        structure_type=_text(narrative_raw["structureType"]),
        turning_point=_optional_text(narrative_raw["turningPoint"]),
        closing_type=_optional_text(narrative_raw["closingType"]),
    )

    segment_values = _list(root["segments"])
    if not segment_values:
        raise ValueError("segments")
    segments: list[DissectionSegment] = []
    for index, value in enumerate(segment_values, start=1):
        item = _closed_object(
            value,
            {
                "id", "title", "sourceChunkIds", "coreClaim", "supportingPoints",
                "rhetoricalDevices", "rhythmNote", "reusablePattern", "riskFlags",
            },
        )
        if type(item["id"]) is not int or item["id"] != index:
            raise ValueError("segment id")
        references = tuple(_integer_list(item["sourceChunkIds"]))
        if (
            not references
            or list(references) != sorted(set(references))
            or not set(references) <= valid_chunk_ids
        ):
            raise ValueError("source references")
        segments.append(
            DissectionSegment(
                id=index,
                title=_text(item["title"]),
                source_chunk_ids=references,
                core_claim=_text(item["coreClaim"]),
                supporting_points=tuple(_text_list(item["supportingPoints"])),
                rhetorical_devices=tuple(_text_list(item["rhetoricalDevices"])),
                rhythm_note=_text(item["rhythmNote"]),
                reusable_pattern=_text(item["reusablePattern"]),
                risk_flags=tuple(_text_list(item["riskFlags"])),
            )
        )

    highlights = tuple(_text_list(root["highlights"], maximum=8))
    if any(highlight not in transcript for highlight in highlights):
        raise ValueError("highlight provenance")
    template_raw = _closed_object(root["reusableTemplate"], {"name", "skeleton"})
    skeleton = tuple(_text_list(template_raw["skeleton"], minimum=3, maximum=7))
    audience_fit: list[DissectionAudienceFit] = []
    for value in _list(root["audienceFit"]):
        item = _closed_object(value, {"audience", "fit", "note"})
        fit = _text(item["fit"])
        if fit not in {"high", "medium", "low"}:
            raise ValueError("audience fit")
        audience_fit.append(
            DissectionAudienceFit(
                audience=_text(item["audience"]),
                fit=fit,
                note=_text(item["note"]),
            )
        )

    return {
        "overall_narrative": narrative,
        "segments": tuple(segments),
        "highlights": highlights,
        "reusable_template": DissectionTemplate(
            name=_text(template_raw["name"]), skeleton=skeleton
        ),
        "audience_fit": tuple(audience_fit),
        "strengths": tuple(_text_list(root["strengths"], maximum=6)),
        "weaknesses": tuple(_text_list(root["weaknesses"], maximum=6)),
    }


def _closed_object(value: object, keys: set[str]) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError("closed object")
    return value


def _list(value: object) -> list[object]:
    if not isinstance(value, list):
        raise ValueError("array")
    return value


def _text(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 4000:
        raise ValueError("text")
    normalized = value.strip()
    if "<script" in normalized.lower() or "javascript:" in normalized.lower():
        raise ValueError("unsafe text")
    return normalized


def _optional_text(value: object) -> str | None:
    return None if value is None else _text(value)


def _text_list(
    value: object,
    *,
    minimum: int = 0,
    maximum: int | None = None,
) -> list[str]:
    values = _list(value)
    if len(values) < minimum or (maximum is not None and len(values) > maximum):
        raise ValueError("array length")
    return [_text(item) for item in values]


def _integer_list(value: object) -> list[int]:
    values = _list(value)
    if any(type(item) is not int or item < 1 for item in values):
        raise ValueError("integer array")
    return values


def _repair_category(exc: KeyError | TypeError | ValueError) -> str:
    if isinstance(exc, (KeyError, TypeError)):
        return "schema_shape"
    return {
        "source references": "source_references",
        "highlight provenance": "quotation_provenance",
        "array length": "collection_limits",
        "audience fit": "enum_values",
    }.get(str(exc), "schema_shape")
