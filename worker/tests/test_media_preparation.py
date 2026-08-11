from __future__ import annotations

from pathlib import Path

import pytest
from studymind_worker import media_preparation
from studymind_worker.media import CommandResult, MediaInfo
from studymind_worker.media_preparation import (
    LocalMediaSource,
    MediaPreparationError,
    MediaPreparationFacade,
)
from studymind_worker.models import ProcessLocalMediaRequest
from studymind_worker.task_store import TaskStoreFacade


def test_media_preparation_reads_the_local_source_path() -> None:
    request = ProcessLocalMediaRequest(
        source_path=Path("C:/missing/lecture.mp4"),
        media_kind="video",
        safe_display_name="lecture.mp4",
        source_extension="mp4",
        asr_model="iic/SenseVoiceSmall",
    )

    with pytest.raises(MediaPreparationError) as error:
        MediaPreparationFacade(lambda _command: None).prepare(
            LocalMediaSource(request),
            None,
        )

    assert error.value.code == "LOCAL_FILE_NOT_FOUND"


def test_media_preparation_uses_task_paths_for_audio_and_video(
    tmp_path,
    monkeypatch,
) -> None:
    source_path = tmp_path / "lecture.mp4"
    source_path.write_bytes(b"video")
    request = ProcessLocalMediaRequest(
        source_path=source_path,
        media_kind="video",
        safe_display_name="lecture.mp4",
        source_extension="mp4",
        asr_model="iic/SenseVoiceSmall",
    )
    task_context = TaskStoreFacade(
        output_root=tmp_path / "outputs",
        cache_root=tmp_path / "cache",
    ).create_local(request, random_id="abcdef12")

    monkeypatch.setattr(
        media_preparation,
        "probe_media_file",
        lambda _path, runner: MediaInfo(
            has_video=True,
            has_audio=True,
            video_codec="h264",
            audio_codec="aac",
            audio_sample_format="fltp",
            audio_sample_rate=48000,
            audio_channels=2,
            width=1280,
            height=720,
            duration_seconds=1.0,
            size_bytes=5,
        ),
    )

    def fake_extract_audio(_input_path, output_path, runner):
        output_path.write_bytes(b"audio")
        return CommandResult([], 0, "", "")

    monkeypatch.setattr(media_preparation, "extract_audio", fake_extract_audio)

    prepared = MediaPreparationFacade(lambda _command: None).prepare(
        LocalMediaSource(request),
        task_context,
    )

    assert prepared.audio_path == task_context.paths.audio_path
    assert prepared.video_path == task_context.paths.video_path_for_extension("mp4")
    assert prepared.audio_path.is_file()
    assert prepared.video_path.is_file()
