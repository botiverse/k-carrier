//! Durable v1 state layout.
use crate::{Result, error::invalid, state::*};
use async_trait::async_trait;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}
pub fn sync_dir(path: &Path) -> Result<()> {
    #[cfg(unix)]
    fs::File::open(path)?.sync_all()?;
    #[cfg(windows)]
    {
        // Windows has no supported unprivileged directory-fsync equivalent.
        // File contents are flushed before publication, but (as in K v1) this
        // does not promise directory-entry durability across power loss.
        let _ = path;
    }
    Ok(())
}
pub fn ensure_dir(path: &Path) -> Result<()> {
    if exists(path)? {
        let meta = fs::symlink_metadata(path)?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(invalid("directory is not a regular directory"));
        }
        return Ok(());
    }
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        ensure_dir(parent)?;
    }
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return ensure_dir(path),
        Err(e) => return Err(e.into()),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        sync_dir(parent)?;
    }
    Ok(())
}
pub fn rename_durable(from: &Path, to: &Path) -> Result<()> {
    fs::rename(from, to)?;
    if let Some(parent) = to.parent() {
        sync_dir(parent)?;
    }
    if from.parent() != to.parent()
        && let Some(parent) = from.parent()
    {
        sync_dir(parent)?;
    }
    Ok(())
}
/// Moves a slot directory under the caller's upgrade lock.
///
/// Overlayfs refuses `rename(2)` of a directory that comes from a lower layer
/// with EXDEV (unless `redirect_dir` is on): a container whose image already
/// held the state could install a new version but never commit it, and every
/// later upgrade failed at the same step. There the directory is copied beside
/// its destination, the fresh copy (an upper-layer directory, which overlayfs
/// renames) is published with one rename, and the source is removed. A crash
/// leaves either the source alone, or source and destination with the same
/// contents; promote and stage replay both. A stray `.k-copy-*` beside the
/// destination is removed on the next such move.
pub fn rename_dir_durable(from: &Path, to: &Path) -> Result<()> {
    rename_dir_with(from, to, |from, to| fs::rename(from, to))
}
fn rename_dir_with(
    from: &Path,
    to: &Path,
    rename: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<()> {
    match rename(from, to) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::CrossesDevices => {
            return copy_dir_then_remove(from, to);
        }
        Err(error) => return Err(error.into()),
    }
    if let Some(parent) = to.parent() {
        sync_dir(parent)?;
    }
    if from.parent() != to.parent()
        && let Some(parent) = from.parent()
    {
        sync_dir(parent)?;
    }
    Ok(())
}
fn copy_dir_then_remove(from: &Path, to: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(from)?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(invalid("refusing to copy a non-directory slot"));
    }
    if exists(to)? {
        return Err(invalid("slot move destination exists"));
    }
    let parent = to.parent().ok_or_else(|| invalid("path has no parent"))?;
    for entry in fs::read_dir(parent)? {
        let entry = entry?;
        let stray = entry
            .file_name()
            .to_str()
            .and_then(|name| name.strip_prefix(".k-copy-"))
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok());
        if stray {
            remove_dir(&entry.path())?;
        }
    }
    let copy = parent.join(format!(".k-copy-{}", uuid::Uuid::new_v4()));
    copy_tree(from, &copy)?;
    fs::rename(&copy, to)?;
    sync_dir(parent)?;
    // Removal is not atomic. Mark the source first, so a crash part-way
    // through leaves a slot that reads as absent, never as incomplete.
    write_durable(&from.join(MOVED_MARKER), b"", false)?;
    remove_moved_source(from)
}
/// A slot directory whose contents were copied elsewhere and which is being
/// removed (`rename_dir_durable`'s cross-device fallback). It reads as absent.
pub const MOVED_MARKER: &str = ".k-moved";
fn remove_moved_source(path: &Path) -> Result<()> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_name() == MOVED_MARKER {
            continue;
        }
        if entry.file_type()?.is_dir() {
            fs::remove_dir_all(entry.path())?;
        } else {
            fs::remove_file(entry.path())?;
        }
    }
    sync_dir(path)?;
    // Only the marker is left. A crash after it goes leaves an empty
    // directory, which promote clears for the experiment slot.
    fs::remove_file(path.join(MOVED_MARKER))?;
    remove_dir(path)
}
fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            // fs::copy keeps the permission bits (the slot's executable artifact).
            fs::copy(entry.path(), &target)?;
            #[cfg(unix)]
            fs::File::open(&target)?.sync_all()?;
            #[cfg(windows)]
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(&target)?
                .sync_all()?;
        } else {
            return Err(invalid(
                "refusing to copy a slot entry that is not a file or directory",
            ));
        }
    }
    #[cfg(unix)]
    fs::set_permissions(to, fs::metadata(from)?.permissions())?;
    sync_dir(to)
}
pub fn remove_dir(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
        Ok(m) if m.file_type().is_symlink() || !m.is_dir() => {
            return Err(invalid("refusing to remove non-directory slot"));
        }
        Ok(_) => {}
    }
    fs::remove_dir_all(path)?;
    if let Some(parent) = path.parent() {
        sync_dir(parent)?;
    }
    Ok(())
}
pub fn write_durable(path: &Path, bytes: &[u8], executable: bool) -> Result<()> {
    let parent = path.parent().ok_or_else(|| invalid("path has no parent"))?;
    ensure_dir(parent)?;
    let tmp = parent.join(format!(".k-write-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&tmp)?;
        file.write_all(bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(if executable {
                0o755
            } else {
                0o600
            }))?;
        }
        #[cfg(not(unix))]
        let _ = executable;
        file.sync_all()?;
        drop(file);
        #[cfg(windows)]
        if executable && exists(path)? {
            // Running PE images cannot be overwritten. Keep their old inode
            // under a unique name until the process exits; never remove the
            // only known-good copy if publishing the replacement fails.
            let aside = parent.join(format!(".k-image-{}", uuid::Uuid::new_v4()));
            fs::rename(path, &aside)?;
            if let Err(error) = rename_durable(&tmp, path) {
                fs::rename(&aside, path)?;
                return Err(error);
            }
            // Old running images stay until their processes exit. A later
            // successful replacement collects those that are now deletable.
            if let Ok(entries) = fs::read_dir(parent) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let owned = name
                        .to_str()
                        .and_then(|s| s.strip_prefix(".k-image-"))
                        .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok());
                    if owned && entry.path() != path && entry.file_type().is_ok_and(|t| t.is_file())
                    {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }
            return Ok(());
        }
        rename_durable(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
pub fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    write_durable(path, &serde_json::to_vec(value)?, false)
}
/// One-time adoption of trusted bytes. The lock excludes both native and
/// other compatible workers; existing complete stable slots are never downgraded.
pub fn bootstrap_stable(root: &Path, version: &str, source: &Path) -> Result<bool> {
    let mut lock = crate::lock::UpgradeLock::acquire(root)?;
    let result = FileStore::new(root).bootstrap_locked(version, source);
    lock.release()?;
    result
}

#[async_trait]
pub trait Effects: Send + Sync {
    async fn read_journal(&self) -> Result<Vec<JournalEntry>>;
    async fn append(&self, entry: &JournalEntry) -> Result<()>;
    async fn versions(&self) -> Result<BTreeMap<String, Option<String>>>;
    async fn stage(&self, version: &str, bytes: &Path) -> Result<()>;
    async fn promote(&self) -> Result<()>;
    async fn clear(&self) -> Result<()>;
}
#[derive(Clone)]
pub struct FileStore {
    pub root: PathBuf,
}
impl FileStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
    pub fn slot(&self, slot: Slot) -> PathBuf {
        self.root.join("slots").join(slot.name())
    }
    pub fn artifact(&self, slot: Slot) -> PathBuf {
        self.slot(slot).join("artifact.bin")
    }
    pub fn version(&self, slot: Slot) -> Result<Option<String>> {
        let dir = self.slot(slot);
        if !exists(&dir)? {
            return Ok(None);
        }
        let meta = fs::symlink_metadata(&dir)?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(invalid("invalid slot directory"));
        }
        // A slot left mid-removal by a cross-device move (rename_dir_durable)
        // is gone: its contents were already published elsewhere.
        if exists(&dir.join(MOVED_MARKER))? {
            return Ok(None);
        }
        let version = fs::read_to_string(dir.join("VERSION"))?.trim().to_owned();
        if version.is_empty() || !fs::symlink_metadata(self.artifact(slot))?.is_file() {
            return Err(invalid("incomplete slot"));
        }
        Ok(Some(version))
    }
    fn populate(&self, staging: &Path, version: &str, bytes: &Path) -> Result<()> {
        if version.trim().is_empty() {
            return Err(invalid("empty artifact version"));
        }
        remove_dir(staging)?;
        ensure_dir(staging)?;
        let target = staging.join("artifact.bin");
        fs::copy(bytes, &target)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&target, fs::Permissions::from_mode(0o755))?;
        }
        // FlushFileBuffers requires a writable handle on Windows. Opening a
        // copied slot read-only works on Unix but rejects Windows bootstrap.
        #[cfg(windows)]
        OpenOptions::new()
            .read(true)
            .write(true)
            .open(target)?
            .sync_all()?;
        #[cfg(unix)]
        fs::File::open(target)?.sync_all()?;
        write_durable(&staging.join("VERSION"), version.as_bytes(), false)?;
        sync_dir(staging)
    }
    /// Caller holds the shared upgrade lock. No transaction evidence is overwritten.
    pub fn bootstrap_locked(&self, version: &str, source: &Path) -> Result<bool> {
        if version.trim().is_empty() {
            return Err(invalid("BOOTSTRAP_VERSION_INVALID"));
        }
        if self.version(Slot::Stable)?.is_some() {
            return Ok(false);
        }
        if exists(&self.root.join("journal.jsonl"))? || exists(&self.slot(Slot::Experiment))? {
            return Err(invalid("BOOTSTRAP_STATE_CONFLICT"));
        }
        if !fs::metadata(source)?.is_file() {
            return Err(invalid("BOOTSTRAP_SOURCE_UNREADABLE"));
        }
        let staging = self.root.join("slots/stable.bootstrap");
        self.populate(&staging, version.trim(), source)?;
        rename_dir_durable(&staging, &self.slot(Slot::Stable))?;
        Ok(true)
    }
    pub fn read_operation(&self) -> OperationRead {
        read_operation_file(&self.root.join("operation.json"))
    }
    pub fn persist_operation(&self, operation: &Operation) -> Result<()> {
        operation.validate()?;
        write_json(&self.root.join("operation.json"), operation)
    }
    fn archive_path(&self, id: &str) -> PathBuf {
        self.root
            .join("receipts")
            .join(format!("{:x}.json", Sha256::digest(id.as_bytes())))
    }
    pub fn read_archive(&self, id: &str) -> OperationRead {
        match read_operation_file(&self.archive_path(id)) {
            OperationRead::Observed { operation }
                if operation.id != id || operation.outcome.is_none() =>
            {
                OperationRead::Unreadable {
                    reason: "invalid archived receipt identity/outcome".into(),
                }
            }
            other => other,
        }
    }
    pub fn archive(&self, operation: &Operation) -> Result<()> {
        operation.validate()?;
        if operation.outcome.is_none() {
            return Err(invalid("cannot archive active operation"));
        }
        match self.read_archive(&operation.id) {
            OperationRead::Unreadable { reason } => Err(invalid(reason)),
            OperationRead::Observed {
                operation: existing,
            } if existing.target_version != operation.target_version
                || existing.outcome != operation.outcome =>
            {
                Err(invalid("OPERATION_ARCHIVE_CONFLICT"))
            }
            OperationRead::Observed { .. } => Ok(()),
            OperationRead::Genesis => write_json(&self.archive_path(&operation.id), operation),
        }
    }
}
pub fn read_operation_file(path: &Path) -> OperationRead {
    let parsed = (|| -> Result<Operation> {
        let op: Operation = serde_json::from_slice(&fs::read(path)?)?;
        op.validate()?;
        Ok(op)
    })();
    match parsed {
        Ok(operation) => OperationRead::Observed { operation },
        Err(crate::Error::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            OperationRead::Genesis
        }
        Err(e) => OperationRead::Unreadable {
            reason: format!("cannot read K receipt: {e}"),
        },
    }
}
#[async_trait]
impl Effects for FileStore {
    async fn read_journal(&self) -> Result<Vec<JournalEntry>> {
        let bytes = match fs::read(self.root.join("journal.jsonl")) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(e.into()),
        };
        // Only a non-newline-terminated tail may be torn. Complete corrupt entries
        // must stop recovery; otherwise later intents could silently be lost.
        let mut entries: Vec<JournalEntry> = vec![];
        let mut start = 0;
        for (i, b) in bytes.iter().enumerate() {
            if *b != b'\n' {
                continue;
            }
            let line = &bytes[start..i];
            start = i + 1;
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let e: JournalEntry = serde_json::from_slice(line)?;
            e.validate()?;
            if e.seq != entries.last().map_or(0, |p| p.seq + 1) {
                return Err(invalid("journal sequence discontinuity"));
            }
            entries.push(e);
        }
        Ok(entries)
    }
    async fn append(&self, entry: &JournalEntry) -> Result<()> {
        entry.validate()?;
        ensure_dir(&self.root)?;
        let prior = self.read_journal().await?;
        if entry.seq != prior.last().map_or(0, |e| e.seq + 1) {
            return Err(invalid("journal sequence discontinuity"));
        }
        let path = self.root.join("journal.jsonl");
        // Repair the uncommitted tail while holding the upgrade lock, before append.
        if exists(&path)? {
            let bytes = fs::read(&path)?;
            let committed = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
            if committed < bytes.len() {
                let f = OpenOptions::new().write(true).open(&path)?;
                f.set_len(committed as u64)?;
                f.sync_all()?;
            }
        }
        let mut opts = OpenOptions::new();
        opts.append(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(path)?;
        let mut bytes = serde_json::to_vec(entry)?;
        bytes.push(b'\n');
        f.write_all(&bytes)?;
        f.sync_all()?;
        sync_dir(&self.root)
    }
    async fn versions(&self) -> Result<BTreeMap<String, Option<String>>> {
        Ok(BTreeMap::from([
            ("stable".into(), self.version(Slot::Stable)?),
            ("experiment".into(), self.version(Slot::Experiment)?),
        ]))
    }
    async fn stage(&self, version: &str, bytes: &Path) -> Result<()> {
        let staging = self.root.join("slots/experiment.staging");
        self.populate(&staging, version, bytes)?;
        remove_dir(&self.slot(Slot::Experiment))?;
        rename_dir_durable(&staging, &self.slot(Slot::Experiment))
    }
    async fn promote(&self) -> Result<()> {
        let old = self.root.join("slots/stable.old");
        // The last instant of a cross-device move's removal: the experiment's
        // contents are already stable, only its empty directory is left.
        let experiment = self.slot(Slot::Experiment);
        if exists(&experiment)?
            && fs::symlink_metadata(&experiment)?.is_dir()
            && fs::read_dir(&experiment)?.next().is_none()
            && self.version(Slot::Stable)?.is_some()
        {
            remove_dir(&experiment)?;
        }
        if self.version(Slot::Experiment)?.is_none() {
            // After the commit rename, only the obsolete backup may remain.
            if self.version(Slot::Stable)?.is_none() {
                return Err(invalid("promotion has no stable or experiment"));
            }
            // A cross-device move may have left the experiment mid-removal.
            remove_dir(&self.slot(Slot::Experiment))?;
            return remove_dir(&old);
        }
        if exists(&self.slot(Slot::Stable))? {
            remove_dir(&old)?;
            rename_dir_durable(&self.slot(Slot::Stable), &old)?;
        }
        rename_dir_durable(&self.slot(Slot::Experiment), &self.slot(Slot::Stable))?;
        remove_dir(&old)
    }
    async fn clear(&self) -> Result<()> {
        remove_dir(&self.slot(Slot::Experiment))
    }
}

#[cfg(test)]
mod slot_move_tests {
    use super::{exists, rename_dir_durable, rename_dir_with};
    use std::{fs, io, path::Path};

    fn cross_device(_: &Path, _: &Path) -> io::Result<()> {
        Err(io::Error::from(io::ErrorKind::CrossesDevices))
    }
    fn slot(root: &Path) -> std::path::PathBuf {
        let slot = root.join("slots/stable");
        fs::create_dir_all(slot.join("nested")).unwrap();
        fs::write(slot.join("artifact.bin"), b"binary").unwrap();
        fs::write(slot.join("VERSION"), b"1.0.67").unwrap();
        fs::write(slot.join("nested/sidecar"), b"side").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(slot.join("artifact.bin"), fs::Permissions::from_mode(0o755))
                .unwrap();
        }
        slot
    }
    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_cross_device_rename_copies_publishes_and_removes_the_source() {
        let root = tempfile::tempdir().unwrap();
        let from = slot(root.path());
        let to = root.path().join("slots/stable.old");
        let stray = root
            .path()
            .join(format!("slots/.k-copy-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&stray).unwrap();
        fs::write(stray.join("partial"), b"x").unwrap();
        let foreign = root.path().join("slots/.k-copy-not-ours");
        fs::create_dir(&foreign).unwrap();

        rename_dir_with(&from, &to, cross_device).unwrap();

        assert!(!exists(&from).unwrap(), "the source is removed");
        assert_eq!(fs::read(to.join("artifact.bin")).unwrap(), b"binary");
        assert_eq!(fs::read(to.join("VERSION")).unwrap(), b"1.0.67");
        assert_eq!(fs::read(to.join("nested/sidecar")).unwrap(), b"side");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(to.join("artifact.bin"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o755, "the artifact stays executable");
        }
        assert_eq!(
            names(&root.path().join("slots")),
            vec![".k-copy-not-ours", "stable.old"],
            "our stray copy is collected, a foreign name is left alone"
        );
    }

    #[test]
    fn other_rename_errors_are_returned_and_touch_nothing() {
        let root = tempfile::tempdir().unwrap();
        let from = slot(root.path());
        let to = root.path().join("slots/stable.old");
        let error = rename_dir_with(&from, &to, |_, _| {
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        })
        .unwrap_err();
        assert!(
            matches!(error, crate::Error::Io(ref io) if io.kind() == io::ErrorKind::PermissionDenied),
            "{error}"
        );
        assert_eq!(names(&from), vec!["VERSION", "artifact.bin", "nested"]);
        assert!(!exists(&to).unwrap());
    }

    #[test]
    fn a_cross_device_move_refuses_an_existing_destination() {
        let root = tempfile::tempdir().unwrap();
        let from = slot(root.path());
        let to = root.path().join("slots/stable.old");
        fs::create_dir(&to).unwrap();
        assert!(rename_dir_with(&from, &to, cross_device).is_err());
        assert_eq!(names(&from), vec!["VERSION", "artifact.bin", "nested"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_cross_device_move_refuses_a_symlink_and_keeps_the_source() {
        let root = tempfile::tempdir().unwrap();
        let from = slot(root.path());
        std::os::unix::fs::symlink("/etc/passwd", from.join("link")).unwrap();
        let to = root.path().join("slots/stable.old");
        assert!(rename_dir_with(&from, &to, cross_device).is_err());
        assert!(exists(&from.join("artifact.bin")).unwrap());
        assert!(!exists(&to).unwrap());
    }

    #[test]
    fn the_fallback_leaves_no_marker_in_the_published_copy() {
        let root = tempfile::tempdir().unwrap();
        let from = slot(root.path());
        let to = root.path().join("slots/stable.old");
        rename_dir_with(&from, &to, cross_device).unwrap();
        assert!(!exists(&to.join(super::MOVED_MARKER)).unwrap());
    }

    fn store_with(root: &Path) -> crate::storage::FileStore {
        let store = crate::storage::FileStore::new(root);
        // stable = the new version, already published by the commit's copy.
        let stable = store.slot(crate::state::Slot::Stable);
        fs::create_dir_all(&stable).unwrap();
        fs::write(stable.join("artifact.bin"), b"new").unwrap();
        fs::write(stable.join("VERSION"), b"1.25.0").unwrap();
        store
    }

    /// The process died while removing the experiment after its contents
    /// were published as stable: the marker is there, VERSION is already gone.
    #[tokio::test]
    async fn promote_replays_over_an_experiment_left_mid_removal() {
        use crate::storage::Effects;
        let root = tempfile::tempdir().unwrap();
        let store = store_with(root.path());
        let experiment = store.slot(crate::state::Slot::Experiment);
        fs::create_dir_all(&experiment).unwrap();
        fs::write(experiment.join("artifact.bin"), b"new").unwrap();
        fs::write(experiment.join(super::MOVED_MARKER), b"").unwrap();
        assert_eq!(store.version(crate::state::Slot::Experiment).unwrap(), None);
        store.promote().await.unwrap();
        assert_eq!(
            store
                .version(crate::state::Slot::Stable)
                .unwrap()
                .as_deref(),
            Some("1.25.0")
        );
        assert!(!exists(&experiment).unwrap(), "the leftover is removed");
    }

    /// Same, one step later: only the marker had been removed, the directory is empty.
    #[tokio::test]
    async fn promote_replays_over_an_empty_experiment() {
        use crate::storage::Effects;
        let root = tempfile::tempdir().unwrap();
        let store = store_with(root.path());
        let experiment = store.slot(crate::state::Slot::Experiment);
        fs::create_dir_all(&experiment).unwrap();
        store.promote().await.unwrap();
        assert_eq!(
            store
                .version(crate::state::Slot::Stable)
                .unwrap()
                .as_deref(),
            Some("1.25.0")
        );
        assert!(!exists(&experiment).unwrap());
    }

    /// A real overlayfs, where a lower-layer directory cannot be renamed.
    /// Needs root to mount, so CI skips it; run with
    /// `K_TEST_OVERLAY_ROOT=<merged dir whose slots/stable is in the lower layer>`.
    #[test]
    #[ignore]
    fn a_lower_layer_slot_moves_on_a_real_overlayfs() {
        let Some(root) = std::env::var_os("K_TEST_OVERLAY_ROOT") else {
            return;
        };
        let root = Path::new(&root);
        let from = root.join("slots/stable");
        let to = root.join("slots/stable.old");
        let plain = fs::rename(&from, &to).unwrap_err();
        assert_eq!(plain.kind(), io::ErrorKind::CrossesDevices, "{plain}");
        rename_dir_durable(&from, &to).unwrap();
        assert!(!exists(&from).unwrap());
        assert!(exists(&to.join("artifact.bin")).unwrap());
    }
}
