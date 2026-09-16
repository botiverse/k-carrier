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
    match FileStore::new(&source).read_operation() {
        OperationRead::Unreadable { .. } if !allow_unreadable => {
            return Err(invalid("QUARANTINE_STATE_UNREADABLE"));
        }
        OperationRead::Observed { operation } => {
            receipt.operation_id = operation.id;
            if operation.outcome.is_none() {
                handoff.ok_or_else(|| invalid("QUARANTINE_ACTIVE_OPERATION"))?()
                    .map_err(|_| invalid("QUARANTINE_ACTIVE_OPERATION"))?;
            }
        }
        _ => {}
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
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let from = CString::new(from.as_os_str().as_bytes())
            .map_err(|_| invalid("QUARANTINE_INVALID_DESTINATION"))?;
        let to = CString::new(to.as_os_str().as_bytes())
            .map_err(|_| invalid("QUARANTINE_INVALID_DESTINATION"))?;
        #[cfg(target_os = "macos")]
        let result = unsafe {
            libc::renameatx_np(
                libc::AT_FDCWD,
                from.as_ptr(),
                libc::AT_FDCWD,
                to.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                from.as_ptr(),
                libc::AT_FDCWD,
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    #[cfg(windows)]
    fs::rename(from, to)?; // Windows rename refuses an existing directory.
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    return Err(invalid("QUARANTINE_PLATFORM_UNSUPPORTED"));
    Ok(())
}
