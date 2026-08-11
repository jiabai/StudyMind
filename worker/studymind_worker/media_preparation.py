from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path

from studymind_worker.atomic_files import AtomicFileCommitError, staged_file
from studymind_worker.desktop_contract import ProgressCallback
from studymind_worker.media import (
    CommandExecutionError,
    CommandRunner,
    extract_audio,
    probe_media_file,
)
from studymind_worker.models import JobStage, ProcessLocalMediaRequest
from studymind_worker.progress_events import build_worker_progress_event
from studymind_worker.subtitles import SubtitleTranscript, find_subtitle_transcript
from studymind_worker.task_store import TaskContext

VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".webm", ".m4v"}


@dataclass(frozen=True, slots=True)
class LocalMediaSource:
    request: ProcessLocalMediaRequest


@dataclass(frozen=True, slots=True)
class PreparedMedia:
    video_path: Path | None
    audio_path: Path
    subtitle_candidate: SubtitleTranscript | None


class MediaPreparationError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.stage = JobStage.VIDEO_EXTRACTING


class MediaPreparationFacade:
    def __init__(
        self,
        command_runner: CommandRunner,
        progress_callback: ProgressCallback | None = None,
    ) -> None:
        self._runner = command_runner
        self._progress = progress_callback

    def prepare(
        self,
        source: LocalMediaSource,
        task_context: TaskContext,
    ) -> PreparedMedia:
        request = source.request
        input_path = request.source_path
        if not input_path.exists():
            raise MediaPreparationError(
                "LOCAL_FILE_NOT_FOUND",
                f"Local media file not found: {input_path}",
            )

        self._emit_progress("local.media.validating", 5)
        try:
            media_info = probe_media_file(input_path, runner=self._runner)
        except CommandExecutionError as exc:
            raise MediaPreparationError(
                "MEDIA_PROBE_FAILED",
                f"ffprobe failed for {input_path.name}: {exc}",
            ) from exc

        audio_path = task_context.paths.audio_path
        if media_info.is_normalized_pcm_wav and input_path.suffix.lower() == ".wav":
            shutil.copy2(input_path, audio_path)
        else:
            self._emit_progress("audio.extract.running", 20)
            try:
                extract_audio(input_path, audio_path, runner=self._runner)
            except CommandExecutionError as exc:
                raise MediaPreparationError(
                    "AUDIO_EXTRACTION_FAILED",
                    f"ffmpeg audio extraction failed for {input_path.name}: {exc}",
                ) from exc

        video_path: Path | None = None
        if input_path.suffix.lower() in VIDEO_SUFFIXES:
            video_path = task_context.paths.video_path_for_extension(
                request.source_extension,
            )
            try:
                with staged_file(video_path) as staging_path:
                    shutil.copy2(input_path, staging_path)
            except AtomicFileCommitError as exc:
                raise MediaPreparationError(
                    "VIDEO_COPY_FAILED",
                    f"Failed to stage video file: {exc}",
                ) from exc

        subtitle_candidate = find_subtitle_transcript(input_path.parent)

        return PreparedMedia(
            video_path=video_path,
            audio_path=audio_path,
            subtitle_candidate=subtitle_candidate,
        )

    def _emit_progress(self, message_code: str, progress: int) -> None:
        if self._progress is not None:
            self._progress(
                build_worker_progress_event(
                    message_code,
                    stage=JobStage.VIDEO_EXTRACTING.value,
                    progress=progress,
                )
            )
