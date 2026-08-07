from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

from studymind_worker.atomic_files import (
    AtomicFileCommitError,
    atomic_write_bytes,
)
from studymind_worker.task_transaction import (
    TaskArtifactCommitError,
    TaskArtifactRecoveryError,
    commit_task_artifacts,
)


def commit_insight_payloads(
    output_dir: Path,
    output_stem: str,
    payloads: Mapping[Path, bytes],
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    if output_stem == "" and output_dir.name == "ai":
        try:
            commit_task_artifacts(
                output_dir.parent,
                {
                    path.relative_to(output_dir.parent).as_posix(): content
                    for path, content in payloads.items()
                },
            )
        except (TaskArtifactCommitError, TaskArtifactRecoveryError):
            raise AtomicFileCommitError() from None
        return

    for path, content in payloads.items():
        atomic_write_bytes(path, content)
