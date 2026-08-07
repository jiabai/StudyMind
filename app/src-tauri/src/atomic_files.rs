use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[cfg(test)]
thread_local! {
    static FAIL_NEXT_INSTALL: std::cell::RefCell<Option<PathBuf>> = const {
        std::cell::RefCell::new(None)
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AtomicFileError;

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), AtomicFileError> {
    atomic_write_using(path, bytes, replace_file)
}

fn atomic_write_using<F>(path: &Path, bytes: &[u8], replace: F) -> Result<(), AtomicFileError>
where
    F: FnOnce(&Path, &Path) -> io::Result<()>,
{
    let parent = path.parent().ok_or(AtomicFileError)?;
    fs::create_dir_all(parent).map_err(|_| AtomicFileError)?;
    validate_destination(path)?;
    let staging = staging_path(path)?;
    write_synced_new_file(&staging, bytes)?;
    let result = (|| {
        validate_regular_file(&staging)?;
        validate_destination(path)?;
        replace(&staging, path).map_err(|_| AtomicFileError)?;
        sync_parent_best_effort(path);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    result
}

#[cfg(test)]
pub(crate) fn atomic_write_with_replace_for_test<F>(
    path: &Path,
    bytes: &[u8],
    replace: F,
) -> Result<(), AtomicFileError>
where
    F: FnOnce(&Path, &Path) -> io::Result<()>,
{
    atomic_write_using(path, bytes, replace)
}

pub(crate) fn write_synced_new_file(path: &Path, bytes: &[u8]) -> Result<(), AtomicFileError> {
    let result = (|| {
        let parent = path.parent().ok_or(AtomicFileError)?;
        fs::create_dir_all(parent).map_err(|_| AtomicFileError)?;
        validate_destination(path)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|_| AtomicFileError)?;
        file.write_all(bytes).map_err(|_| AtomicFileError)?;
        file.sync_all().map_err(|_| AtomicFileError)?;
        drop(file);
        validate_regular_file(path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}

pub(crate) fn install_staged_file(
    staging: &Path,
    destination: &Path,
) -> Result<(), AtomicFileError> {
    if staging.parent() != destination.parent() {
        return Err(AtomicFileError);
    }
    #[cfg(test)]
    if should_fail_install_for_test(destination) {
        return Err(AtomicFileError);
    }
    validate_regular_file(staging)?;
    validate_destination(destination)?;
    replace_file(staging, destination).map_err(|_| AtomicFileError)?;
    sync_parent_best_effort(destination);
    Ok(())
}

#[cfg(test)]
pub(crate) fn fail_next_install_for_test(destination: PathBuf) {
    FAIL_NEXT_INSTALL.with(|slot| *slot.borrow_mut() = Some(destination));
}

#[cfg(test)]
fn should_fail_install_for_test(destination: &Path) -> bool {
    FAIL_NEXT_INSTALL.with(|slot| {
        let should_fail = slot.borrow().as_deref() == Some(destination);
        if should_fail {
            slot.borrow_mut().take();
        }
        should_fail
    })
}

pub(crate) fn atomic_remove_file(path: &Path) -> Result<(), AtomicFileError> {
    let parent = path.parent().ok_or(AtomicFileError)?;
    validate_directory(parent)?;
    let Some(metadata) = metadata_if_present(path)? else {
        return Ok(());
    };
    if !metadata.is_file() || is_link_or_reparse_point(&metadata) {
        return Err(AtomicFileError);
    }
    fs::remove_file(path).map_err(|_| AtomicFileError)?;
    sync_parent_best_effort(path);
    Ok(())
}

fn staging_path(destination: &Path) -> Result<PathBuf, AtomicFileError> {
    let parent = destination.parent().ok_or(AtomicFileError)?;
    let stem = destination
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or(AtomicFileError)?
        .trim_start_matches('.');
    let extension = destination
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    Ok(parent.join(format!(
        ".{stem}.{}.part{extension}",
        Uuid::new_v4().simple()
    )))
}

fn validate_destination(path: &Path) -> Result<(), AtomicFileError> {
    let parent = path.parent().ok_or(AtomicFileError)?;
    validate_directory(parent)?;
    let Some(metadata) = metadata_if_present(path)? else {
        return Ok(());
    };
    if metadata.is_file() && !is_link_or_reparse_point(&metadata) {
        Ok(())
    } else {
        Err(AtomicFileError)
    }
}

fn validate_regular_file(path: &Path) -> Result<(), AtomicFileError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| AtomicFileError)?;
    if metadata.is_file() && !is_link_or_reparse_point(&metadata) {
        Ok(())
    } else {
        Err(AtomicFileError)
    }
}

fn validate_directory(path: &Path) -> Result<(), AtomicFileError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| AtomicFileError)?;
    if metadata.is_dir() && !is_link_or_reparse_point(&metadata) {
        Ok(())
    } else {
        Err(AtomicFileError)
    }
}

fn metadata_if_present(path: &Path) -> Result<Option<fs::Metadata>, AtomicFileError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(AtomicFileError),
    }
}

#[cfg(not(windows))]
fn is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(windows)]
fn is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn replace_file(staging: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(staging, destination)
}

#[cfg(windows)]
fn replace_file(staging: &Path, destination: &Path) -> io::Result<()> {
    use std::ptr;

    #[link(name = "kernel32")]
    extern "system" {
        fn ReplaceFileW(
            replaced_file_name: *const u16,
            replacement_file_name: *const u16,
            backup_file_name: *const u16,
            replace_flags: u32,
            exclude: *mut core::ffi::c_void,
            reserved: *mut core::ffi::c_void,
        ) -> i32;
    }

    if !destination.exists() {
        return fs::rename(staging, destination);
    }
    let destination_wide = wide_path(destination);
    let staging_wide = wide_path(staging);
    let replaced = unsafe {
        ReplaceFileW(
            destination_wide.as_ptr(),
            staging_wide.as_ptr(),
            ptr::null(),
            0,
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    if replaced == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn sync_parent_best_effort(path: &Path) {
    let Some(parent) = path.parent() else {
        return;
    };
    if let Ok(directory) = File::open(parent) {
        let _ = directory.sync_all();
    }
}
