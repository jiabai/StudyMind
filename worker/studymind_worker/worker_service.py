from __future__ import annotations

import json
from pathlib import Path

from studymind_worker.atomic_files import AtomicFileCommitError
from studymind_worker.config import load_project_env
from studymind_worker.desktop_contract import ProgressCallback
from studymind_worker.media import CommandRunner, run_command
from studymind_worker.models import JobStage, ProcessResult, WorkerError
from studymind_worker.pipeline import (
    TranscriberFactory,
    failed_result,
    run_worker_pipeline,
)
from studymind_worker.requests import parse_process_request
from studymind_worker.task_transaction import (
    TaskArtifactCommitError,
    TaskArtifactRecoveryError,
)
from studymind_worker.worker_application import defaults


def run_worker_once(
    request_json: str,
    project_root: Path | None = None,
    command_runner: CommandRunner = run_command,
    transcriber: TranscriberFactory | None = None,
    transcriber_factory: TranscriberFactory | None = None,
    allow_real_asr: bool | None = None,
    environ: dict[str, str] | None = None,
    progress_callback: ProgressCallback | None = None,
) -> dict[str, object]:
    root = project_root or Path.cwd()
    try:
        payload = json.loads(request_json)
    except json.JSONDecodeError:
        return ProcessResult(
            status=JobStage.FAILED,
            error=WorkerError(
                code="INVALID_REQUEST_JSON",
                message="Request payload must be valid JSON.",
                stage=JobStage.WAITING_INPUT,
            ),
        ).to_dict()

    try:
        request = parse_process_request(payload)
    except ValueError as exc:
        return failed_result(
            code="INVALID_REQUEST_PAYLOAD",
            message=str(exc),
            stage=JobStage.WAITING_INPUT,
        ).to_dict()

    runtime_env = load_project_env(root, environ)

    try:
        result = run_worker_pipeline(
            request=request,
            project_root=root,
            command_runner=command_runner,
            transcriber=transcriber,
            allow_real_asr=defaults.should_allow_real_asr(runtime_env)
            if allow_real_asr is None
            else allow_real_asr,
            environ=runtime_env,
            transcriber_factory=(
                transcriber_factory or defaults.build_asr_transcriber
            ),
            progress_callback=progress_callback,
        )
    except TaskArtifactRecoveryError:
        result = failed_result(
            code="TASK_ARTIFACT_RECOVERY_FAILED",
            message="Task artifacts could not be recovered safely.",
            stage=JobStage.FAILED,
        )
    except (AtomicFileCommitError, TaskArtifactCommitError):
        result = failed_result(
            code="TASK_ARTIFACT_COMMIT_FAILED",
            message="Task artifacts could not be stored safely.",
            stage=JobStage.FAILED,
        )
    return result.to_dict()
