use crate::progress_event::cancelled_model_download_event;
pub(crate) use crate::progress_event::ASR_MODEL_DOWNLOAD_EVENT_NAME;
#[allow(unused_imports)]
pub(crate) use crate::progress_event::MODEL_DOWNLOAD_EVENT_PREFIX;
use crate::settings::{
    asr_model_source, configured_env_value, env_path, parse_dotenv_values,
    ASR_MODEL_DOWNLOAD_SHA256_ENV, ASR_MODEL_DOWNLOAD_URL_ENV, MODELSCOPE_ENDPOINT_ENV,
    SENSEVOICE_REVISION_ENV,
};
use crate::worker_runtime::{
    AsrModelDownloadJob, ModelDownloadTerminalResult, ValidatedWorkerResult, WorkerRunError,
    WorkerRunErrorKind, WorkerRunOutcome, WorkerTimeoutKind, WORKER_PROTOCOL_MESSAGE,
};
use crate::{
    ensure_runtime_dirs, path_to_env_string, resolve_runtime_paths, run_blocking_worker_command,
    CancelProcessResult, ProcessSupervisors, RuntimePaths,
};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State, Window};

const MODEL_VERSION_FILE_NAME: &str = "MODEL_VERSION.txt";
pub(crate) const DEFAULT_ASR_MODEL: &str = "iic/SenseVoiceSmall";
pub(crate) const SENSEVOICE_SMALL_ONNX_MODEL: &str = "iic/SenseVoiceSmall-onnx";
const SENSEVOICE_VAD_MODEL: &str = "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch";
const SENSEVOICE_ONNX_VAD_MODEL: &str = "iic/speech_fsmn_vad_zh-cn-16k-common-onnx";
const ONNX_CACHE_DIR_NAME: &str = "onnx";
const SENSEVOICE_BPE_FILE_NAME: &str = "chn_jpn_yue_eng_ko_spectok.bpe.model";
pub(crate) const SUPPORTED_ASR_MODELS: &[&str] = &[DEFAULT_ASR_MODEL, SENSEVOICE_SMALL_ONNX_MODEL];

#[derive(Debug, Serialize)]
pub(crate) struct AsrModelStatusView {
    user_data_dir: String,
    default_output_dir: String,
    asr_model: String,
    asr_model_dir: String,
    asr_model_available: bool,
    asr_model_source: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct AsrModelDownloadResult {
    started: bool,
    status: String,
}

fn asr_model_cache_dir(paths: &RuntimePaths, asr_model: &str) -> PathBuf {
    let root = paths.user_data_dir.join("models");
    if asr_model == SENSEVOICE_SMALL_ONNX_MODEL {
        root.join(ONNX_CACHE_DIR_NAME)
    } else {
        root
    }
}

fn asr_model_display_dir(paths: &RuntimePaths, asr_model: &str) -> PathBuf {
    let model_name = if asr_model == SENSEVOICE_SMALL_ONNX_MODEL {
        "SenseVoiceSmall-onnx"
    } else {
        "SenseVoiceSmall"
    };
    asr_model_cache_dir(paths, asr_model)
        .join("models")
        .join("iic")
        .join(model_name)
}

fn asr_model_available(paths: &RuntimePaths, asr_model: &str) -> bool {
    SUPPORTED_ASR_MODELS.contains(&asr_model)
        && model_marker_exists(&asr_model_cache_dir(paths, asr_model), asr_model)
}

fn model_marker_exists(model_dir: &Path, asr_model: &str) -> bool {
    let marker = model_dir.join(MODEL_VERSION_FILE_NAME);
    marker.is_file()
        && required_model_files_exist(model_dir, asr_model)
        && fs::read_to_string(marker)
            .map(|content| match asr_model {
                DEFAULT_ASR_MODEL => {
                    content.contains(DEFAULT_ASR_MODEL) && content.contains(SENSEVOICE_VAD_MODEL)
                }
                SENSEVOICE_SMALL_ONNX_MODEL => {
                    content.contains(SENSEVOICE_SMALL_ONNX_MODEL)
                        && content.contains(SENSEVOICE_ONNX_VAD_MODEL)
                }
                _ => false,
            })
            .unwrap_or(false)
}

fn required_model_files_exist(model_dir: &Path, asr_model: &str) -> bool {
    match asr_model {
        DEFAULT_ASR_MODEL => [model_dir.to_path_buf(), model_dir.join("models")]
            .iter()
            .any(|model_root| {
                let sensevoice_model = model_root
                    .join("iic")
                    .join("SenseVoiceSmall")
                    .join("model.pt");
                let vad_model = model_root
                    .join("iic")
                    .join("speech_fsmn_vad_zh-cn-16k-common-pytorch")
                    .join("model.pt");
                sensevoice_model.is_file() && vad_model.is_file()
            }),
        SENSEVOICE_SMALL_ONNX_MODEL => {
            let model_root = model_dir.join("models").join("iic");
            model_root
                .join("SenseVoiceSmall-onnx")
                .join("model_quant.onnx")
                .is_file()
                && model_root
                    .join("speech_fsmn_vad_zh-cn-16k-common-onnx")
                    .join("model_quant.onnx")
                    .is_file()
                && model_root
                    .join("SenseVoiceSmall-onnx")
                    .join(SENSEVOICE_BPE_FILE_NAME)
                    .is_file()
        }
        _ => false,
    }
}

#[tauri::command]
pub(crate) fn get_asr_model_status(
    app: AppHandle,
    asr_model: String,
) -> Result<AsrModelStatusView, String> {
    let paths = resolve_runtime_paths(&app)?;
    ensure_runtime_dirs(&paths)?;
    let config_values = parse_dotenv_values(&env_path(&paths))?;
    let asr_model = validate_asr_model(asr_model)?;
    Ok(AsrModelStatusView {
        user_data_dir: path_to_env_string(&paths.user_data_dir),
        default_output_dir: path_to_env_string(paths.user_data_dir.join("outputs")),
        asr_model_dir: path_to_env_string(asr_model_display_dir(&paths, &asr_model)),
        asr_model_available: asr_model_available(&paths, &asr_model),
        asr_model_source: if asr_model == SENSEVOICE_SMALL_ONNX_MODEL {
            "modelscope".to_string()
        } else {
            asr_model_source(&config_values)
        },
        asr_model,
    })
}

#[tauri::command]
pub(crate) async fn download_asr_model(
    window: Window,
    app: AppHandle,
    process_supervisors: State<'_, Arc<ProcessSupervisors>>,
    asr_model: String,
) -> Result<AsrModelDownloadResult, String> {
    let process_supervisors = Arc::clone(process_supervisors.inner());
    run_blocking_worker_command(move || {
        download_asr_model_blocking(window, app, process_supervisors, asr_model)
    })
    .await
}

fn download_asr_model_blocking(
    window: Window,
    app: AppHandle,
    process_supervisors: Arc<ProcessSupervisors>,
    asr_model: String,
) -> Result<AsrModelDownloadResult, String> {
    let paths = resolve_runtime_paths(&app)?;
    ensure_runtime_dirs(&paths)?;
    let asr_model = validate_asr_model(asr_model)?;
    if asr_model_available(&paths, &asr_model) {
        return Ok(AsrModelDownloadResult {
            started: false,
            status: "already_available".to_string(),
        });
    }

    let config_values = parse_dotenv_values(&env_path(&paths))?;
    let job = if asr_model == DEFAULT_ASR_MODEL {
        AsrModelDownloadJob::new(
            asr_model,
            configured_env_value(&config_values, ASR_MODEL_DOWNLOAD_URL_ENV),
            configured_env_value(&config_values, ASR_MODEL_DOWNLOAD_SHA256_ENV),
            configured_env_value(&config_values, MODELSCOPE_ENDPOINT_ENV),
            configured_env_value(&config_values, SENSEVOICE_REVISION_ENV),
        )
    } else {
        // ONNX artifacts are intentionally fixed to official ModelScope sources.
        AsrModelDownloadJob::new(asr_model, None, None, None, None)
    };
    let run_result = process_supervisors.run_asr_model_download(&paths, job, window.clone())?;
    match map_model_download_run_result(run_result)? {
        ModelDownloadRunResult::Completed => Ok(AsrModelDownloadResult {
            started: true,
            status: "completed".to_string(),
        }),
        ModelDownloadRunResult::Cancelled => {
            let _ = window.emit(
                ASR_MODEL_DOWNLOAD_EVENT_NAME,
                cancelled_model_download_event(),
            );
            Ok(AsrModelDownloadResult {
                started: false,
                status: "cancelled".to_string(),
            })
        }
    }
}

fn validate_asr_model(asr_model: String) -> Result<String, String> {
    if SUPPORTED_ASR_MODELS.contains(&asr_model.as_str()) {
        Ok(asr_model)
    } else {
        Err("ASR_MODEL_UNSUPPORTED".to_string())
    }
}

#[derive(Debug, Eq, PartialEq)]
enum ModelDownloadRunResult {
    Completed,
    Cancelled,
}

fn map_model_download_run_result(
    result: Result<WorkerRunOutcome, WorkerRunError>,
) -> Result<ModelDownloadRunResult, String> {
    match result {
        Ok(WorkerRunOutcome::Structured(ValidatedWorkerResult::ModelDownload(
            ModelDownloadTerminalResult::Completed { .. },
        ))) => Ok(ModelDownloadRunResult::Completed),
        Ok(WorkerRunOutcome::Structured(ValidatedWorkerResult::ModelDownload(
            ModelDownloadTerminalResult::Failed { message, .. },
        ))) => Err(message),
        Ok(WorkerRunOutcome::Structured(_)) => Err(WORKER_PROTOCOL_MESSAGE.to_string()),
        Ok(WorkerRunOutcome::Cancelled) => Ok(ModelDownloadRunResult::Cancelled),
        Ok(WorkerRunOutcome::TimedOut(WorkerTimeoutKind::Idle)) => {
            Err("ASR_MODEL_DOWNLOAD_IDLE_TIMEOUT".to_string())
        }
        Ok(WorkerRunOutcome::TimedOut(WorkerTimeoutKind::Absolute)) => {
            Err("ASR_MODEL_DOWNLOAD_EXECUTION_TIMEOUT".to_string())
        }
        Ok(WorkerRunOutcome::UnstructuredFailure(_)) => {
            Err("ASR model download failed before returning a structured result.".to_string())
        }
        Err(error) => Err(match error.kind {
            WorkerRunErrorKind::AlreadyRunning => "Another ASR model download is already running.",
            WorkerRunErrorKind::SpawnFailed | WorkerRunErrorKind::RequestDeliveryFailed => {
                "ASR model download request could not be delivered."
            }
            WorkerRunErrorKind::WatchdogStartFailed => "Worker watchdog failed to start.",
            WorkerRunErrorKind::PipeUnavailable | WorkerRunErrorKind::WaitFailed => {
                "ASR model download runtime failed."
            }
            WorkerRunErrorKind::ProtocolViolation => WORKER_PROTOCOL_MESSAGE,
        }
        .to_string()),
    }
}

#[tauri::command]
pub(crate) fn cancel_asr_model_download(
    process_supervisors: State<'_, Arc<ProcessSupervisors>>,
) -> Result<CancelProcessResult, String> {
    Ok(process_supervisors.cancel_asr_model_download())
}

#[cfg(test)]
mod tests {
    use super::{
        asr_model_available, asr_model_display_dir, cancelled_model_download_event,
        map_model_download_run_result, ModelDownloadRunResult, DEFAULT_ASR_MODEL,
        SENSEVOICE_SMALL_ONNX_MODEL,
    };
    use crate::settings::supported_asr_models;
    use crate::worker_runtime::{
        ModelDownloadTerminalResult, ValidatedWorkerResult, WorkerExitSummary, WorkerRunError,
        WorkerRunErrorKind, WorkerRunOutcome, WorkerTimeoutKind, WORKER_PROTOCOL_MESSAGE,
    };
    use crate::RuntimePaths;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn release_supported_asr_models_exposes_pytorch_and_onnx_sensevoice() {
        assert_eq!(
            supported_asr_models(),
            vec![
                "iic/SenseVoiceSmall".to_string(),
                "iic/SenseVoiceSmall-onnx".to_string(),
            ]
        );
    }

    #[test]
    fn asr_model_display_directory_points_to_selected_runtime_leaf() {
        let paths = RuntimePaths {
            resource_dir: PathBuf::from("resources"),
            user_data_dir: PathBuf::from("app-data"),
        };

        assert_eq!(
            asr_model_display_dir(&paths, DEFAULT_ASR_MODEL),
            paths
                .user_data_dir
                .join("models")
                .join("models")
                .join("iic")
                .join("SenseVoiceSmall")
        );
        assert_eq!(
            asr_model_display_dir(&paths, SENSEVOICE_SMALL_ONNX_MODEL),
            paths
                .user_data_dir
                .join("models")
                .join("onnx")
                .join("models")
                .join("iic")
                .join("SenseVoiceSmall-onnx")
        );
    }

    #[test]
    fn synthesized_model_cancellation_uses_structured_contract_event() {
        let payload = cancelled_model_download_event();

        assert_eq!(payload["status"], "cancelled");
        assert_eq!(payload["progress"], 0);
        assert_eq!(payload["message_code"], "model.download.cancelled");
        assert!(payload.get("message").is_none());
        assert!(payload.get("current_file").is_none());
    }

    #[test]
    fn typed_runner_outcomes_preserve_model_download_product_mapping() {
        assert_eq!(
            map_model_download_run_result(Ok(WorkerRunOutcome::Structured(
                ValidatedWorkerResult::ModelDownload(ModelDownloadTerminalResult::Completed {
                    model: "iic/SenseVoiceSmall".to_string(),
                }),
            ))),
            Ok(ModelDownloadRunResult::Completed)
        );
        assert_eq!(
            map_model_download_run_result(Ok(WorkerRunOutcome::Structured(
                ValidatedWorkerResult::ModelDownload(ModelDownloadTerminalResult::Failed {
                    code: "MODEL_DOWNLOAD_FAILED".to_string(),
                    message: "ASR model download failed.".to_string(),
                }),
            ))),
            Err("ASR model download failed.".to_string())
        );
        assert_eq!(
            map_model_download_run_result(Ok(WorkerRunOutcome::Cancelled)),
            Ok(ModelDownloadRunResult::Cancelled)
        );
        assert_eq!(
            map_model_download_run_result(Ok(WorkerRunOutcome::TimedOut(WorkerTimeoutKind::Idle,))),
            Err("ASR_MODEL_DOWNLOAD_IDLE_TIMEOUT".to_string())
        );
        assert_eq!(
            map_model_download_run_result(Ok(WorkerRunOutcome::TimedOut(
                WorkerTimeoutKind::Absolute,
            ))),
            Err("ASR_MODEL_DOWNLOAD_EXECUTION_TIMEOUT".to_string())
        );
        assert_eq!(
            map_model_download_run_result(Ok(WorkerRunOutcome::UnstructuredFailure(
                WorkerExitSummary {
                    exit_code: Some(1),
                    stderr: "present",
                },
            ))),
            Err("ASR model download failed before returning a structured result.".to_string())
        );
        assert_eq!(
            map_model_download_run_result(Err(WorkerRunError {
                kind: WorkerRunErrorKind::AlreadyRunning,
                detail: "unused",
            })),
            Err("Another ASR model download is already running.".to_string())
        );
    }

    #[test]
    fn model_download_runtime_errors_use_closed_safe_messages() {
        for (kind, expected) in [
            (
                WorkerRunErrorKind::SpawnFailed,
                "ASR model download request could not be delivered.",
            ),
            (
                WorkerRunErrorKind::RequestDeliveryFailed,
                "ASR model download request could not be delivered.",
            ),
            (
                WorkerRunErrorKind::WatchdogStartFailed,
                "Worker watchdog failed to start.",
            ),
            (
                WorkerRunErrorKind::PipeUnavailable,
                "ASR model download runtime failed.",
            ),
            (
                WorkerRunErrorKind::WaitFailed,
                "ASR model download runtime failed.",
            ),
            (
                WorkerRunErrorKind::ProtocolViolation,
                WORKER_PROTOCOL_MESSAGE,
            ),
        ] {
            let result = map_model_download_run_result(Err(WorkerRunError {
                kind,
                detail: "review-secret https://secret.example/private",
            }))
            .expect_err("runtime failure remains an error");

            assert_eq!(result, expected);
            assert!(!result.contains("review-secret"));
            assert!(!result.contains("https://"));
        }
    }

    #[test]
    fn asr_model_availability_requires_marker_and_model_files() {
        let root = temp_dir("asr_model_availability_requires_marker_and_model_files");
        let paths = RuntimePaths {
            resource_dir: root.join("resources"),
            user_data_dir: root.join("app-data"),
        };
        let model_root = paths.user_data_dir.join("models");
        fs::create_dir_all(&model_root).expect("create user model dir");

        assert!(!asr_model_available(&paths, DEFAULT_ASR_MODEL));

        fs::write(
            model_root.join("MODEL_VERSION.txt"),
            "model=iic/SenseVoiceSmall\nvad=iic/speech_fsmn_vad_zh-cn-16k-common-pytorch\n",
        )
        .expect("write model marker");

        assert!(!asr_model_available(&paths, DEFAULT_ASR_MODEL));

        let sensevoice_dir = model_root
            .join("models")
            .join("iic")
            .join("SenseVoiceSmall");
        let vad_dir = model_root
            .join("models")
            .join("iic")
            .join("speech_fsmn_vad_zh-cn-16k-common-pytorch");
        fs::create_dir_all(&sensevoice_dir).expect("create sensevoice dir");
        fs::create_dir_all(&vad_dir).expect("create vad dir");
        fs::write(sensevoice_dir.join("model.pt"), "sensevoice").expect("write sensevoice model");
        fs::write(vad_dir.join("model.pt"), "vad").expect("write vad model");

        assert!(asr_model_available(&paths, DEFAULT_ASR_MODEL));
    }

    #[test]
    fn asr_model_availability_accepts_modelscope_snapshot_layout() {
        let root = temp_dir("asr_model_availability_accepts_modelscope_snapshot_layout");
        let paths = RuntimePaths {
            resource_dir: root.join("resources"),
            user_data_dir: root.join("app-data"),
        };
        let model_root = paths.user_data_dir.join("models");
        fs::write(
            create_parent(model_root.join("MODEL_VERSION.txt")),
            "model=iic/SenseVoiceSmall\nvad=iic/speech_fsmn_vad_zh-cn-16k-common-pytorch\n",
        )
        .expect("write model marker");

        let sensevoice_dir = model_root.join("iic").join("SenseVoiceSmall");
        let vad_dir = model_root
            .join("iic")
            .join("speech_fsmn_vad_zh-cn-16k-common-pytorch");
        fs::create_dir_all(&sensevoice_dir).expect("create sensevoice dir");
        fs::create_dir_all(&vad_dir).expect("create vad dir");
        fs::write(sensevoice_dir.join("model.pt"), "sensevoice").expect("write sensevoice model");
        fs::write(vad_dir.join("model.pt"), "vad").expect("write vad model");

        assert!(asr_model_available(&paths, DEFAULT_ASR_MODEL));
    }

    #[test]
    fn asr_model_availability_ignores_resource_model_marker() {
        let root = temp_dir("asr_model_availability_ignores_resource_model_marker");
        let paths = RuntimePaths {
            resource_dir: root.join("resources"),
            user_data_dir: root.join("app-data"),
        };
        fs::create_dir_all(paths.resource_dir.join("models")).expect("create resource model dir");
        fs::write(
            paths.resource_dir.join("models").join("MODEL_VERSION.txt"),
            "model=iic/SenseVoiceSmall\n",
        )
        .expect("write model marker");

        assert!(!asr_model_available(&paths, DEFAULT_ASR_MODEL));
    }

    #[test]
    fn onnx_availability_requires_its_quantized_asr_vad_and_bpe_files() {
        let root = temp_dir("onnx_availability_requires_its_quantized_asr_vad_and_bpe_files");
        let paths = RuntimePaths {
            resource_dir: root.join("resources"),
            user_data_dir: root.join("app-data"),
        };
        let model_root = paths.user_data_dir.join("models").join("onnx");
        fs::create_dir_all(&model_root).expect("create ONNX model root");
        fs::write(
            model_root.join("MODEL_VERSION.txt"),
            "model=iic/SenseVoiceSmall-onnx\nvad=iic/speech_fsmn_vad_zh-cn-16k-common-onnx\n",
        )
        .expect("write ONNX marker");

        assert!(!asr_model_available(&paths, SENSEVOICE_SMALL_ONNX_MODEL));

        let asr_dir = model_root
            .join("models")
            .join("iic")
            .join("SenseVoiceSmall-onnx");
        let vad_dir = model_root
            .join("models")
            .join("iic")
            .join("speech_fsmn_vad_zh-cn-16k-common-onnx");
        let bpe_dir = model_root
            .join("models")
            .join("iic")
            .join("SenseVoiceSmall-onnx");
        fs::create_dir_all(&asr_dir).expect("create ONNX ASR dir");
        fs::create_dir_all(&vad_dir).expect("create ONNX VAD dir");
        fs::create_dir_all(&bpe_dir).expect("create ONNX BPE dir");
        fs::write(asr_dir.join("model_quant.onnx"), "asr").expect("write ONNX ASR");
        fs::write(vad_dir.join("model_quant.onnx"), "vad").expect("write ONNX VAD");
        fs::write(bpe_dir.join("chn_jpn_yue_eng_ko_spectok.bpe.model"), "bpe")
            .expect("write ONNX BPE");

        assert!(asr_model_available(&paths, SENSEVOICE_SMALL_ONNX_MODEL));
    }

    fn create_parent(path: PathBuf) -> PathBuf {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent dir");
        }
        path
    }

    fn temp_dir(test_name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("StudyMind-{test_name}-{unique}"));
        fs::create_dir_all(&dir).expect("create test dir");
        dir
    }
}
