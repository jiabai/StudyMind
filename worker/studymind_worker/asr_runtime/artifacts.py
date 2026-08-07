from __future__ import annotations

import json
from pathlib import Path

from studymind_worker.asr_runtime.registry import DEFAULT_ASR_MODEL
from studymind_worker.asr_runtime.types import (
    ASREmptyTranscriptError,
    Transcriber,
    TranscriptArtifacts,
    TranscriptSegment,
)
from studymind_worker.atomic_files import (
    AtomicFileCommitError,
    atomic_remove_file,
    atomic_write_bytes,
    platform_text_bytes,
)
from studymind_worker.models import TranscriptMetadata
from studymind_worker.task_transaction import (
    TaskArtifactCommitError,
    TaskArtifactRecoveryError,
    commit_task_artifacts,
)


def transcribe_and_write(
    audio_path: Path,
    output_dir: Path,
    output_stem: str,
    transcriber: Transcriber,
    language: str = "Chinese",
    model: str = DEFAULT_ASR_MODEL,
) -> TranscriptArtifacts:
    transcript = transcriber.transcribe(audio_path, language=language)
    return write_transcript_files(
        text=transcript.text,
        output_dir=output_dir,
        output_stem=output_stem,
        model=model,
        metadata=TranscriptMetadata(
            source="asr",
            language=None,
            engine=model,
        ),
        segments=transcript.segments,
    )


def write_transcript_files(
    text: str,
    output_dir: Path,
    output_stem: str,
    model: str | None = None,
    metadata: TranscriptMetadata | None = None,
    segments: tuple[TranscriptSegment, ...] = (),
) -> TranscriptArtifacts:
    cleaned_text = text.strip()
    if not cleaned_text:
        raise ASREmptyTranscriptError("ASR returned an empty transcript.")

    transcript_metadata = metadata or TranscriptMetadata(
        source="asr",
        language=None,
        engine=model,
    )

    if output_stem:
        txt_path = output_dir / f"{output_stem}_transcript.txt"
        md_path = output_dir / f"{output_stem}_transcript.md"
        segments_path = output_dir / f"{output_stem}_transcript_segments.json"
    else:
        txt_path = output_dir / "transcript.txt"
        md_path = output_dir / "transcript.md"
        segments_path = output_dir / "segments.json"

    txt_bytes = platform_text_bytes(f"{cleaned_text}\n")
    markdown_bytes = platform_text_bytes(
        _format_transcript_markdown(
            text=cleaned_text,
            metadata=transcript_metadata,
        )
    )
    segments_bytes = (
        platform_text_bytes(
            json.dumps(
                {"segments": [segment.to_json() for segment in segments]},
                ensure_ascii=False,
                indent=2,
            )
            + "\n"
        )
        if segments
        else None
    )

    output_dir.mkdir(parents=True, exist_ok=True)
    if output_stem == "" and output_dir.name == "transcript":
        try:
            commit_task_artifacts(
                output_dir.parent,
                {
                    "transcript/transcript.txt": txt_bytes,
                    "transcript/transcript.md": markdown_bytes,
                    "transcript/segments.json": segments_bytes,
                },
            )
        except (TaskArtifactCommitError, TaskArtifactRecoveryError):
            raise AtomicFileCommitError() from None
    else:
        atomic_write_bytes(txt_path, txt_bytes)
        atomic_write_bytes(md_path, markdown_bytes)
        if segments_bytes is None:
            atomic_remove_file(segments_path)
        else:
            atomic_write_bytes(segments_path, segments_bytes)

    return TranscriptArtifacts(
        text=cleaned_text,
        txt_path=txt_path,
        md_path=md_path,
        segments_path=segments_path if segments_bytes is not None else None,
    )


def _format_transcript_markdown(
    text: str,
    metadata: TranscriptMetadata,
) -> str:
    if metadata.source == "subtitle":
        source_lines = ["- Transcript Source: Platform subtitle"]
        if metadata.language:
            source_lines.append(f"- Subtitle Language: {metadata.language}")
    else:
        source_lines = ["- Transcript Source: Local ASR"]
        if metadata.engine:
            source_lines.append(f"- ASR Engine: {metadata.engine}")
            source_lines.append(f"- Model: {metadata.engine}")
    metadata_text = "\n".join(source_lines)
    return f"""# 视频文字稿

## Metadata

{metadata_text}

## Transcript

{text}
"""
