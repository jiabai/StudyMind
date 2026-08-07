use super::facade::AsrModelDownloadJob;
use crate::account;
use crate::settings::{
    legacy_local_llm_env_removals, ASR_MODEL_DOWNLOAD_SHA256_ENV, ASR_MODEL_DOWNLOAD_URL_ENV,
    LLM_CHECKOUT_REQUEST_ID_ENV, LLM_CHECKOUT_URL_ENV, LLM_SESSION_TOKEN_ENV, LLM_SOURCE_ENV,
    MODELSCOPE_ENDPOINT_ENV, SENSEVOICE_REVISION_ENV,
};
use crate::task_manifest;
use crate::{
    bundled_python_path, path_to_env_string, prepend_to_path, RuntimePaths, ALLOW_REAL_ASR_ENV,
    CACHE_DIR_ENV, CACHE_DIR_NAME, MODELSCOPE_OFFLINE_ENV, MODEL_DIR_ENV, OUTPUT_DIR_ENV,
    RESOURCE_DIR_ENV, USER_DATA_DIR_ENV,
};
#[cfg(test)]
use std::collections::HashMap;
use std::path::PathBuf;

const MAX_WORKER_STDIN_PAYLOAD_BYTES: usize = 1024 * 1024;

#[derive(Clone)]
pub(super) enum WorkerInvocation {
    ProcessLocalMedia(String),
    RetryInsights(String),
}

#[derive(Clone)]
pub(in crate::worker_runtime) struct WorkerCommandSpec {
    pub(in crate::worker_runtime) program: PathBuf,
    pub(in crate::worker_runtime) args: Vec<String>,
    pub(in crate::worker_runtime) stdin_payload: Option<String>,
    pub(in crate::worker_runtime) env: Vec<(String, String)>,
    pub(in crate::worker_runtime) env_remove: Vec<String>,
    pub(in crate::worker_runtime) current_dir: PathBuf,
}

impl WorkerCommandSpec {
    #[cfg(test)]
    pub(in crate::worker_runtime) fn env_map(&self) -> HashMap<String, String> {
        self.env.iter().cloned().collect()
    }
}

pub(super) fn js_runtime_diagnostics(spec: &WorkerCommandSpec) -> String {
    let path_value = spec
        .env
        .iter()
        .find_map(|(key, value)| (key == "PATH").then_some(value.as_str()))
        .unwrap_or_default();
    let runtimes = [
        (
            "deno",
            executable_available_on_path(path_value, &["deno", "deno.exe"]),
        ),
        (
            "node",
            executable_available_on_path(path_value, &["node", "node.exe"]),
        ),
        (
            "quickjs",
            executable_available_on_path(path_value, &["qjs", "qjs.exe"]),
        ),
        (
            "bun",
            executable_available_on_path(path_value, &["bun", "bun.exe"]),
        ),
    ];
    let summary = runtimes
        .iter()
        .map(|(name, available)| {
            format!(
                "{name}:{}",
                if *available { "available" } else { "missing" }
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!("js_runtimes={summary}")
}

fn executable_available_on_path(path_value: &str, binary_names: &[&str]) -> bool {
    std::env::split_paths(path_value).any(|directory| {
        binary_names
            .iter()
            .any(|binary_name| directory.join(binary_name).is_file())
    })
}

pub(super) fn build_asr_model_download_command_spec(
    paths: &RuntimePaths,
    job: &AsrModelDownloadJob,
) -> Result<WorkerCommandSpec, String> {
    let path_value = prepend_to_path(&paths.resource_dir.join("bin"))?;
    let mut env = vec![
        (
            "PYTHONPATH".to_string(),
            path_to_env_string(paths.resource_dir.join("worker")),
        ),
        ("PYTHONUTF8".to_string(), "1".to_string()),
        ("PYTHONIOENCODING".to_string(), "utf-8".to_string()),
        ("PATH".to_string(), path_value),
        (
            MODEL_DIR_ENV.to_string(),
            path_to_env_string(paths.user_data_dir.join("models")),
        ),
        (
            RESOURCE_DIR_ENV.to_string(),
            path_to_env_string(&paths.resource_dir),
        ),
        (
            USER_DATA_DIR_ENV.to_string(),
            path_to_env_string(&paths.user_data_dir),
        ),
    ];

    for (key, value) in [
        (ASR_MODEL_DOWNLOAD_URL_ENV, job.download_url()),
        (ASR_MODEL_DOWNLOAD_SHA256_ENV, job.download_sha256()),
        (MODELSCOPE_ENDPOINT_ENV, job.modelscope_endpoint()),
        (SENSEVOICE_REVISION_ENV, job.sensevoice_revision()),
    ] {
        if let Some(value) = value {
            env.push((key.to_string(), value.to_string()));
        }
    }

    Ok(WorkerCommandSpec {
        program: bundled_python_path(&paths.resource_dir),
        args: vec![
            "-m".to_string(),
            "studymind_worker".to_string(),
            "--download-asr-model".to_string(),
            "--asr-model".to_string(),
            job.asr_model().to_string(),
        ],
        stdin_payload: None,
        env,
        env_remove: legacy_local_llm_env_removals(),
        current_dir: paths.user_data_dir.clone(),
    })
}

pub(super) fn build_worker_command_spec(
    paths: &RuntimePaths,
    invocation: WorkerInvocation,
    server_managed_llm: Option<account::ServerManagedLlmInvocation>,
) -> Result<WorkerCommandSpec, String> {
    let include_server_managed_llm = worker_invocation_uses_server_managed_llm(&invocation);
    let (args, stdin_payload) = match invocation {
        WorkerInvocation::ProcessLocalMedia(payload) => (
            vec!["--process-local-media-stdin".to_string()],
            Some(payload),
        ),
        WorkerInvocation::RetryInsights(payload) => {
            (vec!["--retry-insights-stdin".to_string()], Some(payload))
        }
    };
    if stdin_payload
        .as_ref()
        .is_some_and(|payload| payload.len() > MAX_WORKER_STDIN_PAYLOAD_BYTES)
    {
        return Err("Worker request stdin payload was too large.".to_string());
    }
    let resource_bin_dir = paths.resource_dir.join("bin");
    let path_value = prepend_to_path(&resource_bin_dir)?;
    let output_root = task_manifest::configured_output_root(paths)?;

    let mut env = vec![
        (
            "PYTHONPATH".to_string(),
            path_to_env_string(paths.resource_dir.join("worker")),
        ),
        ("PYTHONUTF8".to_string(), "1".to_string()),
        ("PYTHONIOENCODING".to_string(), "utf-8".to_string()),
        ("PATH".to_string(), path_value),
        (OUTPUT_DIR_ENV.to_string(), path_to_env_string(output_root)),
        (
            CACHE_DIR_ENV.to_string(),
            path_to_env_string(paths.user_data_dir.join(CACHE_DIR_NAME)),
        ),
        (
            MODEL_DIR_ENV.to_string(),
            path_to_env_string(paths.user_data_dir.join("models")),
        ),
        (
            RESOURCE_DIR_ENV.to_string(),
            path_to_env_string(&paths.resource_dir),
        ),
        (
            USER_DATA_DIR_ENV.to_string(),
            path_to_env_string(&paths.user_data_dir),
        ),
        (ALLOW_REAL_ASR_ENV.to_string(), "1".to_string()),
        (MODELSCOPE_OFFLINE_ENV.to_string(), "1".to_string()),
    ];
    if include_server_managed_llm {
        if let Some(llm) = server_managed_llm {
            env.push((LLM_SOURCE_ENV.to_string(), "server".to_string()));
            env.push((
                LLM_CHECKOUT_URL_ENV.to_string(),
                format!(
                    "{}/api/desktop/llm/checkouts",
                    llm.server_base_url.trim_end_matches('/')
                ),
            ));
            env.push((LLM_SESSION_TOKEN_ENV.to_string(), llm.session_token));
            env.push((LLM_CHECKOUT_REQUEST_ID_ENV.to_string(), llm.request_id));
        }
    }

    Ok(WorkerCommandSpec {
        program: bundled_python_path(&paths.resource_dir),
        args: [vec!["-m".to_string(), "studymind_worker".to_string()], args].concat(),
        stdin_payload,
        env,
        env_remove: legacy_local_llm_env_removals(),
        current_dir: paths.user_data_dir.clone(),
    })
}

fn worker_invocation_uses_server_managed_llm(invocation: &WorkerInvocation) -> bool {
    match invocation {
        WorkerInvocation::RetryInsights(_) => true,
        WorkerInvocation::ProcessLocalMedia(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_asr_model_download_command_spec, build_worker_command_spec, WorkerCommandSpec,
        WorkerInvocation,
    };
    use crate::account::ServerManagedLlmInvocation;
    use crate::worker_runtime::facade::AsrModelDownloadJob;
    use crate::{bundled_python_path, path_to_env_string, RuntimePaths};
    use std::path::PathBuf;

    fn command_test_paths() -> RuntimePaths {
        RuntimePaths {
            resource_dir: PathBuf::from("StudyMind-test").join("resources"),
            user_data_dir: PathBuf::from("StudyMind-test").join("user-data"),
        }
    }

    fn assert_removes_legacy_local_llm_env(spec: &WorkerCommandSpec) {
        for key in [
            "STUDYMIND_LLM_PROVIDER",
            "STUDYMIND_LLM_BASE_URL",
            "STUDYMIND_LLM_API_KEY",
            "STUDYMIND_LLM_MODEL",
            "STUDYMIND_LLM_TIMEOUT_SECONDS",
        ] {
            assert!(spec.env_remove.iter().any(|value| value == key));
        }
        for key in [
            "STUDYMIND_LLM_SOURCE",
            "STUDYMIND_LLM_CHECKOUT_URL",
            "STUDYMIND_LLM_SESSION_TOKEN",
            "STUDYMIND_LLM_CHECKOUT_REQUEST_ID",
        ] {
            assert!(!spec.env_remove.iter().any(|value| value == key));
        }
    }

    #[test]
    fn asr_model_download_job_derives_fixed_command_and_allowlisted_overrides() {
        let paths = command_test_paths();
        let job = AsrModelDownloadJob::new(
            "iic/SenseVoiceSmall".to_string(),
            Some("https://cdn.example/sensevoice.zip".to_string()),
            Some("abc123".to_string()),
            Some("https://modelscope.example".to_string()),
            Some("revision-1".to_string()),
        );

        let spec = build_asr_model_download_command_spec(&paths, &job)
            .expect("prepare ASR download command");
        let env = spec.env_map();

        assert_eq!(spec.program, bundled_python_path(&paths.resource_dir));
        assert_eq!(
            spec.args,
            vec![
                "-m",
                "studymind_worker",
                "--download-asr-model",
                "--asr-model",
                "iic/SenseVoiceSmall",
            ]
        );
        assert_eq!(spec.stdin_payload, None);
        assert_eq!(spec.current_dir, paths.user_data_dir);
        assert_eq!(
            env.get("STUDYMIND_MODEL_DIR"),
            Some(&path_to_env_string(
                PathBuf::from("StudyMind-test")
                    .join("user-data")
                    .join("models")
            ))
        );
        assert_eq!(
            env.get("STUDYMIND_ASR_MODEL_DOWNLOAD_URL"),
            Some(&"https://cdn.example/sensevoice.zip".to_string())
        );
        assert_eq!(
            env.get("STUDYMIND_ASR_MODEL_DOWNLOAD_SHA256"),
            Some(&"abc123".to_string())
        );
        assert_eq!(
            env.get("STUDYMIND_MODELSCOPE_ENDPOINT"),
            Some(&"https://modelscope.example".to_string())
        );
        assert_eq!(
            env.get("STUDYMIND_SENSEVOICE_REVISION"),
            Some(&"revision-1".to_string())
        );
        assert_removes_legacy_local_llm_env(&spec);
    }

    #[test]
    fn asr_model_download_job_omits_optional_overrides_and_keeps_fixed_environment() {
        let paths = command_test_paths();
        let job =
            AsrModelDownloadJob::new("iic/SenseVoiceSmall".to_string(), None, None, None, None);

        let spec = build_asr_model_download_command_spec(&paths, &job)
            .expect("prepare ASR download command");
        let env = spec.env_map();

        for key in [
            "STUDYMIND_ASR_MODEL_DOWNLOAD_URL",
            "STUDYMIND_ASR_MODEL_DOWNLOAD_SHA256",
            "STUDYMIND_MODELSCOPE_ENDPOINT",
            "STUDYMIND_SENSEVOICE_REVISION",
        ] {
            assert!(!env.contains_key(key), "unexpected optional key {key}");
        }
        for key in [
            "PYTHONPATH",
            "PYTHONUTF8",
            "PYTHONIOENCODING",
            "PATH",
            "STUDYMIND_MODEL_DIR",
            "STUDYMIND_RESOURCE_DIR",
            "STUDYMIND_USER_DATA_DIR",
        ] {
            assert!(env.contains_key(key), "missing fixed key {key}");
        }
        assert_eq!(spec.stdin_payload, None);
        assert_removes_legacy_local_llm_env(&spec);
    }

    #[test]
    fn worker_command_spec_uses_bundled_python_and_app_local_data() {
        let paths = command_test_paths();
        let request_json = r#"{"contract_version":4,"source_path":"C:\\Users\\demo\\Interview.wmv","media_kind":"video","safe_display_name":"Interview.wmv","source_extension":"wmv","asr_model":"iic/SenseVoiceSmall"}"#;

        let spec = build_worker_command_spec(
            &paths,
            WorkerInvocation::ProcessLocalMedia(request_json.to_string()),
            None,
        )
        .expect("build worker command spec");
        let env = spec.env_map();

        assert_eq!(spec.program, bundled_python_path(&paths.resource_dir));
        assert_eq!(
            spec.args,
            vec!["-m", "studymind_worker", "--process-local-media-stdin"]
        );
        assert_eq!(spec.stdin_payload.as_deref(), Some(request_json));
        assert!(!spec.args.join(" ").contains(request_json));
        assert!(!spec.args.join(" ").contains("xsec_token"));
        assert!(!env.values().any(|value| value.contains(request_json)));
        assert!(!spec.program.to_string_lossy().contains("uv"));
        assert!(!spec.args.iter().any(|arg| arg == "uv"));
        assert_eq!(
            env.get("PYTHONPATH"),
            Some(&path_to_env_string(paths.resource_dir.join("worker")))
        );
        assert_eq!(
            env.get("STUDYMIND_OUTPUT_DIR"),
            Some(&path_to_env_string(paths.user_data_dir.join("outputs")))
        );
        assert_eq!(
            env.get("STUDYMIND_CACHE_DIR"),
            Some(&path_to_env_string(paths.user_data_dir.join("cache")))
        );
        assert_eq!(
            env.get("STUDYMIND_MODEL_DIR"),
            Some(&path_to_env_string(paths.user_data_dir.join("models")))
        );
        assert_eq!(
            env.get("STUDYMIND_RESOURCE_DIR"),
            Some(&path_to_env_string(&paths.resource_dir))
        );
        assert_eq!(env.get("STUDYMIND_ALLOW_REAL_ASR"), Some(&"1".to_string()));
        assert_eq!(env.get("MODELSCOPE_OFFLINE"), Some(&"1".to_string()));
        assert_removes_legacy_local_llm_env(&spec);
        assert_eq!(spec.current_dir, paths.user_data_dir);
    }

    #[test]
    fn serialized_worker_requests_never_enter_argv_or_environment() {
        let paths = command_test_paths();
        let secret = "review-secret";
        let cases = [
            (
                WorkerInvocation::ProcessLocalMedia(format!(
                    r#"{{"contract_version":4,"source_path":"C:\\Users\\{secret}\\Interview.wmv","media_kind":"video","safe_display_name":"Interview.wmv","source_extension":"wmv","asr_model":"iic/SenseVoiceSmall"}}"#
                )),
                "--process-local-media-stdin",
            ),
            (
                WorkerInvocation::RetryInsights(
                    r#"{"task_id":"safe-task","target":"summary","output_language":"en-US"}"#
                        .to_string(),
                ),
                "--retry-insights-stdin",
            ),
        ];

        for (invocation, expected_mode) in cases {
            let spec = build_worker_command_spec(&paths, invocation, None)
                .expect("build stdin worker command");
            assert_eq!(
                spec.args,
                vec![
                    "-m".to_string(),
                    "studymind_worker".to_string(),
                    expected_mode.to_string()
                ]
            );
            assert!(!spec.args.iter().any(|value| value.contains(secret)));
            assert!(!spec.args.iter().any(|value| value.contains("xsec_token")));
            assert!(!spec.env.iter().any(|(_, value)| value.contains(secret)));
            assert!(!spec
                .env
                .iter()
                .any(|(_, value)| value.contains("xsec_token")));
        }
    }

    #[test]
    fn oversized_worker_stdin_payload_fails_without_echoing_content() {
        let paths = RuntimePaths {
            resource_dir: PathBuf::from("C:/Program Files/StudyMind/resources"),
            user_data_dir: PathBuf::from("C:/Users/demo/AppData/Local/com.StudyMind.desktop"),
        };
        let payload = format!("review-secret{}", "x".repeat(1024 * 1024));

        let error = match build_worker_command_spec(
            &paths,
            WorkerInvocation::ProcessLocalMedia(payload),
            None,
        ) {
            Ok(_) => panic!("oversized stdin payload unexpectedly accepted"),
            Err(error) => error,
        };

        assert_eq!(error, "Worker request stdin payload was too large.");
        assert!(!error.contains("review-secret"));
    }

    #[test]
    fn worker_command_spec_skips_server_managed_llm_for_process_local_media() {
        let paths = command_test_paths();
        let request_json = r#"{"contract_version":4,"source_path":"C:\\Users\\demo\\Interview.wmv","media_kind":"video","safe_display_name":"Interview.wmv","source_extension":"wmv","asr_model":"iic/SenseVoiceSmall"}"#;

        let spec = build_worker_command_spec(
            &paths,
            WorkerInvocation::ProcessLocalMedia(request_json.to_string()),
            Some(ServerManagedLlmInvocation {
                server_base_url: "http://127.0.0.1:8787".to_string(),
                session_token: "desktop-token".to_string(),
                request_id: "llm-run-12345678".to_string(),
            }),
        )
        .expect("build worker command spec");
        let env = spec.env_map();

        assert_removes_legacy_local_llm_env(&spec);
        assert_eq!(spec.stdin_payload.as_deref(), Some(request_json));
        assert_eq!(env.get("STUDYMIND_LLM_SOURCE"), None);
        assert_eq!(env.get("STUDYMIND_LLM_CHECKOUT_URL"), None);
        assert_eq!(env.get("STUDYMIND_LLM_SESSION_TOKEN"), None);
        assert_eq!(env.get("STUDYMIND_LLM_CHECKOUT_REQUEST_ID"), None);
    }

    #[test]
    fn worker_command_spec_includes_server_managed_llm_checkout_env_for_retry_insights() {
        let paths = command_test_paths();
        let request_json = r#"{"task_id":"20260705-153012-douyin-demo","target":"summary","output_language":"en-US"}"#;

        let spec = build_worker_command_spec(
            &paths,
            WorkerInvocation::RetryInsights(request_json.to_string()),
            Some(ServerManagedLlmInvocation {
                server_base_url: "http://127.0.0.1:8787".to_string(),
                session_token: "desktop-token".to_string(),
                request_id: "llm-run-12345678".to_string(),
            }),
        )
        .expect("build worker command spec");
        let env = spec.env_map();

        assert_removes_legacy_local_llm_env(&spec);
        assert_eq!(spec.stdin_payload.as_deref(), Some(request_json));
        assert_eq!(env.get("STUDYMIND_LLM_SOURCE"), Some(&"server".to_string()));
        assert_eq!(
            env.get("STUDYMIND_LLM_CHECKOUT_URL"),
            Some(&"http://127.0.0.1:8787/api/desktop/llm/checkouts".to_string())
        );
        assert_eq!(
            env.get("STUDYMIND_LLM_SESSION_TOKEN"),
            Some(&"desktop-token".to_string())
        );
        assert_eq!(
            env.get("STUDYMIND_LLM_CHECKOUT_REQUEST_ID"),
            Some(&"llm-run-12345678".to_string())
        );
    }
}
