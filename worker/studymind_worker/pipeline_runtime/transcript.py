from __future__ import annotations

from pathlib import Path

from studymind_worker.asr import (
    DEFAULT_ASR_MODEL,
    ASRError,
    QwenAsrTranscriber,
    Transcriber,
    build_asr_transcriber,
    resolve_model_cache_dir,
    transcribe_and_write,
    write_transcript_files,
)
from studymind_worker.atomic_files import AtomicFileCommitError
from studymind_worker.desktop_contract import ProgressCallback
from studymind_worker.model_download import (
    normalize_asr_model_cache_layout,
    validate_asr_model_cache,
)
from studymind_worker.models import (
    JobStage,
    ProcessLocalMediaRequest,
    ProcessRequest,
    ProcessResult,
    TranscriptMetadata,
    WorkerError,
)
from studymind_worker.pipeline_runtime.shared import (
    TranscriberFactory,
    emit_progress,
    failed_result,
)
from studymind_worker.progress_events import normalize_language_tag, normalize_model_arg
from studymind_worker.source_identity import SourceIdentity
from studymind_worker.subtitles import SubtitleTranscript
from studymind_worker.task_store import TaskContext


def run_asr_transcript_step(
    audio_path: Path,
    output_dir: Path,
    output_stem: str,
    transcriber: Transcriber | None = None,
    model: str = DEFAULT_ASR_MODEL,
    source_identity: SourceIdentity | None = None,
) -> ProcessResult:
    asr = transcriber or QwenAsrTranscriber(model_name=model)

    try:
        artifacts = transcribe_and_write(
            audio_path=audio_path,
            output_dir=output_dir,
            output_stem=output_stem,
            transcriber=asr,
            model=model,
            source_identity=source_identity,
        )
    except ASRError as exc:
        return ProcessResult(
            status=JobStage.FAILED,
            error=WorkerError(
                code=exc.code,
                message=str(exc),
                stage=JobStage.VIDEO_TRANSCRIBING,
            ),
        )
    except AtomicFileCommitError:
        return _artifact_storage_failure()

    return ProcessResult(
        status=JobStage.VIDEO_TRANSCRIBING,
        artifacts={
            "transcript_txt": artifacts.txt_path.relative_to(output_dir).as_posix(),
            "transcript_md": artifacts.md_path.relative_to(output_dir).as_posix(),
            **(
                {"segments": artifacts.segments_path.relative_to(output_dir).as_posix()}
                if artifacts.segments_path
                else {}
            ),
        },
        text=artifacts.text,
        transcript=TranscriptMetadata(
            source="asr",
            language=None,
            engine=model,
            source_identity=source_identity,
        ),
    )


def run_prepared_subtitle_transcript_step(
    subtitle: SubtitleTranscript,
    output_dir: Path,
    output_stem: str,
    source_identity: SourceIdentity,
) -> ProcessResult | None:
    metadata = TranscriptMetadata(
        source="subtitle",
        language=subtitle.language,
        engine=None,
        source_identity=source_identity,
    )
    try:
        artifacts = write_transcript_files(
            text=subtitle.text,
            output_dir=output_dir,
            output_stem=output_stem,
            metadata=metadata,
            segments=subtitle.segments,
        )
    except ASRError:
        return None
    except AtomicFileCommitError:
        return _artifact_storage_failure()

    return ProcessResult(
        status=JobStage.VIDEO_TRANSCRIBING,
        artifacts={
            "transcript_txt": artifacts.txt_path.relative_to(output_dir).as_posix(),
            "transcript_md": artifacts.md_path.relative_to(output_dir).as_posix(),
            **(
                {"segments": artifacts.segments_path.relative_to(output_dir).as_posix()}
                if artifacts.segments_path
                else {}
            ),
        },
        text=artifacts.text,
        transcript=metadata,
    )


def write_prepared_subtitle_stage(
    subtitle_candidate: SubtitleTranscript | None,
    task_context: TaskContext,
    progress_callback: ProgressCallback | None,
) -> ProcessResult | None:
    if subtitle_candidate is None:
        return None
    subtitle_result = run_prepared_subtitle_transcript_step(
        subtitle=subtitle_candidate,
        output_dir=task_context.paths.transcript_dir,
        output_stem="",
        source_identity=task_context.source_identity,
    )
    if subtitle_result is not None and subtitle_result.status != JobStage.FAILED:
        emit_progress(
            progress_callback,
            JobStage.VIDEO_TRANSCRIBING,
            "subtitle.detect.found",
            68,
            message_args=_subtitle_language_args(subtitle_result.transcript.language),
        )
    return subtitle_result


def prepare_asr_transcriber_stage(
    request: ProcessRequest | ProcessLocalMediaRequest,
    project_root: Path,
    transcriber: Transcriber | None,
    allow_real_asr: bool,
    environ: dict[str, str],
    progress_callback: ProgressCallback | None,
    transcriber_factory: TranscriberFactory | None = None,
) -> Transcriber | ProcessResult:
    if transcriber is None and not allow_real_asr:
        return failed_result(
            code="ASR_MODEL_NOT_READY",
            message="Real ASR is disabled until model cache handling is configured.",
            stage=JobStage.VIDEO_TRANSCRIBING,
        )

    if transcriber is not None:
        return transcriber

    emit_progress(
        progress_callback,
        JobStage.VIDEO_TRANSCRIBING,
        "asr.cache.preparing",
        58,
        message_args=_asr_model_args(request.asr_model),
    )
    model_cache_dir = resolve_model_cache_dir(project_root=project_root, environ=environ)
    if request.asr_model == "iic/SenseVoiceSmall":
        normalize_asr_model_cache_layout(model_cache_dir)
    if not validate_asr_model_cache(model_cache_dir, model_name=request.asr_model):
        return failed_result(
            code="ASR_MODEL_NOT_DOWNLOADED",
            message=(
                "SenseVoice Small model is not downloaded yet."
                if request.asr_model == "iic/SenseVoiceSmall"
                else "SenseVoiceSmall-ONNX model is not downloaded yet."
            ),
            stage=JobStage.VIDEO_TRANSCRIBING,
        )
    factory = transcriber_factory or build_asr_transcriber
    try:
        return factory(request.asr_model, model_cache_dir)
    except OSError as exc:
        return failed_result(
            code="ASR_MODEL_CACHE_UNAVAILABLE",
            message=f"Model cache directory is not writable: {exc}",
            stage=JobStage.VIDEO_TRANSCRIBING,
        )


def run_asr_transcript_stage(
    request: ProcessRequest | ProcessLocalMediaRequest,
    project_root: Path,
    audio_path: Path,
    transcriber: Transcriber | None,
    allow_real_asr: bool,
    environ: dict[str, str],
    task_context: TaskContext,
    progress_callback: ProgressCallback | None,
    transcriber_factory: TranscriberFactory | None = None,
) -> ProcessResult:
    emit_progress(
        progress_callback,
        JobStage.VIDEO_TRANSCRIBING,
        "asr.transcribe.starting",
        58,
    )
    prepared_transcriber = prepare_asr_transcriber_stage(
        request=request,
        project_root=project_root,
        transcriber=transcriber,
        transcriber_factory=transcriber_factory,
        allow_real_asr=allow_real_asr,
        environ=environ,
        progress_callback=progress_callback,
    )
    if isinstance(prepared_transcriber, ProcessResult):
        return prepared_transcriber

    emit_progress(
        progress_callback,
        JobStage.VIDEO_TRANSCRIBING,
        "asr.transcribe.running",
        68,
    )
    return run_asr_transcript_step(
        audio_path=audio_path,
        output_dir=task_context.paths.transcript_dir,
        output_stem="",
        transcriber=prepared_transcriber,
        model=request.asr_model,
        source_identity=task_context.source_identity,
    )


def _subtitle_language_args(language: object) -> dict[str, str]:
    return {"language": normalize_language_tag(language) or "und"}


def _asr_model_args(model: object) -> dict[str, str] | None:
    # The release desktop currently exposes and bundles only SenseVoice. The Qwen
    # adapter remains a hidden dev/future path, so it deliberately uses generic
    # progress instead of expanding the release progress-model allowlist.
    normalized = normalize_model_arg(model)
    return {"model": normalized} if normalized is not None else None


def _artifact_storage_failure() -> ProcessResult:
    return ProcessResult(
        status=JobStage.FAILED,
        error=WorkerError(
            code="TASK_ARTIFACT_COMMIT_FAILED",
            message="Task artifacts could not be stored safely.",
            stage=JobStage.VIDEO_TRANSCRIBING,
        ),
    )
