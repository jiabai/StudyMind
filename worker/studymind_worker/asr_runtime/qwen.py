from __future__ import annotations

from pathlib import Path
from typing import Any

from studymind_worker.asr_runtime.types import (
    ASRDependencyError,
    ASREmptyTranscriptError,
    ASRRuntimeError,
    ModelFactory,
    Transcript,
    extract_provider_text,
    missing_dependency_message,
)

QWEN_ASR_MODEL = "Qwen/Qwen3-ASR-0.6B"


class QwenAsrTranscriber:
    def __init__(
        self,
        model_name: str = QWEN_ASR_MODEL,
        model_factory: ModelFactory | None = None,
        max_inference_batch_size: int = 4,
        max_new_tokens: int = 4096,
        model_kwargs: dict[str, Any] | None = None,
    ) -> None:
        self.model_name = model_name
        self._model_factory = model_factory or self._load_default_model
        self.max_inference_batch_size = max_inference_batch_size
        self.max_new_tokens = max_new_tokens
        self.model_kwargs = model_kwargs or {}
        self._model: Any | None = None

    def transcribe(self, audio_path: Path, language: str = "Chinese") -> Transcript:
        model = self._get_model()
        try:
            results = model.transcribe(audio=audio_path.as_posix(), language=language)
        except Exception as exc:
            raise ASRRuntimeError(str(exc)) from exc

        text = extract_provider_text(results)
        if not text.strip():
            raise ASREmptyTranscriptError("ASR returned an empty transcript.")

        return Transcript(text=text.strip(), language=language)

    def _get_model(self) -> Any:
        if self._model is None:
            try:
                self._model = self._model_factory(
                    model_name=self.model_name,
                    max_inference_batch_size=self.max_inference_batch_size,
                    max_new_tokens=self.max_new_tokens,
                    **self.model_kwargs,
                )
            except ModuleNotFoundError as exc:
                raise ASRDependencyError(
                    missing_dependency_message(exc, runtime_name="Qwen ASR")
                ) from exc
        return self._model

    def _load_default_model(
        self,
        model_name: str,
        max_inference_batch_size: int,
        max_new_tokens: int,
        **model_kwargs: Any,
    ) -> Any:
        from qwen_asr import Qwen3ASRModel

        return Qwen3ASRModel.from_pretrained(
            model_name,
            max_inference_batch_size=max_inference_batch_size,
            max_new_tokens=max_new_tokens,
            **model_kwargs,
        )
