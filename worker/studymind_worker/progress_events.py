from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

_INVALID_EVENT_MESSAGE = "Progress event was invalid."
_LANGUAGE_TAG_PATTERN = re.compile(
    r"^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$"
)
_CURRENT_FILE_PATTERN = re.compile(
    r"^(?!\.{1,2}$)(?=[A-Za-z0-9._+() -]{1,255}$)(?=.*[A-Za-z0-9])"
    r"[A-Za-z0-9._+()-](?:[A-Za-z0-9._+() -]{0,253}[A-Za-z0-9_+()-])?$"
)
_CONTROL_CHARACTER_PATTERN = re.compile(r"[\x00-\x1F\x7F]")
_SENSITIVE_FILENAME_PATTERN = re.compile(
    r"(?:^|[^a-z0-9])(?:auth|cookie|credential|password|secret|token)(?:[^a-z0-9]|$)",
    re.IGNORECASE,
)
_ALLOWED_MODELS = frozenset(
    {
        "iic/SenseVoiceSmall",
        "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
        "iic/SenseVoiceSmall-onnx",
        "iic/speech_fsmn_vad_zh-cn-16k-common-onnx",
    }
)
WORKER_PROGRESS_STAGES = frozenset(
    {
        "waiting_input",
        "video_extracting",
        "video_transcribing",
        "insights_generating",
        "completed",
        "partial_completed",
        "failed",
    }
)


class ProgressEventValidationError(ValueError):
    """A deliberately non-echoing progress event validation failure."""

    def __init__(self) -> None:
        super().__init__(_INVALID_EVENT_MESSAGE)


@dataclass(frozen=True)
class WorkerProgressSpec:
    allowed_args: tuple[str, ...] = ()


@dataclass(frozen=True)
class ModelProgressSpec:
    status: str
    current_file: str
    allowed_args: tuple[str, ...] = ()


WORKER_PROGRESS_REGISTRY: dict[str, WorkerProgressSpec] = {
    "video.download.preparing": WorkerProgressSpec(),
    "video.stream.validating": WorkerProgressSpec(),
    "local.media.validating": WorkerProgressSpec(),
    "local.video.copying": WorkerProgressSpec(),
    "local.audio.normalizing": WorkerProgressSpec(),
    "audio.extract.running": WorkerProgressSpec(),
    "audio.extract.reused": WorkerProgressSpec(),
    "subtitle.detect.running": WorkerProgressSpec(),
    "subtitle.detect.found": WorkerProgressSpec(("language",)),
    "asr.cache.preparing": WorkerProgressSpec(("model",)),
    "asr.transcribe.starting": WorkerProgressSpec(),
    "asr.transcribe.running": WorkerProgressSpec(),
    "ai.generation.running": WorkerProgressSpec(("attempt", "total")),
    "douyin.page.resolving": WorkerProgressSpec(),
    "douyin.stream.probing": WorkerProgressSpec(),
    "douyin.video.saving": WorkerProgressSpec(),
    "douyin.stream.retrying": WorkerProgressSpec(("attempt", "total")),
    "xiaohongshu.page.resolving": WorkerProgressSpec(),
    "xiaohongshu.video.saving": WorkerProgressSpec(),
    "xiaohongshu.stream.retrying": WorkerProgressSpec(("attempt", "total")),
    "bilibili.metadata.resolving": WorkerProgressSpec(),
    "bilibili.stream.probing": WorkerProgressSpec(),
    "bilibili.video.downloading": WorkerProgressSpec(),
    "bilibili.audio.downloading": WorkerProgressSpec(),
    "bilibili.media.merging": WorkerProgressSpec(),
}


MODEL_PROGRESS_REGISTRY: dict[str, ModelProgressSpec] = {
    "model.download.preparing": ModelProgressSpec(
        "started", "forbidden", ("model",)
    ),
    "model.download.completed": ModelProgressSpec(
        "completed", "forbidden", ("model",)
    ),
    "model.download.cancelled": ModelProgressSpec("cancelled", "forbidden"),
    "model.primary.downloading": ModelProgressSpec(
        "downloading", "forbidden", ("model",)
    ),
    "model.vad.downloading": ModelProgressSpec(
        "downloading", "forbidden", ("model",)
    ),
    "model.bpe.downloading": ModelProgressSpec(
        "downloading", "forbidden", ("model",)
    ),
    "model.archive.extracting": ModelProgressSpec("extracting", "forbidden"),
    "model.archive.reading": ModelProgressSpec("downloading", "forbidden"),
    "model.archive.downloading": ModelProgressSpec("downloading", "forbidden"),
    "model.file.downloading": ModelProgressSpec("downloading", "required"),
    "model.file.completed": ModelProgressSpec("downloading", "required"),
}


def _invalid() -> ProgressEventValidationError:
    return ProgressEventValidationError()


def _is_integer_in_range(value: object, minimum: int, maximum: int) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and minimum <= value <= maximum
    )


def _validate_message_args(
    message_args: Mapping[str, object] | None,
    *,
    allowed_args: tuple[str, ...],
) -> dict[str, str | int] | None:
    if message_args is None:
        args: dict[str, object] = {}
    elif isinstance(message_args, Mapping):
        args = dict(message_args)
    else:
        raise _invalid()

    if set(args) - set(allowed_args):
        raise _invalid()

    validated: dict[str, str | int] = {}
    for key in allowed_args:
        if key not in args:
            continue
        value = args[key]
        if key == "model":
            if not isinstance(value, str) or value not in _ALLOWED_MODELS:
                raise _invalid()
            validated[key] = value
        elif key == "language":
            if (
                not isinstance(value, str)
                or not 2 <= len(value) <= 35
                or _LANGUAGE_TAG_PATTERN.fullmatch(value) is None
            ):
                raise _invalid()
            validated[key] = value
        elif key in {"attempt", "total"}:
            if not _is_integer_in_range(value, 1, 100):
                raise _invalid()
            validated[key] = value
        else:  # The embedded registry is intentionally closed.
            raise _invalid()

    if "attempt" in validated and "total" in validated:
        if validated["attempt"] > validated["total"]:
            raise _invalid()

    return validated or None


def build_worker_progress_event(
    message_code: str,
    *,
    stage: str,
    progress: object,
    message_args: Mapping[str, object] | None = None,
) -> dict[str, Any]:
    if not isinstance(message_code, str):
        raise _invalid()
    spec = WORKER_PROGRESS_REGISTRY.get(message_code)
    if (
        spec is None
        or stage not in WORKER_PROGRESS_STAGES
        or not _is_integer_in_range(progress, 0, 100)
    ):
        raise _invalid()

    validated_args = _validate_message_args(
        message_args,
        allowed_args=spec.allowed_args,
    )
    event: dict[str, Any] = {
        "stage": stage,
        "progress": progress,
        "message_code": message_code,
    }
    if validated_args is not None:
        event["message_args"] = validated_args
    return event


def build_model_progress_event(
    message_code: str,
    *,
    status: str,
    progress: object,
    current_file: str | None = None,
    message_args: Mapping[str, object] | None = None,
) -> dict[str, Any]:
    if not isinstance(message_code, str):
        raise _invalid()
    spec = MODEL_PROGRESS_REGISTRY.get(message_code)
    if (
        spec is None
        or status != spec.status
        or not _is_integer_in_range(progress, 0, 100)
    ):
        raise _invalid()

    if spec.current_file == "required":
        if (
            not isinstance(current_file, str)
            or not _is_safe_current_file(current_file)
            or safe_current_file_basename(current_file) != current_file
        ):
            raise _invalid()
    elif current_file is not None:
        raise _invalid()

    validated_args = _validate_message_args(
        message_args,
        allowed_args=spec.allowed_args,
    )
    event: dict[str, Any] = {
        "status": status,
        "progress": progress,
        "message_code": message_code,
    }
    if current_file is not None:
        event["current_file"] = current_file
    if validated_args is not None:
        event["message_args"] = validated_args
    return event


def validate_worker_progress_event(event: Mapping[str, object]) -> dict[str, Any]:
    if not isinstance(event, Mapping):
        raise _invalid()
    fields = set(event)
    if fields not in (
        {"stage", "progress", "message_code"},
        {"stage", "progress", "message_code", "message_args"},
    ):
        raise _invalid()
    if "message_args" in event and not isinstance(event["message_args"], Mapping):
        raise _invalid()
    message_code = event.get("message_code")
    stage = event.get("stage")
    if not isinstance(message_code, str) or not isinstance(stage, str):
        raise _invalid()
    return build_worker_progress_event(
        message_code,
        stage=stage,
        progress=event.get("progress"),
        message_args=event.get("message_args"),
    )


def validate_model_progress_event(event: Mapping[str, object]) -> dict[str, Any]:
    if not isinstance(event, Mapping):
        raise _invalid()
    required_fields = {"status", "progress", "message_code"}
    optional_fields = {"current_file", "message_args"}
    fields = set(event)
    if not required_fields <= fields or fields - required_fields - optional_fields:
        raise _invalid()
    if "current_file" in event and not isinstance(event["current_file"], str):
        raise _invalid()
    if "message_args" in event and not isinstance(event["message_args"], Mapping):
        raise _invalid()
    message_code = event.get("message_code")
    status = event.get("status")
    current_file = event.get("current_file")
    if (
        not isinstance(message_code, str)
        or not isinstance(status, str)
        or (current_file is not None and not isinstance(current_file, str))
    ):
        raise _invalid()
    return build_model_progress_event(
        message_code,
        status=status,
        progress=event.get("progress"),
        current_file=current_file,
        message_args=event.get("message_args"),
    )


def normalize_language_tag(raw: object) -> str | None:
    if not isinstance(raw, str):
        return None
    candidate = raw.strip().replace("_", "-")
    if (
        not 2 <= len(candidate) <= 35
        or _LANGUAGE_TAG_PATTERN.fullmatch(candidate) is None
    ):
        return None

    parts = candidate.split("-")
    primary = parts.pop(0)
    if not 2 <= len(primary) <= 3 or not primary.isalpha():
        return None

    normalized = [primary.lower()]
    if parts and len(parts[0]) == 4 and parts[0].isalpha():
        normalized.append(parts.pop(0).title())
    if parts:
        region = parts.pop(0)
        if len(region) == 2 and region.isalpha():
            normalized.append(region.upper())
        elif len(region) == 3 and region.isdigit():
            normalized.append(region)
        else:
            return None
    if parts:
        return None
    return "-".join(normalized)


def normalize_model_arg(raw: object) -> str | None:
    return raw if isinstance(raw, str) and raw in _ALLOWED_MODELS else None


def safe_current_file_basename(raw: object) -> str:
    fallback = "model-file"
    if not isinstance(raw, str):
        return fallback

    cleaned = _CONTROL_CHARACTER_PATTERN.sub("", raw).strip()
    if not cleaned or "?" in cleaned or "#" in cleaned:
        return fallback

    if "://" in cleaned:
        try:
            parsed = urlsplit(cleaned)
            hostname = parsed.hostname
        except (UnicodeError, ValueError):
            return fallback
        if (
            parsed.scheme not in {"http", "https"}
            or hostname is None
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            return fallback
        cleaned = parsed.path

    basename = cleaned.replace("\\", "/").rsplit("/", 1)[-1].strip()
    if (
        not _is_safe_current_file(basename)
        or "=" in basename
        or _SENSITIVE_FILENAME_PATTERN.search(basename) is not None
    ):
        return fallback
    return basename


def _is_safe_current_file(value: str) -> bool:
    return _CURRENT_FILE_PATTERN.fullmatch(value) is not None
