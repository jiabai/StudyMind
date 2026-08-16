from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request

from studymind_worker.insightflow import InsightClient, InsightGenerationError

DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1"
DEFAULT_LLM_TIMEOUT_SECONDS = 60.0
DEFAULT_LLM_TEMPERATURE = 0.7
MAX_LLM_RESPONSE_BYTES = 16 * 1024 * 1024
_MAX_ERROR_BODY_BYTES = 1024 * 1024
LOGGER = logging.getLogger(__name__)

LLM_PROVIDER_ENV = "STUDYMIND_LLM_PROVIDER"
LLM_API_KEY_ENV = "STUDYMIND_LLM_API_KEY"
LLM_MODEL_ENV = "STUDYMIND_LLM_MODEL"
LLM_BASE_URL_ENV = "STUDYMIND_LLM_BASE_URL"
LLM_TIMEOUT_ENV = "STUDYMIND_LLM_TIMEOUT_SECONDS"
LLM_SOURCE_ENV = "STUDYMIND_LLM_SOURCE"
LLM_CHECKOUT_URL_ENV = "STUDYMIND_LLM_CHECKOUT_URL"
LLM_SESSION_TOKEN_ENV = "STUDYMIND_LLM_SESSION_TOKEN"
LLM_CHECKOUT_REQUEST_ID_ENV = "STUDYMIND_LLM_CHECKOUT_REQUEST_ID"

Transport = Callable[[Request, float], bytes]


@dataclass(frozen=True)
class OpenAICompatibleInsightClient:
    api_key: str
    model: str
    base_url: str = DEFAULT_LLM_BASE_URL
    timeout_seconds: float = DEFAULT_LLM_TIMEOUT_SECONDS
    temperature: float = DEFAULT_LLM_TEMPERATURE
    transport: Transport | None = None
    provider: str = "openai_compatible"
    request_id: str | None = None

    def generate(self, prompt: str) -> str:
        started_at = time.monotonic()
        try:
            _validate_llm_request_config(self.api_key, self.model, self.base_url, self.timeout_seconds)
            payload = {
                "model": self.model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": self.temperature,
            }
            request = Request(
                url=_chat_completions_url(self.base_url),
                data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                method="POST",
            )
            raw_response = (self.transport or urlopen_transport)(
                request,
                self.timeout_seconds,
            )
            content = extract_chat_completion_content(raw_response)
        except urllib.error.HTTPError as exc:
            error = _llm_request_http_error(exc)
            _log_request_failure(
                "completion",
                self.base_url,
                self.provider,
                self.model,
                self.request_id,
                started_at,
                error,
                exc,
                http_status=exc.code,
            )
            raise error from exc
        except TimeoutError as exc:
            error = InsightGenerationError(
                "INSIGHTFLOW_LLM_REQUEST_TIMEOUT",
                _timeout_message(self.timeout_seconds),
            )
            _log_request_failure("completion", self.base_url, self.provider, self.model, self.request_id, started_at, error, exc)
            raise error from exc
        except urllib.error.URLError as exc:
            if isinstance(exc.reason, TimeoutError):
                error = InsightGenerationError(
                    "INSIGHTFLOW_LLM_REQUEST_TIMEOUT",
                    _timeout_message(self.timeout_seconds),
                )
            else:
                error = InsightGenerationError(
                    "INSIGHTFLOW_LLM_REQUEST_FAILED",
                    "LLM request failed before a usable response was returned.",
                )
            _log_request_failure("completion", self.base_url, self.provider, self.model, self.request_id, started_at, error, exc)
            raise error from exc
        except InsightGenerationError as exc:
            _log_request_failure("completion", self.base_url, self.provider, self.model, self.request_id, started_at, exc, exc)
            raise
        except (OSError, TypeError, ValueError) as exc:
            error = InsightGenerationError(
                "INSIGHTFLOW_LLM_REQUEST_FAILED",
                "LLM request configuration or transport was invalid.",
            )
            _log_request_failure("completion", self.base_url, self.provider, self.model, self.request_id, started_at, error, exc)
            raise error from exc

        _log_request_success(
            "completion",
            self.base_url,
            self.provider,
            self.model,
            self.request_id,
            started_at,
        )
        return content


@dataclass
class ServerManagedInsightClient:
    checkout_url: str
    session_token: str
    request_id: str
    timeout_seconds: float = DEFAULT_LLM_TIMEOUT_SECONDS
    transport: Transport | None = None
    _call_index: int = field(default=0, init=False, repr=False)

    def generate(self, prompt: str) -> str:
        client = self._checkout_client(self._next_call_request_id())
        return client.generate(prompt)

    def _next_call_request_id(self) -> str:
        self._call_index += 1
        return derive_per_call_request_id(self.request_id, self._call_index)

    def _checkout_client(self, request_id: str) -> OpenAICompatibleInsightClient:
        started_at = time.monotonic()
        try:
            _validate_managed_checkout_config(self.checkout_url, self.session_token, request_id)
            payload = {"request_id": request_id}
            request = Request(
                url=self.checkout_url,
                data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                headers={
                    "Authorization": f"Bearer {self.session_token}",
                    "Content-Type": "application/json",
                },
                method="POST",
            )
            raw_response = (self.transport or urlopen_transport)(
                request,
                self.timeout_seconds,
            )
            config = parse_managed_checkout_response(raw_response)
            client = OpenAICompatibleInsightClient(
                api_key=config["api_key"],
                model=config["model"],
                base_url=config["base_url"],
                timeout_seconds=float(config["timeout_seconds"]),
                transport=self.transport,
                provider=config["provider"],
                request_id=request_id,
            )
        except urllib.error.HTTPError as exc:
            error = _managed_checkout_http_error(exc)
            _log_request_failure(
                "checkout",
                self.checkout_url,
                "managed",
                "-",
                request_id,
                started_at,
                error,
                exc,
                http_status=exc.code,
            )
            raise error from exc
        except TimeoutError as exc:
            error = InsightGenerationError(
                "INSIGHTFLOW_LLM_CHECKOUT_TIMEOUT",
                "StudyMind LLM checkout timed out. Please retry later.",
            )
            _log_request_failure("checkout", self.checkout_url, "managed", "-", request_id, started_at, error, exc)
            raise error from exc
        except urllib.error.URLError as exc:
            if isinstance(exc.reason, TimeoutError):
                error = InsightGenerationError(
                    "INSIGHTFLOW_LLM_CHECKOUT_TIMEOUT",
                    "StudyMind LLM checkout timed out. Please retry later.",
                )
            else:
                error = InsightGenerationError(
                    "INSIGHTFLOW_LLM_CHECKOUT_FAILED",
                    "StudyMind LLM checkout failed before a usable response was returned.",
                )
            _log_request_failure("checkout", self.checkout_url, "managed", "-", request_id, started_at, error, exc)
            raise error from exc
        except InsightGenerationError as exc:
            _log_request_failure("checkout", self.checkout_url, "managed", "-", request_id, started_at, exc, exc)
            raise
        except (OSError, TypeError, ValueError) as exc:
            error = InsightGenerationError(
                "INSIGHTFLOW_LLM_CHECKOUT_FAILED",
                "StudyMind LLM checkout configuration or transport was invalid.",
            )
            _log_request_failure("checkout", self.checkout_url, "managed", "-", request_id, started_at, error, exc)
            raise error from exc

        _log_request_success(
            "checkout",
            self.checkout_url,
            client.provider,
            client.model,
            request_id,
            started_at,
        )
        return client


def derive_per_call_request_id(request_id_seed: str, call_index: int) -> str:
    suffix = f"-call-{call_index:04d}"
    max_request_id_length = 160
    if len(request_id_seed) + len(suffix) <= max_request_id_length:
        return f"{request_id_seed}{suffix}"
    return f"{request_id_seed[: max_request_id_length - len(suffix)]}{suffix}"


def build_insight_client_from_env(env: Mapping[str, str]) -> InsightClient | None:
    if env.get(LLM_SOURCE_ENV, "").strip().lower() == "server":
        checkout_url = env.get(LLM_CHECKOUT_URL_ENV, "").strip()
        session_token = env.get(LLM_SESSION_TOKEN_ENV, "").strip()
        request_id = env.get(LLM_CHECKOUT_REQUEST_ID_ENV, "").strip()
        if not checkout_url or not session_token or not request_id:
            return None
        return ServerManagedInsightClient(
            checkout_url=checkout_url,
            session_token=session_token,
            request_id=request_id,
            timeout_seconds=parse_timeout(env.get(LLM_TIMEOUT_ENV)),
        )

    api_key = env.get(LLM_API_KEY_ENV, "").strip()
    model = env.get(LLM_MODEL_ENV, "").strip()
    if not api_key or not model:
        return None

    provider = env.get(LLM_PROVIDER_ENV, "openai_compatible").strip().lower()
    if provider not in {"openai", "openai_compatible"}:
        return None

    return OpenAICompatibleInsightClient(
        api_key=api_key,
        model=model,
        base_url=env.get(LLM_BASE_URL_ENV, DEFAULT_LLM_BASE_URL).strip() or DEFAULT_LLM_BASE_URL,
        timeout_seconds=parse_timeout(env.get(LLM_TIMEOUT_ENV)),
    )


def parse_managed_checkout_response(raw_response: bytes) -> dict[str, str | int]:
    try:
        payload = json.loads(raw_response.decode("utf-8"))
    except (TypeError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _invalid_managed_checkout_response() from exc

    expected_fields = {
        "provider",
        "base_url",
        "model",
        "api_key",
        "timeout_seconds",
        "quota_remaining",
    }
    if not isinstance(payload, dict) or set(payload) != expected_fields:
        raise _invalid_managed_checkout_response()
    if not all(
        isinstance(payload[field], str) for field in ("provider", "base_url", "model", "api_key")
    ):
        raise _invalid_managed_checkout_response()
    provider = payload["provider"].strip().lower()
    base_url = payload["base_url"].strip()
    model = payload["model"].strip()
    api_key = payload["api_key"].strip()
    timeout_seconds = payload["timeout_seconds"]
    quota_remaining = payload["quota_remaining"]

    try:
        parsed_base_url = urlsplit(base_url)
        _ = parsed_base_url.port
    except ValueError:
        raise _invalid_managed_checkout_response() from None
    if (
        provider not in {"openai", "openai_compatible"}
        or not base_url
        or "\\" in base_url
        or "%5c" in base_url.lower()
        or parsed_base_url.scheme not in {"http", "https"}
        or not parsed_base_url.hostname
        or any(character.isspace() for character in parsed_base_url.netloc)
        or parsed_base_url.username is not None
        or parsed_base_url.password is not None
        or bool(parsed_base_url.query)
        or bool(parsed_base_url.fragment)
        or not model
        or not api_key
        or isinstance(timeout_seconds, bool)
        or not isinstance(timeout_seconds, int)
        or not 1 <= timeout_seconds <= 600
        or isinstance(quota_remaining, bool)
        or not isinstance(quota_remaining, int)
        or quota_remaining < 0
    ):
        raise _invalid_managed_checkout_response()
    return {
        "provider": provider,
        "base_url": base_url,
        "model": model,
        "api_key": api_key,
        "timeout_seconds": timeout_seconds,
        "quota_remaining": quota_remaining,
    }


def _invalid_managed_checkout_response() -> InsightGenerationError:
    return InsightGenerationError(
        "INSIGHTFLOW_LLM_CHECKOUT_INVALID_RESPONSE",
        "StudyMind LLM checkout did not return usable configuration.",
    )


def _chat_completions_url(base_url: str) -> str:
    _validate_http_url(base_url)
    parsed = urlsplit(base_url)
    path = f"{parsed.path.rstrip('/')}/chat/completions"
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def _managed_checkout_http_error(error: urllib.error.HTTPError) -> InsightGenerationError:
    detail = _extract_error_code(error)
    if error.code == 401:
        return InsightGenerationError(
            "INSIGHTFLOW_LLM_AUTH_REQUIRED",
            "StudyMind login is required to use the managed LLM.",
        )
    if error.code == 403:
        return InsightGenerationError(
            "INSIGHTFLOW_LLM_QUOTA_UNAVAILABLE",
            "No cloud LLM API-call uses are available for this account.",
        )
    if detail == "LLM_CONFIG_MISSING":
        return InsightGenerationError(
            "INSIGHTFLOW_LLM_CONFIG_MISSING",
            "StudyMind managed LLM is not configured.",
        )
    return InsightGenerationError(
        "INSIGHTFLOW_LLM_CHECKOUT_FAILED",
        f"StudyMind LLM checkout failed with HTTP {error.code}.",
    )


def _llm_request_http_error(error: urllib.error.HTTPError) -> InsightGenerationError:
    detail = _extract_http_error_detail(error)
    if _looks_like_content_safety_block(detail):
        return InsightGenerationError(
            "INSIGHTFLOW_LLM_CONTENT_BLOCKED",
            _with_provider_detail(
                "LLM provider blocked the request with its content safety policy.",
                detail,
            ),
        )

    return InsightGenerationError(
        "INSIGHTFLOW_LLM_REQUEST_FAILED",
        _with_provider_detail(f"LLM request failed with HTTP {error.code}.", detail),
    )


def _extract_error_code(error: urllib.error.HTTPError) -> str:
    try:
        payload = json.loads(error.read(_MAX_ERROR_BODY_BYTES).decode("utf-8"))
        code = payload.get("error")
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return ""
    return code if isinstance(code, str) else ""


def _extract_http_error_detail(error: urllib.error.HTTPError) -> str:
    try:
        raw_body = error.read(_MAX_ERROR_BODY_BYTES).decode("utf-8", errors="replace")
    except OSError:
        return ""

    raw_body = raw_body.strip()
    if not raw_body:
        return ""

    try:
        payload = json.loads(raw_body)
    except json.JSONDecodeError:
        return _compact_error_detail(raw_body)

    extracted = _extract_error_detail_from_json(payload)
    return _compact_error_detail(extracted or raw_body)


def _extract_error_detail_from_json(payload: object) -> str:
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            parts = [
                str(error.get(key)).strip() for key in ("code", "type", "message") if error.get(key)
            ]
            return ": ".join(parts)
        if isinstance(error, str):
            return error

        parts = [
            str(payload.get(key)).strip() for key in ("code", "type", "message") if payload.get(key)
        ]
        return ": ".join(parts)

    if isinstance(payload, str):
        return payload
    return ""


def _compact_error_detail(detail: str) -> str:
    compacted = " ".join(detail.split())
    if len(compacted) <= 300:
        return compacted
    return f"{compacted[:297]}..."


def _looks_like_content_safety_block(detail: str) -> bool:
    normalized = detail.lower()
    content_markers = (
        "content_policy",
        "content policy",
        "content_filter",
        "content filter",
        "content safety",
        "safety filter",
        "sensitive",
        "risk control",
    )
    return any(marker in normalized for marker in content_markers)


def _with_provider_detail(message: str, detail: str) -> str:
    if not detail:
        return message
    suffix = "" if detail.endswith((".", "!", "?")) else "."
    return f"{message} Provider detail: {detail}{suffix}"


def _validate_llm_request_config(
    api_key: object,
    model: object,
    base_url: object,
    timeout_seconds: object,
) -> None:
    if not isinstance(api_key, str) or not api_key.strip():
        raise ValueError("LLM API key is required.")
    if not isinstance(model, str) or not model.strip():
        raise ValueError("LLM model is required.")
    if (
        isinstance(timeout_seconds, bool)
        or not isinstance(timeout_seconds, (int, float))
        or timeout_seconds <= 0
    ):
        raise ValueError("LLM timeout must be positive.")
    _validate_http_url(base_url)


def _validate_managed_checkout_config(
    checkout_url: object,
    session_token: object,
    request_id: object,
) -> None:
    _validate_http_url(checkout_url)
    if not isinstance(session_token, str) or not session_token.strip():
        raise ValueError("Managed LLM session token is required.")
    if not isinstance(request_id, str) or not request_id.strip():
        raise ValueError("Managed LLM request id is required.")


def _validate_http_url(value: object) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("HTTP URL is required.")
    raw_value = value.strip()
    if "\\" in raw_value or "%5c" in raw_value.lower():
        raise ValueError("HTTP URL contains an invalid path separator.")
    try:
        parsed = urlsplit(raw_value)
        hostname = parsed.hostname
        _ = parsed.port
    except ValueError as exc:
        raise ValueError("HTTP URL is invalid.") from exc
    if (
        parsed.scheme not in {"http", "https"}
        or not hostname
        or any(character.isspace() for character in parsed.netloc)
        or parsed.username is not None
        or parsed.password is not None
        or bool(parsed.query)
        or bool(parsed.fragment)
    ):
        raise ValueError("HTTP URL is invalid.")


def _safe_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        port = parsed.port
    except (TypeError, ValueError):
        return "<invalid-url>"
    if parsed.scheme not in {"http", "https"} or not hostname:
        return "<invalid-url>"
    safe_hostname = f"[{hostname}]" if ":" in hostname else hostname
    netloc = safe_hostname if port is None else f"{safe_hostname}:{port}"
    return urlunsplit((parsed.scheme, netloc, parsed.path or "/", "", ""))


def _safe_log_value(value: object) -> str:
    normalized = " ".join(str(value).split())
    return normalized[:160] if normalized else "-"


def _log_request_success(
    stage: str,
    url: str,
    provider: str,
    model: str,
    request_id: str | None,
    started_at: float,
) -> None:
    LOGGER.debug(
        "llm_request stage=%s url=%s provider=%s model=%s request_id=%s duration_ms=%d status=success",
        stage,
        _safe_url(url),
        _safe_log_value(provider),
        _safe_log_value(model),
        _safe_log_value(request_id or "-"),
        max(0, round((time.monotonic() - started_at) * 1000)),
    )


def _log_request_failure(
    stage: str,
    url: str,
    provider: str,
    model: str,
    request_id: str | None,
    started_at: float,
    error: InsightGenerationError,
    cause: BaseException,
    *,
    http_status: int | None = None,
) -> None:
    LOGGER.warning(
        "llm_request stage=%s url=%s provider=%s model=%s request_id=%s duration_ms=%d status=error http_status=%s error_code=%s exception=%s",
        stage,
        _safe_url(url),
        _safe_log_value(provider),
        _safe_log_value(model),
        _safe_log_value(request_id or "-"),
        max(0, round((time.monotonic() - started_at) * 1000)),
        http_status if http_status is not None else "-",
        error.code,
        type(cause).__name__,
    )


def parse_timeout(raw_value: str | None) -> float:
    if raw_value is None:
        return DEFAULT_LLM_TIMEOUT_SECONDS

    try:
        timeout = float(raw_value)
    except ValueError:
        return DEFAULT_LLM_TIMEOUT_SECONDS

    return timeout if timeout > 0 else DEFAULT_LLM_TIMEOUT_SECONDS


def urlopen_transport(request: Request, timeout: float) -> bytes:
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return _read_bounded_response(response, MAX_LLM_RESPONSE_BYTES)


def _read_bounded_response(response: object, max_bytes: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = response.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise InsightGenerationError(
                "INSIGHTFLOW_LLM_RESPONSE_TOO_LARGE",
                "LLM response exceeded the maximum allowed size.",
            )
        chunks.append(chunk)
    return b"".join(chunks)


def _timeout_message(timeout_seconds: float) -> str:
    timeout_label = f"{timeout_seconds:g}"
    return (
        f"LLM request timed out after {timeout_label} seconds. "
        "Ask the administrator to increase the server-managed timeout and retry."
    )


def extract_chat_completion_content(raw_response: bytes) -> str:
    try:
        payload = json.loads(raw_response.decode("utf-8"))
        choices = payload["choices"]
        content = choices[0]["message"]["content"]
    except (KeyError, IndexError, TypeError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise InsightGenerationError(
            "INSIGHTFLOW_LLM_INVALID_RESPONSE",
            "LLM response did not contain a usable chat completion message.",
        ) from exc

    if not isinstance(content, str) or not content.strip():
        raise InsightGenerationError(
            "INSIGHTFLOW_LLM_INVALID_RESPONSE",
            "LLM response did not contain a usable chat completion message.",
        )

    return content
