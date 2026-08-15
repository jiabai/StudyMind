from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

from studymind_worker.atomic_files import AtomicFileCommitError
from studymind_worker.config import load_project_env
from studymind_worker.desktop_contract import ProgressCallback
from studymind_worker.insightflow import InsightClient
from studymind_worker.insightflow.dissection import (
    DissectionGenerationError,
    parse_persisted_dissection,
)
from studymind_worker.models import (
    Insight,
    JobStage,
    ProcessResult,
    TranscriptMetadata,
    WorkerError,
)
from studymind_worker.pipeline_runtime.insights import run_insight_generation_step
from studymind_worker.pipeline_runtime.shared import resolve_cache_dir, resolve_output_dir
from studymind_worker.requests import (
    INVALID_RETRY_PAYLOAD_MESSAGE,
    parse_retry_insights_request,
)
from studymind_worker.task_store import TaskPaths, TaskStoreFacade
from studymind_worker.task_transaction import (
    TaskArtifactCommitError,
    TaskArtifactRecoveryError,
)
from studymind_worker.worker_application import defaults

InsightClientFactory = Callable[[dict[str, str]], InsightClient | None]


def retry_insights_once(
    request_json: str,
    project_root: Path | None = None,
    insight_client: InsightClient | None = None,
    insight_client_factory: InsightClientFactory | None = None,
    environ: dict[str, str] | None = None,
    progress_callback: ProgressCallback | None = None,
) -> dict[str, object]:
    try:
        payload = json.loads(request_json)
    except json.JSONDecodeError:
        return ProcessResult(
            status=JobStage.FAILED,
            error=WorkerError(
                code="INVALID_RETRY_JSON",
                message="Retry payload must be valid JSON.",
                stage=JobStage.INSIGHTS_GENERATING,
            ),
        ).to_dict()

    try:
        request = parse_retry_insights_request(payload)
    except (TypeError, ValueError):
        return failed_insight_retry_result(
            code="INVALID_RETRY_PAYLOAD",
            message=INVALID_RETRY_PAYLOAD_MESSAGE,
            text="",
        ).to_dict()

    root = project_root or Path.cwd()
    runtime_env = load_project_env(root, environ)
    configured_insight_client = insight_client or (
        insight_client_factory or defaults.build_insight_client_from_env
    )(runtime_env)
    output_dir = resolve_output_dir(root, runtime_env)
    cache_dir = resolve_cache_dir(root, runtime_env)
    task_store = TaskStoreFacade(output_root=output_dir, cache_root=cache_dir)
    try:
        opened_task = task_store.open(request.task_id)
    except TaskArtifactRecoveryError:
        return failed_insight_retry_result(
            code="TASK_ARTIFACT_RECOVERY_FAILED",
            message="Task artifacts could not be recovered safely.",
            text="",
        ).to_dict()
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return ProcessResult(
            status=JobStage.PARTIAL_COMPLETED,
            error=WorkerError(
                code="TASK_MANIFEST_NOT_FOUND",
                message="A safe task manifest is required to regenerate insights.",
                stage=JobStage.INSIGHTS_GENERATING,
            ),
        ).to_dict()
    task_context = opened_task.context
    if request.target == "insights" and request.preference_snapshot is not None:
        try:
            task_store.save_preference_snapshot(
                task_context,
                request.preference_snapshot,
            )
        except TaskArtifactRecoveryError:
            return failed_insight_retry_result(
                code="TASK_ARTIFACT_RECOVERY_FAILED",
                message="Task artifacts could not be recovered safely.",
                text="",
                transcript=opened_task.transcript,
            ).to_dict()
        except (AtomicFileCommitError, TaskArtifactCommitError):
            return failed_insight_retry_result(
                code="TASK_ARTIFACT_COMMIT_FAILED",
                message="Task artifacts could not be stored safely.",
                text="",
                transcript=opened_task.transcript,
            ).to_dict()

    insight_result = run_insight_generation_step(
        transcript_txt_path=task_context.paths.transcript_txt_path,
        output_dir=task_context.paths.ai_dir,
        output_stem="",
        client=configured_insight_client,
        transcript=opened_task.transcript,
        preference_snapshot=request.preference_snapshot,
        target=request.target,
        output_language=request.output_language,
        persist=False,
        progress_callback=progress_callback,
    )

    merged_result = merge_existing_ai_artifacts(task_context.paths, insight_result)
    try:
        return task_store.finalize(task_context, merged_result).to_dict()
    except TaskArtifactRecoveryError:
        return failed_insight_retry_result(
            code="TASK_ARTIFACT_RECOVERY_FAILED",
            message="Task artifacts could not be recovered safely.",
            text=insight_result.text,
            transcript=opened_task.transcript,
        ).to_dict()
    except (AtomicFileCommitError, TaskArtifactCommitError):
        return failed_insight_retry_result(
            code="TASK_ARTIFACT_COMMIT_FAILED",
            message="Task artifacts could not be stored safely.",
            text=insight_result.text,
            transcript=opened_task.transcript,
        ).to_dict()


def merge_existing_ai_artifacts(
    paths: TaskPaths,
    result: ProcessResult,
) -> ProcessResult:
    summary = result.summary or read_existing_summary(paths)
    insights = result.insights or read_existing_insights(paths)
    dissection = result.dissection or read_existing_dissection(paths)
    return ProcessResult(
        status=result.status,
        artifacts=result.artifacts,
        text=result.text,
        summary=summary,
        insights=insights,
        transcript=result.transcript,
        dissection=dissection,
        error=result.error,
        artifact_payloads=result.artifact_payloads,
    )


def read_existing_summary(paths: TaskPaths) -> str:
    summary_path = paths.summary_path
    if not summary_path.is_file():
        return ""
    return summary_path.read_text(encoding="utf-8").strip()


def read_existing_insights(paths: TaskPaths) -> list[Insight]:
    insights_path = paths.insights_json_path
    if not insights_path.is_file():
        return []
    try:
        payload = json.loads(insights_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(payload, dict) or payload.get("schemaVersion") != 1:
        return []
    raw_insights = payload.get("insights")
    if not isinstance(raw_insights, list):
        return []

    insights: list[Insight] = []
    for raw in raw_insights:
        if not isinstance(raw, dict):
            return []
        try:
            insight_id = int(raw["id"])
            topic = str(raw["topic"]).strip()
            match_reason = str(raw["matchReason"]).strip()
            raw_questions = raw["followUpQuestions"]
            if not isinstance(raw_questions, list):
                return []
            follow_up_questions = tuple(
                question.strip()
                for question in raw_questions
                if isinstance(question, str) and question.strip()
            )
            suitable_use = str(raw["suitableUse"]).strip()
            raw_source_chunk_id = raw.get("sourceChunkId")
            source_chunk_id = int(raw_source_chunk_id) if raw_source_chunk_id is not None else None
        except (KeyError, TypeError, ValueError):
            return []
        if not topic or not match_reason or not follow_up_questions or not suitable_use:
            return []
        insights.append(
            Insight(
                id=insight_id,
                topic=topic,
                match_reason=match_reason,
                follow_up_questions=follow_up_questions,
                suitable_use=suitable_use,
                source_chunk_id=source_chunk_id,
            )
        )
    return insights


def read_existing_dissection(paths: TaskPaths) -> dict[str, object] | None:
    if not paths.dissection_json.is_file() or not paths.transcript_txt_path.is_file():
        return None
    try:
        payload = json.loads(paths.dissection_json.read_text(encoding="utf-8"))
        transcript = paths.transcript_txt_path.read_bytes().decode("utf-8")
        return parse_persisted_dissection(payload, transcript=transcript).to_dict()
    except (OSError, UnicodeError, json.JSONDecodeError, DissectionGenerationError):
        return None


def failed_insight_retry_result(
    code: str,
    message: str,
    text: str,
    transcript: TranscriptMetadata | None = None,
) -> ProcessResult:
    return ProcessResult(
        status=JobStage.PARTIAL_COMPLETED,
        text=text,
        transcript=transcript,
        error=WorkerError(
            code=code,
            message=message,
            stage=JobStage.INSIGHTS_GENERATING,
        ),
    )
