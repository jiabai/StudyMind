from __future__ import annotations

import re
import urllib.parse
from dataclasses import dataclass
from typing import Literal

SourcePlatform = Literal["douyin", "xiaohongshu", "bilibili", "youtube"]

SOURCE_IDENTITY_VERSION = 1
SOURCE_PRIVACY_MIGRATION_VERSION = 2
URL_PATTERN = re.compile(r"https?://[^\s\"'<>]+", re.IGNORECASE)
URL_TRAILING_PUNCTUATION = " \t\r\n\"'<>[]{}()，。！？；：、.;:!?"
XHS_NOTE_ID_PATTERN = re.compile(r"(?i)^[0-9a-f]{24}$")
BILIBILI_BVID_PATTERN = re.compile(r"(?i)^BV[0-9A-Za-z]{10}$")
BILIBILI_AVID_PATTERN = re.compile(r"(?i)^av(\d{1,20})$")
YOUTUBE_VIDEO_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{11}$")
DOUYIN_AWEME_ID_PATTERN = re.compile(r"^\d{15,24}$")
MAX_BILIBILI_PART_INDEX = 100_000


class SourceIdentityError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class SourceIdentity:
    platform: SourcePlatform
    stable_id: str
    canonical_url: str
    effective_part: int | None = None
    version: int = SOURCE_IDENTITY_VERSION

    @property
    def equality_key(self) -> tuple[str, str, int | None]:
        return (self.platform, self.stable_id, self.effective_part)

    def to_manifest_dict(self) -> dict[str, object]:
        return {
            "version": self.version,
            "platform": self.platform,
            "stable_id": self.stable_id,
            "effective_part": self.effective_part,
            "canonical_url": self.canonical_url,
        }


def identify_source(
    raw_source: str,
    *,
    resolved_url: str | None = None,
) -> SourceIdentity:
    source = raw_source.strip()
    if not source:
        raise SourceIdentityError("Source URL cannot be empty.")

    if resolved_url:
        resolved = _identify_direct_source(resolved_url)
        if resolved is not None:
            return resolved

    direct = _identify_direct_source(source)
    if direct is not None:
        return direct

    raise SourceIdentityError("Source URL does not contain a supported stable video ID.")


def source_identity_from_manifest(value: object) -> SourceIdentity | None:
    if not isinstance(value, dict):
        return None
    version = value.get("version")
    platform = value.get("platform")
    stable_id = value.get("stable_id")
    canonical_url = value.get("canonical_url")
    effective_part = value.get("effective_part")
    if version != SOURCE_IDENTITY_VERSION:
        return None
    if platform not in {"douyin", "xiaohongshu", "bilibili", "youtube"}:
        return None
    if not isinstance(stable_id, str) or not stable_id:
        return None
    if not isinstance(canonical_url, str) or not canonical_url:
        return None
    if effective_part is not None and (
        not isinstance(effective_part, int) or isinstance(effective_part, bool)
    ):
        return None
    try:
        expected = identify_source(canonical_url)
    except SourceIdentityError:
        return None
    identity = SourceIdentity(
        platform=platform,
        stable_id=stable_id,
        effective_part=effective_part,
        canonical_url=canonical_url,
    )
    return identity if identity == expected else None


def canonical_url_for_persistence(identity: SourceIdentity | None) -> str | None:
    if identity is None:
        return None
    validated = source_identity_from_manifest(identity.to_manifest_dict())
    if validated != identity:
        raise SourceIdentityError("Source identity is not safe for persistence.")
    return validated.canonical_url


def _identify_direct_source(raw_source: str) -> SourceIdentity | None:
    normalized = raw_source.strip()
    if XHS_NOTE_ID_PATTERN.fullmatch(normalized):
        return _xiaohongshu_identity(normalized.lower())
    bilibili_direct = _normalize_bilibili_id(normalized)
    if bilibili_direct is not None:
        return _bilibili_identity(bilibili_direct, part_index=1)

    for candidate in extract_url_candidates(normalized):
        try:
            parsed = urllib.parse.urlparse(candidate)
            host = (parsed.hostname or "").lower().rstrip(".")
        except ValueError:
            continue
        if parsed.scheme.lower() not in {"http", "https"}:
            continue
        if _host_matches(host, "xiaohongshu.com"):
            note_id = _find_xhs_note_id(parsed)
            if note_id:
                return _xiaohongshu_identity(note_id)
        if _host_matches(host, "douyin.com") or _host_matches(host, "iesdouyin.com"):
            aweme_id = _find_douyin_aweme_id(parsed)
            if aweme_id:
                return _douyin_identity(aweme_id)
        if _host_matches(host, "bilibili.com"):
            bilibili = _find_bilibili_video(parsed)
            if bilibili is not None:
                video_id, part_index = bilibili
                return _bilibili_identity(video_id, part_index)
        if host in {
            "youtube.com",
            "www.youtube.com",
            "m.youtube.com",
            "youtu.be",
            "www.youtu.be",
        }:
            video_id = _find_youtube_video_id(parsed)
            if video_id:
                return _youtube_identity(video_id)
    return None


def extract_url_candidates(raw_source: str) -> list[str]:
    return [
        match.group(0).rstrip(URL_TRAILING_PUNCTUATION)
        for match in URL_PATTERN.finditer(raw_source)
    ]


def _host_matches(host: str, suffix: str) -> bool:
    return host == suffix or host.endswith(f".{suffix}")


def _find_xhs_note_id(parsed: urllib.parse.ParseResult) -> str | None:
    segments = [segment for segment in parsed.path.split("/") if segment]
    candidate = ""
    if len(segments) == 2 and segments[0].lower() == "explore":
        candidate = segments[1]
    elif len(segments) == 3 and [part.lower() for part in segments[:2]] == [
        "discovery",
        "item",
    ]:
        candidate = segments[2]
    return candidate.lower() if XHS_NOTE_ID_PATTERN.fullmatch(candidate) else None


def _find_douyin_aweme_id(parsed: urllib.parse.ParseResult) -> str | None:
    query = urllib.parse.parse_qs(parsed.query)
    for key in ("modal_id", "aweme_id"):
        value = query.get(key, [""])[0]
        if DOUYIN_AWEME_ID_PATTERN.fullmatch(value):
            return value
    path_match = re.search(r"/(?:video|note|share/slides)/(\d+)(?:/|$)", parsed.path)
    if path_match and DOUYIN_AWEME_ID_PATTERN.fullmatch(path_match.group(1)):
        return path_match.group(1)
    return None


def _find_bilibili_video(parsed: urllib.parse.ParseResult) -> tuple[str, int] | None:
    segments = [segment for segment in parsed.path.split("/") if segment]
    if len(segments) < 2 or segments[0].lower() != "video":
        return None
    video_id = _normalize_bilibili_id(segments[1])
    if video_id is None:
        return None
    raw_part = urllib.parse.parse_qs(parsed.query).get("p", ["1"])[0]
    try:
        part_index = int(raw_part)
    except (TypeError, ValueError):
        part_index = 1
    if not 1 <= part_index <= MAX_BILIBILI_PART_INDEX:
        return None
    return video_id, part_index


def _find_youtube_video_id(parsed: urllib.parse.ParseResult) -> str | None:
    host = (parsed.hostname or "").lower().rstrip(".")
    segments = [segment for segment in parsed.path.split("/") if segment]
    if host in {"youtu.be", "www.youtu.be"}:
        candidate = segments[0] if len(segments) == 1 else ""
    elif parsed.path.rstrip("/") == "/watch":
        candidate = urllib.parse.parse_qs(parsed.query).get("v", [""])[0]
    elif len(segments) == 2 and segments[0].lower() == "shorts":
        candidate = segments[1]
    else:
        candidate = ""
    return candidate if YOUTUBE_VIDEO_ID_PATTERN.fullmatch(candidate) else None


def _normalize_bilibili_id(value: str) -> str | None:
    if BILIBILI_BVID_PATTERN.fullmatch(value):
        return _normalize_bvid(value)
    avid = BILIBILI_AVID_PATTERN.fullmatch(value)
    return f"av{avid.group(1)}" if avid else None


def _normalize_bvid(value: str) -> str:
    return f"BV{value[2:]}"


def _xiaohongshu_identity(note_id: str) -> SourceIdentity:
    normalized = note_id.lower()
    if not XHS_NOTE_ID_PATTERN.fullmatch(normalized):
        raise SourceIdentityError("Invalid Xiaohongshu note ID.")
    return SourceIdentity(
        platform="xiaohongshu",
        stable_id=normalized,
        canonical_url=f"https://www.xiaohongshu.com/explore/{normalized}",
    )


def _douyin_identity(aweme_id: str) -> SourceIdentity:
    if not DOUYIN_AWEME_ID_PATTERN.fullmatch(aweme_id):
        raise SourceIdentityError("Invalid Douyin work ID.")
    return SourceIdentity(
        platform="douyin",
        stable_id=aweme_id,
        canonical_url=f"https://www.douyin.com/video/{aweme_id}",
    )


def _bilibili_identity(video_id: str, part_index: int) -> SourceIdentity:
    normalized_video_id = _normalize_bilibili_id(video_id)
    if normalized_video_id is None:
        raise SourceIdentityError("Invalid Bilibili video ID.")
    if not 1 <= part_index <= MAX_BILIBILI_PART_INDEX:
        raise SourceIdentityError("Invalid Bilibili part index.")
    suffix = f"?p={part_index}" if part_index > 1 else ""
    return SourceIdentity(
        platform="bilibili",
        stable_id=normalized_video_id,
        effective_part=part_index,
        canonical_url=f"https://www.bilibili.com/video/{normalized_video_id}{suffix}",
    )


def _youtube_identity(video_id: str) -> SourceIdentity:
    if not YOUTUBE_VIDEO_ID_PATTERN.fullmatch(video_id):
        raise SourceIdentityError("Invalid YouTube video ID.")
    return SourceIdentity(
        platform="youtube",
        stable_id=video_id,
        canonical_url=f"https://www.youtube.com/watch?v={video_id}",
    )
