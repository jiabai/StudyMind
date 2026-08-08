from __future__ import annotations

import io
import json
import urllib.error
from urllib.request import Request

import pytest
from studymind_worker.insightflow import InsightGenerationError
from studymind_worker.llm import ServerManagedInsightClient, parse_managed_checkout_response


def checkout_payload(**overrides: object) -> bytes:
    payload = {
        "provider": "openai_compatible",
        "base_url": "https://llm.example/v1",
        "model": "study-model",
        "api_key": "managed-secret",
        "timeout_seconds": 45,
        "quota_remaining": 19,
    }
    payload.update(overrides)
    return json.dumps(payload).encode()


def test_parse_managed_checkout_response_validates_the_exact_contract() -> None:
    assert parse_managed_checkout_response(checkout_payload()) == {
        "provider": "openai_compatible",
        "base_url": "https://llm.example/v1",
        "model": "study-model",
        "api_key": "managed-secret",
        "timeout_seconds": 45,
        "quota_remaining": 19,
    }


@pytest.mark.parametrize(
    "raw",
    [
        b"not-json",
        checkout_payload(api_key=""),
        checkout_payload(provider="unknown"),
        checkout_payload(quota_remaining=-1),
        checkout_payload(quota_remaining=True),
        checkout_payload(timeout_seconds=True),
        checkout_payload(timeout_seconds=0),
        checkout_payload(timeout_seconds=601),
        checkout_payload(timeout_seconds="45"),
        checkout_payload(provider=1),
        checkout_payload(base_url=["https://llm.example/v1"]),
        checkout_payload(model={"name": "study-model"}),
        checkout_payload(api_key=True),
        checkout_payload(extra_field="not-allowed"),
        json.dumps(["not", "an", "object"]).encode(),
        json.dumps({"provider": "openai"}).encode(),
        json.dumps(
            {
                "provider": "openai_compatible",
                "base_url": "https://llm.example/v1",
                "model": "study-model",
                "api_key": "managed-secret",
                "timeout_seconds": 45,
            }
        ).encode(),
    ],
)
def test_parse_managed_checkout_response_rejects_malformed_or_missing_values(raw: bytes) -> None:
    with pytest.raises(InsightGenerationError, match="did not return usable configuration") as raised:
        parse_managed_checkout_response(raw)
    assert raised.value.code == "INSIGHTFLOW_LLM_CHECKOUT_INVALID_RESPONSE"


@pytest.mark.parametrize(
    ("status", "body", "expected_code"),
    [
        (401, {"error": "AUTH_REQUIRED"}, "INSIGHTFLOW_LLM_AUTH_REQUIRED"),
        (403, {"error": "LLM_QUOTA_UNAVAILABLE"}, "INSIGHTFLOW_LLM_QUOTA_UNAVAILABLE"),
        (503, {"error": "LLM_CONFIG_MISSING"}, "INSIGHTFLOW_LLM_CONFIG_MISSING"),
    ],
)
def test_managed_client_maps_checkout_errors(status: int, body: dict[str, str], expected_code: str) -> None:
    def transport(request: Request, timeout: float) -> bytes:
        raise urllib.error.HTTPError(request.full_url, status, "failure", {}, io.BytesIO(json.dumps(body).encode()))

    client = ServerManagedInsightClient("https://server.example/api/desktop/llm/checkouts", "session-secret", "lesson-run-0001", transport=transport)
    with pytest.raises(InsightGenerationError) as raised:
        client.generate("prompt")
    assert raised.value.code == expected_code
    assert "session-secret" not in str(raised.value)


def test_managed_client_uses_per_call_request_ids_and_keeps_session_auth_off_provider_requests() -> None:
    seen: list[tuple[str, str, dict[str, object]]] = []

    def transport(request: Request, timeout: float) -> bytes:
        body = json.loads((request.data or b"{}").decode())
        authorization = request.get_header("Authorization") or ""
        seen.append((request.full_url, authorization, body))
        if request.full_url.endswith("/checkouts"):
            return checkout_payload()
        return json.dumps({"choices": [{"message": {"content": "summary"}}]}).encode()

    client = ServerManagedInsightClient("https://server.example/checkouts", "session-secret", "lesson-run-0001", transport=transport)
    assert client.generate("first prompt") == "summary"
    assert client.generate("second prompt") == "summary"
    checkout_calls = [call for call in seen if call[0].endswith("/checkouts")]
    provider_calls = [call for call in seen if not call[0].endswith("/checkouts")]
    assert [call[2]["request_id"] for call in checkout_calls] == ["lesson-run-0001-call-0001", "lesson-run-0001-call-0002"]
    assert all(call[1] == "Bearer session-secret" for call in checkout_calls)
    assert all(call[1] == "Bearer managed-secret" for call in provider_calls)
    assert all("session-secret" not in json.dumps(call) for call in provider_calls)
