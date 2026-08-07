from __future__ import annotations

import json
import os
import re
import stat
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path, PurePosixPath
from typing import Any, Literal
from uuid import uuid4

from studymind_worker.atomic_files import (
    AtomicFileCommitError,
    atomic_remove_file,
    atomic_write_bytes,
    atomic_write_json,
    install_staged_file,
    write_synced_new_file,
)

JOURNAL_FILE_NAME = ".StudyMind-artifact-transaction.json"
SCHEMA_VERSION = 1
_MANIFEST_DESTINATION = "StudyMind-task.json"
_MAX_ENTRIES = 8
_MAX_JOURNAL_BYTES = 64 * 1024
_TRANSACTION_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
_ORPHAN_NAME_PATTERN = re.compile(
    r"^\.StudyMind-artifact-[0-9a-f]{32}-[0-7]\.(?:staging|rollback)$"
)
_JOURNAL_STAGING_NAME_PATTERN = re.compile(
    r"^\.StudyMind-artifact-transaction\.[0-9a-f]{32}\.part\.json$"
)
_ALLOWED_DESTINATIONS = (
    "StudyMind-task.json",
    "transcript/transcript.txt",
    "transcript/transcript.md",
    "transcript/segments.json",
    "transcript/original/transcript.txt",
    "transcript/original/transcript.md",
    "ai/summary.md",
    "ai/mindmap.mmd",
    "ai/insights.json",
    "ai/insights.md",
    "ai/dissection.json",
    "ai/dissection.md",
)
_ALLOWED_DESTINATION_SET = frozenset(_ALLOWED_DESTINATIONS)
_INTERNAL_PARENTS = (
    PurePosixPath("."),
    PurePosixPath("transcript"),
    PurePosixPath("transcript/original"),
    PurePosixPath("ai"),
)


class TaskArtifactCommitError(OSError):
    code = "TASK_ARTIFACT_COMMIT_FAILED"

    def __init__(self) -> None:
        super().__init__("Task artifacts could not be stored safely.")


class TaskArtifactRecoveryError(OSError):
    code = "TASK_ARTIFACT_RECOVERY_FAILED"

    def __init__(self) -> None:
        super().__init__("Task artifacts could not be recovered safely.")


class RecoveryOutcome(StrEnum):
    NONE = "none"
    ROLLED_BACK = "rolled_back"
    COMMITTED_CLEANED = "committed_cleaned"


@dataclass(frozen=True)
class _TransactionEntry:
    destination: str
    staging: str | None
    rollback: str | None
    existed_before: bool


@dataclass(frozen=True)
class _TransactionJournal:
    transaction_id: str
    state: Literal["prepared", "committed"]
    entries: tuple[_TransactionEntry, ...]


class _InvalidTransactionError(ValueError):
    pass


def commit_task_artifacts(
    task_dir: Path,
    mutations: Mapping[str, bytes | None],
    *,
    _fault_hook: Callable[[str], None] | None = None,
) -> None:
    """Commit one allowlisted task revision, recovering any prior transaction first."""

    try:
        _validate_task_dir(task_dir)
        recover_task_artifacts(task_dir)
        ordered_mutations = _validate_mutations(task_dir, mutations)
    except TaskArtifactRecoveryError:
        raise
    except (AtomicFileCommitError, OSError, ValueError):
        raise TaskArtifactCommitError() from None

    transaction_id = uuid4().hex
    entries = tuple(
        _build_entry(task_dir, transaction_id, index, destination, content)
        for index, (destination, content) in enumerate(ordered_mutations)
    )
    journal = _TransactionJournal(
        transaction_id=transaction_id,
        state="prepared",
        entries=entries,
    )
    journal_installed = False
    material_paths = _material_paths(task_dir, entries)

    try:
        _prepare_materials(task_dir, entries, ordered_mutations)
        atomic_write_json(task_dir / JOURNAL_FILE_NAME, _journal_payload(journal))
        journal_installed = True
        _emit_fault(_fault_hook, "after_journal_prepared")

        for entry in entries:
            destination = _destination_path(task_dir, entry.destination)
            if entry.staging is None:
                atomic_remove_file(destination)
            else:
                install_staged_file(task_dir / Path(entry.staging), destination)
            _emit_fault(_fault_hook, f"after_replace:{entry.destination}")

        committed = _TransactionJournal(
            transaction_id=journal.transaction_id,
            state="committed",
            entries=journal.entries,
        )
        atomic_write_json(task_dir / JOURNAL_FILE_NAME, _journal_payload(committed))
        _emit_fault(_fault_hook, "after_journal_committed")
    except Exception:
        if journal_installed:
            try:
                recover_task_artifacts(task_dir)
            except TaskArtifactRecoveryError:
                raise TaskArtifactRecoveryError() from None
        else:
            _cleanup_paths_best_effort(material_paths)
        raise TaskArtifactCommitError() from None

    _remove_journal_then_cleanup(task_dir, material_paths, required=False)


def recover_task_artifacts(task_dir: Path) -> RecoveryOutcome:
    """Resolve a prepared/committed task journal before trusting task artifacts."""

    try:
        _validate_task_dir(task_dir)
        journal_path = task_dir / JOURNAL_FILE_NAME
        if not _path_exists(journal_path):
            _cleanup_closed_orphans_best_effort(task_dir)
            return RecoveryOutcome.NONE
        _validate_regular_path(journal_path)
        raw_journal = journal_path.read_bytes()
        if len(raw_journal) > _MAX_JOURNAL_BYTES:
            raise _InvalidTransactionError()
        payload = json.loads(
            raw_journal.decode("utf-8"),
            object_pairs_hook=_closed_object,
        )
        journal = _parse_journal_payload(payload)
        _validate_recovery_paths(task_dir, journal)

        if journal.state == "prepared":
            rollback_payloads = _load_all_rollbacks(task_dir, journal.entries)
            for entry in journal.entries:
                destination = _destination_path(task_dir, entry.destination)
                if entry.existed_before:
                    atomic_write_bytes(destination, rollback_payloads[entry.destination])
                else:
                    atomic_remove_file(destination)
            outcome = RecoveryOutcome.ROLLED_BACK
        else:
            outcome = RecoveryOutcome.COMMITTED_CLEANED

        _remove_journal_then_cleanup(
            task_dir,
            _material_paths(task_dir, journal.entries),
            required=True,
        )
    except TaskArtifactRecoveryError:
        raise
    except (AtomicFileCommitError, OSError, UnicodeError, ValueError, TypeError):
        raise TaskArtifactRecoveryError() from None
    else:
        return outcome


def _validate_mutations(
    task_dir: Path,
    mutations: Mapping[str, bytes | None],
) -> tuple[tuple[str, bytes | None], ...]:
    if not isinstance(mutations, Mapping) or not 1 <= len(mutations) <= _MAX_ENTRIES:
        raise _InvalidTransactionError()
    ordered: list[tuple[str, bytes | None]] = []
    manifest: tuple[str, bytes | None] | None = None
    for destination, content in mutations.items():
        if not isinstance(destination, str) or destination not in _ALLOWED_DESTINATION_SET:
            raise _InvalidTransactionError()
        if content is not None and not isinstance(content, bytes):
            raise _InvalidTransactionError()
        _ensure_destination_parent(task_dir, destination)
        _validate_optional_regular_path(_destination_path(task_dir, destination))
        item = (destination, content)
        if destination == _MANIFEST_DESTINATION:
            manifest = item
        else:
            ordered.append(item)
    if manifest is not None:
        ordered.append(manifest)
    return tuple(ordered)


def _build_entry(
    task_dir: Path,
    transaction_id: str,
    index: int,
    destination: str,
    content: bytes | None,
) -> _TransactionEntry:
    destination_path = _destination_path(task_dir, destination)
    existed_before = _path_exists(destination_path)
    return _TransactionEntry(
        destination=destination,
        staging=(
            _internal_relative_path(destination, transaction_id, index, "staging")
            if content is not None
            else None
        ),
        rollback=(
            _internal_relative_path(destination, transaction_id, index, "rollback")
            if existed_before
            else None
        ),
        existed_before=existed_before,
    )


def _prepare_materials(
    task_dir: Path,
    entries: tuple[_TransactionEntry, ...],
    mutations: tuple[tuple[str, bytes | None], ...],
) -> None:
    content_by_destination = dict(mutations)
    for entry in entries:
        destination = _destination_path(task_dir, entry.destination)
        if entry.staging is not None:
            content = content_by_destination[entry.destination]
            if not isinstance(content, bytes):
                raise _InvalidTransactionError()
            write_synced_new_file(task_dir / Path(entry.staging), content)
        if entry.rollback is not None:
            _validate_regular_path(destination)
            previous = destination.read_bytes()
            write_synced_new_file(task_dir / Path(entry.rollback), previous)


def _parse_journal_payload(payload: Any) -> _TransactionJournal:
    if not isinstance(payload, dict) or set(payload) != {
        "schema_version",
        "transaction_id",
        "state",
        "entries",
    }:
        raise _InvalidTransactionError()
    if type(payload["schema_version"]) is not int or payload["schema_version"] != SCHEMA_VERSION:
        raise _InvalidTransactionError()
    transaction_id = payload["transaction_id"]
    if not isinstance(transaction_id, str) or not _TRANSACTION_ID_PATTERN.fullmatch(
        transaction_id
    ):
        raise _InvalidTransactionError()
    state = payload["state"]
    if state not in ("prepared", "committed") or not isinstance(state, str):
        raise _InvalidTransactionError()
    raw_entries = payload["entries"]
    if not isinstance(raw_entries, list) or not 1 <= len(raw_entries) <= _MAX_ENTRIES:
        raise _InvalidTransactionError()

    entries: list[_TransactionEntry] = []
    destinations: set[str] = set()
    for index, raw_entry in enumerate(raw_entries):
        entry = _parse_entry(raw_entry, transaction_id, index)
        if entry.destination in destinations:
            raise _InvalidTransactionError()
        destinations.add(entry.destination)
        entries.append(entry)
    if _MANIFEST_DESTINATION in destinations and entries[-1].destination != _MANIFEST_DESTINATION:
        raise _InvalidTransactionError()
    return _TransactionJournal(
        transaction_id=transaction_id,
        state=state,
        entries=tuple(entries),
    )


def _parse_entry(raw_entry: Any, transaction_id: str, index: int) -> _TransactionEntry:
    if not isinstance(raw_entry, dict) or set(raw_entry) != {
        "destination",
        "staging",
        "rollback",
        "existed_before",
    }:
        raise _InvalidTransactionError()
    destination = raw_entry["destination"]
    staging = raw_entry["staging"]
    rollback = raw_entry["rollback"]
    existed_before = raw_entry["existed_before"]
    if not isinstance(destination, str) or destination not in _ALLOWED_DESTINATION_SET:
        raise _InvalidTransactionError()
    if staging is not None and not isinstance(staging, str):
        raise _InvalidTransactionError()
    if rollback is not None and not isinstance(rollback, str):
        raise _InvalidTransactionError()
    if type(existed_before) is not bool:
        raise _InvalidTransactionError()
    expected_staging = _internal_relative_path(
        destination, transaction_id, index, "staging"
    )
    expected_rollback = _internal_relative_path(
        destination, transaction_id, index, "rollback"
    )
    if staging is not None and staging != expected_staging:
        raise _InvalidTransactionError()
    if existed_before and rollback != expected_rollback:
        raise _InvalidTransactionError()
    if not existed_before and rollback is not None:
        raise _InvalidTransactionError()
    return _TransactionEntry(
        destination=destination,
        staging=staging,
        rollback=rollback,
        existed_before=existed_before,
    )


def _validate_recovery_paths(task_dir: Path, journal: _TransactionJournal) -> None:
    for entry in journal.entries:
        _ensure_destination_parent(task_dir, entry.destination)
        _validate_optional_regular_path(_destination_path(task_dir, entry.destination))
        for relative in (entry.staging, entry.rollback):
            if relative is not None:
                _validate_optional_regular_path(task_dir / Path(relative))


def _load_all_rollbacks(
    task_dir: Path,
    entries: tuple[_TransactionEntry, ...],
) -> dict[str, bytes]:
    payloads: dict[str, bytes] = {}
    for entry in entries:
        if not entry.existed_before:
            continue
        if entry.rollback is None:
            raise _InvalidTransactionError()
        rollback_path = task_dir / Path(entry.rollback)
        _validate_regular_path(rollback_path)
        payloads[entry.destination] = rollback_path.read_bytes()
    return payloads


def _journal_payload(journal: _TransactionJournal) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "transaction_id": journal.transaction_id,
        "state": journal.state,
        "entries": [
            {
                "destination": entry.destination,
                "staging": entry.staging,
                "rollback": entry.rollback,
                "existed_before": entry.existed_before,
            }
            for entry in journal.entries
        ],
    }


def _material_paths(
    task_dir: Path,
    entries: tuple[_TransactionEntry, ...],
) -> tuple[Path, ...]:
    return tuple(
        task_dir / Path(relative)
        for entry in entries
        for relative in (entry.staging, entry.rollback)
        if relative is not None
    )


def _remove_journal_then_cleanup(
    task_dir: Path,
    material_paths: tuple[Path, ...],
    *,
    required: bool,
) -> None:
    try:
        atomic_remove_file(task_dir / JOURNAL_FILE_NAME)
    except AtomicFileCommitError:
        if required:
            raise TaskArtifactRecoveryError() from None
        return
    _cleanup_paths_best_effort(material_paths)


def _cleanup_paths_best_effort(paths: tuple[Path, ...]) -> None:
    for path in paths:
        try:
            atomic_remove_file(path)
        except AtomicFileCommitError:
            pass


def _cleanup_closed_orphans_best_effort(task_dir: Path) -> None:
    for relative_parent in _INTERNAL_PARENTS:
        directory = task_dir / Path(relative_parent.as_posix())
        if not _path_exists(directory):
            continue
        try:
            _validate_directory_path(directory)
            entries = tuple(directory.iterdir())
        except OSError:
            continue
        for path in entries:
            if not (
                _ORPHAN_NAME_PATTERN.fullmatch(path.name)
                or _JOURNAL_STAGING_NAME_PATTERN.fullmatch(path.name)
            ):
                continue
            try:
                _validate_regular_path(path)
                atomic_remove_file(path)
            except (AtomicFileCommitError, OSError):
                pass


def _ensure_destination_parent(task_dir: Path, destination: str) -> None:
    relative = PurePosixPath(destination)
    if relative.as_posix() != destination or relative.is_absolute():
        raise _InvalidTransactionError()
    current = task_dir
    for component in relative.parent.parts:
        current /= component
        current.mkdir(exist_ok=True)
        _validate_directory_path(current)


def _destination_path(task_dir: Path, destination: str) -> Path:
    return task_dir.joinpath(*PurePosixPath(destination).parts)


def _internal_relative_path(
    destination: str,
    transaction_id: str,
    index: int,
    kind: Literal["staging", "rollback"],
) -> str:
    parent = PurePosixPath(destination).parent
    name = f".StudyMind-artifact-{transaction_id}-{index}.{kind}"
    return name if parent == PurePosixPath(".") else (parent / name).as_posix()


def _validate_task_dir(task_dir: Path) -> None:
    _validate_directory_path(task_dir)


def _validate_directory_path(path: Path) -> None:
    metadata = path.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or _is_link_or_reparse_point(metadata):
        raise _InvalidTransactionError()


def _validate_regular_path(path: Path) -> None:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or _is_link_or_reparse_point(metadata):
        raise _InvalidTransactionError()


def _validate_optional_regular_path(path: Path) -> None:
    try:
        _validate_regular_path(path)
    except FileNotFoundError:
        return


def _path_exists(path: Path) -> bool:
    try:
        path.lstat()
    except FileNotFoundError:
        return False
    return True


def _is_link_or_reparse_point(metadata: os.stat_result) -> bool:
    if stat.S_ISLNK(metadata.st_mode):
        return True
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x0400)
    return bool(getattr(metadata, "st_file_attributes", 0) & reparse_flag)


def _closed_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise _InvalidTransactionError()
        value[key] = item
    return value


def _emit_fault(hook: Callable[[str], None] | None, event: str) -> None:
    if hook is not None:
        hook(event)
