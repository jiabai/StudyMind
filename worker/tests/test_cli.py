from __future__ import annotations

import io
import logging

from studymind_worker.cli import configure_logging


def _restore_root_logging(handlers: list[logging.Handler], level: int) -> None:
    root = logging.getLogger()
    root.handlers.clear()
    root.handlers.extend(handlers)
    root.setLevel(level)


def test_configure_logging_emits_debug_to_the_worker_stderr_stream() -> None:
    root = logging.getLogger()
    original_handlers = root.handlers[:]
    original_level = root.level
    stream = io.StringIO()

    try:
        configure_logging({"STUDYMIND_LOG_LEVEL": "debug"}, stream=stream)
        logging.getLogger("studymind_worker.llm").debug("debug-check")
    finally:
        _restore_root_logging(original_handlers, original_level)

    assert "debug-check" in stream.getvalue()
    assert "studymind_worker.llm" in stream.getvalue()


def test_configure_logging_uses_info_for_unknown_level() -> None:
    root = logging.getLogger()
    original_handlers = root.handlers[:]
    original_level = root.level
    stream = io.StringIO()

    try:
        configure_logging({"STUDYMIND_LOG_LEVEL": "not-a-level"}, stream=stream)
        logger = logging.getLogger("studymind_worker.llm")
        logger.debug("hidden-debug-check")
        logger.info("visible-info-check")
    finally:
        _restore_root_logging(original_handlers, original_level)

    output = stream.getvalue()
    assert "hidden-debug-check" not in output
    assert "visible-info-check" in output
