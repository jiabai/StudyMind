use crate::worker_runtime::command::WorkerCommandSpec;
use crate::worker_runtime::supervisor::{
    hide_child_console_window, terminate_process_tree, CleanupClaim, ProcessInstance,
    ProcessSupervisor,
};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::time::Duration;

pub(super) fn configure_child_process_group(command: &mut Command) {
    #[cfg(unix)]
    {
        command.process_group(0);
    }

    #[cfg(not(unix))]
    {
        let _ = command;
    }
}

pub(super) fn spawn_worker_process(
    spec: WorkerCommandSpec,
) -> Result<(Child, Option<String>), String> {
    let WorkerCommandSpec {
        program,
        args,
        stdin_payload,
        env,
        env_remove,
        current_dir,
    } = spec;
    let mut command = Command::new(program);
    hide_child_console_window(&mut command);
    configure_child_process_group(&mut command);
    for key in env_remove {
        command.env_remove(key);
    }
    command
        .args(args)
        .envs(env)
        .current_dir(current_dir)
        .stdin(if stdin_payload.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    command
        .spawn()
        .map(|child| (child, stdin_payload))
        .map_err(|error| error.to_string())
}

pub(super) fn deliver_worker_stdin(
    child: &mut Child,
    stdin_payload: Option<String>,
) -> Result<(), String> {
    let Some(payload) = stdin_payload else {
        return Ok(());
    };
    child
        .stdin
        .take()
        .ok_or(())
        .and_then(|mut stdin| stdin.write_all(payload.as_bytes()).map_err(|_| ()))
        .map_err(|_| "Failed to deliver worker request through stdin.".to_string())
}

pub(super) fn read_worker_stdout(mut stdout: ChildStdout) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    stdout.read_to_end(&mut bytes).map(|_| bytes)
}

pub(super) fn terminate_and_reap(child: &mut Child, process_group_id: u32) {
    let _ = terminate_process_tree(process_group_id);
    let _ = child.wait();
}

pub(super) fn cleanup_registered_child(
    child: &mut Child,
    supervisor: &ProcessSupervisor,
    instance: ProcessInstance,
) {
    loop {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        match supervisor.claim_cleanup(instance.instance_id) {
            CleanupClaim::Claimed(claimed) => {
                let _ = terminate_process_tree(claimed.process_group_id.unwrap_or(claimed.pid));
                let _ = child.wait();
                return;
            }
            CleanupClaim::AlreadyTerminating(_) => {
                std::thread::sleep(Duration::from_millis(10));
            }
            CleanupClaim::NotRunning => {
                let _ = child.wait();
                return;
            }
        }
    }
}
