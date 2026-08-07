from __future__ import annotations

import os

DEFAULT_SOURCE_RESOLVER = None


def should_allow_real_asr(environ: dict[str, str] | None = None) -> bool:
    env = environ if environ is not None else os.environ
    return env.get("STUDYMIND_ALLOW_REAL_ASR") == "1"
