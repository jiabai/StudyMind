from __future__ import annotations

import json
import os
import re
import secrets
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from studymind_worker.atomic_files import atomic_write_text
from studymind_worker.desktop_contract import AUDIO_EXTENSIONS, VIDEO_EXTENSIONS
from studymind_worker.models import (
    LocalMediaKind,
    PreferenceSnapshot,
    ProcessLocalMediaRequest,
    ProcessResult,
    TranscriptMetadata,
)
from studymind_worker.task_transaction import (
    TaskArtifactCommitError,
    commit_task_artifacts,
    recover_task_artifacts,
)

TASK_MANIFEST_FILE_NAME = "StudyMind-task.json"
TASK_SCHEMA_VERSION = 4
_LOCAL_TASK_RANDOM_ID_PATTERN = re.compile(r"^[a-z0-9]{6,32}$")


@dataclass(frozen=True)
class TaskPaths:
    output_root: Path
    cache_root: Path
    task_id: str

    @property
    def task_dir(self) -> Path:
        return self.output_root / "tasks" / self.task_id

    @property
    def cache_task_dir(self) -> Path:
        return self.cache_root / "tasks" / self.task_id

    @property
    def download_dir(self) -> Path:
        return self.cache_task_dir / "download"

    @property
    def media_dir(self) -> Path:
        return self.task_dir / "media"

    @property
    def transcript_dir(self) -> Path:
        return self.task_dir / "transcript"

    @property
    def transcript_original_dir(self) -> Path:
        return self.transcript_dir / "original"

    @property
    def ai_dir(self) -> Path:
        return self.task_dir / "ai"

    @property
    def manifest_path(self) -> Path:
        return self.task_dir / TASK_MANIFEST_FILE_NAME

    @property
    def video_path(self) -> Path:
        return self.video_path_for_extension("mp4")

    def video_path_for_extension(self, extension: str) -> Path:
        if extension not in VIDEO_EXTENSIONS:
            raise ValueError("Task video extension is unsupported.")
        return self.media_dir / f"video.{extension}"

    @property
    def audio_path(self) -> Path:
        return self.media_dir / "audio.wav"

    @property
    def transcript_txt_path(self) -> Path:
        return self.transcript_dir / "transcript.txt"

    @property
    def transcript_md_path(self) -> Path:
        return self.transcript_dir / "transcript.md"

    @property
    def segments_path(self) -> Path:
        return self.transcript_dir / "segments.json"

    @property
    def summary_path(self) -> Path:
        return self.ai_dir / "summary.md"

    @property
    def mindmap_path(self) -> Path:
        return self.ai_dir / "mindmap.mmd"

    @property
    def insights_json_path(self) -> Path:
        return self.ai_dir / "insights.json"

    @property
    def insights_md_path(self) -> Path:
        return self.ai_dir / "insights.md"

    @property
    def preference_snapshot_path(self) -> Path:
        return self.ai_dir / "preference-snapshot.json"

    @property
    def dissection_json(self) -> Path:
        return self.ai_dir / "dissection.json"

    @property
    def dissection_markdown(self) -> Path:
        return self.ai_dir / "dissection.md"


@dataclass(frozen=True)
class LocalFileTaskSource:
    display_name: str = field(repr=False)
    media_kind: LocalMediaKind
    extension: str

    def __post_init__(self) -> None:
        if not _is_valid_local_source(
            self.display_name,
            self.media_kind,
            self.extension,
        ):
            raise ValueError("Local task source is invalid.")


TaskSource = LocalFileTaskSource


@dataclass(frozen=True)
class TaskContext:
    paths: TaskPaths
    source: TaskSource
    model: str
    created_at: str
    worker_version: str = "app"
    app_version: str = "app"

    @property
    def task_id(self) -> str:
        return self.paths.task_id


@dataclass(frozen=True)
class OpenedTask:
    context: TaskContext
    transcript: TranscriptMetadata | None


@dataclass(frozen=True)
class TaskStoreFacade:
    output_root: Path
    cache_root: Path

    def create_local(
        self,
        request: ProcessLocalMediaRequest,
        now: datetime | None = None,
        random_id: str | None = None,
    ) -> TaskContext:
        context = create_local_task_context(
            request,
            output_root=self.output_root,
            cache_root=self.cache_root,
            now=now,
            random_id=random_id,
        )
        ensure_task_dirs(context.paths)
        return context

    def open(self, task_id: str) -> OpenedTask:
        manifest = load_task_manifest(self.output_root, task_id)
        context = task_context_from_loaded_manifest(
            self.output_root,
            self.cache_root,
            task_id,
            manifest,
        )
        ensure_task_dirs(context.paths)
        return OpenedTask(
            context=context,
            transcript=transcript_metadata_from_manifest(manifest),
        )

    def finalize(self, context: TaskContext, result: ProcessResult) -> ProcessResult:
        recover_task_artifacts(context.paths.task_dir)
        artifact_payloads = result.artifact_payloads
        artifacts = (
            _artifacts_after_payloads(context, artifact_payloads)
            if artifact_payloads
            else task_artifacts_for_existing_files(context.paths, context.source)
        )
        task_result = result_with_task(
            result,
            context,
            artifacts=artifacts,
        )
        if artifact_payloads:
            commit_task_artifacts(
                context.paths.task_dir,
                {
                    **artifact_payloads,
                    TASK_MANIFEST_FILE_NAME: serialize_task_manifest(
                        context,
                        task_result,
                    ),
                },
            )
        else:
            write_task_manifest(context, task_result)
        return task_result

    def save_preference_snapshot(
        self,
        context: TaskContext,
        snapshot: PreferenceSnapshot,
    ) -> None:
        recover_task_artifacts(context.paths.task_dir)
        write_preference_snapshot_artifact(context.paths, snapshot)


def create_local_task_context(
    request: ProcessLocalMediaRequest,
    output_root: Path,
    cache_root: Path,
    now: datetime | None = None,
    random_id: str | None = None,
) -> TaskContext:
    created = (now or datetime.now(UTC)).astimezone(UTC)
    source = LocalFileTaskSource(
        display_name=request.safe_display_name,
        media_kind=request.media_kind,
        extension=request.source_extension,
    )
    safe_random_id = random_id or secrets.token_hex(8)
    if _LOCAL_TASK_RANDOM_ID_PATTERN.fullmatch(safe_random_id) is None:
        raise ValueError("Local task random id is invalid.")
    timestamp = created.strftime("%Y%m%d-%H%M%S")
    task_id = f"{timestamp}-local-{safe_random_id}"
    return TaskContext(
        paths=TaskPaths(
            output_root=output_root,
            cache_root=cache_root,
            task_id=task_id,
        ),
        source=source,
        model=request.asr_model,
        created_at=created.isoformat(timespec="seconds").replace("+00:00", "Z"),
    )


def ensure_task_dirs(paths: TaskPaths) -> None:
    for directory in [
        paths.media_dir,
        paths.transcript_dir,
        paths.ai_dir,
        paths.download_dir,
    ]:
        directory.mkdir(parents=True, exist_ok=True)


def task_artifacts_for_existing_files(
    paths: TaskPaths,
    source: TaskSource | None = None,
) -> dict[str, str]:
    video_path = (
        paths.video_path_for_extension(source.extension)
        if isinstance(source, LocalFileTaskSource) and source.media_kind == "video"
        else paths.video_path
    )
    candidates = {
        "video": video_path,
        "audio": paths.audio_path,
        "transcript_txt": paths.transcript_txt_path,
        "transcript_md": paths.transcript_md_path,
        "segments": paths.segments_path,
        "summary": paths.summary_path,
        "mindmap": paths.mindmap_path,
        "insights": paths.insights_json_path,
        "insights_md": paths.insights_md_path,
        "preference_snapshot": paths.preference_snapshot_path,
        "dissection": paths.dissection_json,
        "dissection_md": paths.dissection_markdown,
    }
    return {
        key: path.relative_to(paths.task_dir).as_posix()
        for key, path in candidates.items()
        if _is_committed_regular_file(path)
    }


def _is_committed_regular_file(path: Path) -> bool:
    try:
        return path.is_file() and not _is_link_or_junction(path)
    except OSError:
        return False


def result_with_task(
    result: ProcessResult,
    context: TaskContext,
    artifacts: dict[str, str] | None = None,
) -> ProcessResult:
    return ProcessResult(
        status=result.status,
        task_id=context.task_id,
        task_dir=context.paths.task_dir.as_posix(),
        artifacts=(
            artifacts
            if artifacts is not None
            else task_artifacts_for_existing_files(context.paths, context.source)
        ),
        text=result.text,
        summary=result.summary,
        insights=result.insights,
        transcript=result.transcript,
        dissection=result.dissection,
        error=result.error,
        artifact_payloads=result.artifact_payloads,
    )


def write_task_manifest(context: TaskContext, result: ProcessResult) -> None:
    atomic_write_text(
        context.paths.manifest_path,
        serialize_task_manifest(context, result).decode("utf-8"),
    )


def serialize_task_manifest(context: TaskContext, result: ProcessResult) -> bytes:
    context.paths.task_dir.mkdir(parents=True, exist_ok=True)
    source_fields = _manifest_source_fields(context.source)
    payload = {
        "schema_version": TASK_SCHEMA_VERSION,
        "task_id": context.task_id,
        "created_at": context.created_at,
        "updated_at": datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
        **source_fields,
        "status": result.status.value,
        "app_version": context.app_version,
        "worker_version": context.worker_version,
        "model": context.model,
        "transcript": result.transcript.to_dict() if result.transcript else None,
        "artifacts": result.artifacts,
        "error": result.error.to_dict() if result.error else None,
        "text_preview": result.text.strip()[:180],
        "insights_count": len(result.insights),
    }
    return (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def write_preference_snapshot_artifact(
    paths: TaskPaths,
    snapshot: PreferenceSnapshot,
) -> None:
    paths.ai_dir.mkdir(parents=True, exist_ok=True)
    atomic_write_text(
        paths.preference_snapshot_path,
        json.dumps(snapshot.to_dict(), ensure_ascii=False, indent=2) + "\n",
    )


def load_task_manifest(output_root: Path, task_id: str) -> dict[str, object]:
    manifest_path = _validated_task_manifest_path(output_root, task_id)
    recover_task_artifacts(manifest_path.parent)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema_version") != TASK_SCHEMA_VERSION:
        raise ValueError("Task is unavailable in the current history format.")
    try:
        _task_source_from_manifest(manifest)
    except ValueError:
        raise ValueError("Task is unavailable in the current history format.") from None
    return manifest


def _validated_task_manifest_path(output_root: Path, task_id: str) -> Path:
    task_id_path = Path(task_id)
    if (
        task_id_path.is_absolute()
        or len(task_id_path.parts) != 1
        or task_id_path.name != task_id
        or task_id in {"", ".", ".."}
    ):
        raise ValueError("Task id must be a single directory name.")

    tasks_root = (output_root / "tasks").resolve()
    task_dir = output_root / "tasks" / task_id
    manifest_path = task_dir / TASK_MANIFEST_FILE_NAME
    if (
        _is_link_or_junction(task_dir)
        or _is_link_or_junction(manifest_path)
        or not task_dir.is_dir()
        or not manifest_path.is_file()
    ):
        raise ValueError("Task storage is unavailable or linked.")
    try:
        if not task_dir.resolve().is_relative_to(tasks_root):
            raise ValueError("Task storage is outside the configured output root.")
    except OSError as exc:
        raise ValueError("Task storage could not be resolved.") from exc
    return manifest_path


def _is_link_or_junction(path: Path) -> bool:
    is_junction = getattr(os.path, "isjunction", lambda _path: False)
    return path.is_symlink() or bool(is_junction(path))


_ARTIFACT_KEY_BY_RELATIVE_PATH = {
    "transcript/transcript.txt": "transcript_txt",
    "transcript/transcript.md": "transcript_md",
    "transcript/segments.json": "segments",
    "ai/summary.md": "summary",
    "ai/mindmap.mmd": "mindmap",
    "ai/insights.json": "insights",
    "ai/insights.md": "insights_md",
    "ai/dissection.json": "dissection",
    "ai/dissection.md": "dissection_md",
}


def _artifacts_after_payloads(
    context: TaskContext,
    payloads: Mapping[str, bytes | None],
) -> dict[str, str]:
    artifacts = task_artifacts_for_existing_files(context.paths, context.source)
    for relative_path, content in payloads.items():
        artifact_key = _ARTIFACT_KEY_BY_RELATIVE_PATH.get(relative_path)
        if artifact_key is None:
            raise TaskArtifactCommitError() from None
        if content is None:
            artifacts.pop(artifact_key, None)
        else:
            artifacts[artifact_key] = relative_path
    return artifacts


def task_context_from_manifest(output_root: Path, cache_root: Path, task_id: str) -> TaskContext:
    manifest = load_task_manifest(output_root, task_id)
    return task_context_from_loaded_manifest(
        output_root,
        cache_root,
        task_id,
        manifest,
    )


def task_context_from_loaded_manifest(
    output_root: Path,
    cache_root: Path,
    task_id: str,
    manifest: dict[str, object],
) -> TaskContext:
    source = _task_source_from_manifest(manifest)
    model = str(manifest.get("model") or "iic/SenseVoiceSmall")
    created_at = str(
        manifest.get("created_at")
        or datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
    )
    return TaskContext(
        paths=TaskPaths(output_root=output_root, cache_root=cache_root, task_id=task_id),
        source=source,
        model=model,
        created_at=created_at,
        app_version=str(manifest.get("app_version") or "app"),
        worker_version=str(manifest.get("worker_version") or "app"),
    )


def _manifest_source_fields(source: TaskSource) -> dict[str, object]:
    return {
        "source_kind": "local_file",
        "local_source": {
            "display_name": source.display_name,
            "media_kind": source.media_kind,
            "extension": source.extension,
        },
        "platform": "local",
    }


def _task_source_from_manifest(manifest: Mapping[str, object]) -> TaskSource:
    source_kind = manifest.get("source_kind")
    if source_kind != "local_file":
        raise ValueError("Task source kind is unsupported.")
    raw_local_source = manifest.get("local_source")
    if not isinstance(raw_local_source, dict) or set(raw_local_source) != {
        "display_name",
        "media_kind",
        "extension",
    }:
        raise ValueError("Local task source is unavailable or invalid.")
    display_name = raw_local_source.get("display_name")
    media_kind = raw_local_source.get("media_kind")
    extension = raw_local_source.get("extension")
    if (
        not isinstance(display_name, str)
        or media_kind not in {"video", "audio"}
        or not isinstance(extension, str)
    ):
        raise ValueError("Local task source is unavailable or invalid.")
    return LocalFileTaskSource(
        display_name=display_name,
        media_kind=media_kind,
        extension=extension,
    )


def _is_valid_local_source(
    display_name: str,
    media_kind: LocalMediaKind,
    extension: str,
) -> bool:
    allowed_extensions = VIDEO_EXTENSIONS if media_kind == "video" else AUDIO_EXTENSIONS
    return (
        media_kind in {"video", "audio"}
        and extension in allowed_extensions
        and bool(display_name.strip())
        and display_name not in {".", ".."}
        and len(display_name) <= 160
        and display_name.lower().endswith(f".{extension}")
        and not any(_is_unsafe_basename_character(value) for value in display_name)
    )


def _is_unsafe_basename_character(value: str) -> bool:
    codepoint = ord(value)
    return (
        value in {"/", "\\"}
        or unicodedata.category(value) == "Cc"
        or codepoint in {0x061C, 0x200E, 0x200F}
        or 0x202A <= codepoint <= 0x202E
        or 0x2066 <= codepoint <= 0x2069
    )


def transcript_metadata_from_manifest(
    manifest: dict[str, object],
) -> TranscriptMetadata | None:
    raw_transcript = manifest.get("transcript")
    if not isinstance(raw_transcript, dict):
        return None
    source = raw_transcript.get("source")
    if source not in {"asr", "subtitle"}:
        return None
    language = raw_transcript.get("language")
    engine = raw_transcript.get("engine")
    return TranscriptMetadata(
        source=source,
        language=language if isinstance(language, str) else None,
        engine=engine if isinstance(engine, str) else None,
    )
