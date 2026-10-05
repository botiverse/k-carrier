//! Move state aside intact, under the same writer lock used by upgrades.
use crate::{
    Result,
    error::invalid,
    lock::UpgradeLock,
    state::OperationRead,
    storage::{FileStore, ensure_dir, exists, sync_dir, write_json},
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub format_version: u32,
    pub kind: String,
    pub source_path: PathBuf,
    pub quarantine_path: PathBuf,
    pub operation_id: String,
    pub timestamp_ms: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Quarantined,
    AlreadyQuarantined,
    NotFound,
}
#[derive(Debug, Clone, Serialize)]
pub struct QuarantineResult {
    pub status: Status,
    #[serde(flatten)]
    pub receipt: Receipt,
}

/// `handoff` must prove the host is safe while the writer lock is held.
/// Unreadable state is preserved only when the caller explicitly opts in.
pub fn quarantine_state(
    source: &Path,
    destination: &Path,
    timestamp_ms: u64,
    allow_unreadable: bool,
    handoff: Option<&dyn Fn() -> Result<()>>,
) -> Result<QuarantineResult> {
    if !source.is_absolute() || !destination.is_absolute() {
        return Err(invalid("QUARANTINE_INVALID_DESTINATION"));
    }
    // Canonicalize existing parents to reject aliases into the source tree.
    let source = normalize(source)?;
    let destination = normalize(destination)?;
    if destination.starts_with(&source) {
        return Err(invalid("QUARANTINE_INVALID_DESTINATION"));
    }
    if exists(&destination)? {
        if exists(&source)? {
            return Err(invalid("QUARANTINE_DESTINATION_CONFLICT"));
        }
        let receipt = fs::read(destination.join("fresh-install-quarantine.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Receipt>(&b).ok())
            .filter(|r| {
                r.format_version == 1
                    && r.kind == "k-fresh-install-quarantine"
                    && r.source_path == source
                    && r.quarantine_path == destination
            })
            .ok_or_else(|| invalid("QUARANTINE_DESTINATION_CONFLICT"))?;
        return Ok(QuarantineResult {
            status: Status::AlreadyQuarantined,
            receipt,
        });
    }
    let mut receipt = Receipt {
        format_version: 1,
        kind: "k-fresh-install-quarantine".into(),
        source_path: source.clone(),
        quarantine_path: destination.clone(),
        operation_id: "genesis".into(),
        timestamp_ms,
    };
    if !exists(&source)? {
        return Ok(QuarantineResult {
            status: Status::NotFound,
            receipt,
        });
    }
    let _lock = UpgradeLock::acquire(&source).map_err(|e| match e {
        crate::Error::Locked(_) => invalid("QUARANTINE_ACTIVE_LOCK"),
        other => other,
    })?;
    let requires_handoff = match FileStore::new(&source).read_operation() {
        OperationRead::Unreadable { .. } if !allow_unreadable => {
            return Err(invalid("QUARANTINE_STATE_UNREADABLE"));
        }
        OperationRead::Unreadable { .. } => true,
        OperationRead::Observed { operation } => {
            receipt.operation_id = operation.id;
            operation.outcome.is_none()
        }
        OperationRead::Genesis => fs::metadata(source.join("journal.jsonl"))
            .map(|meta| meta.len() > 0)
            .or_else(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    Ok(false)
                } else {
                    Err(error)
                }
            })?,
    };
    if requires_handoff || handoff.is_some() {
        handoff.ok_or_else(|| invalid("QUARANTINE_ACTIVE_OPERATION"))?()
            .map_err(|_| invalid("QUARANTINE_ACTIVE_OPERATION"))?;
    }
    ensure_dir(
        destination
            .parent()
            .ok_or_else(|| invalid("QUARANTINE_INVALID_DESTINATION"))?,
    )?;
    write_json(&source.join("fresh-install-quarantine.json"), &receipt)?;
    rename_exclusive(&source, &destination)?;
    sync_dir(source.parent().unwrap())?;
    sync_dir(destination.parent().unwrap())?;
    Ok(QuarantineResult {
        status: Status::Quarantined,
        receipt,
    })
}
fn normalize(path: &Path) -> Result<PathBuf> {
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(invalid("QUARANTINE_INVALID_DESTINATION"));
    }
    if exists(path)? {
        return Ok(fs::canonicalize(path)?);
    }
    let parent = path
        .parent()
        .ok_or_else(|| invalid("QUARANTINE_INVALID_DESTINATION"))?;
    Ok(normalize(parent)?.join(
        path.file_name()
            .ok_or_else(|| invalid("QUARANTINE_INVALID_DESTINATION"))?,
    ))
}
fn rename_exclusive(from: &Path, to: &Path) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let from = CString::new(from.as_os_str().as_bytes())
            .map_err(|_| invalid("QUARANTINE_INVALID_DESTINATION"))?;
        let to = CString::new(to.as_os_str().as_bytes())
            .map_err(|_| invalid("QUARANTINE_INVALID_DESTINATION"))?;
        let result = unsafe {
            libc::renameatx_np(
                libc::AT_FDCWD,
                from.as_ptr(),
                libc::AT_FDCWD,
                to.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        if result != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    #[cfg(target_os = "linux")]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let c_from = CString::new(from.as_os_str().as_bytes())
            .map_err(|_| invalid("QUARANTINE_INVALID_DESTINATION"))?;
        let c_to = CString::new(to.as_os_str().as_bytes())
            .map_err(|_| invalid("QUARANTINE_INVALID_DESTINATION"))?;
        rename_noreplace_linux(from, to, || renameat2_noreplace(&c_from, &c_to))?;
    }
    #[cfg(windows)]
    fs::rename(from, to)?; // Windows rename refuses an existing directory.
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    return Err(invalid("QUARANTINE_PLATFORM_UNSUPPORTED"));
    Ok(())
}
/// `renameat2(..., RENAME_NOREPLACE)`. The raw syscall keeps this buildable
/// on musl, whose libc crate does not export a renameat2 wrapper.
#[cfg(target_os = "linux")]
fn renameat2_noreplace(from: &std::ffi::CStr, to: &std::ffi::CStr) -> std::io::Result<()> {
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
/// Some filesystems (Lustre, NFS, some FUSE) reject RENAME_NOREPLACE with
/// EINVAL, and pre-3.15 kernels lack renameat2 (ENOSYS). There the move falls
/// back to "destination absent, then rename(2)". This is a weaker guarantee:
/// the kernel no longer enforces no-replace. It is acceptable here because
/// every caller holds K's writer lock (`UpgradeLock`) and the destination is
/// an installer-owned, uniquely named path, so nothing else creates it between
/// the check and the rename. That rests on the lock's own assumptions (local
/// atomic create, coherent directory reads; not a distributed lock), so with
/// several hosts sharing the state directory the window is not closed.
/// Any other errno is returned unchanged.
#[cfg(target_os = "linux")]
fn rename_noreplace_linux(
    from: &Path,
    to: &Path,
    renameat2: impl FnOnce() -> std::io::Result<()>,
) -> Result<()> {
    match renameat2() {
        Ok(()) => Ok(()),
        Err(error) if matches!(error.raw_os_error(), Some(libc::EINVAL | libc::ENOSYS)) => {
            match fs::symlink_metadata(to) {
                Ok(_) => Err(invalid("QUARANTINE_DESTINATION_CONFLICT")),
                Err(probe) if probe.kind() == std::io::ErrorKind::NotFound => {
                    fs::rename(from, to)?;
                    Ok(())
                }
                Err(probe) => Err(probe.into()),
            }
        }
        Err(error) => Err(error.into()),
    }
}

#[cfg(all(test, target_os = "linux"))]
mod rename_fallback_tests {
    use super::rename_noreplace_linux;
    use std::{fs, io, path::Path};

    fn fixture() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("state");
        fs::create_dir(&from).unwrap();
        fs::write(from.join("journal.jsonl"), b"entry").unwrap();
        let to = dir.path().join("quarantine");
        (dir, from, to)
    }
    fn fails_with(errno: i32) -> impl FnOnce() -> io::Result<()> {
        move || Err(io::Error::from_raw_os_error(errno))
    }
    fn assert_moved(from: &Path, to: &Path) {
        assert!(!from.exists(), "source should be gone");
        assert_eq!(fs::read(to.join("journal.jsonl")).unwrap(), b"entry");
    }
    fn assert_untouched(from: &Path) {
        assert_eq!(fs::read(from.join("journal.jsonl")).unwrap(), b"entry");
    }

    #[test]
    fn einval_falls_back_to_checked_rename() {
        let (_dir, from, to) = fixture();
        rename_noreplace_linux(&from, &to, fails_with(libc::EINVAL)).unwrap();
        assert_moved(&from, &to);
    }
    #[test]
    fn enosys_falls_back_to_checked_rename() {
        let (_dir, from, to) = fixture();
        rename_noreplace_linux(&from, &to, fails_with(libc::ENOSYS)).unwrap();
        assert_moved(&from, &to);
    }
    #[test]
    fn fallback_refuses_existing_destination() {
        let (_dir, from, to) = fixture();
        fs::create_dir(&to).unwrap();
        let error = rename_noreplace_linux(&from, &to, fails_with(libc::EINVAL)).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("QUARANTINE_DESTINATION_CONFLICT"),
            "{error}"
        );
        assert_untouched(&from);
        assert!(fs::read_dir(&to).unwrap().next().is_none());
    }
    #[test]
    fn other_errno_is_returned_without_fallback() {
        for errno in [libc::EXDEV, libc::EACCES] {
            let (_dir, from, to) = fixture();
            let error = rename_noreplace_linux(&from, &to, fails_with(errno)).unwrap_err();
            match error {
                crate::Error::Io(io) => assert_eq!(io.raw_os_error(), Some(errno)),
                other => panic!("errno {errno}: unexpected {other}"),
            }
            assert_untouched(&from);
            assert!(!to.exists());
        }
    }
    #[test]
    fn real_renameat2_moves_directory_on_local_fs() {
        let (_dir, from, to) = fixture();
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let c_from = CString::new(from.as_os_str().as_bytes()).unwrap();
        let c_to = CString::new(to.as_os_str().as_bytes()).unwrap();
        let mut syscall = None;
        rename_noreplace_linux(&from, &to, || {
            let result = super::renameat2_noreplace(&c_from, &c_to);
            syscall = Some(result.as_ref().map_err(|e| e.raw_os_error()).copied());
            result
        })
        .unwrap();
        // The local fs supports RENAME_NOREPLACE: the kernel did the move.
        assert_eq!(syscall, Some(Ok(())));
        assert_moved(&from, &to);
    }
}
