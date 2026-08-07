from __future__ import annotations

import json
import os
import stat
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from uuid import uuid4


class AtomicFileCommitError(OSError):
    """A safe, path-free failure raised before a staged file is committed."""

    def __init__(self) -> None:
        super().__init__("Atomic file commit failed.")


def platform_text_bytes(content: str) -> bytes:
    return content.replace("\n", os.linesep).encode("utf-8")


@contextmanager
def staged_file(
    destination: Path,
    *,
    validator: Callable[[Path], None] | None = None,
) -> Iterator[Path]:
    """Yield a same-directory staging path and atomically install it on success."""

    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        _validate_destination(destination)
    except OSError:
        raise AtomicFileCommitError() from None
    staging_stem = destination.stem.lstrip(".")
    staging_path = destination.with_name(
        f".{staging_stem}.{uuid4().hex}.part{destination.suffix}"
    )
    try:
        yield staging_path
        _sync_regular_file(staging_path)
        if validator is not None:
            validator(staging_path)
        install_staged_file(staging_path, destination)
    except AtomicFileCommitError:
        raise
    except OSError:
        raise AtomicFileCommitError() from None
    finally:
        try:
            staging_path.unlink(missing_ok=True)
        except OSError:
            pass


def atomic_write_text(destination: Path, content: str) -> None:
    with staged_file(destination) as staging_path:
        with staging_path.open("x", encoding="utf-8", newline="\n") as handle:
            handle.write(content)


def atomic_write_bytes(destination: Path, content: bytes) -> None:
    with staged_file(destination) as staging_path:
        with staging_path.open("xb") as handle:
            handle.write(content)


def atomic_write_json(destination: Path, payload: Any) -> None:
    try:
        content = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    except (OverflowError, TypeError, ValueError):
        raise AtomicFileCommitError() from None
    atomic_write_text(destination, content)


def write_synced_new_file(path: Path, content: bytes) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        _validate_destination(path)
        with path.open("xb", buffering=0) as handle:
            handle.write(content)
            os.fsync(handle.fileno())
        _validate_regular_file(path)
    except AtomicFileCommitError:
        _cleanup_file_best_effort(path)
        raise
    except OSError:
        _cleanup_file_best_effort(path)
        raise AtomicFileCommitError() from None


def install_staged_file(staging_path: Path, destination: Path) -> None:
    try:
        if staging_path.parent != destination.parent:
            raise AtomicFileCommitError()
        _validate_regular_file(staging_path)
        _validate_destination(destination)
        os.replace(staging_path, destination)
        _sync_directory_best_effort(destination.parent)
    except AtomicFileCommitError:
        raise
    except OSError:
        raise AtomicFileCommitError() from None


def atomic_remove_file(path: Path) -> None:
    try:
        _validate_destination(path)
        try:
            path.unlink()
        except FileNotFoundError:
            return
        _sync_directory_best_effort(path.parent)
    except AtomicFileCommitError:
        raise
    except OSError:
        raise AtomicFileCommitError() from None


def _sync_regular_file(path: Path) -> None:
    _validate_regular_file(path)
    with path.open("r+b") as handle:
        os.fsync(handle.fileno())


def _validate_regular_file(path: Path) -> None:
    file_stat = path.lstat()
    if not stat.S_ISREG(file_stat.st_mode) or _is_link_or_reparse_point(file_stat):
        raise AtomicFileCommitError()


def _sync_directory_best_effort(directory: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    try:
        descriptor = os.open(directory, flags)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        try:
            os.close(descriptor)
        except OSError:
            pass


def _validate_destination(destination: Path) -> None:
    parent_stat = destination.parent.lstat()
    if not stat.S_ISDIR(parent_stat.st_mode) or _is_link_or_reparse_point(parent_stat):
        raise AtomicFileCommitError()

    try:
        destination_stat = destination.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISREG(destination_stat.st_mode) or _is_link_or_reparse_point(
        destination_stat
    ):
        raise AtomicFileCommitError()


def _is_link_or_reparse_point(file_stat: os.stat_result) -> bool:
    if stat.S_ISLNK(file_stat.st_mode):
        return True
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x0400)
    return bool(getattr(file_stat, "st_file_attributes", 0) & reparse_flag)


def _cleanup_file_best_effort(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass
