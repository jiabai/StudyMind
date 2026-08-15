from __future__ import annotations

import json
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

DEFAULT_COMMAND_TIMEOUT_SECONDS = 15 * 60.0


@dataclass(frozen=True)
class CommandResult:
    command: list[str]
    returncode: int
    stdout: str
    stderr: str


CommandRunner = Callable[[list[str]], CommandResult]
ProgressCallback = Callable[[dict[str, object]], None]


class CommandExecutionError(RuntimeError):
    def __init__(self, result: CommandResult) -> None:
        message = f"Media command failed with exit code {result.returncode}."
        super().__init__(message)
        self.result = result


class CommandTimeoutError(RuntimeError):
    def __init__(self, command: list[str], timeout_seconds: float) -> None:
        message = (
            f"Media command timed out after {timeout_seconds:g} seconds: "
            f"{command[0] if command else 'unknown'}."
        )
        super().__init__(message)
        self.command = command
        self.timeout_seconds = timeout_seconds


class MediaProbeError(RuntimeError):
    """Raised when ffprobe exits successfully but its output is unusable."""

    def __init__(self) -> None:
        super().__init__("ffprobe returned output that could not be parsed.")


@dataclass(frozen=True)
class MediaInfo:
    has_video: bool
    has_audio: bool
    video_codec: str | None
    audio_codec: str | None
    audio_sample_format: str | None
    audio_sample_rate: int | None
    audio_channels: int | None
    width: int | None
    height: int | None
    duration_seconds: float | None
    size_bytes: int | None

    @property
    def is_valid(self) -> bool:
        return self.has_video and self.is_valid_audio

    @property
    def is_valid_audio(self) -> bool:
        return (
            self.has_audio
            and self.duration_seconds is not None
            and self.duration_seconds > 0
            and self.size_bytes is not None
            and self.size_bytes > 0
        )

    @property
    def is_normalized_pcm_wav(self) -> bool:
        return (
            self.is_valid_audio
            and self.audio_codec == "pcm_s16le"
            and self.audio_sample_format == "s16"
            and self.audio_sample_rate == 16000
            and self.audio_channels == 1
        )


def build_ffprobe_command(media_path: Path) -> list[str]:
    return [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        (
            "format=duration,size:"
            "stream=index,codec_type,codec_name,width,height,"
            "sample_fmt,sample_rate,channels"
        ),
        "-of",
        "json",
        media_path.as_posix(),
    ]


def build_audio_extract_command(input_path: Path, output_path: Path) -> list[str]:
    return [
        "ffmpeg",
        "-y",
        "-i",
        input_path.as_posix(),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        output_path.as_posix(),
    ]


def run_command(
    command: list[str],
    timeout_seconds: float = DEFAULT_COMMAND_TIMEOUT_SECONDS,
) -> CommandResult:
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            check=False,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        raise CommandTimeoutError(command, timeout_seconds) from exc
    return CommandResult(
        command=command,
        returncode=completed.returncode,
        stdout=completed.stdout,
        stderr=completed.stderr,
    )


def probe_media_file(
    media_path: Path,
    runner: CommandRunner = run_command,
) -> MediaInfo:
    result = runner(build_ffprobe_command(media_path))
    if result.returncode != 0:
        raise CommandExecutionError(result)
    try:
        return parse_ffprobe_json(result.stdout)
    except (json.JSONDecodeError, TypeError, ValueError):
        raise MediaProbeError() from None


def extract_audio(
    input_path: Path,
    output_path: Path,
    runner: CommandRunner = run_command,
) -> CommandResult:
    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise CommandExecutionError(
            CommandResult(
                command=build_audio_extract_command(input_path, output_path),
                returncode=-1,
                stdout="",
                stderr=str(exc),
            )
        ) from exc
    result = runner(build_audio_extract_command(input_path, output_path))
    if result.returncode != 0:
        raise CommandExecutionError(result)
    return result


def parse_ffprobe_json(raw_json: str) -> MediaInfo:
    payload = json.loads(raw_json)
    if not isinstance(payload, dict):
        raise TypeError("ffprobe output was not a JSON object.")
    raw_streams = payload.get("streams")
    streams = (
        [stream for stream in raw_streams if isinstance(stream, dict)]
        if isinstance(raw_streams, list)
        else []
    )
    video_stream = next(
        (stream for stream in streams if stream.get("codec_type") == "video"),
        None,
    )
    audio_stream = next(
        (stream for stream in streams if stream.get("codec_type") == "audio"),
        None,
    )
    media_format = payload.get("format")
    if not isinstance(media_format, dict):
        media_format = {}

    return MediaInfo(
        has_video=video_stream is not None,
        has_audio=audio_stream is not None,
        video_codec=video_stream.get("codec_name") if video_stream else None,
        audio_codec=audio_stream.get("codec_name") if audio_stream else None,
        audio_sample_format=audio_stream.get("sample_fmt") if audio_stream else None,
        audio_sample_rate=(_parse_int(audio_stream.get("sample_rate")) if audio_stream else None),
        audio_channels=(_parse_int(audio_stream.get("channels")) if audio_stream else None),
        width=video_stream.get("width") if video_stream else None,
        height=video_stream.get("height") if video_stream else None,
        duration_seconds=_parse_float(media_format.get("duration")),
        size_bytes=_parse_int(media_format.get("size")),
    )


def _parse_float(value: object) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _parse_int(value: object) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None
