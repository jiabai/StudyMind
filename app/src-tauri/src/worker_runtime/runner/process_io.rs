use crate::worker_runtime::command::WorkerCommandSpec;
use crate::worker_runtime::supervisor::{
    hide_child_console_window, CleanupClaim, ProcessInstance, ProcessSupervisor, ProcessTreeHandle,
};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::thread::JoinHandle;

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
) -> Result<(Child, Option<String>, ProcessTreeHandle), String> {
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
        .map(|child| {
            let tree = ProcessTreeHandle::attach(&child);
            (child, stdin_payload, tree)
        })
        .map_err(|error| error.to_string())
}

#[allow(dead_code)]
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

pub(super) fn spawn_worker_stdin_delivery(
    child: &mut Child,
    stdin_payload: Option<String>,
) -> Result<Option<JoinHandle<Result<(), String>>>, String> {
    let Some(payload) = stdin_payload else {
        return Ok(None);
    };
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to open worker stdin pipe.".to_string())?;
    Ok(Some(std::thread::spawn(move || {
        deliver_stdin_to_pipe(stdin, payload)
    })))
}

fn deliver_stdin_to_pipe(mut stdin: ChildStdin, payload: String) -> Result<(), String> {
    stdin
        .write_all(payload.as_bytes())
        .map_err(|_| "Failed to deliver worker request through stdin.".to_string())
}

pub(super) fn read_worker_stdout(mut stdout: ChildStdout) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    stdout.read_to_end(&mut bytes).map(|_| bytes)
}

pub(super) fn terminate_and_reap(
    child: &mut Child,
    process_group_id: u32,
    tree: &ProcessTreeHandle,
) {
    if tree.terminate(process_group_id).is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
}

pub(super) fn cleanup_registered_child(
    child: &mut Child,
    supervisor: &ProcessSupervisor,
    instance: ProcessInstance,
    tree: &ProcessTreeHandle,
) {
    loop {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        match supervisor.claim_cleanup(instance.instance_id) {
            CleanupClaim::Claimed(claimed) => {
                if tree
                    .terminate(claimed.process_group_id.unwrap_or(claimed.pid))
                    .is_err()
                {
                    let _ = child.kill();
                }
                let _ = child.wait();
                return;
            }
            CleanupClaim::AlreadyTerminating(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
            CleanupClaim::NotRunning => {
                let _ = child.wait();
                return;
            }
        }
    }
}
