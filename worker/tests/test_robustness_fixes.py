"""Robustness regression tests for the worker hardening pass."""

from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

import pytest
from studymind_worker import model_download, subtitles
from studymind_worker.asr_runtime.sensevoice import _read_pcm_wav_mono_float32
from studymind_worker.media import (
    CommandExecutionError,
    CommandResult,
    CommandTimeoutError,
    MediaProbeError,
    extract_audio,
    probe_media_file,
    run_command,
)
from studymind_worker.media_preparation import (
    LocalMediaSource,
    MediaPreparationError,
    MediaPreparationFacade,
)
from studymind_worker.models import JobStage, ProcessLocalMediaRequest
from studymind_worker.pipeline_runtime.orchestration import run_local_media_pipeline
from studymind_worker.task_store import TaskStoreFacade, load_task_manifest


def _command_result(stdout: str = "", returncode: int = 0) -> CommandResult:
    return CommandResult(command=["ffprobe"], returncode=returncode, stdout=stdout, stderr="")


def test_run_command_timeout_raises_command_timeout_error() -> None:
    with pytest.raises(CommandTimeoutError):
        run_command([sys.executable, "-c", "import time; time.sleep(30)"], timeout_seconds=0.5)


def test_run_command_tolerates_non_utf8_output() -> None:
    result = run_command(
        [
            sys.executable,
            "-c",
            "import sys; sys.stdout.buffer.write(b'\\xff\\xfe'); sys.stderr.buffer.write(b'\\x80')",
        ],
        timeout_seconds=30,
    )
    assert result.returncode == 0


def test_probe_media_file_garbage_json_raises_media_probe_error() -> None:
    with pytest.raises(MediaProbeError):
        probe_media_file(Path("lecture.mp4"), runner=lambda _command: _command_result("not json"))


def test_probe_media_file_json_array_raises_media_probe_error() -> None:
    with pytest.raises(MediaProbeError):
        probe_media_file(Path("lecture.mp4"), runner=lambda _command: _command_result("[]"))


def test_probe_media_file_nonzero_exit_raises_command_execution_error() -> None:
    with pytest.raises(CommandExecutionError):
        probe_media_file(
            Path("lecture.mp4"),
            runner=lambda _command: _command_result("", returncode=1),
        )


def test_extract_audio_timeout_propagates(tmp_path) -> None:
    def timeout_runner(command):
        raise CommandTimeoutError(command, 1.0)

    with pytest.raises(CommandTimeoutError):
        extract_audio(tmp_path / "in.mp4", tmp_path / "out.wav", runner=timeout_runner)


def test_media_preparation_probe_timeout_is_structured(tmp_path) -> None:
    source_path = tmp_path / "lecture.mp4"
    source_path.write_bytes(b"media")
    request = ProcessLocalMediaRequest(
        source_path=source_path,
        media_kind="video",
        safe_display_name="lecture.mp4",
        source_extension="mp4",
        asr_model="iic/SenseVoiceSmall",
    )

    def timeout_runner(command):
        raise CommandTimeoutError(command, 1.0)

    with pytest.raises(MediaPreparationError) as error:
        MediaPreparationFacade(timeout_runner).prepare(
            LocalMediaSource(request),
            None,
        )
    assert error.value.code == "MEDIA_PROBE_TIMEOUT"


def test_media_preparation_wav_copy_failure_is_structured(tmp_path, monkeypatch) -> None:
    from studymind_worker import media_preparation as media_preparation_module
    from studymind_worker.media import MediaInfo

    source_path = tmp_path / "lecture.wav"
    source_path.write_bytes(b"media")
    request = ProcessLocalMediaRequest(
        source_path=source_path,
        media_kind="audio",
        safe_display_name="lecture.wav",
        source_extension="wav",
        asr_model="iic/SenseVoiceSmall",
    )
    task_context = TaskStoreFacade(
        output_root=tmp_path / "outputs",
        cache_root=tmp_path / "cache",
    ).create_local(request, random_id="abcdef12")

    monkeypatch.setattr(
        media_preparation_module,
        "probe_media_file",
        lambda _path, runner: MediaInfo(
            has_video=False,
            has_audio=True,
            video_codec=None,
            audio_codec="pcm_s16le",
            audio_sample_format="s16",
            audio_sample_rate=16000,
            audio_channels=1,
            width=None,
            height=None,
            duration_seconds=1.0,
            size_bytes=5,
        ),
    )

    def failing_copy2(_source, _destination):
        raise OSError("disk full")

    monkeypatch.setattr(media_preparation_module.shutil, "copy2", failing_copy2)

    with pytest.raises(MediaPreparationError) as error:
        MediaPreparationFacade(lambda _command: None).prepare(
            LocalMediaSource(request),
            task_context,
        )
    assert error.value.code == "MEDIA_READ_FAILED"


def test_load_task_manifest_json_array_is_clean_value_error(tmp_path) -> None:
    task_dir = tmp_path / "tasks" / "task-1"
    task_dir.mkdir(parents=True)
    (task_dir / "StudyMind-task.json").write_text("[]", encoding="utf-8")
    with pytest.raises((TypeError, ValueError)):
        load_task_manifest(tmp_path, "task-1")


def test_load_task_manifest_invalid_json_is_clean_value_error(tmp_path) -> None:
    task_dir = tmp_path / "tasks" / "task-1"
    task_dir.mkdir(parents=True)
    (task_dir / "StudyMind-task.json").write_text("{broken", encoding="utf-8")
    with pytest.raises(ValueError):
        load_task_manifest(tmp_path, "task-1")


def _wav_bytes(frame_bytes: bytes, channels: int = 2, sample_rate: int = 16000) -> bytes:
    sample_width = 2
    header = b"RIFF" + struct.pack("<I", 36 + len(frame_bytes)) + b"WAVE"
    header += b"fmt " + struct.pack(
        "<IHHIIHH",
        16,
        1,
        channels,
        sample_rate,
        sample_rate * channels * sample_width,
        channels * sample_width,
        sample_width * 8,
    )
    return header + b"data" + struct.pack("<I", len(frame_bytes)) + frame_bytes


def test_read_pcm_wav_truncated_frames_returns_none(tmp_path) -> None:
    # Header claims 4 bytes of stereo frames but the file only holds 3;
    # wave reports zero whole frames, which must be rejected as unusable.
    truncated = tmp_path / "truncated.wav"
    truncated.write_bytes(_wav_bytes(b"\x00\x00\x00"))
    assert _read_pcm_wav_mono_float32(truncated, np=None) is None


def test_read_pcm_wav_zero_sample_rate_returns_none(tmp_path) -> None:
    invalid = tmp_path / "invalid.wav"
    invalid.write_bytes(_wav_bytes(b"\x00\x00\x00\x00", sample_rate=0))
    assert _read_pcm_wav_mono_float32(invalid, np=None) is None


def test_read_pcm_wav_valid_mono_parses_samples(tmp_path) -> None:
    import numpy as np

    valid = tmp_path / "valid.wav"
    valid.write_bytes(_wav_bytes(b"\x00\x00\x7f\x00", channels=1))
    samples, sample_rate = _read_pcm_wav_mono_float32(valid, np)
    assert sample_rate == 16000
    assert samples.shape == (2,)


def test_find_subtitle_transcript_tolerates_unreadable_directory(tmp_path) -> None:
    not_a_directory = tmp_path / "not-a-directory"
    not_a_directory.write_text("x", encoding="utf-8")
    assert subtitles.find_subtitle_transcript(not_a_directory) is None


def test_archive_download_rejects_oversized_content_length(tmp_path, monkeypatch) -> None:
    class FakeResponse:
        def __init__(self) -> None:
            self.headers = {"Content-Length": str(model_download.MAX_MODEL_ARCHIVE_BYTES + 1)}

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, _size):
            return b""

    monkeypatch.setattr(
        model_download.urllib.request,
        "urlopen",
        lambda _url, timeout: FakeResponse(),
    )
    with pytest.raises(model_download.ModelDownloadError) as error:
        model_download._resolve_archive(
            "https://example.com/model.zip",
            tmp_path,
            None,
        )
    assert error.value.code == model_download.MODEL_DOWNLOAD_ERROR_CODE


def test_pipeline_unexpected_error_preserves_task_id_and_manifest(tmp_path) -> None:
    source_path = tmp_path / "lecture.mp4"
    source_path.write_bytes(b"media")
    request = ProcessLocalMediaRequest(
        source_path=source_path,
        media_kind="video",
        safe_display_name="lecture.mp4",
        source_extension="mp4",
        asr_model="iic/SenseVoiceSmall",
    )

    def exploding_runner(command):
        raise RuntimeError("boom")

    result = run_local_media_pipeline(
        request=request,
        project_root=tmp_path,
        command_runner=exploding_runner,
        transcriber=None,
        allow_real_asr=False,
        environ={},
    )

    assert result.status == JobStage.FAILED
    assert result.error is not None
    assert result.error.code == "WORKER_INTERNAL_ERROR"
    assert result.task_id is not None
    manifest_path = tmp_path / "outputs" / "tasks" / result.task_id / "StudyMind-task.json"
    assert manifest_path.is_file()
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert payload["status"] == "failed"
    assert payload["task_id"] == result.task_id
