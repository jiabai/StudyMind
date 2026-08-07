use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

const TASK_BUSY_ERROR: &str = "Task is busy. Try again shortly.";
static ACTIVE_TASKS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

#[derive(Debug)]
pub(crate) struct TaskLease {
    key: PathBuf,
}

impl Drop for TaskLease {
    fn drop(&mut self) {
        let registry = ACTIVE_TASKS.get_or_init(|| Mutex::new(HashSet::new()));
        let mut active = registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        active.remove(&self.key);
    }
}

pub(crate) fn acquire_task(task_dir: &Path) -> Result<Arc<TaskLease>, String> {
    try_acquire_task(task_dir)?.ok_or_else(|| TASK_BUSY_ERROR.to_string())
}

pub(crate) fn try_acquire_task(task_dir: &Path) -> Result<Option<Arc<TaskLease>>, String> {
    let key = fs::canonicalize(task_dir).unwrap_or_else(|_| task_dir.to_path_buf());
    let registry = ACTIVE_TASKS.get_or_init(|| Mutex::new(HashSet::new()));
    let mut active = registry
        .lock()
        .map_err(|_| "Task coordinator is unavailable.".to_string())?;
    if !active.insert(key.clone()) {
        return Ok(None);
    }
    Ok(Some(Arc::new(TaskLease { key })))
}
