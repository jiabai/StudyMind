"""Request payload parsers for the desktop worker stdin contract (v8).

These parsers replace the never-landed legacy ``requests`` module from the
FrameQ-era worker. Validation rules mirror
``contracts/desktop-worker-contract.json``:
- ``localMedia.workerRequest`` for ``--process-local-media-stdin``
- ``aiGeneration.request`` for ``--retry-insights-stdin``
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from studymind_worker.desktop_contract import (
    AUDIO_EXTENSIONS,
    LOCAL_MEDIA_CONTRACT_VERSION,
    VIDEO_EXTENSIONS,
)
from studymind_worker.models import ProcessLocalMediaRequest, RetryInsightTarget
from studymind_worker.output_language import OutputLanguage, is_output_language

INVALID_RETRY_PAYLOAD_MESSAGE = "Retry request payload was invalid."

_WORKER_ASR_MODELS = frozenset({"iic/SenseVoiceSmall", "iic/SenseVoiceSmall-onnx"})
_SAFE_BASENAME_PATTERN = re.compile(r"^[A-Za-z0-9._+() -]+$")
_MAX_DISPLAY_NAME_CHARS = 160


@dataclass(frozen=True)
class RetryInsightsRequest:
    task_id: str
    target: RetryInsightTarget
    output_language: OutputLanguage
    preference_snapshot: dict[str, Any] | None = None


def optional_env(environ: Mapping[str, str], key: str) -> str | None:
    """Return a trimmed env value, or ``None`` when blank/absent."""
    value = environ.get(key)
    if value is None:
        return None
    trimmed = value.strip()
    return trimmed or None


def parse_process_local_media_request(payload: object) -> ProcessLocalMediaRequest:
    if not isinstance(payload, Mapping):
        raise TypeError("Local media request payload was invalid.")
    allowed_keys = {
        "contract_version",
        "source_path",
        "media_kind",
        "safe_display_name",
        "source_extension",
        "asr_model",
    }
    if set(payload) != allowed_keys:
        raise ValueError("Local media request payload was invalid.")

    contract_version = payload.get("contract_version")
    if contract_version != LOCAL_MEDIA_CONTRACT_VERSION:
        raise ValueError("Local media request payload was invalid.")

    source_path = payload.get("source_path")
    media_kind = payload.get("media_kind")
    safe_display_name = payload.get("safe_display_name")
    source_extension = payload.get("source_extension")
    asr_model = payload.get("asr_model")

    if not isinstance(source_path, str) or not source_path.strip():
        raise ValueError("Local media request payload was invalid.")
    if media_kind not in ("video", "audio"):
        raise ValueError("Local media request payload was invalid.")
    if not isinstance(safe_display_name, str) or not safe_display_name.strip():
        raise ValueError("Local media request payload was invalid.")
    if not isinstance(source_extension, str) or not source_extension.strip():
        raise ValueError("Local media request payload was invalid.")
    if asr_model not in _WORKER_ASR_MODELS:
        raise ValueError("Local media request payload was invalid.")

    normalized_extension = source_extension.lower()
    if media_kind == "video" and normalized_extension not in VIDEO_EXTENSIONS:
        raise ValueError("Local media request payload was invalid.")
    if media_kind == "audio" and normalized_extension not in AUDIO_EXTENSIONS:
        raise ValueError("Local media request payload was invalid.")

    path = Path(source_path)
    if not path.is_absolute():
        raise ValueError("Local media request payload was invalid.")
    path_suffix = path.suffix.lower().lstrip(".")
    if path_suffix != normalized_extension:
        raise ValueError("Local media request payload was invalid.")

    display_name = safe_display_name.strip()
    if not _is_safe_display_name(display_name, normalized_extension):
        raise ValueError("Local media request payload was invalid.")

    return ProcessLocalMediaRequest(
        source_path=path,
        media_kind=media_kind,
        safe_display_name=display_name,
        source_extension=normalized_extension,
        asr_model=asr_model,
    )


def parse_retry_insights_request(payload: object) -> RetryInsightsRequest:
    if not isinstance(payload, Mapping):
        raise TypeError(INVALID_RETRY_PAYLOAD_MESSAGE)
    allowed_keys = {"task_id", "target", "output_language", "preference_snapshot"}
    if set(payload) - allowed_keys:
        raise ValueError(INVALID_RETRY_PAYLOAD_MESSAGE)

    task_id = payload.get("task_id")
    target = payload.get("target")
    output_language = payload.get("output_language")
    if not isinstance(task_id, str) or not task_id.strip():
        raise ValueError(INVALID_RETRY_PAYLOAD_MESSAGE)
    if target not in ("summary", "insights", "dissection"):
        raise ValueError(INVALID_RETRY_PAYLOAD_MESSAGE)
    if not is_output_language(output_language):
        raise ValueError(INVALID_RETRY_PAYLOAD_MESSAGE)

    has_snapshot = "preference_snapshot" in payload
    snapshot = payload.get("preference_snapshot")
    if has_snapshot:
        if target != "insights" or not isinstance(snapshot, Mapping):
            raise ValueError(INVALID_RETRY_PAYLOAD_MESSAGE)
    elif snapshot is not None:
        raise ValueError(INVALID_RETRY_PAYLOAD_MESSAGE)

    return RetryInsightsRequest(
        task_id=task_id.strip(),
        target=target,
        output_language=output_language,
        preference_snapshot=dict(snapshot) if has_snapshot else None,
    )


def _is_safe_display_name(display_name: str, extension: str) -> bool:
    if not 1 <= len(display_name) <= _MAX_DISPLAY_NAME_CHARS:
        return False
    if display_name in (".", ".."):
        return False
    if display_name.startswith(" ") or display_name.endswith((".", " ")):
        return False
    if _SAFE_BASENAME_PATTERN.fullmatch(display_name) is None:
        return False
    if not any(character.isascii() and character.isalnum() for character in display_name):
        return False
    return display_name.lower().endswith("." + extension)
