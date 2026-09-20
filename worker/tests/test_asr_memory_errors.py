"""Regression tests for classifying ASR out-of-memory failures.

An exhausted machine used to be indistinguishable from a code defect: torch
raised a bare ``RuntimeError``, nothing in the ASR layer claimed it, and the
pipeline escape hatch in ``orchestration.py`` turned it into
``WORKER_INTERNAL_ERROR``. The desktop renders that as "the local worker exited
unexpectedly, keep existing results and retry", which sends the user into a loop
that cannot succeed. These tests pin the honest classification.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from studymind_worker.asr_runtime.qwen import QwenAsrTranscriber
from studymind_worker.asr_runtime.sensevoice import SenseVoiceTranscriber
from studymind_worker.asr_runtime.types import (
    ASRError,
    ASRInsufficientMemoryError,
    ASRRuntimeError,
    is_memory_exhaustion_error,
    memory_exhaustion_message,
)
from studymind_worker.models import JobStage
from studymind_worker.pipeline_runtime.transcript import run_asr_transcript_step
from studymind_worker.resource_throttle import available_commit_bytes

# Verbatim from %LOCALAPPDATA%\com.studymind.desktop\logs\StudyMind-desktop.log
# on 2026-09-20, where Windows refused torch a 4 MiB allocation.
PRODUCTION_ALLOCATION_FAILURE = (
    "[enforce fail at C:\\actions-runner\\_work\\pytorch\\pytorch\\builder\\"
    "windows\\pytorch\\c10\\core\\impl\\alloc_cpu.cpp:117] data. "
    "DefaultCPUAllocator: not enough memory: you tried to allocate 4194304 bytes."
)

NON_MEMORY_FAILURES = (
    "Unexpected key(s) in state_dict: \"encoder.layer.0.weight\".",
    "Model not found: iic/SenseVoiceSmall",
    "Only tensors of floating point dtype can require gradients",
)


def _raising_factory(exc: Exception):
    def factory(**_kwargs: object) -> object:
        raise exc

    return factory


def _stub_model(exception: Exception) -> object:
    class _StubModel:
        def generate(self, **_kwargs: object) -> object:
            raise exception

    return _StubModel()


@pytest.mark.parametrize(
    "failure",
    [
        PRODUCTION_ALLOCATION_FAILURE,
        "CUDA out of memory. Tried to allocate 20.00 MiB",
        "std::bad_alloc",
        "onnxruntime.capi.onnxruntime_pybind11_state.RuntimeException: "
        "Failed to allocate memory for requested buffer",
    ],
)
def test_memory_exhaustion_is_recognised_from_provider_prose(failure: str) -> None:
    assert is_memory_exhaustion_error(RuntimeError(failure)) is True


def test_memory_exhaustion_is_recognised_from_the_native_error() -> None:
    assert is_memory_exhaustion_error(MemoryError()) is True


@pytest.mark.parametrize("failure", NON_MEMORY_FAILURES)
def test_unrelated_failures_are_not_mistaken_for_memory_exhaustion(failure: str) -> None:
    assert is_memory_exhaustion_error(RuntimeError(failure)) is False


def test_memory_exhaustion_message_reports_the_provider_text_and_headroom() -> None:
    message = memory_exhaustion_message(
        "load the SenseVoice ASR model",
        RuntimeError(PRODUCTION_ALLOCATION_FAILURE),
    )

    assert message.startswith("Not enough memory to load the SenseVoice ASR model:")
    assert PRODUCTION_ALLOCATION_FAILURE in message
    if available_commit_bytes() is None:
        assert "Commit available" not in message
    else:
        assert "Commit available when it failed:" in message


def test_sensevoice_model_load_out_of_memory_is_an_asr_memory_error() -> None:
    transcriber = SenseVoiceTranscriber(
        model_factory=_raising_factory(RuntimeError(PRODUCTION_ALLOCATION_FAILURE))
    )

    with pytest.raises(ASRInsufficientMemoryError) as failure:
        transcriber.transcribe(Path("recording_1789887637620.wav"))

    assert failure.value.code == "ASR_INSUFFICIENT_MEMORY"
    # The transcript step only claims ASRError, so membership here is what stops
    # the failure from falling through to WORKER_INTERNAL_ERROR.
    assert isinstance(failure.value, ASRError)
    assert isinstance(failure.value, ASRRuntimeError)


def test_sensevoice_inference_out_of_memory_is_an_asr_memory_error() -> None:
    transcriber = SenseVoiceTranscriber(
        model_factory=lambda **_kwargs: _stub_model(
            RuntimeError(PRODUCTION_ALLOCATION_FAILURE)
        )
    )

    with pytest.raises(ASRInsufficientMemoryError):
        transcriber.transcribe(Path("recording_1789887637620.wav"))


@pytest.mark.parametrize("failure", NON_MEMORY_FAILURES)
def test_sensevoice_model_load_failures_stay_in_the_asr_error_family(
    failure: str,
) -> None:
    transcriber = SenseVoiceTranscriber(
        model_factory=_raising_factory(RuntimeError(failure))
    )

    with pytest.raises(ASRRuntimeError) as raised:
        transcriber.transcribe(Path("recording_1789887637620.wav"))

    assert raised.value.code == "ASR_RUNTIME_ERROR"
    assert str(raised.value) == failure


def test_qwen_model_load_out_of_memory_is_an_asr_memory_error() -> None:
    transcriber = QwenAsrTranscriber(
        model_factory=_raising_factory(RuntimeError(PRODUCTION_ALLOCATION_FAILURE))
    )

    with pytest.raises(ASRInsufficientMemoryError) as failure:
        transcriber.transcribe(Path("recording_1789887637620.wav"))

    assert failure.value.code == "ASR_INSUFFICIENT_MEMORY"


def test_transcript_stage_reports_the_memory_code_instead_of_an_internal_error(
    tmp_path: Path,
) -> None:
    transcriber = SenseVoiceTranscriber(
        model_factory=_raising_factory(RuntimeError(PRODUCTION_ALLOCATION_FAILURE))
    )

    result = run_asr_transcript_step(
        audio_path=tmp_path / "recording_1789887637620.wav",
        output_dir=tmp_path / "transcript",
        output_stem="",
        transcriber=transcriber,
    )

    assert result.status == JobStage.FAILED
    assert result.error is not None
    assert result.error.code == "ASR_INSUFFICIENT_MEMORY"
    assert result.error.stage == JobStage.VIDEO_TRANSCRIBING
