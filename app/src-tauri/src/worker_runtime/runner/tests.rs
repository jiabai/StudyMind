mod fixtures;
mod lifecycle;
mod progress;
mod terminal;
mod watchdog;

use std::path::{Path, PathBuf};

fn collect_runner_rust_sources(dir: &Path, sources: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("read Rust source directory") {
        let path = entry.expect("read Rust source entry").path();
        if path.is_dir() {
            collect_runner_rust_sources(&path, sources);
        } else if path.extension().and_then(|value| value.to_str()) == Some("rs") {
            sources.push(path);
        }
    }
}

fn direct_rust_file_names(dir: &Path) -> Vec<String> {
    let mut names = std::fs::read_dir(dir)
        .expect("read Rust owner directory")
        .map(|entry| entry.expect("read Rust owner entry").path())
        .filter(|path| path.is_file())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("rs"))
        .map(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .expect("UTF-8 Rust file name")
                .to_string()
        })
        .collect::<Vec<_>>();
    names.sort();
    names
}

#[test]
fn worker_runner_module_boundary_matches_approved_private_owners() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let runtime_dir = src.join("worker_runtime");
    let root_path = runtime_dir.join("runner.rs");
    let module_dir = runtime_dir.join("runner");
    let root = std::fs::read_to_string(&root_path).expect("read runner root");
    let progress_event = std::fs::read_to_string(src.join("progress_event.rs"))
        .expect("read shared progress boundary");
    let asr_model =
        std::fs::read_to_string(src.join("asr_model.rs")).expect("read ASR model owner");
    let process_io =
        std::fs::read_to_string(module_dir.join("process_io.rs")).expect("read process I/O owner");
    let watchdog =
        std::fs::read_to_string(module_dir.join("watchdog.rs")).expect("read watchdog owner");
    let progress =
        std::fs::read_to_string(module_dir.join("progress.rs")).expect("read progress owner");
    let terminal =
        std::fs::read_to_string(module_dir.join("terminal.rs")).expect("read terminal owner");

    assert_eq!(
        direct_rust_file_names(&module_dir),
        vec![
            String::from("process_io.rs"),
            String::from("progress.rs"),
            String::from("terminal.rs"),
            String::from("tests.rs"),
            String::from("watchdog.rs"),
        ]
    );
    assert_eq!(
        direct_rust_file_names(&module_dir.join("tests")),
        vec![
            String::from("fixtures.rs"),
            String::from("lifecycle.rs"),
            String::from("progress.rs"),
            String::from("terminal.rs"),
            String::from("watchdog.rs"),
        ]
    );

    assert!(root.lines().count() <= 500, "runner root exceeds 500 lines");
    for (name, source) in [
        ("process_io", process_io.as_str()),
        ("watchdog", watchdog.as_str()),
        ("progress", progress.as_str()),
        ("terminal", terminal.as_str()),
    ] {
        assert!(
            source.lines().count() <= 400,
            "{name} exceeds the approved 400-line review alarm"
        );
    }
    for relative in [
        "tests.rs",
        "tests/fixtures.rs",
        "tests/lifecycle.rs",
        "tests/progress.rs",
        "tests/terminal.rs",
        "tests/watchdog.rs",
    ] {
        let source = std::fs::read_to_string(module_dir.join(relative))
            .unwrap_or_else(|_| panic!("read test owner {relative}"));
        assert!(
            source.lines().count() <= 500,
            "{relative} recreates a test hotspot"
        );
    }

    for module in ["process_io", "progress", "terminal", "watchdog", "tests"] {
        let declaration = format!("mod {module};");
        assert!(
            root.lines().any(|line| line.trim() == declaration.as_str()),
            "missing private {declaration}"
        );
    }
    assert!(root.contains("pub(crate) use progress::ProgressRoute;"));
    assert!(root.contains("pub(crate) use terminal::WorkerExitSummary;"));
    assert!(root.contains("pub(super) use watchdog::WatchdogPolicy;"));

    for moved in [
        "fn configure_child_process_group",
        "struct WatchdogControl",
        "pub(crate) enum ProgressRoute",
        "fn read_stderr",
        "fn safe_start_log_detail",
        "fn classify_terminal",
    ] {
        assert!(!root.contains(moved), "runner root still owns {moved}");
    }
    assert!(root.contains("pub(crate) struct WorkerLane"));
    assert!(root.contains("fn run_inner"));
    assert!(root.contains("struct InstanceGuard"));
    assert!(root.contains("struct RunnerHooks"));

    for required in [
        "pub(super) fn configure_child_process_group",
        "pub(super) fn spawn_worker_process",
        "pub(super) fn deliver_worker_stdin",
        "pub(super) fn read_worker_stdout",
        "pub(super) fn terminate_and_reap",
        "pub(super) fn cleanup_registered_child",
    ] {
        assert!(
            process_io.contains(required),
            "process_io missing {required}"
        );
    }
    for required in [
        "pub(in crate::worker_runtime) struct WatchdogPolicy",
        "pub(in crate::worker_runtime) fn idle_timeout",
        "pub(in crate::worker_runtime) fn absolute_timeout",
        "pub(in crate::worker_runtime) fn watchdog_policy",
        "pub(super) struct WatchdogControl",
        "pub(super) fn record_validated_progress",
        "pub(super) struct WatchdogHandle",
        "pub(super) fn start_watchdog",
        "pub(super) fn run_watchdog_with_terminator",
    ] {
        assert!(watchdog.contains(required), "watchdog missing {required}");
    }
    for required in [
        "pub(crate) enum ProgressRoute",
        "pub(super) struct StderrSummary",
        "pub(super) fn read_stderr",
        "pub(super) fn inspect_progress_line",
    ] {
        assert!(progress.contains(required), "progress missing {required}");
    }
    for required in [
        "pub(crate) struct WorkerExitSummary",
        "pub(super) fn safe_start_log_detail",
        "pub(super) fn safe_exit_log_detail",
        "pub(super) fn classify_terminal",
    ] {
        assert!(terminal.contains(required), "terminal missing {required}");
    }

    assert!(progress.contains("super::watchdog"));
    assert!(terminal.contains("super::progress"));
    for constant in [
        "ASR_MODEL_DOWNLOAD_EVENT_NAME",
        "MODEL_DOWNLOAD_EVENT_PREFIX",
    ] {
        let definition = format!("pub(crate) const {constant}");
        assert!(
            progress_event.contains(definition.as_str()),
            "shared progress boundary must define {constant}"
        );
        assert!(
            asr_model.contains("pub(crate) use crate::progress_event")
                && asr_model.contains(constant),
            "ASR model compatibility path must re-export {constant}"
        );
        assert!(
            !asr_model.contains(definition.as_str()),
            "ASR model must not define {constant}"
        );
    }
    for (name, source, forbidden_edges) in [
        (
            "process_io",
            process_io.as_str(),
            ["super::watchdog", "super::progress", "super::terminal"].as_slice(),
        ),
        (
            "watchdog",
            watchdog.as_str(),
            ["super::process_io", "super::progress", "super::terminal"].as_slice(),
        ),
        (
            "progress",
            progress.as_str(),
            ["super::process_io", "super::terminal"].as_slice(),
        ),
        (
            "terminal",
            terminal.as_str(),
            ["super::process_io", "super::watchdog"].as_slice(),
        ),
    ] {
        for &forbidden in forbidden_edges {
            assert!(
                !source.contains(forbidden),
                "{name} has forbidden dependency {forbidden}"
            );
        }
        for forbidden in [
            "crate::worker_runtime::runner::",
            "crate::account",
            "crate::asr_model",
            "crate::history",
            "crate::insight_preferences",
            "crate::settings",
            "crate::task_manifest",
            "crate::transcript_detail",
            "crate::ui_preferences",
            "crate::updates",
            "crate::video_processing",
            "termination_command_spec",
            "send_process_group_signal",
            "ProcessSignal",
            "taskkill",
            "tauri::command",
            "struct WorkerLane",
            "fn run_inner",
            "fn cancel(",
            "fn is_active(",
        ] {
            assert!(
                !source.contains(forbidden),
                "{name} contains forbidden ownership {forbidden}"
            );
        }
    }

    let mut sources = Vec::new();
    collect_runner_rust_sources(&src, &mut sources);
    for path in sources {
        if path == root_path || path.starts_with(&module_dir) {
            continue;
        }
        let source = std::fs::read_to_string(&path).expect("read Rust caller");
        for forbidden in [
            "runner::process_io",
            "runner::watchdog",
            "runner::progress",
            "runner::terminal",
        ] {
            assert!(
                !source.contains(forbidden),
                "{} bypasses the stable runner through {forbidden}",
                path.display()
            );
        }
    }
}
