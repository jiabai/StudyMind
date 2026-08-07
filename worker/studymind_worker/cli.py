from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable, Sequence
from contextlib import redirect_stdout
from io import TextIOBase
from pathlib import Path

from studymind_worker import worker_service as worker_service_module
from studymind_worker.desktop_contract import (
    MODEL_DOWNLOAD_EVENT_PREFIX,
    PROGRESS_EVENT_PREFIX,
)
from studymind_worker.progress_events import (
    validate_model_progress_event,
    validate_worker_progress_event,
)

MAX_STDIN_REQUEST_BYTES = 1024 * 1024


class StdinRequestError(ValueError):
    pass


def read_stdin_request(stream: TextIOBase) -> str:
    reader = getattr(stream, "buffer", stream)
    raw = reader.read(MAX_STDIN_REQUEST_BYTES + 1)
    if isinstance(raw, bytes):
        if len(raw) > MAX_STDIN_REQUEST_BYTES:
            raise StdinRequestError
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise StdinRequestError from exc
    else:
        if len(raw.encode("utf-8")) > MAX_STDIN_REQUEST_BYTES:
            raise StdinRequestError
        text = raw
    if not text.strip():
        raise StdinRequestError
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise StdinRequestError from exc
    if not isinstance(payload, dict):
        raise StdinRequestError
    return json.dumps(payload, ensure_ascii=True)


def stdin_failure_result(mode: str) -> dict[str, object]:
    if mode == "resolve_source_identity":
        return {
            "status": "failed",
            "error": {"code": "WORKER_STDIN_INVALID"},
        }
    stage = "insights_generating" if mode == "retry_insights" else "waiting_input"
    return {
        "status": "failed",
        "task_id": None,
        "task_dir": None,
        "artifacts": {},
        "text": "",
        "summary": "",
        "insights": [],
        "transcript": None,
        "error": {
            "code": "WORKER_STDIN_INVALID",
            "message": "Worker request stdin was invalid.",
            "stage": stage,
        },
    }


def render_result_json(result: dict[str, object]) -> str:
    return json.dumps(result, ensure_ascii=True)


def render_progress_event(event: dict[str, object]) -> str:
    validated = validate_worker_progress_event(event)
    return f"{PROGRESS_EVENT_PREFIX}{json.dumps(validated, ensure_ascii=True)}"


def render_model_download_event(event: dict[str, object]) -> str:
    validated = validate_model_progress_event(event)
    return f"{MODEL_DOWNLOAD_EVENT_PREFIX}{json.dumps(validated, ensure_ascii=True)}"


def print_progress_event(event: dict[str, object]) -> None:
    print(render_progress_event(event), file=sys.stderr, flush=True)


def print_model_download_event(event: dict[str, object]) -> None:
    print(render_model_download_event(event), file=sys.stderr, flush=True)


def run_worker_business(call: Callable[[], dict[str, object]]) -> dict[str, object]:
    with redirect_stdout(sys.stderr):
        return call()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run one StudyMind worker request.")
    request_group = parser.add_mutually_exclusive_group(required=True)
    request_group.add_argument(
        "--request-stdin",
        action="store_true",
        help="Read one ProcessRequest JSON object from stdin.",
    )
    request_group.add_argument(
        "--retry-insights-stdin",
        action="store_true",
        help="Read one RetryInsightsRequest JSON object from stdin.",
    )
    request_group.add_argument(
        "--process-local-media-stdin",
        action="store_true",
        help="Read one ProcessLocalMediaRequest JSON object from stdin.",
    )
    request_group.add_argument(
        "--download-asr-model",
        action="store_true",
        help="Download the release ASR model cache into STUDYMIND_MODEL_DIR.",
    )
    parser.add_argument(
        "--asr-model",
        help="Allowlisted ASR model ID required with --download-asr-model.",
    )
    request_group.add_argument(
        "--resolve-source-stdin",
        action="store_true",
        help="Read one source-identity request JSON object from stdin.",
    )
    args = parser.parse_args(argv)

    if args.asr_model is not None and not args.download_asr_model:
        parser.error("--asr-model is only valid with --download-asr-model")
    if args.download_asr_model and args.asr_model is None:
        parser.error("--download-asr-model requires --asr-model")

    is_model_download = args.download_asr_model
    stdin_mode = next(
        (
            mode
            for enabled, mode in [
                (args.request_stdin, "process_video"),
                (args.process_local_media_stdin, "process_local_media"),
                (args.retry_insights_stdin, "retry_insights"),
                (args.resolve_source_stdin, "resolve_source_identity"),
            ]
            if enabled
        ),
        None,
    )
    request_json: str | None = None
    if stdin_mode is not None:
        try:
            request_json = read_stdin_request(sys.stdin)
        except (OSError, StdinRequestError):
            print(render_result_json(stdin_failure_result(stdin_mode)))
            return 1
    if is_model_download:
        result = run_worker_business(
            lambda: worker_service_module.run_asr_model_download_once(
                project_root=Path.cwd(),
                asr_model=args.asr_model,
                progress_callback=print_model_download_event,
            )
        )
    elif args.process_local_media_stdin:
        result = run_worker_business(
            lambda: worker_service_module.run_local_media_once(
                request_json or "{}",
                project_root=Path.cwd(),
                progress_callback=print_progress_event,
            )
        )
    elif args.retry_insights_stdin:
        result = run_worker_business(
            lambda: worker_service_module.retry_insights_once(
                request_json or "{}",
                project_root=Path.cwd(),
                progress_callback=print_progress_event,
            )
        )
    elif args.resolve_source_stdin:
        result = run_worker_business(
            lambda: worker_service_module.resolve_source_identity_once(
                request_json or "{}"
            )
        )
    else:
        result = run_worker_business(
            lambda: worker_service_module.run_worker_once(
                request_json or "{}",
                project_root=Path.cwd(),
                progress_callback=print_progress_event,
            )
        )
    print(render_result_json(result))
    return 1 if is_model_download and result.get("status") == "failed" else 0
