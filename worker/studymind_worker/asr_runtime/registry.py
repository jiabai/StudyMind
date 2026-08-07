from __future__ import annotations

import os
from os import PathLike
from pathlib import Path
from typing import Any

from studymind_worker.asr_runtime.qwen import QWEN_ASR_MODEL, QwenAsrTranscriber
from studymind_worker.asr_runtime.sensevoice import (
    SENSEVOICE_SMALL_MODEL,
    SENSEVOICE_VAD_MAX_SEGMENT_TIME_MS,
    SENSEVOICE_VAD_MODEL,
    SenseVoiceTranscriber,
)
from studymind_worker.asr_runtime.sensevoice_onnx import (
    SENSEVOICE_SMALL_ONNX_MODEL,
    SenseVoiceOnnxTranscriber,
)
from studymind_worker.asr_runtime.types import (
    AsrModelSpec,
    ASRUnsupportedModelError,
    Transcriber,
)

DEFAULT_ASR_MODEL = SENSEVOICE_SMALL_MODEL
DEFAULT_MODEL_CACHE_ENV = "STUDYMIND_MODEL_DIR"
MODELSCOPE_CACHE_ENV = "MODELSCOPE_CACHE"

SUPPORTED_ASR_MODELS: tuple[AsrModelSpec, ...] = (
    AsrModelSpec(SENSEVOICE_SMALL_MODEL, "sensevoice", "SenseVoice Small"),
    AsrModelSpec(SENSEVOICE_SMALL_ONNX_MODEL, "sensevoice_onnx", "SenseVoiceSmall-ONNX"),
    AsrModelSpec(QWEN_ASR_MODEL, "qwen", "Qwen3-ASR-0.6B"),
)


def supported_asr_model_names() -> list[str]:
    return [model.name for model in SUPPORTED_ASR_MODELS]


def resolve_asr_model_name(model_name: str | None) -> str:
    candidate = (model_name or "").strip() or DEFAULT_ASR_MODEL
    if candidate in supported_asr_model_names():
        return candidate
    raise ASRUnsupportedModelError(f"Unsupported ASR model: {candidate}")


def asr_model_display_name(model_name: str) -> str:
    resolved = resolve_asr_model_name(model_name)
    for model in SUPPORTED_ASR_MODELS:
        if model.name == resolved:
            return model.display_name
    return resolved


def asr_model_family(model_name: str) -> str:
    resolved = resolve_asr_model_name(model_name)
    for model in SUPPORTED_ASR_MODELS:
        if model.name == resolved:
            return model.family
    raise ASRUnsupportedModelError(f"Unsupported ASR model: {model_name}")


def resolve_model_cache_dir(
    project_root: Path,
    environ: dict[str, str] | None = None,
) -> Path:
    env = environ if environ is not None else {}
    configured_path = env.get(DEFAULT_MODEL_CACHE_ENV)
    if configured_path:
        return Path(configured_path)
    return project_root / "models"


def build_qwen_asr_transcriber(
    model_name: str = QWEN_ASR_MODEL,
    cache_dir: str | PathLike[str] | Path | None = None,
) -> QwenAsrTranscriber:
    model_kwargs: dict[str, Any] = {}
    if cache_dir is not None:
        resolved_cache_dir = Path(cache_dir)
        resolved_cache_dir.mkdir(parents=True, exist_ok=True)
        model_kwargs["cache_dir"] = resolved_cache_dir.as_posix()

    return QwenAsrTranscriber(model_name=model_name, model_kwargs=model_kwargs)


def build_sensevoice_transcriber(
    model_name: str,
    cache_dir: str | PathLike[str] | Path | None = None,
) -> SenseVoiceTranscriber:
    model_kwargs: dict[str, Any] = {
        "vad_model": SENSEVOICE_VAD_MODEL,
        "vad_kwargs": {"max_single_segment_time": SENSEVOICE_VAD_MAX_SEGMENT_TIME_MS},
    }
    if cache_dir is not None:
        configure_modelscope_cache_dir(cache_dir)

    return SenseVoiceTranscriber(model_name=model_name, model_kwargs=model_kwargs)


def build_sensevoice_onnx_transcriber(
    cache_dir: str | PathLike[str] | Path,
) -> SenseVoiceOnnxTranscriber:
    model_root = Path(cache_dir) / "onnx" / "models" / "iic"
    return SenseVoiceOnnxTranscriber(
        asr_model_dir=model_root / "SenseVoiceSmall-onnx",
        vad_model_dir=model_root / "speech_fsmn_vad_zh-cn-16k-common-onnx",
    )


def build_asr_transcriber(
    model_name: str = DEFAULT_ASR_MODEL,
    cache_dir: str | PathLike[str] | Path | None = None,
) -> Transcriber:
    resolved_model = resolve_asr_model_name(model_name)
    family = asr_model_family(resolved_model)
    if family == "qwen":
        return build_qwen_asr_transcriber(model_name=resolved_model, cache_dir=cache_dir)
    if family == "sensevoice":
        return build_sensevoice_transcriber(model_name=resolved_model, cache_dir=cache_dir)
    if family == "sensevoice_onnx":
        if cache_dir is None:
            raise ASRUnsupportedModelError("SenseVoiceSmall-ONNX requires a local model cache.")
        return build_sensevoice_onnx_transcriber(cache_dir=cache_dir)
    raise ASRUnsupportedModelError(f"Unsupported ASR model: {resolved_model}")


def configure_modelscope_cache_dir(cache_dir: str | PathLike[str] | Path) -> Path:
    resolved_cache_dir = Path(cache_dir)
    resolved_cache_dir.mkdir(parents=True, exist_ok=True)
    os.environ[MODELSCOPE_CACHE_ENV] = resolved_cache_dir.as_posix()
    return resolved_cache_dir
