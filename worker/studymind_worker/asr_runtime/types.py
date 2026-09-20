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


class ASRInsufficientMemoryError(ASRRuntimeError):
    """The host machine could not lend the ASR runtime enough memory.

    Distinguished from ``ASRRuntimeError`` because the user action is different:
    a runtime bug is retried, an exhausted machine is not. Mapping both to the
    same code sent users into an endless retry loop, so this error exists to
    give the desktop something honest to say.
    """

    code = "ASR_INSUFFICIENT_MEMORY"


# Prose markers used by PyTorch, ONNX Runtime and libc when an allocation
# fails. Allocation failures surface as plain ``RuntimeError``, so the message
# is the only signal available to classify on.
MEMORY_EXHAUSTION_MARKERS = (
    "bad_alloc",
    "cannot allocate memory",
    "defaultcpuallocator",
    "failed to allocate",
    "not enough memory",
    "out of memory",
    "unable to allocate",
)


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


def is_memory_exhaustion_error(exc: BaseException) -> bool:
    """Return True when ``exc`` means "out of memory", not "broken code".

    PyTorch raises ``RuntimeError: [enforce fail at alloc_cpu.cpp:117] data.
    DefaultCPUAllocator: not enough memory: you tried to allocate 4194304
    bytes.`` with no dedicated type, so the text is matched instead.
    """

    if isinstance(exc, MemoryError):
        return True
    message = str(exc).casefold()
    return any(marker in message for marker in MEMORY_EXHAUSTION_MARKERS)


def memory_exhaustion_message(context: str, exc: BaseException) -> str:
    """Diagnostic text for an out-of-memory ASR failure.

    Written to the worker logs and the failed task manifest, never rendered to
    the user. It carries the machine-level figure the provider error omits, so
    the next reader can tell how close the machine was to its commit limit.
    """

    from studymind_worker.resource_throttle import describe_available_memory

    parts = [f"Not enough memory to {context}: {exc}."]
    headroom = describe_available_memory()
    if headroom:
        parts.append(f"{headroom}.")
    parts.append(
        "Close other applications, or raise the system page file size, then retry."
    )
    return " ".join(parts)
