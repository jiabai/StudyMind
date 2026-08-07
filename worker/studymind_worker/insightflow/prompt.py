from __future__ import annotations

import json

from studymind_worker.insightflow.splitter import MarkdownChunk
from studymind_worker.models import PreferenceSnapshot
from studymind_worker.output_language import (
    OutputLanguage,
    output_language_semantics,
)

_MAP_SCHEMA_EXAMPLE = {
    "segments": [
        {
            "title": "knowledge segment title",
            "sourceChunkIds": [1],
            "coreClaim": "source-grounded core knowledge point",
            "supportingPoints": ["source-grounded supporting detail"],
            "rhetoricalDevices": ["teaching method and its effectiveness"],
            "rhythmNote": "information density and pacing observation",
            "reusablePattern": (
                "must-keep structural function; replaceable [content slot]; optional node; "
                "applicable type"
            ),
            "riskFlags": ["segment-specific concept requiring verification"],
        }
    ],
    "highlights": ["verbatim quotation from the supplied chunks"],
    "strengths": ["source-grounded pedagogical strength"],
    "weaknesses": ["source-grounded learning difficulty or gap"],
}

_FINAL_SCHEMA_EXAMPLE = {
    "overallNarrative": {
        "openingHook": "opening concept or null",
        "structureType": "overall knowledge progression structure",
        "turningPoint": "key insight transition or null",
        "closingType": "concluding type or null",
    },
    "segments": [
        {
            "id": 1,
            "title": "knowledge segment title",
            "sourceChunkIds": [1],
            "coreClaim": "source-grounded core knowledge point",
            "supportingPoints": ["source-grounded supporting detail"],
            "rhetoricalDevices": ["teaching method and its effectiveness"],
            "rhythmNote": "information density and pacing observation",
            "reusablePattern": (
                "must-keep structural function; replaceable [content slot]; optional node; "
                "applicable type"
            ),
            "riskFlags": ["segment-specific concept requiring verification"],
        }
    ],
    "highlights": ["verbatim quotation present in map data"],
    "reusableTemplate": {
        "name": "study template name",
        "skeleton": [
            "Required: introduce [learning objective]",
            "Required: support with [key evidence]",
            "Optional: close with [study action]",
        ],
    },
    "audienceFit": [
        {"audience": "learner level", "fit": "high", "note": "source-grounded reason"}
    ],
    "strengths": ["source-grounded pedagogical strength"],
    "weaknesses": ["source-grounded learning difficulty or gap"],
}


def _schema_example(value: dict[str, object]) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


def build_dissection_map_prompt(
    chunks: list[MarkdownChunk],
    output_language: OutputLanguage,
) -> str:
    semantics = output_language_semantics(output_language)
    source = [{"id": chunk.id, "content": chunk.content} for chunk in chunks]
    valid_chunk_ids = [chunk.id for chunk in chunks]
    return f"""# Transcript dissection map stage
{semantics.prompt_instruction}
Act as a senior education editor performing text-only structural analysis on a lecture or study
transcript. Analyze only the supplied transcript chunks. Do not infer visual, audio, speaking-rate,
or presentation style.

## Analysis dimensions
- Identify meaningful knowledge segments and topic boundaries, not arbitrary sentence groups.
- For every segment, state its core knowledge point, supporting details, teaching methods and their
  effectiveness, information density and pacing, a transferable study pattern, and cautious risk
  flags for concepts that may need verification.
- Treat risk flags only as concepts that may need further verification or areas where the explanation
  may be incomplete; never present them as completed fact-checks.
- Make reusable patterns actionable for study and note-taking transfer, but do not copy source
  wording as a template or invent a topic, learner, outcome, or fact.
- Treat reuse as study and content-structure transfer only. Each `reusablePattern` must name the
  structural function that must remain, show replaceable bracketed slots such as `[learning
  objective]` or `[key evidence]`, identify every optional or removable node, include applicable
  content types, and state any source-grounded inapplicability condition.
- Put segment-specific learning risks in `riskFlags`; put global learning limitations, prerequisite
  dependencies, and cases where the structure should not be reused in `weaknesses`.
- Never claim to analyze slides, board writing, voice, music, captions, or equipment.

## Output contract
- Return JSON only, without Markdown fences, commentary, or extra text.
- Return one closed object with exactly these four keys: `segments`, `highlights`, `strengths`, and
  `weaknesses`. Objects at every level must contain exactly the keys shown in the schema example.
- Return 1 through 8 segments for this batch. `supportingPoints`, `rhetoricalDevices`, and
  `riskFlags` each contain at most 6 concise strings.
- `highlights` contains at most 8 verbatim quotations from the supplied chunks.
- `strengths` and `weaknesses` each contain at most 6 source-grounded strings.
- Every `sourceChunkIds` array is non-empty, ascending, deduplicated, and contains only IDs from
  this batch. Legal sourceChunkIds for this batch: {valid_chunk_ids}
- Do not add facts, preferences, paths, URLs, prior AI results, or unknown fields.

## Exact intermediate JSON schema example
{_schema_example(_MAP_SCHEMA_EXAMPLE)}

## Transcript chunks
{json.dumps(source, ensure_ascii=False, separators=(",", ":"))}
"""


def build_dissection_reduce_prompt(
    map_results: list[dict[str, object]],
    output_language: OutputLanguage,
) -> str:
    semantics = output_language_semantics(output_language)
    return f"""# Transcript dissection reduce stage
{semantics.prompt_instruction}
Act as a senior education editor. Combine only the structured map results; do not add source text,
facts, preferences, paths, URLs, prior AI results, or visual/audio claims.

## Output contract
- Return JSON only, without Markdown fences, commentary, or extra text.
- Return one closed object with exactly these keys: `overallNarrative`, `segments`, `highlights`,
  `reusableTemplate`, `audienceFit`, `strengths`, and `weaknesses`. Nested objects must contain
  exactly the keys shown in the schema example.
- `openingHook`, `turningPoint`, and `closingType` are either a non-empty string or null.
  `structureType` is always a non-empty string.
- Segment `id` values are sequential integers starting at 1. Every `sourceChunkIds` array is
  non-empty, ascending, deduplicated, and uses only IDs present in the map results.
- `supportingPoints`, `rhetoricalDevices`, and `riskFlags` are arrays of concise strings. Risk flags
  use cautious language and never claim that fact-checking has been completed.
- `highlights` contains at most 8 items. Every item is a verbatim quotation already present in map
  data; never rewrite a quotation and still label it as source text.
- `reusableTemplate.skeleton` contains 3 through 7 actionable, transferable study steps and does
  not copy the source verbatim; preserve must-keep nodes, use replaceable bracketed slots in the
  required output language, mark every step as required or optional/removable, and include
  applicable content types in the template or corresponding segment patterns.
- Preserve optional or removable nodes and source-grounded applicability information from map data.
  Route segment-specific learning risks to `riskFlags` and store global transfer limits in
  `weaknesses`, including global inapplicability and prerequisite-dependent constraints.
- Do not invent a topic, learner, performance outcome, or use case. Limit recommendations to
  study and content-structure transfer; never claim analysis of slides, board writing, voice,
  music, captions, equipment, or presentation style.
- Every `audienceFit.fit` is exactly one of `"high" | "medium" | "low"` and its note is grounded in
  the map results.
- `strengths` and `weaknesses` each contain at most 6 source-grounded strings.

## Exact final semantic JSON schema example
{_schema_example(_FINAL_SCHEMA_EXAMPLE)}

## Structured map results
{json.dumps(map_results, ensure_ascii=False, separators=(",", ":"))}
"""


def build_dissection_repair_prompt(
    invalid_result: object,
    output_language: OutputLanguage,
    *,
    valid_chunk_ids: tuple[int, ...],
    validation_category: str,
) -> str:
    semantics = output_language_semantics(output_language)
    return f"""# Transcript dissection repair stage
{semantics.prompt_instruction}
Repair this structured candidate to the exact final semantic schema below.

## Repair context
- Validation category: {validation_category}
- Legal sourceChunkIds: {list(valid_chunk_ids)}

## Repair rules
- Return JSON only, without Markdown fences, commentary, or extra text.
- You may add required schema fields that are missing and remove unknown fields.
- Populate added fields only by reorganizing evidence already present in the candidate. Use null for
  missing optional narrative fields and empty arrays where the schema permits them.
- Do not invent facts, quotations, or chunk IDs. Never use a chunk ID outside the legal list.
- Preserve every valid source-grounded value that already satisfies the schema.
- Repair structure and preserve actionable study guidance already present in the candidate,
  including required versus optional nodes and replaceable bracketed slots.
- Preserve applicability and inapplicability plus learning risks. Repair
  structure only; do not manufacture missing study evidence, topics, learners, outcomes, or
  use cases.
- Keep advice limited to study and content-structure transfer. Never add claims about slides,
  board writing, voice, music, captions, equipment, or presentation style.
- Enforce sequential segment IDs, ordered unique non-empty sourceChunkIds, the
  `"high" | "medium" | "low"` fit enum, at most 8 highlights, at most 6 strengths and weaknesses,
  and 3 through 7 reusable-template steps.

## Exact final semantic JSON schema example
{_schema_example(_FINAL_SCHEMA_EXAMPLE)}

## Invalid structured candidate
{json.dumps(invalid_result, ensure_ascii=False, separators=(",", ":"))}
"""


def build_topic_plan_prompt(
    text: str,
    output_language: OutputLanguage,
    max_topics: int = 8,
    max_questions: int = 12,
    preference_snapshot: PreferenceSnapshot | None = None,
) -> str:
    semantics = output_language_semantics(output_language)
    preference_prompt_section = ""
    if preference_snapshot is not None:
        preference_prompt_section = f"""
## Personalization snapshot
Use this JSON only to select, rank, and assign `question_count` to knowledge segments.
Do not use it for a summary or mindmap. Treat `profile.platforms` as background context.
If it differs from `generationPreferences.scenario`, follow the current scenario.
Transcript evidence wins over all preferences.
Use `labelSnapshot` only to understand option meaning.
```json
{format_preference_snapshot_for_prompt(preference_snapshot)}
```
"""

    return f"""
# Role
You are a knowledge-segment planner for lecture transcripts. Do not generate questions yet. Divide
a lecture or study transcript that may have no natural sections into semantic knowledge segments
suitable for later study guidance.

## Output-language contract
{semantics.prompt_instruction}

## Task
Extract at most {max_topics} high-value knowledge segments from the transcript ({len(text)} characters).
{preference_prompt_section}

## Planning rules
- Ignore greetings, repetition, filler, empty setup, and transitions.
- Prefer core concepts, methods, definitions, examples, explanations, cause-effect relationships,
  key decisions, and transferable study insights.
- Personalization may affect only priority, order, and `question_count`; never invent facts.
- The transcript wins whenever a preference conflicts with it.
- Keep one main knowledge topic per segment.
- `excerpt` must come from the transcript or faithfully compress its wording.
- Set `question_count` from 1 through 3 according to topic density.
- The sum of all `question_count` values must not exceed {max_questions}.

## Output format
- Output only a JSON array, with no explanation, Markdown wrapper, or extra text.
- Keep these JSON keys and this schema exactly:
```json
[
  {{
    "id": 1,
    "title": "{semantics.topic_example_title}",
    "summary": "{semantics.topic_example_summary}",
    "excerpt": "{semantics.topic_example_excerpt}",
    "question_count": 2
  }}
]
```

## Transcript
{text}
"""


def build_question_prompt(
    text: str,
    number: int,
    output_language: OutputLanguage,
    global_prompt: str = "",
    question_prompt: str = "",
    preference_snapshot: PreferenceSnapshot | None = None,
) -> str:
    semantics = output_language_semantics(output_language)
    global_prompt_section = ""
    if global_prompt:
        global_prompt_section = f"""
## Additional global constraints
{global_prompt}
"""

    question_prompt_section = ""
    if question_prompt:
        question_prompt_section = f"""
## Additional constraints for this request
{question_prompt}
"""

    preference_prompt_section = ""
    if preference_snapshot is not None:
        preference_prompt_section = f"""
## Personalization snapshot
Use this JSON only to generate study guidance, not a summary or mindmap.
Treat `profile.platforms` as background context. If it differs from
`generationPreferences.scenario`, follow the current scenario.
Transcript evidence wins over all preferences.
Use `labelSnapshot` only to understand option meaning.
```json
{format_preference_snapshot_for_prompt(preference_snapshot)}
```
"""

    return f"""
# Role
You are a study companion and knowledge curator. Extract open-ended, thought-provoking questions
that help learners deepen their understanding of the lecture material.
{global_prompt_section}
{preference_prompt_section}

## Output-language contract
{semantics.prompt_instruction}

## Task
Generate at least {number} high-quality study questions from the text ({len(text)} characters).
Every question must encourage deeper thinking and knowledge application.
{question_prompt_section}

## Generation rules
- Prefer conceptual understanding, method application, cause-effect analysis, comparison,
  evaluation, and implementation angles.
- Do not ask learners to simply repeat what was said. Encourage synthesis and application.
- Treat specific examples as context, not the grammatical subject of the question by default.
- Make each question open, concrete, discussable, natural, and easy to understand.
- Keep one main thought per question and avoid nested clauses or abstract noun piles.
- Do not generate fact checks, definitions, rote memorization, exams, or translation-like templates.

## Output format
- Output a valid JSON array only.
- Keep these JSON keys and this schema exactly:
```json
[
  {{
    "topic": "{semantics.question_example_topic}",
    "matchReason": "{semantics.question_example_reason}",
    "followUpQuestions": ["{semantics.question_example_follow_up}"],
    "suitableUse": "{semantics.question_example_use}"
  }}
]
```

## Source text
{text}
"""


def format_preference_snapshot_for_prompt(snapshot: PreferenceSnapshot) -> str:
    return json.dumps(
        {
            "profile": _profile_to_prompt_dict(snapshot),
            "profileSkipped": snapshot.profile_skipped,
            "generationPreferences": {
                "goal": snapshot.generation_preferences.goal,
                "scenario": snapshot.generation_preferences.scenario,
                "angles": list(snapshot.generation_preferences.angles),
                "audience": snapshot.generation_preferences.audience,
                "styles": list(snapshot.generation_preferences.styles),
                "avoid": list(snapshot.generation_preferences.avoid),
            },
            "labelSnapshot": {
                "profile": [
                    _label_snapshot_item_to_prompt_dict(item)
                    for item in snapshot.label_snapshot.profile
                ],
                "generationPreferences": [
                    _label_snapshot_item_to_prompt_dict(item)
                    for item in snapshot.label_snapshot.generation_preferences
                ],
            },
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _profile_to_prompt_dict(snapshot: PreferenceSnapshot) -> dict[str, object] | None:
    if snapshot.profile is None:
        return None
    return {
        "role": snapshot.profile.role,
        "domain": snapshot.profile.domain,
        "stage": snapshot.profile.stage,
        "cityContext": snapshot.profile.city_context,
        "genderPerspective": snapshot.profile.gender_perspective,
        "platforms": list(snapshot.profile.platforms),
    }


def _label_snapshot_item_to_prompt_dict(item) -> dict[str, object]:
    return {
        "field": item.field,
        "label": item.label,
        "values": [
            {
                "id": value.id,
                "label": value.label,
            }
            for value in item.values
        ],
    }


def build_mindmap_prompt(
    text: str,
    output_language: OutputLanguage,
) -> str:
    semantics = output_language_semantics(output_language)
    return f"""
# Role
You organize knowledge mindmaps for study material. Extract the lecture's main topics, branches,
and hierarchy, then produce Mermaid mindmap source that can be saved directly to a local file.

## Output-language contract
{semantics.prompt_instruction}

## Task
Organize the transcript ({len(text)} characters) into a clear knowledge mindmap.

## Generation rules
- Prefer core concepts, methods, definitions, examples, cause-effect relationships, key conclusions,
  and transferable study insights.
- Remove greetings, repetition, filler, and empty transitions.
- Use the top node for the central topic and lower levels for knowledge branches and supporting points.
- Keep node labels short; do not write paragraph-length nodes.
- Do not add facts, numbers, people, or conclusions absent from the transcript.

## Output format
- Output only Mermaid mindmap source, with no explanation, code fence, or extra text.
- The first line must be `mindmap`.
- Preserve Mermaid syntax. Example:
mindmap
  root(({semantics.mindmap_example_root}))
    {semantics.mindmap_example_branch}
      {semantics.mindmap_example_point}

## Transcript
{text}
"""


def build_summary_prompt(
    transcript_markdown: str,
    mermaid_mindmap: str,
    output_language: OutputLanguage,
) -> str:
    semantics = output_language_semantics(output_language)
    return f"""
# Role
You are a study summary editor. Create a Key Summary from the source Transcript and Mermaid mindmap
for lecture review purposes.

## Output-language contract
{semantics.prompt_instruction}

## Inputs
### Transcript
{transcript_markdown}

### Mermaid mindmap
{mermaid_mindmap}

## Output requirements
- Output only the Markdown summary body, without Mermaid source, code fences, or reasoning.
- Start with the exact heading `# {semantics.summary_title}`.
- Then use `## {semantics.summary_overview_title}` followed by 2 through 6 knowledge topic sections
  with concise bullet points capturing key learning points.
- Stay faithful to the Transcript. The Mermaid mindmap may organize logic but adds no facts.
- Make the result suitable for direct UI display and copying; avoid empty generalities.
- Highlight key concepts, definitions, and actionable study insights.
"""
