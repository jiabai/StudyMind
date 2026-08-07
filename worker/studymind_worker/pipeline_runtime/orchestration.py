from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from studymind_worker.desktop_contract import ProgressCallback
from studymind_worker.media import CommandRunner
from studymind_worker.media_preparation import (
    LocalMediaSource,
    MediaPreparationError,
    MediaPreparationFacade,
)
from studymind_worker.models import (
    JobStage,
    ProcessLocalMediaRequest,
    ProcessResult,
    TranscriptMetadata,
)
from studymind_worker.pipeline_runtime.shared import (
    Transcriber,
    TranscriberFactory,
    failed_result,
    resolve_cache_dir,
    resolve_output_dir,
)
from studymind_worker.pipeline_runtime.transcript import (
    run_asr_transcript_stage,
    write_prepared_subtitle_stage,
)
from studymind_worker.task_store import TaskContext, TaskStoreFacade


@dataclass(frozen=True)
class LocalPipelineContext:
    task_context: TaskContext
    task_store: TaskStoreFacade


def prepare_local_pipeline_context(
    request: ProcessLocalMediaRequest,
    project_root: Path,
    environ: dict[str, str],
) -> LocalPipelineContext:
    output_dir = resolve_output_dir(project_root, environ)
    cache_dir = resolve_cache_dir(project_root, environ)
    task_store = TaskStoreFacade(output_root=output_dir, cache_root=cache_dir)
    task_context = task_store.create_local(request)
    return LocalPipelineContext(
        task_context=task_context,
        task_store=task_store,
    )


def complete_transcript_stage(
    task_store: TaskStoreFacade,
    task_context: TaskContext,
    transcript_text: str,
    transcript: TranscriptMetadata | None,
) -> ProcessResult:
    return task_store.finalize(
        task_context,
        ProcessResult(
            status=JobStage.COMPLETED,
            text=transcript_text,
            transcript=transcript,
        ),
    )


def run_local_media_pipeline(
    request: ProcessLocalMediaRequest,
    project_root: Path,
    command_runner: CommandRunner,
    transcriber: Transcriber | None,
    allow_real_asr: bool,
    environ: dict[str, str],
    progress_callback: ProgressCallback | None = None,
    transcriber_factory: TranscriberFactory | None = None,
) -> ProcessResult:
    try:
        pipeline_context = prepare_local_pipeline_context(
            request,
            project_root,
            environ,
        )
    except (OSError, ValueError):
        return failed_result(
            code="TASK_STORAGE_UNAVAILABLE",
            message="Task storage could not be prepared.",
            stage=JobStage.VIDEO_EXTRACTING,
        )
    task_context = pipeline_context.task_context
    try:
        prepared_media = MediaPreparationFacade(
            command_runner=command_runner,
            progress_callback=progress_callback,
        ).prepare(
            LocalMediaSource(request),
            task_context,
        )
    except MediaPreparationError as exc:
        return pipeline_context.task_store.finalize(
            task_context,
            failed_result(
                code=exc.code,
                message=str(exc),
                stage=exc.stage,
            ),
        )

    subtitle_result = write_prepared_subtitle_stage(
        subtitle_candidate=prepared_media.subtitle_candidate,
        task_context=task_context,
        progress_callback=progress_callback,
    )
    if subtitle_result is not None:
        if subtitle_result.status == JobStage.FAILED:
            return pipeline_context.task_store.finalize(task_context, subtitle_result)
        return complete_transcript_stage(
            task_store=pipeline_context.task_store,
            task_context=task_context,
            transcript_text=subtitle_result.text,
            transcript=subtitle_result.transcript,
        )

    transcript_result = run_asr_transcript_stage(
        request=request,
        project_root=project_root,
        audio_path=prepared_media.audio_path,
        transcriber=transcriber,
        transcriber_factory=transcriber_factory,
        allow_real_asr=allow_real_asr,
        environ=environ,
        task_context=task_context,
        progress_callback=progress_callback,
    )
    if transcript_result.status == JobStage.FAILED:
        return pipeline_context.task_store.finalize(task_context, transcript_result)

    return complete_transcript_stage(
        task_store=pipeline_context.task_store,
        task_context=task_context,
        transcript_text=transcript_result.text,
        transcript=transcript_result.transcript,
    )


# Keep run_worker_pipeline as an alias for local-only operation
run_worker_pipeline = run_local_media_pipeline
