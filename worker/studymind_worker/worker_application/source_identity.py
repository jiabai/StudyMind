from __future__ import annotations

import json

from studymind_worker.source_identity import SourceIdentityError
from studymind_worker.worker_application import defaults


def resolve_source_identity_once(
    request_json: str,
    source_request_resolver: SourceRequestResolver = (
        defaults.DEFAULT_SOURCE_RESOLVER.resolve_request
    ),
) -> dict[str, object]:
    try:
        payload = json.loads(request_json)
    except json.JSONDecodeError:
        return {
            "status": "failed",
            "error": {"code": "INVALID_SOURCE_IDENTITY_JSON"},
        }
    raw_url = payload.get("url") if isinstance(payload, dict) else None
    if not isinstance(raw_url, str) or not raw_url.strip():
        return {
            "status": "failed",
            "error": {"code": "INVALID_SOURCE_IDENTITY_PAYLOAD"},
        }
    try:
        identity = source_request_resolver(raw_url).identity
    except SourceIdentityError:
        return {
            "status": "failed",
            "error": {"code": "SOURCE_IDENTITY_UNAVAILABLE"},
        }
    return {
        "status": "completed",
        "source_url": identity.canonical_url,
        "source_identity": identity.to_manifest_dict(),
    }
