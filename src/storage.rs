//! Durable v1 layout shared with the previous TypeScript implementation.
use crate::{Result, error::invalid, state::*};
use async_trait::async_trait;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
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
    File::open(path)?.sync_all()?;
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
            let _ = fs::remove_file(aside);
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
/// legacy workers; existing complete stable slots are never downgraded.
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
        File::open(target)?.sync_all()?;
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
        rename_durable(&staging, &self.slot(Slot::Stable))?;
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
        rename_durable(&staging, &self.slot(Slot::Experiment))
    }
    async fn promote(&self) -> Result<()> {
        let old = self.root.join("slots/stable.old");
        if self.version(Slot::Experiment)?.is_none() {
            // After the commit rename, only the obsolete backup may remain.
            if self.version(Slot::Stable)?.is_none() {
                return Err(invalid("promotion has no stable or experiment"));
            }
            return remove_dir(&old);
        }
        if exists(&self.slot(Slot::Stable))? {
            remove_dir(&old)?;
            rename_durable(&self.slot(Slot::Stable), &old)?;
        }
        rename_durable(&self.slot(Slot::Experiment), &self.slot(Slot::Stable))?;
        remove_dir(&old)
    }
    async fn clear(&self) -> Result<()> {
        remove_dir(&self.slot(Slot::Experiment))
    }
}
