from __future__ import annotations

import json

from studymind_worker.worker_application.local_media import run_local_media_once


def test_local_media_failure_is_structured_before_asr_factory_is_used(tmp_path) -> None:
    source_path = tmp_path / "lecture.mp4"
    request = {
        "contract_version": 4,
        "source_path": str(source_path),
        "media_kind": "video",
        "safe_display_name": "lecture.mp4",
        "source_extension": "mp4",
        "asr_model": "iic/SenseVoiceSmall",
    }

    result = run_local_media_once(
        json.dumps(request),
        project_root=tmp_path,
        allow_real_asr=False,
    )

    assert result["status"] == "failed"
    assert result["error"]["code"] == "LOCAL_FILE_NOT_FOUND"


def test_unicode_m4a_filename_reaches_media_preparation_instead_of_validation_failure(
    tmp_path,
) -> None:
    source_path = tmp_path / "秋实西街 4.m4a"
    request = {
        "contract_version": 4,
        "source_path": str(source_path),
        "media_kind": "audio",
        "safe_display_name": "秋实西街 4.m4a",
        "source_extension": "m4a",
        "asr_model": "iic/SenseVoiceSmall",
    }

    result = run_local_media_once(
        json.dumps(request, ensure_ascii=False),
        project_root=tmp_path,
        allow_real_asr=False,
    )

    assert result["status"] == "failed"
    assert result["error"]["code"] == "LOCAL_FILE_NOT_FOUND"
