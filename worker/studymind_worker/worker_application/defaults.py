from __future__ import annotations

import os

from studymind_worker.asr_runtime.registry import build_asr_transcriber
from studymind_worker.llm import build_insight_client_from_env

DEFAULT_SOURCE_RESOLVER = None

__all__ = [
    "DEFAULT_SOURCE_RESOLVER",
    "build_asr_transcriber",
    "build_insight_client_from_env",
    "should_allow_real_asr",
]


def should_allow_real_asr(environ: dict[str, str] | None = None) -> bool:
    env = environ if environ is not None else os.environ
    return env.get("STUDYMIND_ALLOW_REAL_ASR") == "1"
