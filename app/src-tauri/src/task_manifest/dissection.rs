use crate::worker_runtime::{validate_task_dissection, TaskDissection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const INVALID_DISSECTION_ARTIFACT: &str = "Task dissection artifact is invalid.";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DissectionSourceStatus {
    Current,
    Stale,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct DissectionView {
    pub(crate) report: TaskDissection,
    pub(crate) source_status: DissectionSourceStatus,
}

pub(super) fn verify_dissection_source(
    report: &TaskDissection,
    transcript: &[u8],
) -> Result<DissectionSourceStatus, String> {
    if !validate_task_dissection(report) {
        return Err(INVALID_DISSECTION_ARTIFACT.to_string());
    }
    if sha256_hex(transcript) != report.source_transcript_sha256 {
        return Ok(DissectionSourceStatus::Stale);
    }

    let mut expected_start = 0usize;
    for chunk in &report.source_chunks {
        let start = usize::try_from(chunk.start_byte)
            .map_err(|_| INVALID_DISSECTION_ARTIFACT.to_string())?;
        let end =
            usize::try_from(chunk.end_byte).map_err(|_| INVALID_DISSECTION_ARTIFACT.to_string())?;
        if start != expected_start
            || end > transcript.len()
            || sha256_hex(&transcript[start..end]) != chunk.sha256
        {
            return Err(INVALID_DISSECTION_ARTIFACT.to_string());
        }
        expected_start = end;
    }
    if expected_start != transcript.len() {
        return Err(INVALID_DISSECTION_ARTIFACT.to_string());
    }
    Ok(DissectionSourceStatus::Current)
}

pub(super) fn build_dissection_view(
    report: TaskDissection,
    transcript: &[u8],
) -> Result<DissectionView, String> {
    let source_status = verify_dissection_source(&report, transcript)?;
    Ok(DissectionView {
        report,
        source_status,
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::{verify_dissection_source, DissectionSourceStatus};
    use crate::worker_runtime::TaskDissection;

    fn report() -> TaskDissection {
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "sourceTranscriptSha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            "sourceLanguage": null,
            "sourceChunks": [{"id": 1, "startByte": 0, "endByte": 3,
                "sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}],
            "overallNarrative": {"openingHook": null, "structureType": "statement",
                "turningPoint": null, "closingType": null},
            "segments": [{"id": 1, "title": "Opening", "sourceChunkIds": [1],
                "coreClaim": "abc", "supportingPoints": [], "rhetoricalDevices": [],
                "rhythmNote": "Brief", "reusablePattern": "Direct", "riskFlags": []}],
            "highlights": ["abc"],
            "reusableTemplate": {"name": "Direct", "skeleton": ["A", "B", "C"]},
            "audienceFit": [], "strengths": ["Direct"], "weaknesses": ["Brief"]
        }))
        .expect("valid report")
    }

    #[test]
    fn source_verification_distinguishes_current_and_stale_bytes() {
        assert_eq!(
            verify_dissection_source(&report(), b"abc").expect("verify current"),
            DissectionSourceStatus::Current
        );
        assert_eq!(
            verify_dissection_source(&report(), b"abd").expect("verify stale"),
            DissectionSourceStatus::Stale
        );
    }

    #[test]
    fn source_verification_rejects_structurally_invalid_ranges() {
        let mut invalid = report();
        invalid.source_chunks[0].end_byte = 4;
        assert!(verify_dissection_source(&invalid, b"abc").is_err());
    }
}
