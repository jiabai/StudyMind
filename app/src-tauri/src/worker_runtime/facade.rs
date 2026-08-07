use super::command::{build_worker_command_spec, WorkerInvocation};
use super::runner::{
    ProgressRoute, WorkerLane, WorkerOperation, WorkerRunError, WorkerRunOutcome, WorkerRunRequest,
};
use crate::account::{self, ServerManagedLlmInvocation};
use crate::RuntimePaths;
#[cfg(not(test))]
use tauri::Window;

pub(crate) struct AsrModelDownloadJob {
    asr_model: String,
    download_url: Option<String>,
    download_sha256: Option<String>,
    modelscope_endpoint: Option<String>,
    sensevoice_revision: Option<String>,
}

impl AsrModelDownloadJob {
    pub(crate) fn new(
        asr_model: String,
        download_url: Option<String>,
        download_sha256: Option<String>,
        modelscope_endpoint: Option<String>,
        sensevoice_revision: Option<String>,
    ) -> Self {
        Self {
            asr_model,
            download_url,
            download_sha256,
            modelscope_endpoint,
            sensevoice_revision,
        }
    }

    pub(super) fn asr_model(&self) -> &str {
        &self.asr_model
    }

    pub(super) fn download_url(&self) -> Option<&str> {
        self.download_url.as_deref()
    }

    pub(super) fn download_sha256(&self) -> Option<&str> {
        self.download_sha256.as_deref()
    }

    pub(super) fn modelscope_endpoint(&self) -> Option<&str> {
        self.modelscope_endpoint.as_deref()
    }

    pub(super) fn sensevoice_revision(&self) -> Option<&str> {
        self.sensevoice_revision.as_deref()
    }
}

pub(crate) enum WorkerJob {
    ProcessVideo {
        payload: String,
        progress: ProgressRoute,
    },
    ProcessLocalMedia {
        payload: String,
        progress: ProgressRoute,
    },
    ResolveSourceIdentity {
        payload: String,
    },
    RetryInsights {
        payload: String,
        progress: ProgressRoute,
    },
}

impl WorkerJob {
    #[cfg(not(test))]
    pub(crate) fn process_video(payload: String, window: Window) -> Self {
        Self::ProcessVideo {
            payload,
            progress: ProgressRoute::worker(window),
        }
    }

    #[cfg(test)]
    pub(crate) fn process_video<T>(payload: String, window: T) -> Self {
        Self::ProcessVideo {
            payload,
            progress: ProgressRoute::worker(window),
        }
    }

    #[cfg(not(test))]
    pub(crate) fn process_local_media(payload: String, window: Window) -> Self {
        Self::ProcessLocalMedia {
            payload,
            progress: ProgressRoute::worker(window),
        }
    }

    #[cfg(test)]
    pub(crate) fn process_local_media<T>(payload: String, window: T) -> Self {
        Self::ProcessLocalMedia {
            payload,
            progress: ProgressRoute::worker(window),
        }
    }

    pub(crate) fn resolve_source_identity(payload: String) -> Self {
        Self::ResolveSourceIdentity { payload }
    }

    #[cfg(not(test))]
    pub(crate) fn retry_insights(payload: String, window: Window) -> Self {
        Self::RetryInsights {
            payload,
            progress: ProgressRoute::worker(window),
        }
    }

    #[cfg(test)]
    pub(crate) fn retry_insights<T>(payload: String, window: T) -> Self {
        Self::RetryInsights {
            payload,
            progress: ProgressRoute::worker(window),
        }
    }
}

pub(crate) struct TaskWorkerFacade<'a> {
    paths: &'a RuntimePaths,
    lane: &'a WorkerLane,
}

impl<'a> TaskWorkerFacade<'a> {
    pub(super) fn new(paths: &'a RuntimePaths, lane: &'a WorkerLane) -> Self {
        Self { paths, lane }
    }

    pub(crate) fn execute(
        &self,
        job: WorkerJob,
    ) -> Result<Result<WorkerRunOutcome, WorkerRunError>, String> {
        let request = self.prepare_with(job, account::server_managed_llm_invocation)?;
        Ok(self.lane.run(self.paths, request))
    }

    fn prepare_with<F>(&self, job: WorkerJob, resolve_llm: F) -> Result<WorkerRunRequest, String>
    where
        F: FnOnce(&RuntimePaths) -> Result<Option<ServerManagedLlmInvocation>, String>,
    {
        let (invocation, operation, progress, needs_llm) = match job {
            WorkerJob::ProcessVideo { payload, progress } => (
                WorkerInvocation::ProcessVideo(payload),
                WorkerOperation::ProcessVideo,
                progress,
                false,
            ),
            WorkerJob::ProcessLocalMedia { payload, progress } => (
                WorkerInvocation::ProcessLocalMedia(payload),
                WorkerOperation::ProcessLocalMedia,
                progress,
                false,
            ),
            WorkerJob::ResolveSourceIdentity { payload } => (
                WorkerInvocation::ResolveSourceIdentity(payload),
                WorkerOperation::ResolveSourceIdentity,
                ProgressRoute::None,
                false,
            ),
            WorkerJob::RetryInsights { payload, progress } => (
                WorkerInvocation::RetryInsights(payload),
                WorkerOperation::RetryInsights,
                progress,
                true,
            ),
        };
        let llm = if needs_llm {
            resolve_llm(self.paths)?
        } else {
            None
        };
        let command = build_worker_command_spec(self.paths, invocation, llm)?;
        Ok(WorkerRunRequest {
            operation,
            command,
            progress,
        })
    }

    #[cfg(test)]
    fn prepare_for_test<F>(
        &self,
        job: WorkerJob,
        resolve_llm: F,
    ) -> Result<WorkerRunRequest, String>
    where
        F: FnOnce(&RuntimePaths) -> Result<Option<ServerManagedLlmInvocation>, String>,
    {
        self.prepare_with(job, resolve_llm)
    }
}

#[cfg(test)]
mod typed_job_policy_tests {
    use super::super::runner::{ProgressRoute, WorkerOperation};
    use super::super::ProcessSupervisors;
    use super::WorkerJob;
    use crate::account::ServerManagedLlmInvocation;
    use crate::RuntimePaths;
    use std::cell::Cell;
    use std::path::PathBuf;
    use std::time::Duration;

    fn assert_watchdog_policy(
        operation: WorkerOperation,
        idle_timeout: Option<Duration>,
        absolute_timeout: Duration,
    ) {
        let policy = operation.watchdog_policy();
        assert_eq!(policy.idle_timeout(), idle_timeout);
        assert_eq!(policy.absolute_timeout(), absolute_timeout);
    }

    fn runtime_paths() -> RuntimePaths {
        RuntimePaths {
            resource_dir: PathBuf::from("StudyMind-test").join("resources"),
            user_data_dir: PathBuf::from("StudyMind-test").join("user-data"),
        }
    }

    fn server_llm() -> ServerManagedLlmInvocation {
        ServerManagedLlmInvocation {
            server_base_url: "http://127.0.0.1:8787".to_string(),
            session_token: "desktop-token".to_string(),
            request_id: "llm-run-12345678".to_string(),
        }
    }

    #[test]
    fn process_video_job_derives_worker_progress_and_never_resolves_llm() {
        let paths = runtime_paths();
        let supervisors = ProcessSupervisors::default();
        let resolver_calls = Cell::new(0);
        let payload = r#"{"contract_version":3,"url":"https://example.test/video","asr_model":"iic/SenseVoiceSmall"}"#;

        let request = supervisors
            .task_worker(&paths)
            .prepare_for_test(WorkerJob::process_video(payload.to_string(), ()), |_| {
                resolver_calls.set(resolver_calls.get() + 1);
                Ok(Some(server_llm()))
            })
            .expect("prepare process-video job");

        assert_eq!(request.operation, WorkerOperation::ProcessVideo);
        assert_watchdog_policy(
            request.operation,
            Some(Duration::from_secs(45 * 60)),
            Duration::from_secs(8 * 60 * 60),
        );
        assert!(matches!(request.progress, ProgressRoute::Worker));
        assert_eq!(
            request.command.args,
            vec!["-m", "studymind_worker", "--request-stdin"]
        );
        assert_eq!(request.command.stdin_payload.as_deref(), Some(payload));
        assert_eq!(resolver_calls.get(), 0);
        assert!(!request
            .command
            .env
            .iter()
            .any(|(key, _)| key.starts_with("STUDYMIND_LLM_")));
    }

    #[test]
    fn process_local_media_job_uses_task_lane_stdin_progress_watchdog_and_no_llm() {
        let paths = runtime_paths();
        let supervisors = ProcessSupervisors::default();
        let resolver_calls = Cell::new(0);
        let payload = r#"{"contract_version":4,"source_path":"C:\\Users\\review-secret\\Interview.wmv","media_kind":"video","safe_display_name":"Interview.wmv","source_extension":"wmv","asr_model":"iic/SenseVoiceSmall"}"#;

        let request = supervisors
            .task_worker(&paths)
            .prepare_for_test(
                WorkerJob::process_local_media(payload.to_string(), ()),
                |_| {
                    resolver_calls.set(resolver_calls.get() + 1);
                    Ok(Some(server_llm()))
                },
            )
            .expect("prepare local-media job");

        assert_eq!(request.operation, WorkerOperation::ProcessLocalMedia);
        assert_watchdog_policy(
            request.operation,
            Some(Duration::from_secs(45 * 60)),
            Duration::from_secs(8 * 60 * 60),
        );
        assert!(matches!(request.progress, ProgressRoute::Worker));
        assert_eq!(
            request.command.args,
            vec!["-m", "studymind_worker", "--process-local-media-stdin"]
        );
        assert_eq!(request.command.stdin_payload.as_deref(), Some(payload));
        assert_eq!(resolver_calls.get(), 0);
        assert!(!request
            .command
            .args
            .iter()
            .any(|arg| arg.contains("review-secret")));
        assert!(!request
            .command
            .env
            .iter()
            .any(|(_, value)| value.contains("review-secret")));
        assert!(!request
            .command
            .env
            .iter()
            .any(|(key, _)| key.starts_with("STUDYMIND_LLM_")));
    }

    #[test]
    fn source_identity_job_derives_silent_progress_and_never_resolves_llm() {
        let paths = runtime_paths();
        let supervisors = ProcessSupervisors::default();
        let resolver_calls = Cell::new(0);
        let payload = r#"{"url":"https://example.test/video"}"#;

        let request = supervisors
            .task_worker(&paths)
            .prepare_for_test(
                WorkerJob::resolve_source_identity(payload.to_string()),
                |_| {
                    resolver_calls.set(resolver_calls.get() + 1);
                    Ok(Some(server_llm()))
                },
            )
            .expect("prepare source-identity job");

        assert_eq!(request.operation, WorkerOperation::ResolveSourceIdentity);
        assert_watchdog_policy(request.operation, None, Duration::from_secs(3 * 60));
        assert!(matches!(request.progress, ProgressRoute::None));
        assert_eq!(
            request.command.args,
            vec!["-m", "studymind_worker", "--resolve-source-stdin"]
        );
        assert_eq!(request.command.stdin_payload.as_deref(), Some(payload));
        assert_eq!(resolver_calls.get(), 0);
    }

    #[test]
    fn retry_insights_job_derives_worker_progress_and_resolves_llm_once() {
        let paths = runtime_paths();
        let supervisors = ProcessSupervisors::default();
        let resolver_calls = Cell::new(0);
        let payload = r#"{"task_id":"safe-task","target":"summary","output_language":"en-US"}"#;

        let request = supervisors
            .task_worker(&paths)
            .prepare_for_test(WorkerJob::retry_insights(payload.to_string(), ()), |_| {
                resolver_calls.set(resolver_calls.get() + 1);
                Ok(Some(server_llm()))
            })
            .expect("prepare retry-insights job");
        let env = request.command.env_map();

        assert_eq!(request.operation, WorkerOperation::RetryInsights);
        assert_watchdog_policy(
            request.operation,
            Some(Duration::from_secs(30 * 60)),
            Duration::from_secs(90 * 60),
        );
        assert!(matches!(request.progress, ProgressRoute::Worker));
        assert_eq!(
            request.command.args,
            vec!["-m", "studymind_worker", "--retry-insights-stdin"]
        );
        assert_eq!(request.command.stdin_payload.as_deref(), Some(payload));
        assert_eq!(resolver_calls.get(), 1);
        assert_eq!(env.get("STUDYMIND_LLM_SOURCE"), Some(&"server".to_string()));
        assert_eq!(
            env.get("STUDYMIND_LLM_SESSION_TOKEN"),
            Some(&"desktop-token".to_string())
        );
    }

    #[test]
    fn caller_payload_cannot_override_operation_owned_watchdog_policy() {
        let paths = runtime_paths();
        let supervisors = ProcessSupervisors::default();
        let spoofed_payload = r#"{"contract_version":3,"url":"https://example.test/video","asr_model":"iic/SenseVoiceSmall","timeout":0,"idle_timeout":0,"deadline":0,"watchdog":{"disabled":true}}"#;

        let request = supervisors
            .task_worker(&paths)
            .prepare_for_test(
                WorkerJob::process_video(spoofed_payload.to_string(), ()),
                |_| panic!("process video must not resolve LLM configuration"),
            )
            .expect("prepare process-video job with spoofed timeout fields");

        assert_eq!(
            request.command.stdin_payload.as_deref(),
            Some(spoofed_payload),
            "the facade transports opaque worker JSON but never interprets timeout-like fields",
        );
        assert_watchdog_policy(
            request.operation,
            Some(Duration::from_secs(45 * 60)),
            Duration::from_secs(8 * 60 * 60),
        );
    }
}
