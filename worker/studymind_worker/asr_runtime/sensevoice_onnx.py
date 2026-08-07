from __future__ import annotations

from pathlib import Path
from typing import Any

from studymind_worker.asr_runtime.sensevoice import (
    _clean_sensevoice_text,
    _coerce_milliseconds,
    _read_pcm_wav_mono_float32,
    _sensevoice_language,
    _slice_audio_by_milliseconds,
)
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

SENSEVOICE_SMALL_ONNX_MODEL = "iic/SenseVoiceSmall-onnx"
ONNX_VAD_CHUNK_SECONDS = 10
ONNX_VAD_INVALID_STREAM_MESSAGE = "ONNX VAD returned an invalid event stream."


def _extract_onnx_text(results: object) -> str:
    if isinstance(results, str):
        return results
    if isinstance(results, list) and all(isinstance(result, str) for result in results):
        return " ".join(results)
    return extract_provider_text(results)


def _invalid_vad_stream() -> ASRRuntimeError:
    return ASRRuntimeError(ONNX_VAD_INVALID_STREAM_MESSAGE)


def _decode_onnx_vad_events(
    results: object,
) -> list[tuple[int | None, int | None]]:
    if isinstance(results, list) and not results:
        return []
    if (
        not isinstance(results, list)
        or len(results) != 1
        or not isinstance(results[0], list)
        or not results[0]
    ):
        raise _invalid_vad_stream()

    events: list[tuple[int | None, int | None]] = []
    for item in results[0]:
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            raise _invalid_vad_stream()
        try:
            raw_start = _coerce_milliseconds(item[0])
            raw_end = _coerce_milliseconds(item[1])
        except OverflowError as exc:
            raise _invalid_vad_stream() from exc
        if (
            raw_start is None
            or raw_end is None
            or raw_start < -1
            or raw_end < -1
            or (raw_start == -1 and raw_end == -1)
        ):
            raise _invalid_vad_stream()
        events.append(
            (
                None if raw_start == -1 else raw_start,
                None if raw_end == -1 else raw_end,
            )
        )
    return events


def _stream_onnx_vad_segments(
    *,
    vad: Any,
    samples: Any,
    sample_rate: int,
) -> list[list[int]]:
    chunk_samples = sample_rate * ONNX_VAD_CHUNK_SECONDS
    if sample_rate <= 0 or chunk_samples <= 0:
        raise ASRRuntimeError("ONNX ASR could not read normalized PCM WAV audio.")

    sample_count = len(samples)
    provider_state: dict[str, Any] = {}
    segments: list[list[int]] = []
    pending_start_ms: int | None = None

    for offset in range(0, sample_count, chunk_samples):
        end_offset = min(sample_count, offset + chunk_samples)
        provider_state["is_final"] = end_offset == sample_count
        try:
            result = vad(
                samples[offset:end_offset],
                param_dict=provider_state,
            )
        except ASRDependencyError:
            raise
        except Exception as exc:
            raise ASRRuntimeError("ONNX VAD inference failed.") from exc

        for start_ms, end_ms in _decode_onnx_vad_events(result):
            last_end_ms = segments[-1][1] if segments else 0
            if start_ms is not None and end_ms is None:
                if pending_start_ms is not None or start_ms < last_end_ms:
                    raise _invalid_vad_stream()
                pending_start_ms = start_ms
                continue

            if start_ms is None and end_ms is not None:
                if pending_start_ms is None or end_ms <= pending_start_ms:
                    raise _invalid_vad_stream()
                segments.append([pending_start_ms, end_ms])
                pending_start_ms = None
                continue

            if (
                start_ms is None
                or end_ms is None
                or pending_start_ms is not None
                or start_ms < last_end_ms
                or end_ms <= start_ms
            ):
                raise _invalid_vad_stream()
            segments.append([start_ms, end_ms])

    if pending_start_ms is not None:
        raise _invalid_vad_stream()
    return segments


class SenseVoiceOnnxTranscriber:
    """Direct local `funasr_onnx` adapter with bounded online VAD inference."""

    def __init__(
        self,
        asr_model_dir: Path,
        vad_model_dir: Path,
        asr_factory: ModelFactory | None = None,
        vad_factory: ModelFactory | None = None,
    ) -> None:
        self.asr_model_dir = Path(asr_model_dir)
        self.vad_model_dir = Path(vad_model_dir)
        self._asr_factory = asr_factory or self._load_default_asr
        self._vad_factory = vad_factory or self._load_default_vad
        self._asr: Any | None = None
        self._vad: Any | None = None

    def transcribe(self, audio_path: Path, language: str = "Chinese") -> Transcript:
        return self._transcribe_vad_segments(audio_path, language)

    def _get_asr(self) -> Any:
        if self._asr is None:
            try:
                self._asr = self._asr_factory(
                    model_dir=self.asr_model_dir.as_posix(),
                    quantize=True,
                    batch_size=1,
                    device_id="-1",
                )
            except ModuleNotFoundError as exc:
                raise ASRDependencyError(
                    missing_dependency_message(exc, runtime_name="SenseVoice ONNX ASR")
                ) from exc
        return self._asr

    def _get_vad(self) -> Any:
        if self._vad is None:
            try:
                self._vad = self._vad_factory(
                    model_dir=self.vad_model_dir.as_posix(),
                    quantize=True,
                    device_id="-1",
                )
            except ModuleNotFoundError as exc:
                raise ASRDependencyError(
                    missing_dependency_message(exc, runtime_name="SenseVoice ONNX VAD")
                ) from exc
        return self._vad

    def _load_default_asr(self, **kwargs: Any) -> Any:
        from funasr_onnx import SenseVoiceSmall

        return SenseVoiceSmall(**kwargs)

    def _load_default_vad(self, **kwargs: Any) -> Any:
        from funasr_onnx import Fsmn_vad_online

        return Fsmn_vad_online(**kwargs)

    def _transcribe_vad_segments(
        self,
        audio_path: Path,
        language: str,
    ) -> Transcript:
        def _segment_failure(reason: Exception) -> ASRRuntimeError:
            return ASRRuntimeError(
                f"ONNX ASR segment {_index} of {total_blocks} failed: {reason}"
            )

        try:
            import numpy as np
        except ModuleNotFoundError as exc:
            raise ASRDependencyError(
                missing_dependency_message(exc, runtime_name="SenseVoice ONNX ASR")
            ) from exc

        audio_samples = _read_pcm_wav_mono_float32(audio_path, np)
        if audio_samples is None:
            raise ASRRuntimeError("ONNX ASR could not read normalized PCM WAV audio.")

        samples, sample_rate = audio_samples
        vad_segments = _stream_onnx_vad_segments(
            vad=self._get_vad(),
            samples=samples,
            sample_rate=sample_rate,
        )
        if not vad_segments:
            raise ASREmptyTranscriptError("ONNX VAD detected no speech.")

        try:
            blocks, valid_segments = _slice_audio_by_milliseconds(
                samples=samples,
                sample_rate=sample_rate,
                vad_segments=vad_segments,
            )
        except Exception as exc:
            raise ASRRuntimeError("ONNX ASR segment preparation failed.") from exc
        if not blocks or len(blocks) != len(valid_segments):
            raise ASRRuntimeError("ONNX VAD returned no usable audio segments.")

        asr = self._get_asr()
        segments: list[TranscriptSegment] = []
        total_blocks = len(blocks)
        for _index, (timing, block) in enumerate(
            zip(valid_segments, blocks, strict=True),
            start=1,
        ):
            try:
                result = asr(
                    block,
                    language=_sensevoice_language(language),
                    textnorm="withitn",
                )
            except Exception as exc:
                raise _segment_failure(exc) from exc
            text = _clean_sensevoice_text(_extract_onnx_text(result))
            if text:
                segments.append(
                    TranscriptSegment(
                        id=f"seg-{len(segments) + 1:04d}",
                        start_ms=timing[0],
                        end_ms=timing[1],
                        text=text,
                    )
                )
        if not segments:
            raise ASREmptyTranscriptError("ASR returned an empty transcript.")
        return Transcript(
            text=" ".join(segment.text for segment in segments),
            language=language,
            segments=tuple(segments),
        )
