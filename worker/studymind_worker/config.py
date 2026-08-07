from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path

DOTENV_FILE_NAME = ".env"
USER_DATA_DIR_ENV = "STUDYMIND_USER_DATA_DIR"
LEGACY_LOCAL_LLM_DOTENV_KEYS = {
    "STUDYMIND_LLM_PROVIDER",
    "STUDYMIND_LLM_BASE_URL",
    "STUDYMIND_LLM_API_KEY",
    "STUDYMIND_LLM_MODEL",
    "STUDYMIND_LLM_TIMEOUT_SECONDS",
}


def load_project_env(
    project_root: Path,
    environ: Mapping[str, str] | None = None,
) -> dict[str, str]:
    base_env = dict(environ if environ is not None else os.environ)
    user_data_dotenv_env: dict[str, str] = {}
    user_data_dir = base_env.get(USER_DATA_DIR_ENV, "").strip()
    if user_data_dir:
        user_data_dotenv_env = remove_legacy_local_llm_dotenv_keys(
            parse_dotenv(Path(user_data_dir) / DOTENV_FILE_NAME)
        )

    # The repository-root .env is intentionally ignored. Desktop runtime settings
    # live in app-local data, and LLM settings are provided by server checkout env.
    _ = project_root
    merged_env = {**user_data_dotenv_env, **base_env}
    return {key: value for key, value in merged_env.items() if value != ""}


def parse_dotenv(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}

    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        if line.startswith("export "):
            line = line.removeprefix("export ").strip()

        key, value = line.split("=", 1)
        key = key.strip()
        if not key:
            continue

        values[key] = strip_env_value(value.strip())

    return values


def remove_legacy_local_llm_dotenv_keys(values: dict[str, str]) -> dict[str, str]:
    return {
        key: value
        for key, value in values.items()
        if key not in LEGACY_LOCAL_LLM_DOTENV_KEYS
    }


def strip_env_value(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]

    return value
