from __future__ import annotations

import html
import re
from dataclasses import dataclass
from pathlib import Path

from studymind_worker.asr_runtime.types import TranscriptSegment

PREFERRED_SUBTITLE_LANGUAGES = (
    "zh-Hans",
    "zh-CN",
    "zh-Hant",
    "zh",
    "en",
    "ja",
    "ko",
)
SUPPORTED_SUBTITLE_SUFFIXES = (".srt", ".vtt")
TIMESTAMP_PATTERN = re.compile(
    r"(?P<start>(?:\d{2}:)?\d{2}:\d{2}[\.,]\d{3})\s*-->\s*"
    r"(?P<end>(?:\d{2}:)?\d{2}:\d{2}[\.,]\d{3})"
)
TAG_PATTERN = re.compile(r"<[^>]+>")
INLINE_TIMESTAMP_TAG_PATTERN = re.compile(r"<\d{2}:\d{2}:\d{2}[\.,]\d{3}>")


@dataclass(frozen=True)
class SubtitleTranscript:
    text: str
    language: str
    segments: tuple[TranscriptSegment, ...]


def find_subtitle_transcript(download_dir: Path) -> SubtitleTranscript | None:
    for subtitle_path, language in _candidate_subtitle_files(download_dir):
        transcript = _parse_subtitle_file(subtitle_path, language)
        if transcript is not None:
            return transcript
    return None


def _candidate_subtitle_files(download_dir: Path) -> list[tuple[Path, str]]:
    try:
        files = [
            path
            for path in download_dir.iterdir()
            if path.is_file() and path.suffix.lower() in SUPPORTED_SUBTITLE_SUFFIXES
        ]
    except OSError:
        return []
    candidates: list[tuple[int, str, Path]] = []
    for path in files:
        language = _subtitle_language(path)
        try:
            rank = PREFERRED_SUBTITLE_LANGUAGES.index(language)
        except ValueError:
            rank = len(PREFERRED_SUBTITLE_LANGUAGES)
        candidates.append((rank, path.name.lower(), path))
    return [(path, _subtitle_language(path)) for _, _, path in sorted(candidates)]


def _subtitle_language(path: Path) -> str:
    parts = path.name.split(".")
    if len(parts) >= 3:
        return parts[-2]
    return "unknown"


def _parse_subtitle_file(path: Path, language: str) -> SubtitleTranscript | None:
    try:
        content = path.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return None
    blocks = re.split(r"\n\s*\n", content.replace("\r\n", "\n").replace("\r", "\n"))
    raw_segments: list[TranscriptSegment] = []
    for block in blocks:
        parsed = _parse_subtitle_block(block)
        if parsed is not None:
            raw_segments.append(parsed)

    segments = _dedupe_rolling_segments(raw_segments)
    if not segments:
        return None

    text = "\n".join(segment.text for segment in segments).strip()
    if not text:
        return None
    return SubtitleTranscript(text=text, language=language, segments=tuple(segments))


def _parse_subtitle_block(block: str) -> TranscriptSegment | None:
    lines = [line.strip() for line in block.splitlines() if line.strip()]
    if not lines:
        return None
    if lines[0] == "WEBVTT" or lines[0].startswith(("NOTE", "STYLE", "REGION")):
        return None

    timestamp_index = next(
        (index for index, line in enumerate(lines) if TIMESTAMP_PATTERN.search(line)),
        None,
    )
    if timestamp_index is None:
        return None

    timestamp_match = TIMESTAMP_PATTERN.search(lines[timestamp_index])
    if timestamp_match is None:
        return None

    start_ms = _parse_timestamp_ms(timestamp_match.group("start"))
    end_ms = _parse_timestamp_ms(timestamp_match.group("end"))
    if start_ms is None or end_ms is None or end_ms <= start_ms:
        return None

    cue_text = _clean_subtitle_text(" ".join(lines[timestamp_index + 1 :]))
    if not cue_text:
        return None
    return TranscriptSegment(id="", start_ms=start_ms, end_ms=end_ms, text=cue_text)


def _parse_timestamp_ms(value: str) -> int | None:
    normalized = value.replace(",", ".")
    parts = normalized.split(":")
    if len(parts) == 2:
        hours = 0
        minutes_text, seconds_text = parts
    elif len(parts) == 3:
        hours_text, minutes_text, seconds_text = parts
        hours = int(hours_text)
    else:
        return None
    seconds_parts = seconds_text.split(".")
    if len(seconds_parts) != 2:
        return None
    minutes = int(minutes_text)
    seconds = int(seconds_parts[0])
    millis = int(seconds_parts[1].ljust(3, "0")[:3])
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis


def _clean_subtitle_text(value: str) -> str:
    without_inline_timestamps = INLINE_TIMESTAMP_TAG_PATTERN.sub("", value)
    without_tags = TAG_PATTERN.sub("", without_inline_timestamps)
    unescaped = html.unescape(without_tags)
    return re.sub(r"\s+", " ", unescaped).strip()


def _dedupe_rolling_segments(
    raw_segments: list[TranscriptSegment],
) -> list[TranscriptSegment]:
    deduped: list[TranscriptSegment] = []
    for segment in raw_segments:
        if not deduped:
            deduped.append(segment)
            continue
        previous = deduped[-1]
        if segment.text == previous.text:
            continue
        if segment.text.startswith(previous.text):
            deduped[-1] = segment
            continue
        deduped.append(segment)

    return [
        TranscriptSegment(
            id=f"subtitle-{index}",
            start_ms=segment.start_ms,
            end_ms=segment.end_ms,
            text=segment.text,
        )
        for index, segment in enumerate(deduped, start=1)
    ]
