use super::TranscriptSegmentView;
use crate::task_manifest;
use std::fs;
use std::path::Path;

pub(super) fn read_segments_sidecar(
    task: &task_manifest::SupportedTask,
) -> Result<Vec<TranscriptSegmentView>, String> {
    let path = task.artifact_path_or_default(
        task_manifest::TaskArtifact::Segments,
        "transcript/segments.json",
    )?;
    if !path.exists() {
        return Ok(vec![]);
    }
    validate_segments_path(task.task_dir(), &path)?;
    task.validate_existing_path(&path, task_manifest::TaskArtifact::Segments)?;
    let Ok(content) = fs::read_to_string(path) else {
        return Ok(vec![]);
    };
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(&content) else {
        return Ok(vec![]);
    };
    let Some(items) = payload
        .get("segments")
        .and_then(serde_json::Value::as_array)
    else {
        return Ok(vec![]);
    };

    Ok(items
        .iter()
        .filter_map(|item| segment_from_value(item).ok())
        .collect())
}

fn segment_from_value(value: &serde_json::Value) -> Result<TranscriptSegmentView, String> {
    let id = value
        .get("id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Transcript segment is missing id.".to_string())?
        .to_string();
    let start_ms = value
        .get("start_ms")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "Transcript segment is missing start_ms.".to_string())?;
    let end_ms = value
        .get("end_ms")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "Transcript segment is missing end_ms.".to_string())?;
    if end_ms <= start_ms {
        return Err("Transcript segment timing is invalid.".to_string());
    }
    let text = value
        .get("text")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Transcript segment is missing text.".to_string())?
        .to_string();
    let speaker = value
        .get("speaker")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    Ok(TranscriptSegmentView {
        id,
        start_ms,
        end_ms,
        text,
        speaker,
    })
}

pub(super) fn encode_segments_sidecar(
    segments: &[TranscriptSegmentView],
) -> Result<Vec<u8>, String> {
    for segment in segments {
        if segment.id.trim().is_empty() {
            return Err("Transcript segment id cannot be empty.".to_string());
        }
        if segment.end_ms <= segment.start_ms {
            return Err("Transcript segment timing is invalid.".to_string());
        }
    }
    Ok(
        (serde_json::to_string_pretty(&serde_json::json!({ "segments": segments }))
            .map_err(|_| "Failed to encode transcript segments.".to_string())?
            + "\n")
            .into_bytes(),
    )
}

pub(super) fn validate_segments_path(task_dir: &Path, path: &Path) -> Result<(), String> {
    if path == task_dir.join("transcript").join("segments.json") {
        Ok(())
    } else {
        Err("Task segments must be transcript/segments.json.".to_string())
    }
}
