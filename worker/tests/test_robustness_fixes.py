"""Robustness regression tests for the worker hardening pass."""

from __future__ import annotations

import hashlib
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


def _write_modelscope_snapshot_payload(target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    (target / "model.pt").write_bytes(b"pytorch-model")
    (target / "config.yaml").write_bytes(b"config")


def _make_modelscope_snapshot_downloader(calls: list[dict[str, object]]):
    """Mimic the real ModelScope SDK across cache layouts.

    With ``local_dir`` the SDK writes files flat into that directory (all
    versions). With only ``cache_dir`` the SDK >=1.38 writes the snapshot
    layout ``{cache}/models/{owner}--{name}/snapshots/{revision}/`` instead.
    """

    def snapshot_downloader(**kwargs: object) -> str:
        calls.append(kwargs)
        model_id = str(kwargs["model_id"])
        revision = str(kwargs.get("revision") or "master")
        local_dir = kwargs.get("local_dir")
        if local_dir is not None:
            target = Path(str(local_dir))
        else:
            safe_id = model_id.replace("/", "--")
            target = Path(str(kwargs["cache_dir"])) / "models" / safe_id / "snapshots" / revision
        if not (target / "model.pt").exists():
            _write_modelscope_snapshot_payload(target)
        return target.as_posix()

    return snapshot_downloader


def test_modelscope_download_lands_flat_regardless_of_sdk_cache_layout(tmp_path) -> None:
    """ModelScope >=1.38 changed its cache_dir layout; downloads must land in
    the flat per-repo layout StudyMind validates (regression: downloads used
    to complete at 96% and then fail validation with ASR_MODEL_ARCHIVE_INVALID)."""
    calls: list[dict[str, object]] = []
    cache_dir = tmp_path / "asr-models"

    model_download.download_asr_model_cache(
        cache_dir,
        snapshot_downloader=_make_modelscope_snapshot_downloader(calls),
    )

    assert model_download.validate_asr_model_cache(cache_dir)
    assert (cache_dir / "models" / "iic" / "SenseVoiceSmall" / "model.pt").is_file()
    assert (
        cache_dir
        / "models"
        / "iic"
        / "speech_fsmn_vad_zh-cn-16k-common-pytorch"
        / "model.pt"
    ).is_file()
    assert calls, "snapshot downloader must have been invoked"
    assert all(call.get("local_dir") for call in calls)


def test_modelscope_snapshot_layout_migration_reuses_downloaded_bytes(tmp_path) -> None:
    """A completed ModelScope >=1.38 snapshot-cache download (left behind by a
    previous failed attempt) must be migrated to the flat layout so the bytes
    are reused instead of re-downloaded."""
    cache_dir = tmp_path / "asr-models"
    modelscope_root = cache_dir / "models"
    primary_snapshot = (
        modelscope_root / "models" / "iic--SenseVoiceSmall" / "snapshots" / "master"
    )
    primary_snapshot.mkdir(parents=True)
    (primary_snapshot / "model.pt").write_bytes(b"primary-model")
    vad_snapshot = (
        modelscope_root
        / "models"
        / "iic--speech_fsmn_vad_zh-cn-16k-common-pytorch"
        / "snapshots"
        / "master"
    )
    vad_snapshot.mkdir(parents=True)
    (vad_snapshot / "model.pt").write_bytes(b"vad-model")

    model_download.download_asr_model_cache(
        cache_dir,
        snapshot_downloader=_make_modelscope_snapshot_downloader([]),
    )

    primary = cache_dir / "models" / "iic" / "SenseVoiceSmall" / "model.pt"
    vad = (
        cache_dir
        / "models"
        / "iic"
        / "speech_fsmn_vad_zh-cn-16k-common-pytorch"
        / "model.pt"
    )
    assert primary.read_bytes() == b"primary-model"
    assert vad.read_bytes() == b"vad-model"
    assert not (modelscope_root / "models" / "iic--SenseVoiceSmall").exists()
    assert not (modelscope_root / "models" / "iic--speech_fsmn_vad_zh-cn-16k-common-pytorch").exists()


def test_onnx_download_targets_flat_modelscope_layout(tmp_path) -> None:
    calls: list[dict[str, object]] = []
    payloads_by_model: dict[str, dict[str, bytes]] = {
        "iic/SenseVoiceSmall-onnx": {
            "model_quant.onnx": b"asr-onnx",
            "config.yaml": b"asr-config",
            "am.mvn": b"asr-mvn",
            "tokens.json": b"asr-tokens",
            "configuration.json": b"asr-configuration",
            "chn_jpn_yue_eng_ko_spectok.bpe.model": b"asr-bpe",
        },
        "iic/speech_fsmn_vad_zh-cn-16k-common-onnx": {
            "model_quant.onnx": b"vad-onnx",
            "config.yaml": b"vad-config",
            "am.mvn": b"vad-mvn",
        },
        "iic/SenseVoiceSmall": {
            "chn_jpn_yue_eng_ko_spectok.bpe.model": b"asr-bpe",
        },
    }

    def snapshot_downloader(**kwargs: object) -> str:
        calls.append(kwargs)
        target = Path(str(kwargs["local_dir"]))
        target.mkdir(parents=True, exist_ok=True)
        for file_name, payload in payloads_by_model[str(kwargs["model_id"])].items():
            (target / file_name).write_bytes(payload)
        return target.as_posix()

    def sha256(payload: bytes) -> str:
        return hashlib.sha256(payload).hexdigest()

    onnx_asset_hashes = {
        Path("models/iic/SenseVoiceSmall-onnx/am.mvn"): sha256(b"asr-mvn"),
        Path("models/iic/SenseVoiceSmall-onnx/config.yaml"): sha256(b"asr-config"),
        Path("models/iic/SenseVoiceSmall-onnx/configuration.json"): sha256(b"asr-configuration"),
        Path("models/iic/SenseVoiceSmall-onnx/model_quant.onnx"): sha256(b"asr-onnx"),
        Path("models/iic/SenseVoiceSmall-onnx/tokens.json"): sha256(b"asr-tokens"),
        Path(
            "models/iic/SenseVoiceSmall-onnx/chn_jpn_yue_eng_ko_spectok.bpe.model"
        ): sha256(b"asr-bpe"),
        Path(
            "models/iic/speech_fsmn_vad_zh-cn-16k-common-onnx/model_quant.onnx"
        ): sha256(b"vad-onnx"),
    }

    ready_dir = model_download.download_asr_model_cache(
        tmp_path / "cache",
        model_name="iic/SenseVoiceSmall-onnx",
        snapshot_downloader=snapshot_downloader,
        onnx_asset_hashes=onnx_asset_hashes,
    )

    asr_dir = ready_dir / "models" / "iic" / "SenseVoiceSmall-onnx"
    assert (asr_dir / "model_quant.onnx").read_bytes() == b"asr-onnx"
    assert (
        asr_dir / "chn_jpn_yue_eng_ko_spectok.bpe.model"
    ).read_bytes() == b"asr-bpe"
    assert (
        ready_dir
        / "models"
        / "iic"
        / "speech_fsmn_vad_zh-cn-16k-common-onnx"
        / "model_quant.onnx"
    ).read_bytes() == b"vad-onnx"
    assert not (ready_dir / "models" / "iic" / "SenseVoiceSmall").exists()
    assert calls, "snapshot downloader must have been invoked"
    assert all(call.get("local_dir") for call in calls)


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
