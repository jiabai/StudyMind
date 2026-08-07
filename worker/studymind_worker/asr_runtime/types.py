from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol


class ASRError(RuntimeError):
    code = "ASR_ERROR"


class ASRDependencyError(ASRError):
    code = "ASR_DEPENDENCY_MISSING"


class ASRRuntimeError(ASRError):
    code = "ASR_RUNTIME_ERROR"


class ASREmptyTranscriptError(ASRRuntimeError):
    code = "ASR_EMPTY_TRANSCRIPT"


class ASRUnsupportedModelError(ASRRuntimeError):
    code = "ASR_MODEL_UNSUPPORTED"


@dataclass(frozen=True)
class TranscriptSegment:
    id: str
    start_ms: int
    end_ms: int
    text: str
    speaker: str | None = None

    def to_json(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "id": self.id,
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "text": self.text,
        }
        if self.speaker:
            payload["speaker"] = self.speaker
        return payload


@dataclass(frozen=True)
class Transcript:
    text: str
    language: str = "Chinese"
    segments: tuple[TranscriptSegment, ...] = ()


@dataclass(frozen=True)
class TranscriptArtifacts:
    text: str
    txt_path: Path
    md_path: Path
    segments_path: Path | None = None


class Transcriber(Protocol):
    def transcribe(self, audio_path: Path, language: str = "Chinese") -> Transcript:
        pass


ModelFactory = Callable[..., Any]


@dataclass(frozen=True)
class AsrModelSpec:
    name: str
    family: str
    display_name: str


def extract_provider_text(results: object) -> str:
    if isinstance(results, list) and results:
        first = results[0]
        if isinstance(first, dict):
            return str(first.get("text", ""))
        return str(getattr(first, "text", ""))
    if isinstance(results, dict):
        return str(results.get("text", ""))
    return str(getattr(results, "text", ""))


def missing_dependency_message(exc: ModuleNotFoundError, runtime_name: str) -> str:
    missing_name = exc.name or str(exc).removeprefix("No module named ").strip("'\"")
    return (
        f"Missing ASR runtime dependency: {missing_name}. "
        f"Install project dependencies with `uv sync` before running {runtime_name}."
    )
