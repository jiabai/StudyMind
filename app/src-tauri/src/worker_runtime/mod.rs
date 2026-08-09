mod command;
mod facade;
mod result_protocol;
mod runner;
mod supervisor;

use command::build_asr_model_download_command_spec;
pub(crate) use facade::{AsrModelDownloadJob, TaskWorkerFacade, WorkerJob};
#[cfg(test)]
pub(crate) use result_protocol::{TaskError, TaskErrorStage, TaskTerminalStatus};
pub(crate) use result_protocol::{
    validate_task_dissection, ModelDownloadTerminalResult, TaskDissection, TaskTerminalResult,
    ValidatedWorkerResult, WORKER_PROTOCOL_MESSAGE, WORKER_PROTOCOL_VIOLATION,
};
#[cfg(test)]
pub(crate) use runner::WorkerExitSummary;
use runner::{ProgressRoute, WorkerLane, WorkerOperation, WorkerRunRequest};
pub(crate) use runner::{WorkerRunError, WorkerRunErrorKind, WorkerRunOutcome, WorkerTimeoutKind};
pub(crate) use supervisor::CancelProcessResult;
use tauri::Window;

use crate::RuntimePaths;

#[derive(Default)]
pub(crate) struct ProcessSupervisors {
    task: WorkerLane,
    asr_model_download: WorkerLane,
}

impl ProcessSupervisors {
    pub(crate) fn task_worker<'a>(&'a self, paths: &'a RuntimePaths) -> TaskWorkerFacade<'a> {
        TaskWorkerFacade::new(paths, &self.task)
    }

    pub(crate) fn cancel_task(&self) -> CancelProcessResult {
        self.task.cancel()
    }

    pub(crate) fn is_task_active(&self) -> bool {
        self.task.is_active()
    }

    pub(crate) fn run_asr_model_download(
        &self,
        paths: &RuntimePaths,
        job: AsrModelDownloadJob,
        window: Window,
    ) -> Result<Result<WorkerRunOutcome, WorkerRunError>, String> {
        let request = prepare_asr_model_download_request(
            paths,
            job,
            ProgressRoute::asr_model_download(window),
        )?;
        Ok(self.asr_model_download.run(paths, request))
    }

    pub(crate) fn cancel_asr_model_download(&self) -> CancelProcessResult {
        self.asr_model_download.cancel()
    }

    #[cfg(test)]
    pub(crate) fn activate_task_for_test(&self, pid: u32) -> u64 {
        self.task.activate_for_test(pid)
    }

    #[cfg(test)]
    pub(crate) fn finish_task_for_test(&self, instance_id: u64) {
        self.task.finish_for_test(instance_id);
    }
}

fn prepare_asr_model_download_request(
    paths: &RuntimePaths,
    job: AsrModelDownloadJob,
    progress: ProgressRoute,
) -> Result<WorkerRunRequest, String> {
    Ok(WorkerRunRequest {
        operation: WorkerOperation::DownloadAsrModel,
        command: build_asr_model_download_command_spec(paths, &job)?,
        progress,
    })
}

pub(crate) async fn run_blocking_worker_command<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("Worker command task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::facade::AsrModelDownloadJob;
    use super::{
        prepare_asr_model_download_request, run_blocking_worker_command, ProgressRoute,
        WorkerOperation,
    };
    use crate::RuntimePaths;
    use std::path::{Path, PathBuf};

    fn collect_rust_sources(dir: &Path, sources: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("read Rust source directory") {
            let path = entry.expect("read Rust source entry").path();
            if path.is_dir() {
                collect_rust_sources(&path, sources);
            } else if path.extension().and_then(|value| value.to_str()) == Some("rs") {
                sources.push(path);
            }
        }
    }

    #[test]
    fn asr_model_download_job_derives_selected_model_command_and_model_root() {
        let paths = RuntimePaths {
            resource_dir: PathBuf::from("StudyMind-test").join("resources"),
            user_data_dir: PathBuf::from("StudyMind-test").join("user-data"),
        };
        let job = AsrModelDownloadJob::new(
            "iic/SenseVoiceSmall-onnx".to_string(),
            None,
            None,
            None,
            None,
        );

        let request =
            prepare_asr_model_download_request(&paths, job, ProgressRoute::asr_model_download(()))
                .expect("prepare model-download request");

        assert_eq!(request.operation, WorkerOperation::DownloadAsrModel);
        assert!(matches!(request.progress, ProgressRoute::AsrModelDownload));
        assert_eq!(
            request.command.args,
            vec![
                "-m",
                "studymind_worker",
                "--download-asr-model",
                "--asr-model",
                "iic/SenseVoiceSmall-onnx",
            ]
        );
        assert_eq!(request.command.stdin_payload, None);
        assert_eq!(
            request.command.env_map().get("STUDYMIND_MODEL_DIR"),
            Some(&"StudyMind-test/user-data/models".to_string())
        );
    }

    #[test]
    fn raw_worker_process_capability_stays_inside_worker_runtime() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let runtime_dir = src.join("worker_runtime");
        let command = std::fs::read_to_string(runtime_dir.join("command.rs"))
            .expect("read worker command owner");
        let runtime_root =
            std::fs::read_to_string(runtime_dir.join("mod.rs")).expect("read runtime root");
        let crate_root = std::fs::read_to_string(src.join("lib.rs")).expect("read crate root");
        let asr_model =
            std::fs::read_to_string(src.join("asr_model.rs")).expect("read ASR model owner");

        assert!(command.contains("pub(in crate::worker_runtime) struct WorkerCommandSpec"));
        let raw_spec_reexport = ["pub(crate) use command::", "WorkerCommandSpec"].concat();
        assert!(!runtime_root.contains(&raw_spec_reexport));
        assert!(!crate_root.contains("WorkerCommandSpec"));
        assert!(asr_model.contains("AsrModelDownloadJob"));
        for forbidden in [
            "WorkerCommandSpec",
            "WorkerInvocation",
            "WorkerRunRequest",
            "build_model_download_command_spec",
            "bundled_python_path",
            "prepend_to_path",
        ] {
            assert!(
                !asr_model.contains(forbidden),
                "ASR application owner retains raw process capability {forbidden}"
            );
        }
        assert!(command.contains("--download-asr-model"));

        let mut sources = Vec::new();
        collect_rust_sources(&src, &mut sources);
        for path in sources {
            if path.starts_with(&runtime_dir) {
                continue;
            }
            let source = std::fs::read_to_string(&path).expect("read Rust application source");
            for forbidden in ["WorkerCommandSpec", "WorkerInvocation", "WorkerRunRequest"] {
                assert!(
                    !source.contains(forbidden),
                    "{} imports raw worker capability {forbidden}",
                    path.display()
                );
            }
            assert!(
                !source.contains("--download-asr-model"),
                "{} owns the model-download CLI outside worker_runtime",
                path.display()
            );
        }
    }

    #[test]
    fn blocking_worker_command_runs_on_background_thread() {
        let caller_thread = std::thread::current().id();

        let ran_on_background_thread =
            tauri::async_runtime::block_on(run_blocking_worker_command(move || {
                Ok(std::thread::current().id() != caller_thread)
            }))
            .expect("blocking command should complete");

        assert!(ran_on_background_thread);
    }
}
