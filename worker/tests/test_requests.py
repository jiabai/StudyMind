from __future__ import annotations

import pytest
from studymind_worker.requests import parse_retry_insights_request


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
