from __future__ import annotations

from pathlib import Path

from studymind_worker.asr import DEFAULT_ASR_MODEL, SENSEVOICE_SMALL_ONNX_MODEL
from studymind_worker.config import load_project_env
from studymind_worker.desktop_contract import (
    MODEL_DIR_ENV,
    MODEL_DOWNLOAD_SHA256_ENV,
    MODEL_DOWNLOAD_URL_ENV,
    MODELSCOPE_ENDPOINT_ENV,
    SENSEVOICE_REVISION_ENV,
    ProgressCallback,
)
from studymind_worker.model_download import (
    ARCHIVE_INVALID_ERROR_CODE,
    ModelDownloadError,
    download_asr_model_cache,
)
from studymind_worker.requests import optional_env

MODEL_DOWNLOAD_FAILED_MESSAGE = "ASR model download failed."
MODEL_ARCHIVE_INVALID_MESSAGE = "Downloaded ASR model archive was invalid."


def run_asr_model_download_once(
    project_root: Path | None = None,
    environ: dict[str, str] | None = None,
    progress_callback: ProgressCallback | None = None,
    asr_model: str = DEFAULT_ASR_MODEL,
) -> dict[str, object]:
    if asr_model not in {DEFAULT_ASR_MODEL, SENSEVOICE_SMALL_ONNX_MODEL}:
        return {
            "status": "failed",
            "code": "ASR_MODEL_UNSUPPORTED",
            "message": MODEL_DOWNLOAD_FAILED_MESSAGE,
        }
    root = project_root or Path.cwd()
    runtime_env = load_project_env(root, environ)
    cache_dir = Path(runtime_env.get(MODEL_DIR_ENV, str(root / "models")))

    download_options: dict[str, object] = {
        "cache_dir": cache_dir,
        "model_name": asr_model,
        "progress_callback": progress_callback,
    }
    if asr_model == DEFAULT_ASR_MODEL:
        download_options.update(
            download_url=optional_env(runtime_env, MODEL_DOWNLOAD_URL_ENV),
            expected_sha256=optional_env(runtime_env, MODEL_DOWNLOAD_SHA256_ENV),
            revision=optional_env(runtime_env, SENSEVOICE_REVISION_ENV),
            endpoint=optional_env(runtime_env, MODELSCOPE_ENDPOINT_ENV),
        )

    try:
        download_asr_model_cache(
            **download_options,
        )
    except ModelDownloadError as exc:
        code, message = _safe_model_download_failure(exc.code)
        return {
            "status": "failed",
            "code": code,
            "message": message,
        }
    except Exception:
        return {
            "status": "failed",
            "code": "ASR_MODEL_DOWNLOAD_FAILED",
            "message": MODEL_DOWNLOAD_FAILED_MESSAGE,
        }

    return {
        "status": "completed",
        "model": asr_model,
    }


def _safe_model_download_failure(code: str) -> tuple[str, str]:
    if code == ARCHIVE_INVALID_ERROR_CODE:
        return code, MODEL_ARCHIVE_INVALID_MESSAGE
    return "ASR_MODEL_DOWNLOAD_FAILED", MODEL_DOWNLOAD_FAILED_MESSAGE
