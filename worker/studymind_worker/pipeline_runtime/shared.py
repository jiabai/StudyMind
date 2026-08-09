from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from studymind_worker.asr_runtime.types import Transcriber
from studymind_worker.desktop_contract import CACHE_DIR_ENV, OUTPUT_DIR_ENV, ProgressCallback
from studymind_worker.models import JobStage, ProcessResult, WorkerError
from studymind_worker.progress_events import build_worker_progress_event

TranscriberFactory = Callable[[str, Path], Transcriber]


def resolve_output_dir(project_root: Path, environ: dict[str, str] | None = None) -> Path:
    env = environ if environ is not None else {}
    configured_path = env.get(OUTPUT_DIR_ENV, "").strip()
    if not configured_path:
        return project_root / "outputs"

    output_dir = Path(configured_path)
    if output_dir.is_absolute():
        return output_dir
    return project_root / output_dir


def resolve_cache_dir(project_root: Path, environ: dict[str, str] | None = None) -> Path:
    env = environ if environ is not None else {}
    configured_path = env.get(CACHE_DIR_ENV, "").strip()
    if not configured_path:
        return project_root / "cache"

    cache_dir = Path(configured_path)
    if cache_dir.is_absolute():
        return cache_dir
    return project_root / cache_dir


def failed_result(
    code: str,
    message: str,
    stage: JobStage,
) -> ProcessResult:
    return ProcessResult(
        status=JobStage.FAILED,
        error=WorkerError(
            code=code,
            message=message,
            stage=stage,
        ),
    )


def emit_progress(
    callback: ProgressCallback | None,
    stage: JobStage,
    message_code: str,
    progress: int,
    message_args: dict[str, str | int] | None = None,
) -> None:
    event = build_worker_progress_event(
        message_code,
        stage=stage.value,
        progress=progress,
        message_args=message_args,
    )
    if callback is None:
        return
    callback(event)
