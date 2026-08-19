use crate::worker_runtime::TaskTerminalResult;
use crate::{RuntimePaths, DESKTOP_LOG_DIR_NAME};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const DESKTOP_LOG_FILE_NAME: &str = "StudyMind-desktop.log";

/// Register the application logger so Rust-side logs land in the same file the
/// worker-event log uses (`<user-data>/logs/StudyMind-desktop.log`). Debug builds
/// keep the full Debug level; release builds default to Info, so expected noise
/// (e.g. COM apartment messages) is filtered out while warnings/errors are kept.
///
/// The plugin's default rotation (40KB, keep-one-delete) would discard the
/// worker-event history `append_desktop_log` writes to the same file, so a
/// larger cap with archived rotation is configured explicitly.
pub(crate) fn register_desktop_logger(
    app: &tauri::AppHandle,
    paths: &RuntimePaths,
) -> Result<(), tauri::Error> {
    let level = if cfg!(debug_assertions) {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    };
    app.plugin(
        tauri_plugin_log::Builder::new()
            .level(level)
            .max_file_size(10 * 1024 * 1024)
            .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
            .targets([
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder {
                    path: desktop_log_dir(paths),
                    file_name: Some(DESKTOP_LOG_FILE_NAME.to_string()),
                }),
            ])
            .build(),
    )
}

pub(crate) fn desktop_log_dir(paths: &RuntimePaths) -> PathBuf {
    paths.user_data_dir.join(DESKTOP_LOG_DIR_NAME)
}

pub(crate) fn desktop_log_path(paths: &RuntimePaths) -> PathBuf {
    desktop_log_dir(paths).join(DESKTOP_LOG_FILE_NAME)
}

pub(crate) fn append_desktop_log(
    paths: &RuntimePaths,
    event: &str,
    detail: &str,
) -> Result<(), String> {
    let log_path = desktop_log_path(paths);
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| error.to_string())?;
    let line = format!(
        "{} event={} {}\n",
        diagnostic_timestamp(),
        sanitize_log_token(event),
        sanitize_diagnostic_text(detail)
    );
    file.write_all(line.as_bytes())
        .map_err(|error| error.to_string())
}

fn diagnostic_timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| format!("unix_ms={}", duration.as_millis()))
        .unwrap_or_else(|_| "unix_ms=unknown".to_string())
}

fn sanitize_log_token(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

pub(crate) fn sanitize_diagnostic_text(text: &str) -> String {
    let redacted_lines = text
        .lines()
        .map(redact_sensitive_line)
        .collect::<Vec<_>>()
        .join(" | ");
    let without_source_urls = redact_http_urls(&redacted_lines);
    let without_credentials = redact_credential_assignments(&without_source_urls);
    let without_cookie_cli_hints = redact_cookie_cli_hints(&without_credentials);
    collapse_log_whitespace(&without_cookie_cli_hints)
}

fn redact_sensitive_line(line: &str) -> String {
    let trimmed = line.trim_start();
    let sensitive_prefixes = [
        "STUDYMIND_LLM_API_KEY=",
        "STUDYMIND_LLM_SESSION_TOKEN=",
        "Authorization:",
        "Cookie:",
        "Set-Cookie:",
    ];

    for prefix in sensitive_prefixes {
        if trimmed.starts_with(prefix) {
            let leading_len = line.len() - trimmed.len();
            return format!("{}{}[redacted]", &line[..leading_len], prefix);
        }
    }

    line.to_string()
}

fn redact_http_urls(text: &str) -> String {
    text.split_whitespace()
        .map(|token| {
            let normalized = token.to_ascii_lowercase();
            if normalized.contains("http://") || normalized.contains("https://") {
                "[url removed]"
            } else {
                token
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn redact_credential_assignments(text: &str) -> String {
    const SENSITIVE_MARKERS: [&str; 15] = [
        "xsec_token=",
        "access_token=",
        "session_token=",
        "token=",
        "signature=",
        "sig=",
        "authorization=",
        "cookie=",
        "password=",
        "passwd=",
        "credential=",
        "secret=",
        "auth=",
        "key=",
        "ticket=",
    ];
    text.split_whitespace()
        .map(|token| {
            let normalized = token.to_ascii_lowercase();
            if normalized.contains("[redacted]") {
                token
            } else if SENSITIVE_MARKERS
                .iter()
                .any(|marker| normalized.contains(marker))
            {
                "[credential removed]"
            } else {
                token
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn redact_cookie_cli_hints(text: &str) -> String {
    let mut output = Vec::new();
    let mut skip_cookie_hint = false;

    for token in text.split_whitespace() {
        let normalized = token.trim_matches(|character: char| {
            matches!(
                character,
                '"' | '\'' | ',' | ';' | ':' | '(' | ')' | '[' | ']'
            )
        });
        if normalized.starts_with("--cookies") {
            skip_cookie_hint = true;
            continue;
        }
        if skip_cookie_hint {
            if token.ends_with('.') || token.ends_with('|') {
                skip_cookie_hint = false;
            }
            continue;
        }
        output.push(token);
    }

    output.join(" ")
}

fn collapse_log_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn summarize_worker_result_for_log(result: &TaskTerminalResult) -> String {
    let mut parts = Vec::new();
    parts.push(format!("status={}", result.status.as_str()));

    if let Some(task_id) = result.task_id.as_deref() {
        parts.push(format!("task_id={task_id}"));
    }

    if let Some(error) = result.error.as_ref() {
        parts.push(format!("error_code={}", error.code));
        parts.push(format!("error_stage={}", error.stage.as_str()));
        parts.push(format!(
            "error_message={}",
            truncate_for_log(&sanitize_diagnostic_text(&error.message), 500)
        ));
    }

    parts.join(" ")
}

pub(crate) fn truncate_for_log(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }

    value
        .chars()
        .take(max_chars.saturating_sub(3))
        .collect::<String>()
        + "..."
}

#[cfg(test)]
mod tests {
    use super::{
        append_desktop_log, desktop_log_path, sanitize_diagnostic_text,
        summarize_worker_result_for_log,
    };
    use crate::RuntimePaths;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn desktop_log_path_lives_under_app_local_logs() {
        let root = temp_dir("desktop_log_path_lives_under_app_local_logs");
        let paths = RuntimePaths {
            resource_dir: root.join("resources"),
            user_data_dir: root.join("app-data"),
        };

        assert_eq!(
            desktop_log_path(&paths),
            paths.user_data_dir.join("logs").join("StudyMind-desktop.log")
        );
    }

    #[test]
    fn desktop_log_redacts_sensitive_values_before_writing() {
        let root = temp_dir("desktop_log_redacts_sensitive_values_before_writing");
        let paths = RuntimePaths {
            resource_dir: root.join("resources"),
            user_data_dir: root.join("app-data"),
        };

        append_desktop_log(
            &paths,
            "worker.finish",
            "STUDYMIND_LLM_API_KEY=sk-secret\nSTUDYMIND_LLM_SESSION_TOKEN=session-token\nhttps://example.test/video?sig=SECRET Use --cookies cookies.txt.",
        )
        .expect("write desktop log");

        let log = fs::read_to_string(desktop_log_path(&paths)).expect("read desktop log");
        assert!(log.contains("worker.finish"));
        assert!(log.contains("[redacted]"));
        assert!(log.contains("[url removed]"));
        assert!(!log.contains("sk-secret"));
        assert!(!log.contains("session-token"));
        assert!(!log.contains("sig=SECRET"));
        assert!(!log.contains("--cookies"));
    }

    #[test]
    fn desktop_log_redacts_deep_link_ticket_tokens() {
        let redacted = sanitize_diagnostic_text(
            "studymind://auth/callback?ticket=flt_secret123&state=state-1",
        );
        assert_eq!(redacted, "[credential removed]");
    }

    #[test]
    fn worker_result_log_summary_includes_status_task_and_sanitized_error() {
        use crate::worker_runtime::{
            TaskError, TaskErrorStage, TaskTerminalResult, TaskTerminalStatus,
        };
        use std::collections::HashMap;

        let result = TaskTerminalResult {
            status: TaskTerminalStatus::Failed,
            task_id: Some("20260705-120000-local-demo".to_string()),
            task_dir: None,
            artifacts: HashMap::new(),
            text: String::new(),
            summary: String::new(),
            insights: Vec::new(),
            transcript: None,
            dissection: None,
            dissection_source_status: None,
            error: Some(TaskError {
                code: "LOCAL_MEDIA_FAILED".to_string(),
                message:
                    "extraction failed https://example.test/video?sig=SECRET Use --cookies cookies.txt."
                        .to_string(),
                stage: TaskErrorStage::VideoExtracting,
            }),
        };

        let summary = summarize_worker_result_for_log(&result);

        assert!(summary.contains("status=failed"));
        assert!(summary.contains("task_id=20260705-120000-local-demo"));
        assert!(summary.contains("error_code=LOCAL_MEDIA_FAILED"));
        assert!(summary.contains("error_stage=video_extracting"));
        assert!(summary.contains("[url removed]"));
        assert!(!summary.contains("sig=SECRET"));
        assert!(!summary.contains("--cookies"));
    }

    #[test]
    fn diagnostic_text_redacts_llm_and_cookie_material() {
        let sanitized = sanitize_diagnostic_text(
            "STUDYMIND_LLM_API_KEY=secret\nSTUDYMIND_LLM_SESSION_TOKEN=token\nAuthorization: Bearer abc\nCookie: SID=1\n--cookies-from-browser chrome",
        );

        assert!(sanitized.contains("[redacted]"));
        assert!(!sanitized.contains("secret"));
        assert!(!sanitized.contains("token"));
        assert!(!sanitized.contains("Bearer abc"));
        assert!(!sanitized.contains("SID=1"));
        assert!(!sanitized.contains("--cookies-from-browser"));
    }

    #[test]
    fn diagnostic_text_redacts_embedded_sensitive_source_url() {
        let sanitized = sanitize_diagnostic_text(
            "ERROR downloader failed https://www.xiaohongshu.com/explore/demo?xsec_token=review-secret xsec_token=review-secret",
        );

        assert!(!sanitized.contains("review-secret"));
        assert!(!sanitized.contains("xsec_token"));
        assert!(!sanitized.contains("xiaohongshu.com"));
        assert!(sanitized.contains("[url removed]"));
    }

    #[test]
    fn diagnostic_text_redacts_uppercase_url_with_userinfo() {
        let sanitized = sanitize_diagnostic_text(
            "ERROR HTTPS://alice:review-secret@www.xiaohongshu.com/explore/demo",
        );

        assert!(!sanitized.contains("review-secret"));
        assert!(!sanitized.contains("alice"));
        assert!(!sanitized.contains("xiaohongshu.com"));
        assert!(sanitized.contains("[url removed]"));
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
