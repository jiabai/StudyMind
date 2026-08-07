"""Worker service entry-point facade.

Historically re-exported the URL-based `run_worker_once` pipeline; that path was
removed when StudyMind dropped social-platform source tracking (see ADR-0001).
The live worker entry-points (`run_local_media_once`, `retry_insights_once`,
`run_asr_model_download_once`) live in :mod:`studymind_worker.worker_application`.
"""
