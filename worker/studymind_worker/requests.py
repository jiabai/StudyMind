"""Request payload parsers for the desktop worker stdin contract (v8).

These parsers define the current local-media worker request boundary.
Validation rules mirror
``contracts/desktop-worker-contract.json``:
- ``localMedia.workerRequest`` for ``--process-local-media-stdin``
- ``aiGeneration.request`` for ``--retry-insights-stdin``
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from pathlib import Path

from studymind_worker.desktop_contract import (
    AUDIO_EXTENSIONS,
    LOCAL_MEDIA_CONTRACT_VERSION,
    VIDEO_EXTENSIONS,
)
from studymind_worker.models import (
    GenerationPreferences,
    InspirationProfile,
    PreferenceLabelSnapshot,
    PreferenceLabelSnapshotItem,
    PreferenceLabelValue,
    PreferenceSnapshot,
    ProcessLocalMediaRequest,
    RetryInsightsRequest,
)
from studymind_worker.output_language import is_output_language

INVALID_RETRY_PAYLOAD_MESSAGE = "Retry request payload was invalid."

_WORKER_ASR_MODELS = frozenset({"iic/SenseVoiceSmall", "iic/SenseVoiceSmall-onnx"})
_SAFE_BASENAME_PATTERN = re.compile(r"^[A-Za-z0-9._+() -]+$")
_MAX_DISPLAY_NAME_CHARS = 160


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
        preference_snapshot=(parse_preference_snapshot(snapshot) if has_snapshot else None),
    )


def parse_preference_snapshot(payload: Mapping[str, object]) -> PreferenceSnapshot:
    if set(payload) != {
        "profile",
        "profileSkipped",
        "generationPreferences",
        "labelSnapshot",
    }:
        raise ValueError(INVALID_RETRY_PAYLOAD_MESSAGE)

    profile_value = payload["profile"]
    profile = None if profile_value is None else parse_inspiration_profile(profile_value)
    profile_skipped = payload["profileSkipped"]
    if not isinstance(profile_skipped, bool):
        raise TypeError(INVALID_RETRY_PAYLOAD_MESSAGE)

    generation = parse_generation_preferences(payload["generationPreferences"])
    labels = parse_label_snapshot(payload["labelSnapshot"])
    return PreferenceSnapshot(
        profile=profile,
        profile_skipped=profile_skipped,
        generation_preferences=generation,
        label_snapshot=labels,
    )


def parse_inspiration_profile(payload: object) -> InspirationProfile:
    if not isinstance(payload, Mapping) or set(payload) != {
        "role",
        "domain",
        "stage",
        "learningContext",
        "knowledgeLevel",
        "studyMethods",
    }:
        raise ValueError(INVALID_RETRY_PAYLOAD_MESSAGE)
    role = _required_string(payload["role"])
    domain = _required_string(payload["domain"])
    stage = _required_string(payload["stage"])
    learning_context = _required_string(payload["learningContext"])
    knowledge_level = _required_string(payload["knowledgeLevel"])
    study_methods = _string_array(payload["studyMethods"])
    if len(study_methods) > 3 or len(set(study_methods)) != len(study_methods):
        raise ValueError(INVALID_RETRY_PAYLOAD_MESSAGE)
    return InspirationProfile(
        role=role,
        domain=domain,
        stage=stage,
        learning_context=learning_context,
        knowledge_level=knowledge_level,
        study_methods=tuple(study_methods),
    )


def parse_generation_preferences(payload: object) -> GenerationPreferences:
    if not isinstance(payload, Mapping) or set(payload) != {
        "goal",
        "scenario",
        "angles",
        "audience",
        "styles",
        "avoid",
    }:
        raise ValueError(INVALID_RETRY_PAYLOAD_MESSAGE)
    angles = _string_array(payload["angles"])
    styles = _string_array(payload["styles"])
    avoid = _string_array(payload["avoid"])
    if not 1 <= len(angles) <= 3 or len(set(angles)) != len(angles):
        raise ValueError(INVALID_RETRY_PAYLOAD_MESSAGE)
    if not 1 <= len(styles) <= 2 or len(set(styles)) != len(styles):
        raise ValueError(INVALID_RETRY_PAYLOAD_MESSAGE)
    if len(avoid) > 3 or len(set(avoid)) != len(avoid):
        raise ValueError(INVALID_RETRY_PAYLOAD_MESSAGE)
    return GenerationPreferences(
        goal=_required_string(payload["goal"]),
        scenario=_required_string(payload["scenario"]),
        angles=tuple(angles),
        audience=_required_string(payload["audience"]),
        styles=tuple(styles),
        avoid=tuple(avoid),
    )


def parse_label_snapshot(payload: object) -> PreferenceLabelSnapshot:
    if not isinstance(payload, Mapping) or set(payload) != {"profile", "generationPreferences"}:
        raise ValueError(INVALID_RETRY_PAYLOAD_MESSAGE)
    return PreferenceLabelSnapshot(
        profile=tuple(parse_label_item(item) for item in _mapping_array(payload["profile"])),
        generation_preferences=tuple(
            parse_label_item(item) for item in _mapping_array(payload["generationPreferences"])
        ),
    )


def parse_label_item(payload: Mapping[str, object]) -> PreferenceLabelSnapshotItem:
    if set(payload) != {"field", "label", "values"}:
        raise ValueError(INVALID_RETRY_PAYLOAD_MESSAGE)
    values = tuple(
        PreferenceLabelValue(
            id=_required_string(item["id"]),
            label=_required_string(item["label"]),
        )
        for item in _mapping_array(payload["values"])
    )
    return PreferenceLabelSnapshotItem(
        field=_required_string(payload["field"]),
        label=_required_string(payload["label"]),
        values=values,
    )


def _required_string(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(INVALID_RETRY_PAYLOAD_MESSAGE)
    return value


def _string_array(value: object) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        raise ValueError(INVALID_RETRY_PAYLOAD_MESSAGE)
    return value


def _mapping_array(value: object) -> list[Mapping[str, object]]:
    if not isinstance(value, list) or any(not isinstance(item, Mapping) for item in value):
        raise ValueError(INVALID_RETRY_PAYLOAD_MESSAGE)
    return value


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
