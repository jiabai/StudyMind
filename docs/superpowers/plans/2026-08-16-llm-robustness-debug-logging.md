# LLM Robustness and Debug Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Worker LLM calls safer and diagnosable without logging credentials, prompts, or full provider responses.

**Architecture:** Keep the existing `InsightClient` and server checkout protocol. Add validation and safe logging at the two transport boundaries in `worker/studymind_worker/llm.py`; preserve existing error codes and leave retry ownership with the upper pipeline. Test behavior through injected transports and `caplog`.

**Tech Stack:** Python 3.12, `urllib.request`, standard-library `logging`, pytest, Ruff.

---

### Task 1: Add safe request context and logging helpers

**Files:**
- Modify: `worker/studymind_worker/llm.py`
- Test: `worker/tests/test_llm.py`

- [ ] **Step 1: Add logger and bounded safe URL/context helpers**

Add `import logging`, `import time`, and `from urllib.parse import SplitResult, urlsplit, urlunsplit`. Define a module logger and helpers with these exact behaviors:

```python
LOGGER = logging.getLogger(__name__)
MAX_LOG_DETAIL_LENGTH = 300

def _safe_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return "<invalid-url>"
    netloc = parsed.hostname
    if parsed.port is not None:
        netloc = f"{netloc}:{parsed.port}"
    return urlunsplit((parsed.scheme, netloc, parsed.path or "/", "", ""))

def _log_request_completed(*, stage: str, url: str, model: str, request_id: str | None,
                           started_at: float, status: str, error_code: str | None = None) -> None:
    LOGGER.debug(
        "llm_request stage=%s url=%s model=%s request_id=%s duration_ms=%d status=%s error_code=%s",
        stage, _safe_url(url), model or "<unknown>", request_id or "-",
        round((time.monotonic() - started_at) * 1000), status, error_code or "-",
    )

def _log_request_failed(...):
    LOGGER.warning(...)
```

The warning helper must log only `stage`, safe URL, model, request id, duration, stable error code, and exception class. It must not accept prompt, API key, session token, headers, or raw body.

- [ ] **Step 2: Add tests that prove safe context behavior**

Add tests for `_safe_url` through the public request logs: a URL containing query, fragment, and userinfo must produce a log record containing only scheme/host/port/path; assert the query, fragment, username, password, session token, and API key are absent.

- [ ] **Step 3: Run focused tests**

Run: `uv run pytest worker/tests/test_llm.py -q`

Expected: existing tests pass; new helper tests pass.

### Task 2: Instrument checkout and provider completion boundaries

**Files:**
- Modify: `worker/studymind_worker/llm.py`
- Test: `worker/tests/test_llm.py`

- [ ] **Step 1: Instrument `OpenAICompatibleInsightClient.generate`**

Wrap the transport and response extraction with one `started_at = time.monotonic()` and a `try/except/finally`-equivalent outcome path. Emit a debug log after a successful bounded response/content extraction with `stage="completion"`, safe completion URL, model, request id if supplied, and `status="success"`. Emit a warning exactly when mapping HTTP/network/timeout/invalid-response/oversize failures, using the stable `InsightGenerationError.code` and exception class.

Extend the dataclass with an optional `request_id: str | None = None`; pass the managed per-call request id from `ServerManagedInsightClient._checkout_client`. Do not add the session token to the client or log context.

- [ ] **Step 2: Instrument `ServerManagedInsightClient._checkout_client`**

Record `started_at` before checkout transport. On success log `stage="checkout"`, checkout URL, provider/model from the validated response, request id, and `status="success"`. On every mapped checkout failure log `stage="checkout"`, checkout URL, request id, the stable error code, and exception class. Keep the request body and Authorization header out of logs.

- [ ] **Step 3: Add success/failure log tests**

Use `caplog.at_level(logging.DEBUG, logger="studymind_worker.llm")` and an injected transport. Assert:

```python
assert "stage=checkout" in messages[0]
assert "stage=completion" in messages[1]
assert "request_id=lesson-run-0001-call-0001" in messages[0]
assert "request_id=lesson-run-0001-call-0001" in messages[1]
assert "duration_ms=" in messages[0]
assert "status=success" in messages[1]
assert "managed-secret" not in joined
assert "session-secret" not in joined
assert "first prompt" not in joined
```

Add a failure test asserting warning output contains `error_code=INSIGHTFLOW_LLM_REQUEST_FAILED` and never contains the error body if that body includes credential-like text.

- [ ] **Step 4: Run focused tests**

Run: `uv run pytest worker/tests/test_llm.py -q`

Expected: PASS with all existing request-id and credential-isolation assertions preserved.

### Task 3: Harden configuration and transport edge handling

**Files:**
- Modify: `worker/studymind_worker/llm.py`
- Test: `worker/tests/test_llm.py`

- [ ] **Step 1: Add explicit client configuration validation**

Validate in `__post_init__` for both client dataclasses:

```python
if not self.api_key.strip() or not self.model.strip():
    raise ValueError("LLM API key and model are required.")
if self.timeout_seconds <= 0:
    raise ValueError("LLM timeout must be positive.")
_validate_http_url(self.base_url)
```

For managed checkout, validate `checkout_url` as an HTTP(S) URL without query/fragment/userinfo before creating `Request`; map invalid runtime values to `INSIGHTFLOW_LLM_CHECKOUT_INVALID_RESPONSE` or the existing request failure error instead of exposing raw URL exceptions. Keep environment factory behavior (`None` for absent credentials) unchanged.

- [ ] **Step 2: Normalize timeout/network exception mapping**

Handle `socket.timeout` and `TimeoutError` before generic `OSError`; handle `urllib.error.URLError` whose reason is `socket.timeout` as timeout; map other `URLError`/`OSError` to the existing provider or checkout failure code. When response extraction raises `InsightGenerationError`, log its stable code and re-raise unchanged.

- [ ] **Step 3: Add edge-case tests**

Add parametrized tests for:

```python
("https://llm.example/v1?tenant=secret", "INSIGHTFLOW_LLM_REQUEST_FAILED")
("https://user:pass@llm.example/v1", "INSIGHTFLOW_LLM_REQUEST_FAILED")
```

and tests for `socket.timeout`, `urllib.error.URLError(socket.timeout(...))`, generic `URLError`, and oversized provider response. Assert stable error codes, no raw secret values, and no raw prompt in exception/log text.

- [ ] **Step 4: Run focused tests and lint**

Run: `uv run pytest worker/tests/test_llm.py -q`

Run: `uv run ruff check worker/studymind_worker/llm.py worker/tests/test_llm.py`

Expected: both commands exit 0.

### Task 4: Verify the Worker regression surface

**Files:**
- Modify: `task_plan.md`
- Modify: `findings.md`
- Modify: `progress.md`

- [ ] **Step 1: Run the complete Worker test suite**

Run: `uv run pytest worker/tests -q`

Expected: exit code 0 with no failures.

- [ ] **Step 2: Run the Worker lint check**

Run: `uv run ruff check worker`

Expected: exit code 0.

- [ ] **Step 3: Review the diff and sensitive-data constraints**

Run: `git diff -- worker/studymind_worker/llm.py worker/tests/test_llm.py`

Confirm logs contain no prompt/API key/session token/Authorization/raw response, no server contract changes, and no edits to pre-existing unrelated files. Record command output and any environment limitation in `progress.md`.
