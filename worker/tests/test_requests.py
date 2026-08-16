from __future__ import annotations

import pytest
from studymind_worker.requests import (
    parse_process_local_media_request,
    parse_retry_insights_request,
)


def local_audio_request(source_path, display_name: str) -> dict[str, object]:
    return {
        "contract_version": 4,
        "source_path": str(source_path),
        "media_kind": "audio",
        "safe_display_name": display_name,
        "source_extension": "m4a",
        "asr_model": "iic/SenseVoiceSmall",
    }


def learning_snapshot() -> dict[str, object]:
    return {
        "profile": {
            "role": "student",
            "domain": "science_engineering",
            "stage": "beginner",
            "learningContext": "lecture",
            "knowledgeLevel": "new_to_topic",
            "studyMethods": ["note_taking", "practice_questions"],
        },
        "profileSkipped": False,
        "generationPreferences": {
            "goal": "understand_concepts",
            "scenario": "class_notes",
            "angles": ["core_concepts", "practice_questions"],
            "audience": "self",
            "styles": ["structured"],
            "avoid": [],
        },
        "labelSnapshot": {
            "profile": [
                {
                    "field": "learningContext",
                    "label": "Learning context",
                    "values": [{"id": "lecture", "label": "Lecture"}],
                }
            ],
            "generationPreferences": [],
        },
    }


def test_retry_request_parses_learning_snapshot_without_creator_fields() -> None:
    request = parse_retry_insights_request(
        {
            "task_id": "local-lecture-1",
            "target": "insights",
            "output_language": "en-US",
            "preference_snapshot": learning_snapshot(),
        }
    )

    assert request.preference_snapshot is not None
    assert request.preference_snapshot.profile is not None
    assert request.preference_snapshot.profile.learning_context == "lecture"
    assert request.preference_snapshot.profile.study_methods == (
        "note_taking",
        "practice_questions",
    )


@pytest.mark.parametrize(
    "display_name",
    [
        "private/lecture.m4a",
        "private\\lecture.m4a",
        "lecture\u0000.m4a",
        "lecture\u202e.m4a",
    ],
)
def test_local_media_request_rejects_unsafe_unicode_basename_characters(
    tmp_path,
    display_name: str,
) -> None:
    with pytest.raises(ValueError, match="Local media request payload was invalid"):
        parse_process_local_media_request(
            local_audio_request(tmp_path / "秋实西街 4.m4a", display_name)
        )


@pytest.mark.parametrize("legacy_field", ["cityContext", "genderPerspective", "platforms"])
def test_retry_request_rejects_legacy_creator_profile_fields(legacy_field: str) -> None:
    snapshot = learning_snapshot()
    profile = snapshot["profile"]
    assert isinstance(profile, dict)
    profile[legacy_field] = "legacy"

    with pytest.raises(ValueError):
        parse_retry_insights_request(
            {
                "task_id": "local-lecture-1",
                "target": "insights",
                "output_language": "en-US",
                "preference_snapshot": snapshot,
            }
        )
