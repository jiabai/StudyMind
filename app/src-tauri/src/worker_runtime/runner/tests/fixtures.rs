use super::super::{
    ProgressRoute, RunnerHooks, WatchdogPolicy, WorkerLane, WorkerOperation, WorkerRunRequest,
};
use crate::worker_runtime::command::WorkerCommandSpec;
use crate::RuntimePaths;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(super) fn fixture_request(
    test_name: &str,
    probe_env: &str,
    stdin_payload: Option<String>,
) -> WorkerRunRequest {
    WorkerRunRequest {
        operation: WorkerOperation::ProcessVideo,
        command: WorkerCommandSpec {
            program: std::env::current_exe().expect("resolve test executable"),
            args: vec![
                "--exact".to_string(),
                test_name.to_string(),
                "--nocapture".to_string(),
            ],
            stdin_payload,
            env: vec![(probe_env.to_string(), "1".to_string())],
            env_remove: Vec::new(),
            current_dir: std::env::current_dir().expect("resolve test directory"),
        },
        progress: ProgressRoute::None,
    }
}

pub(super) fn watchdog_hooks(
    idle_timeout_ms: Option<u64>,
    absolute_timeout_ms: u64,
) -> RunnerHooks {
    RunnerHooks {
        watchdog_policy: Some(WatchdogPolicy {
            idle_timeout: idle_timeout_ms.map(Duration::from_millis),
            absolute_timeout: Duration::from_millis(absolute_timeout_ms),
        }),
        watchdog_retry_backoff: Some(Duration::from_millis(25)),
        ..RunnerHooks::default()
    }
}

pub(super) fn watchdog_fixture_request(
    operation: WorkerOperation,
    progress: ProgressRoute,
    script: String,
    stdin_payload: Option<String>,
) -> WorkerRunRequest {
    let (program, args) = shell_fixture_command(script);
    WorkerRunRequest {
        operation,
        command: WorkerCommandSpec {
            program,
            args,
            stdin_payload,
            env: Vec::new(),
            env_remove: Vec::new(),
            current_dir: std::env::current_dir().expect("resolve test directory"),
        },
        progress,
    }
}

pub(super) fn watchdog_tree_fixture_request(pid_file: &Path) -> WorkerRunRequest {
    let (program, args) = shell_fixture_command(watchdog_tree_fixture_script());
    WorkerRunRequest {
        operation: WorkerOperation::ProcessVideo,
        command: WorkerCommandSpec {
            program,
            args,
            stdin_payload: None,
            env: vec![(
                "STUDYMIND_TEST_CHILD_PID_FILE".to_string(),
                pid_file.to_string_lossy().into_owned(),
            )],
            env_remove: Vec::new(),
            current_dir: std::env::current_dir().expect("resolve test directory"),
        },
        progress: ProgressRoute::None,
    }
}

#[cfg(windows)]
pub(super) fn shell_fixture_command(script: String) -> (PathBuf, Vec<String>) {
    (
        PathBuf::from("powershell.exe"),
        vec![
            "-NoLogo".to_string(),
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-Command".to_string(),
            script,
        ],
    )
}

#[cfg(unix)]
pub(super) fn shell_fixture_command(script: String) -> (PathBuf, Vec<String>) {
    (PathBuf::from("/bin/sh"), vec!["-c".to_string(), script])
}

pub(super) fn valid_progress_line() -> &'static str {
    r#"STUDYMIND_PROGRESS {"stage":"video_extracting","progress":22,"message_code":"video.download.preparing"}"#
}

#[cfg(windows)]
pub(super) fn silent_fixture_script() -> String {
    "Start-Sleep -Seconds 30".to_string()
}

#[cfg(unix)]
pub(super) fn silent_fixture_script() -> String {
    "sleep 30".to_string()
}

#[cfg(windows)]
pub(super) fn watchdog_tree_fixture_script() -> String {
    "$child = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30') -PassThru -WindowStyle Hidden; [System.IO.File]::WriteAllText($env:STUDYMIND_TEST_CHILD_PID_FILE, [string]$child.Id); Wait-Process -Id $child.Id".to_string()
}

#[cfg(unix)]
pub(super) fn watchdog_tree_fixture_script() -> String {
    "sleep 30 & child_pid=$!; printf '%s' \"$child_pid\" > \"$STUDYMIND_TEST_CHILD_PID_FILE\"; trap 'wait \"$child_pid\" 2>/dev/null; exit 143' TERM INT HUP; wait \"$child_pid\"".to_string()
}

#[cfg(windows)]
pub(super) fn progress_then_result_fixture_script() -> String {
    format!(
        "for ($i = 0; $i -lt 6; $i++) {{ [Console]::Error.WriteLine('{}'); [Console]::Error.Flush(); Start-Sleep -Milliseconds 400 }}; [Console]::Out.WriteLine('{}')",
        valid_progress_line(),
        valid_task_stdout()
    )
}

#[cfg(unix)]
pub(super) fn progress_then_result_fixture_script() -> String {
    format!(
        "for i in 1 2 3 4 5 6; do printf '%s\\n' '{}' >&2; sleep 0.4; done; printf '%s\\n' '{}'",
        valid_progress_line(),
        valid_task_stdout()
    )
}

#[cfg(windows)]
pub(super) fn endless_progress_fixture_script() -> String {
    format!(
        "while ($true) {{ [Console]::Error.WriteLine('{}'); [Console]::Error.Flush(); Start-Sleep -Milliseconds 250 }}",
        valid_progress_line()
    )
}

#[cfg(unix)]
pub(super) fn endless_progress_fixture_script() -> String {
    format!(
        "while :; do printf '%s\\n' '{}' >&2; sleep 0.25; done",
        valid_progress_line()
    )
}

#[cfg(windows)]
pub(super) fn untrusted_spam_fixture_script() -> String {
    "while ($true) { [Console]::Error.WriteLine('STUDYMIND_PROGRESS {not-json'); [Console]::Error.WriteLine('diagnostic'); [Console]::Error.WriteLine(''); [Console]::Out.WriteLine('stdout-noise'); [Console]::Error.Flush(); [Console]::Out.Flush(); Start-Sleep -Milliseconds 250 }".to_string()
}

#[cfg(unix)]
pub(super) fn untrusted_spam_fixture_script() -> String {
    "while :; do printf '%s\\n' 'STUDYMIND_PROGRESS {not-json' 'diagnostic' '' >&2; printf '%s\\n' 'stdout-noise'; sleep 0.25; done".to_string()
}

#[cfg(windows)]
pub(super) fn result_then_stall_fixture_script() -> String {
    format!(
        "[Console]::Out.WriteLine('{}'); [Console]::Out.Flush(); Start-Sleep -Seconds 30",
        valid_task_stdout()
    )
}

#[cfg(unix)]
pub(super) fn result_then_stall_fixture_script() -> String {
    format!("printf '%s\\n' '{}'; sleep 30", valid_task_stdout())
}

pub(super) fn terminal_fixture_request(
    stdin_payload: Option<String>,
    require_stdin: bool,
) -> WorkerRunRequest {
    let (program, args) = terminal_fixture_command(require_stdin);
    WorkerRunRequest {
        operation: WorkerOperation::ProcessVideo,
        command: WorkerCommandSpec {
            program,
            args,
            stdin_payload,
            env: Vec::new(),
            env_remove: Vec::new(),
            current_dir: std::env::current_dir().expect("resolve test directory"),
        },
        progress: ProgressRoute::None,
    }
}

#[cfg(windows)]
pub(super) fn terminal_fixture_command(require_stdin: bool) -> (PathBuf, Vec<String>) {
    let stdin_check = if require_stdin {
        "$payload = [Console]::In.ReadToEnd(); if ([string]::IsNullOrEmpty($payload)) { exit 17 }; "
    } else {
        ""
    };
    let script = format!(
        "{stdin_check}[Console]::Out.WriteLine('{}')",
        valid_task_stdout()
    );
    (
        PathBuf::from("powershell.exe"),
        vec![
            "-NoLogo".to_string(),
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-Command".to_string(),
            script,
        ],
    )
}

#[cfg(unix)]
pub(super) fn terminal_fixture_command(require_stdin: bool) -> (PathBuf, Vec<String>) {
    let stdin_check = if require_stdin {
        "payload=$(cat); test -n \"$payload\" || exit 17; "
    } else {
        ""
    };
    let script = format!("{stdin_check}printf '%s\\n' '{}'", valid_task_stdout());
    (PathBuf::from("/bin/sh"), vec!["-c".to_string(), script])
}

pub(super) fn valid_task_stdout() -> &'static str {
    r#"{"status":"completed","task_id":"safe-task","task_dir":null,"artifacts":{},"text":"","summary":"","insights":[],"transcript":null,"dissection":null,"error":null}"#
}

pub(super) fn wait_until_active(lane: &WorkerLane) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !lane.is_active() && Instant::now() < deadline {
        std::thread::yield_now();
    }
    assert!(lane.is_active(), "runner did not become active");
}

pub(super) fn wait_for_numeric_fixture_pid(path: &Path, timeout: Duration) -> Option<u32> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(value) = std::fs::read_to_string(path) {
            if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) {
                if let Ok(pid) = value.parse::<u32>() {
                    if pid > 0 {
                        return Some(pid);
                    }
                }
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

pub(super) fn wait_until_fixture_process_is_gone(pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while fixture_process_is_alive(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        !fixture_process_is_alive(pid),
        "watchdog left the fixture descendant alive"
    );
}

#[cfg(unix)]
pub(super) fn fixture_process_is_alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(windows)]
pub(super) fn fixture_process_is_alive(pid: u32) -> bool {
    let mut command = Command::new("powershell.exe");
    crate::worker_runtime::supervisor::hide_child_console_window(&mut command);
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!(
                "if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 0 }} else {{ exit 1 }}"
            ),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

pub(super) fn test_paths(label: &str) -> RuntimePaths {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "StudyMind-worker-runner-{label}-{}-{nonce}",
        std::process::id()
    ));
    RuntimePaths {
        resource_dir: root.join("resources"),
        user_data_dir: root.join("user-data"),
    }
}

#[cfg(windows)]
pub(super) fn exit_status(code: u32) -> std::process::ExitStatus {
    use std::os::windows::process::ExitStatusExt;
    std::process::ExitStatus::from_raw(code)
}

#[cfg(unix)]
pub(super) fn exit_status(code: i32) -> std::process::ExitStatus {
    use std::os::unix::process::ExitStatusExt;
    std::process::ExitStatus::from_raw(code << 8)
}
