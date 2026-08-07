from __future__ import annotations

import re
import wave
from pathlib import Path
from typing import Any

from studymind_worker.asr_runtime.types import (
    ASRDependencyError,
    ASREmptyTranscriptError,
    ASRRuntimeError,
    ModelFactory,
    Transcript,
    TranscriptSegment,
    extract_provider_text,
    missing_dependency_message,
)

SENSEVOICE_SMALL_MODEL = "iic/SenseVoiceSmall"
SENSEVOICE_VAD_MODEL = "fsmn-vad"
SENSEVOICE_VAD_MAX_SEGMENT_TIME_MS = 30000
SENSEVOICE_TAG_PATTERN = re.compile(r"<\|[^|>]+?\|>")


class SenseVoiceTranscriber:
    def __init__(
        self,
        model_name: str = SENSEVOICE_SMALL_MODEL,
        model_factory: ModelFactory | None = None,
        model_kwargs: dict[str, Any] | None = None,
    ) -> None:
        self.model_name = model_name
        self._model_factory = model_factory or self._load_default_model
        self.model_kwargs = {
            "vad_model": SENSEVOICE_VAD_MODEL,
            "vad_kwargs": {"max_single_segment_time": SENSEVOICE_VAD_MAX_SEGMENT_TIME_MS},
            **(model_kwargs or {}),
        }
        self._model: Any | None = None

    def transcribe(self, audio_path: Path, language: str = "Chinese") -> Transcript:
        model = self._get_model()
        segmented_transcript = _transcribe_sensevoice_vad_blocks(
            model=model,
            audio_path=audio_path,
            language=language,
        )
        if segmented_transcript is not None:
            return segmented_transcript

        try:
            results = model.generate(
                input=audio_path.as_posix(),
                language=_sensevoice_language(language),
                use_itn=True,
                batch_size_s=60,
                merge_vad=True,
                merge_length_s=15,
                cache={},
            )
        except Exception as exc:  # noqa: BLE001 - wraps third-party model failures.
            raise ASRRuntimeError(str(exc)) from exc

        text = _clean_sensevoice_text(extract_provider_text(results))
        if not text.strip():
            raise ASREmptyTranscriptError("ASR returned an empty transcript.")

        segments = _extract_sensevoice_segments(results)

        return Transcript(text=text.strip(), language=language, segments=segments)

    def _get_model(self) -> Any:
        if self._model is None:
            try:
                self._model = self._model_factory(
                    model=self.model_name,
                    trust_remote_code=True,
                    **self.model_kwargs,
                )
            except ModuleNotFoundError as exc:
                raise ASRDependencyError(
                    missing_dependency_message(exc, runtime_name="SenseVoice ASR")
                ) from exc
        return self._model

    def _load_default_model(
        self,
        model: str,
        trust_remote_code: bool,
        **model_kwargs: Any,
    ) -> Any:
        from funasr import AutoModel

        return AutoModel(model=model, trust_remote_code=trust_remote_code, **model_kwargs)


def _sensevoice_language(language: str) -> str:
    normalized = language.strip().lower()
    if normalized in {"chinese", "zh", "zh-cn", "mandarin"}:
        return "zh"
    if normalized in {"english", "en"}:
        return "en"
    return "auto"


def _clean_sensevoice_text(text: str) -> str:
    return SENSEVOICE_TAG_PATTERN.sub("", text).strip()


def _extract_sensevoice_segments(results: object) -> tuple[TranscriptSegment, ...]:
    sentence_info = _extract_sentence_info(results)
    segments: list[TranscriptSegment] = []
    for sentence in sentence_info:
        if not isinstance(sentence, dict):
            continue
        start_ms = _coerce_milliseconds(sentence.get("start", sentence.get("start_ms")))
        end_ms = _coerce_milliseconds(sentence.get("end", sentence.get("end_ms")))
        if start_ms is None or end_ms is None or end_ms <= start_ms:
            continue
        text = _clean_sensevoice_text(str(sentence.get("text", "")))
        if not text:
            continue
        speaker = sentence.get("speaker", sentence.get("spk"))
        speaker_text = str(speaker).strip() if speaker is not None else None
        segments.append(
            TranscriptSegment(
                id=f"seg-{len(segments) + 1:04d}",
                start_ms=start_ms,
                end_ms=end_ms,
                text=text,
                speaker=speaker_text or None,
            )
        )
    return tuple(segments)


def _transcribe_sensevoice_vad_blocks(
    model: Any,
    audio_path: Path,
    language: str,
) -> Transcript | None:
    if getattr(model, "vad_model", None) is None or not hasattr(model, "inference"):
        return None

    try:
        import copy

        import numpy as np
        from funasr.utils.vad_utils import merge_vad
    except ModuleNotFoundError:
        return None

    generate_cfg: dict[str, Any] = {
        "language": _sensevoice_language(language),
        "use_itn": True,
        "batch_size_s": 60,
        "merge_vad": True,
        "merge_length_s": 15,
        "cache": {},
    }

    try:
        if hasattr(model, "_reset_runtime_configs"):
            model._reset_runtime_configs()
        vad_kwargs = copy.deepcopy(getattr(model, "vad_kwargs", {}) or {})
        vad_results = model.inference(
            audio_path.as_posix(),
            model=model.vad_model,
            kwargs=vad_kwargs,
            **generate_cfg,
        )
        vad_segments = _extract_vad_segments(vad_results)
        if not vad_segments:
            return None
        if generate_cfg["merge_vad"]:
            vad_segments = merge_vad(
                vad_segments,
                int(generate_cfg["merge_length_s"]) * 1000,
            )
        audio_samples = _read_pcm_wav_mono_float32(audio_path, np)
        if audio_samples is None:
            return None
        samples, sample_rate = audio_samples
        audio_blocks, valid_segments = _slice_audio_by_milliseconds(
            samples=samples,
            sample_rate=sample_rate,
            vad_segments=vad_segments,
        )
        if not audio_blocks:
            return None

        if hasattr(model, "_reset_runtime_configs"):
            model._reset_runtime_configs()
        asr_kwargs = copy.deepcopy(getattr(model, "kwargs", {}) or {})
        asr_kwargs["batch_size"] = max(1, int(asr_kwargs.get("batch_size", 1) or 1))
        asr_results = model.inference(
            audio_blocks,
            model=model.model,
            kwargs=asr_kwargs,
            language=generate_cfg["language"],
            use_itn=generate_cfg["use_itn"],
            cache={},
        )
    except Exception:
        return None

    segments: list[TranscriptSegment] = []
    for vad_segment, result in zip(valid_segments, asr_results, strict=False):
        text = _clean_sensevoice_text(extract_provider_text(result))
        if not text:
            continue
        segments.append(
            TranscriptSegment(
                id=f"seg-{len(segments) + 1:04d}",
                start_ms=vad_segment[0],
                end_ms=vad_segment[1],
                text=text,
            )
        )

    if not segments:
        return None

    return Transcript(
        text=" ".join(segment.text for segment in segments).strip(),
        language=language,
        segments=tuple(segments),
    )


def _extract_vad_segments(results: object) -> list[list[int]]:
    if not isinstance(results, list) or not results:
        return []
    first = results[0]
    if not isinstance(first, dict):
        return []
    value = first.get("value", [])
    if not isinstance(value, list):
        return []

    segments: list[list[int]] = []
    for item in value:
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            continue
        start_ms = _coerce_milliseconds(item[0])
        end_ms = _coerce_milliseconds(item[1])
        if start_ms is None or end_ms is None or end_ms <= start_ms:
            continue
        segments.append([start_ms, end_ms])
    return segments


def _read_pcm_wav_mono_float32(audio_path: Path, np: Any) -> tuple[Any, int] | None:
    try:
        with wave.open(str(audio_path), "rb") as wav_file:
            channels = wav_file.getnchannels()
            sample_width = wav_file.getsampwidth()
            sample_rate = wav_file.getframerate()
            frames = wav_file.readframes(wav_file.getnframes())
    except (wave.Error, OSError):
        return None

    if sample_width == 1:
        samples = (np.frombuffer(frames, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif sample_width == 2:
        samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    elif sample_width == 4:
        samples = np.frombuffer(frames, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        return None

    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return samples, sample_rate


def _slice_audio_by_milliseconds(
    samples: Any,
    sample_rate: int,
    vad_segments: list[list[int]],
) -> tuple[list[Any], list[tuple[int, int]]]:
    audio_blocks: list[Any] = []
    valid_segments: list[tuple[int, int]] = []
    sample_count = len(samples)
    for start_ms, end_ms in vad_segments:
        start_index = max(0, int(start_ms * sample_rate / 1000))
        end_index = min(sample_count, int(end_ms * sample_rate / 1000))
        if end_index <= start_index:
            continue
        audio_blocks.append(samples[start_index:end_index])
        valid_segments.append((start_ms, end_ms))
    return audio_blocks, valid_segments


def _extract_sentence_info(results: object) -> list[object]:
    if isinstance(results, list) and results:
        first = results[0]
        if isinstance(first, dict):
            sentence_info = first.get("sentence_info", [])
            return sentence_info if isinstance(sentence_info, list) else []
        sentence_info = getattr(first, "sentence_info", [])
        return sentence_info if isinstance(sentence_info, list) else []
    if isinstance(results, dict):
        sentence_info = results.get("sentence_info", [])
        return sentence_info if isinstance(sentence_info, list) else []
    sentence_info = getattr(results, "sentence_info", [])
    return sentence_info if isinstance(sentence_info, list) else []


def _coerce_milliseconds(value: object) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None
