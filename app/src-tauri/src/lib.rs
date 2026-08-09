use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

mod account;
mod annotation_storage;
mod asr_model;
mod atomic_files;
mod deep_link;
mod diagnostics;
mod history;
mod history_deletion;
mod insight_preferences;
mod local_media;
mod local_media_contract;
mod progress_event;
mod runtime;
mod settings;
mod task_manifest;
mod transcript_detail;
mod ui_preferences;
mod updates;
mod video_processing;
mod window_chrome;
mod worker_runtime;

#[cfg(test)]
mod local_media_contract_tests;

pub(crate) use runtime::{
    bundled_python_path, ensure_runtime_dirs, path_to_env_string, prepend_to_path,
    resolve_runtime_paths, RuntimePaths, ALLOW_REAL_ASR_ENV, AUDIO_REVIEW_CACHE_DIR_NAME,
    CACHE_DIR_ENV, CACHE_DIR_NAME, DESKTOP_LOG_DIR_NAME, MODELSCOPE_OFFLINE_ENV, MODEL_DIR_ENV,
    OUTPUT_DIR_ENV, RESOURCE_DIR_ENV, USER_DATA_DIR_ENV,
};

pub(crate) use diagnostics::{append_desktop_log, summarize_worker_result_for_log};

pub(crate) use asr_model::{DEFAULT_ASR_MODEL, SUPPORTED_ASR_MODELS};

#[cfg(test)]
pub(crate) use asr_model::{ASR_MODEL_DOWNLOAD_EVENT_NAME, MODEL_DOWNLOAD_EVENT_PREFIX};

pub(crate) use worker_runtime::{
    run_blocking_worker_command, CancelProcessResult, ProcessSupervisors,
};

pub(crate) use history_deletion::HistoryDeletionState;

pub(crate) const PROGRESS_EVENT_NAME: &str = "worker-progress";
pub(crate) const PROGRESS_EVENT_PREFIX: &str = "STUDYMIND_PROGRESS ";
#[cfg(test)]
pub(crate) const DESKTOP_WORKER_CONTRACT_VERSION: u32 = 8;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(ProcessSupervisors::default()))
        .manage(Arc::new(HistoryDeletionState::default()))
        .manage(Arc::new(local_media::LocalMediaSelectionState::default()))
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                deep_link::activate_main_window_for_deep_link(&window, argv);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(any(windows, target_os = "linux"))]
            if let Err(error) = app.deep_link().register_all() {
                eprintln!("[studymind] failed to register deep links: {error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            local_media::select_local_media,
            local_media::select_local_media_by_path,
            local_media::clear_local_media_selection,
            video_processing::process_local_media,
            video_processing::retry_insights,
            video_processing::cancel_process,
            settings::get_llm_config,
            settings::save_llm_config,
            settings::get_audio_review_cache_usage,
            settings::clear_audio_review_cache,
            ui_preferences::get_ui_preferences,
            ui_preferences::save_ui_preferences,
            insight_preferences::get_insight_preferences,
            insight_preferences::save_inspiration_profile,
            insight_preferences::skip_inspiration_profile,
            insight_preferences::clear_inspiration_profile,
            insight_preferences::save_default_generation_preferences,
            history::get_history,
            history::get_history_detail,
            history_deletion::delete_history_task,
            transcript_detail::load_transcript_detail,
            transcript_detail::save_transcript_edit,
            annotation_storage::load_annotations,
            annotation_storage::save_annotations,
            updates::get_update_preferences,
            updates::save_update_preferences,
            updates::get_update_delivery,
            asr_model::get_asr_model_status,
            asr_model::download_asr_model,
            asr_model::cancel_asr_model_download,
            account::begin_auth_flow,
            account::complete_auth_flow,
            account::get_account_status,
            account::logout_account,
            account::redeem_activation_code,
            account::create_wechat_checkout,
            account::get_checkout_status,
            window_chrome::start_window_drag,
            window_chrome::close_window,
            window_chrome::minimize_window,
            window_chrome::toggle_maximize_window,
            window_chrome::get_window_position,
            window_chrome::set_window_position
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::account::{
        build_activation_redeem_url, build_auth_login_url, parse_auth_callback_url,
        server_base_url_from_env, AuthCallback,
    };
    use super::path_to_env_string;
    use super::settings::{load_llm_config_from_file, save_llm_config_to_file, LlmConfigInput};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn auth_login_url_includes_state_and_redirect_scheme() {
        let url =
            build_auth_login_url("https://StudyMind.example", "state-123456").expect("build auth url");

        assert_eq!(
            url,
            "https://StudyMind.example/login?desktop=1&state=state-123456&redirect_uri=studymind%3A%2F%2Fauth%2Fcallback"
        );
    }

    #[test]
    fn server_base_url_requires_explicit_exact_valid_configuration() {
        assert_eq!(
            server_base_url_from_env(Vec::<(&str, &str)>::new()).unwrap_err(),
            "StudyMind server is not configured. Set STUDYMIND_SERVER_BASE_URL to a valid http(s) URL."
        );
        assert!(server_base_url_from_env([("StudyMind_SERVER_BASE_URL", "https://legacy.example")]).is_err());
        assert_eq!(
            server_base_url_from_env([("STUDYMIND_SERVER_BASE_URL", " http://127.0.0.1:8787/ ")]).unwrap(),
            "http://127.0.0.1:8787"
        );
        for invalid in [
            "ftp://api.studymind.invalid",
            "https://user:pass@api.studymind.invalid",
            "https://api.studymind.invalid?secret=value",
            "https://api.studymind.invalid#fragment",
            "not-a-url",
        ] {
            assert!(server_base_url_from_env([("STUDYMIND_SERVER_BASE_URL", invalid)]).is_err());
        }
    }

    #[test]
    fn activation_redeem_url_targets_desktop_activation_route() {
        assert_eq!(
            build_activation_redeem_url("https://StudyMind.example/"),
            "https://StudyMind.example/api/desktop/activation-codes/redeem"
        );
    }

    #[test]
    fn auth_callback_parser_accepts_matching_state() {
        let callback = parse_auth_callback_url(
            "studymind://auth/callback?ticket=smlt_abc123&state=state-123456",
            "state-123456",
        )
        .expect("parse auth callback");

        assert_eq!(
            callback,
            AuthCallback {
                ticket: "smlt_abc123".to_string(),
                state: "state-123456".to_string(),
            }
        );
    }

    #[test]
    fn auth_callback_parser_rejects_wrong_state_or_path() {
        let legacy_ticket = legacy_ticket();
        assert!(parse_auth_callback_url(
            &format!(
                "studymind://auth/callback?ticket={legacy_ticket}&state=other-state"
            ),
            "state-123456",
        )
        .is_err());
        assert!(parse_auth_callback_url(
            &format!(
                "studymind://billing/callback?ticket={legacy_ticket}&state=state-123456"
            ),
            "state-123456",
        )
        .is_err());
    }

    #[test]
    fn auth_callback_parser_rejects_legacy_ticket_prefix() {
        let legacy_ticket = legacy_ticket();
        assert!(parse_auth_callback_url(
            &format!(
                "studymind://auth/callback?ticket={legacy_ticket}&state=state-123456"
            ),
            "state-123456",
        )
        .is_err());
    }

    fn legacy_ticket() -> String {
        String::from_utf8(vec![102, 108, 116, 95, 97, 98, 99, 49, 50, 51])
            .expect("valid legacy ticket fixture")
    }

    #[test]
    fn auth_callback_parser_rejects_malformed_studymind_ticket() {
        assert!(parse_auth_callback_url(
            "studymind://auth/callback?ticket=smlt_bad%20ticket&state=state-123456",
            "state-123456",
        )
        .is_err());
    }

    #[test]
    fn auth_callback_parser_rejects_noncanonical_urls_and_query_shapes() {
        let invalid_urls = [
            "studymind://auth:443/callback?ticket=smlt_abc123&state=state-123456",
            "studymind://auth/callback?ticket=smlt_abc123&state=state-123456#fragment",
            "studymind://auth/callback?ticket=smlt_abc123&state=state-123456&extra=1",
            "studymind://auth/callback?ticket=smlt_first&ticket=smlt_second&state=state-123456",
            "studymind://auth/callback?ticket=smlt_abc123&state=state-123456&state=state-123456",
            "studymind://auth/callback?state=state-123456",
            "studymind://auth/callback?ticket=smlt_abc123",
            "studymind://auth/callback?ticket=&state=state-123456",
            "studymind://auth/callback?ticket=smlt_abc123&state=",
        ];
        for callback_url in invalid_urls {
            assert!(
                parse_auth_callback_url(callback_url, "state-123456").is_err(),
                "accepted invalid callback: {callback_url}"
            );
        }
    }

    #[test]
    fn load_llm_config_reads_only_local_app_settings() {
        let env_path = temp_env_path("load_llm_config_reads_only_local_app_settings");
        fs::write(
            &env_path,
            [
                "StudyMind_LLM_PROVIDER=openai_compatible",
                "StudyMind_LLM_BASE_URL=https://llm.example/v1",
                "StudyMind_LLM_API_KEY=secret-key",
                "StudyMind_LLM_MODEL=demo-model",
                "StudyMind_LLM_TIMEOUT_SECONDS=42",
                "StudyMind_OUTPUT_DIR=D:/StudyMind/results",
                "StudyMind_ASR_MODEL=iic/SenseVoiceSmall",
            ]
            .join("\n"),
        )
        .expect("write test env");

        let config = load_llm_config_from_file(&env_path).expect("load config");

        assert_eq!(config.output_dir, "D:/StudyMind/results");
        assert_eq!(config.asr_model, "iic/SenseVoiceSmall");
        assert_eq!(
            config.supported_asr_models,
            vec!["iic/SenseVoiceSmall", "iic/SenseVoiceSmall-onnx"]
        );
    }

    #[test]
    fn load_llm_config_creates_app_local_env_template_and_reports_path() {
        let env_path = temp_env_path("load_llm_config_creates_app_local_env_template");

        let config = load_llm_config_from_file(&env_path).expect("load config");
        let saved = fs::read_to_string(&env_path).expect("read created env");

        assert_eq!(config.config_path, path_to_env_string(&env_path));
        assert_eq!(config.asr_model, "iic/SenseVoiceSmall");
        assert!(saved.contains("StudyMind desktop local settings"));
        assert!(saved.contains("StudyMind_OUTPUT_DIR="));
        assert!(saved.contains("StudyMind_ASR_MODEL=iic/SenseVoiceSmall"));
        assert!(!saved.contains("StudyMind_LLM_API_KEY"));
    }

    #[test]
    fn save_llm_config_updates_local_settings_and_removes_old_llm_values() {
        let env_path = temp_env_path("save_llm_config_updates_local_settings");
        fs::write(
            &env_path,
            [
                "# keep this comment",
                "StudyMind_LLM_PROVIDER=openai_compatible",
                "StudyMind_LLM_BASE_URL=https://old.example/v1",
                "StudyMind_LLM_API_KEY=old-secret",
                "StudyMind_LLM_MODEL=old-model",
                "StudyMind_LLM_TIMEOUT_SECONDS=44",
                "OTHER_SETTING=keep-me",
            ]
            .join("\n"),
        )
        .expect("write test env");

        let config = save_llm_config_to_file(
            &env_path,
            LlmConfigInput {
                output_dir: "D:/StudyMind/custom-results".to_string(),
                asr_model: "iic/SenseVoiceSmall".to_string(),
            },
        )
        .expect("save config");
        let saved = fs::read_to_string(&env_path).expect("read saved env");

        assert_eq!(config.output_dir, "D:/StudyMind/custom-results");
        assert_eq!(config.asr_model, "iic/SenseVoiceSmall");
        assert_eq!(config.config_path, path_to_env_string(&env_path));
        assert!(saved.contains("StudyMind_OUTPUT_DIR=D:/StudyMind/custom-results"));
        assert!(saved.contains("StudyMind_ASR_MODEL=iic/SenseVoiceSmall"));
        assert!(saved.contains("OTHER_SETTING=keep-me"));
        assert!(!saved.contains("StudyMind_LLM_PROVIDER"));
        assert!(!saved.contains("StudyMind_LLM_BASE_URL"));
        assert!(!saved.contains("StudyMind_LLM_API_KEY"));
        assert!(!saved.contains("StudyMind_LLM_MODEL"));
        assert!(!saved.contains("StudyMind_LLM_TIMEOUT_SECONDS"));
    }

    #[test]
    fn save_llm_config_allows_output_dir_without_llm_credentials() {
        let env_path = temp_env_path("save_llm_config_allows_output_dir_only");

        let config = save_llm_config_to_file(
            &env_path,
            LlmConfigInput {
                output_dir: "D:/StudyMind/results-only".to_string(),
                asr_model: "iic/SenseVoiceSmall".to_string(),
            },
        )
        .expect("save output directory");
        let saved = fs::read_to_string(&env_path).expect("read saved env");

        assert_eq!(config.output_dir, "D:/StudyMind/results-only");
        assert_eq!(config.asr_model, "iic/SenseVoiceSmall");
        assert!(saved.contains("StudyMind_OUTPUT_DIR=D:/StudyMind/results-only"));
        assert!(saved.contains("StudyMind_ASR_MODEL=iic/SenseVoiceSmall"));
        assert!(saved.contains("StudyMind desktop local settings"));
        assert!(!saved.contains("StudyMind_LLM_API_KEY"));
    }

    #[test]
    fn desktop_worker_contract_matches_tauri_constants() {
        let contract_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("contracts")
            .join("desktop-worker-contract.json");
        let contract: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(contract_path).expect("read desktop worker contract"),
        )
        .expect("parse desktop worker contract");

        assert_eq!(
            super::DESKTOP_WORKER_CONTRACT_VERSION,
            contract["contractVersion"]
                .as_u64()
                .expect("numeric desktop contract version") as u32
        );
        assert_eq!(
            super::local_media_contract::LOCAL_MEDIA_CONTRACT_VERSION,
            contract["localMedia"]["workerRequest"]["properties"]["contract_version"]["const"]
                .as_u64()
                .expect("numeric local-media worker contract version") as u32
        );
        assert_eq!(
            serde_json::json!(super::local_media_contract::VIDEO_EXTENSIONS),
            contract["localMedia"]["extensionsByKind"]["video"]
        );
        assert_eq!(
            serde_json::json!(super::local_media_contract::AUDIO_EXTENSIONS),
            contract["localMedia"]["extensionsByKind"]["audio"]
        );
        assert_eq!(
            super::PROGRESS_EVENT_NAME,
            contract["events"]["workerProgress"]
        );
        assert_eq!(
            super::ASR_MODEL_DOWNLOAD_EVENT_NAME,
            contract["events"]["asrModelDownloadProgress"]
        );
        assert_eq!(
            super::PROGRESS_EVENT_PREFIX,
            contract["events"]["workerProgressPrefix"]
        );
        assert_eq!(
            super::MODEL_DOWNLOAD_EVENT_PREFIX,
            contract["events"]["asrModelDownloadPrefix"]
        );
        assert_eq!(super::DEFAULT_ASR_MODEL, contract["asr"]["defaultModel"]);
        assert_eq!(super::OUTPUT_DIR_ENV, contract["env"]["outputDir"]);
        assert_eq!(super::CACHE_DIR_ENV, contract["env"]["cacheDir"]);
        assert_eq!(super::MODEL_DIR_ENV, contract["env"]["modelDir"]);
    }

    fn temp_env_path(test_name: &str) -> PathBuf {
        temp_dir(test_name).join(".env")
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
