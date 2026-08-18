from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Literal

from studymind_worker.output_language import OutputLanguage

RetryInsightTarget = Literal["summary", "insights", "dissection"]
InsightGenerationTarget = Literal["all", "summary", "insights", "dissection"]
LocalMediaKind = Literal["video", "audio"]


class JobStage(StrEnum):
    WAITING_INPUT = "waiting_input"
    VIDEO_EXTRACTING = "video_extracting"
    VIDEO_TRANSCRIBING = "video_transcribing"
    INSIGHTS_GENERATING = "insights_generating"
    COMPLETED = "completed"
    PARTIAL_COMPLETED = "partial_completed"
    FAILED = "failed"
    # Tombstone-only status written by persist_initial_manifest before the
    # pipeline runs. Never emitted over the worker progress protocol and
    # never produced by finalize(); it only marks an in-flight task whose
    # worker may still be running or may have crashed before settling. The
    # desktop history layer treats it as "processing / interrupted" so the
    # task stays visible and deletable instead of becoming an orphan dir.
    PROCESSING = "processing"


@dataclass(frozen=True)
class ProcessLocalMediaRequest:
    source_path: Path = field(repr=False)
    media_kind: LocalMediaKind
    safe_display_name: str = field(repr=False)
    source_extension: str
    asr_model: str


@dataclass(frozen=True)
class InspirationProfile:
    role: str
    domain: str
    stage: str
    learning_context: str
    knowledge_level: str
    study_methods: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, object]:
        return {
            "role": self.role,
            "domain": self.domain,
            "stage": self.stage,
            "learningContext": self.learning_context,
            "knowledgeLevel": self.knowledge_level,
            "studyMethods": list(self.study_methods),
        }


@dataclass(frozen=True)
class GenerationPreferences:
    goal: str
    scenario: str
    angles: tuple[str, ...]
    audience: str
    styles: tuple[str, ...]
    avoid: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, object]:
        return {
            "goal": self.goal,
            "scenario": self.scenario,
            "angles": list(self.angles),
            "audience": self.audience,
            "styles": list(self.styles),
            "avoid": list(self.avoid),
        }


@dataclass(frozen=True)
class PreferenceLabelValue:
    id: str
    label: str

    def to_dict(self) -> dict[str, str]:
        return {
            "id": self.id,
            "label": self.label,
        }


@dataclass(frozen=True)
class PreferenceLabelSnapshotItem:
    field: str
    label: str
    values: tuple[PreferenceLabelValue, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "field": self.field,
            "label": self.label,
            "values": [value.to_dict() for value in self.values],
        }


@dataclass(frozen=True)
class PreferenceLabelSnapshot:
    profile: tuple[PreferenceLabelSnapshotItem, ...]
    generation_preferences: tuple[PreferenceLabelSnapshotItem, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "profile": [item.to_dict() for item in self.profile],
            "generationPreferences": [
                item.to_dict() for item in self.generation_preferences
            ],
        }


@dataclass(frozen=True)
class PreferenceSnapshot:
    profile: InspirationProfile | None
    profile_skipped: bool
    generation_preferences: GenerationPreferences
    label_snapshot: PreferenceLabelSnapshot

    def to_dict(self) -> dict[str, object]:
        return {
            "profile": self.profile.to_dict() if self.profile else None,
            "profileSkipped": self.profile_skipped,
            "generationPreferences": self.generation_preferences.to_dict(),
            "labelSnapshot": self.label_snapshot.to_dict(),
        }


@dataclass(frozen=True)
class RetryInsightsRequest:
    task_id: str
    target: RetryInsightTarget
    output_language: OutputLanguage
    preference_snapshot: PreferenceSnapshot | None = None


@dataclass(frozen=True)
class Insight:
    id: int
    topic: str
    match_reason: str
    follow_up_questions: tuple[str, ...]
    suitable_use: str
    source_chunk_id: int | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "topic": self.topic,
            "matchReason": self.match_reason,
            "followUpQuestions": list(self.follow_up_questions),
            "suitableUse": self.suitable_use,
            "sourceChunkId": self.source_chunk_id,
        }


@dataclass(frozen=True)
class WorkerError:
    code: str
    message: str
    stage: JobStage

    def to_dict(self) -> dict[str, str]:
        return {
            "code": self.code,
            "message": self.message,
            "stage": self.stage.value,
        }


@dataclass(frozen=True)
class TranscriptMetadata:
    source: Literal["asr", "subtitle"]
    language: str | None = None
    engine: str | None = None

    def to_dict(self) -> dict[str, str | None]:
        return {
            "source": self.source,
            "language": self.language,
            "engine": self.engine,
        }


@dataclass(frozen=True)
class ProcessResult:
    status: JobStage
    task_id: str | None = None
    task_dir: str | None = None
    artifacts: dict[str, str] = field(default_factory=dict)
    text: str = ""
    summary: str = ""
    insights: list[Insight] = field(default_factory=list)
    transcript: TranscriptMetadata | None = None
    dissection: dict[str, object] | None = None
    error: WorkerError | None = None
    artifact_payloads: dict[str, bytes | None] = field(default_factory=dict, repr=False)

    def to_dict(self) -> dict[str, object]:
        return {
            "status": self.status.value,
            "task_id": self.task_id,
            "task_dir": self.task_dir,
            "artifacts": self.artifacts,
            "text": self.text,
            "summary": self.summary,
            "insights": [insight.to_dict() for insight in self.insights],
            "transcript": self.transcript.to_dict() if self.transcript else None,
            "dissection": self.dissection,
            "error": self.error.to_dict() if self.error else None,
        }
