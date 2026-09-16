//! Same contender directory and legacy lock file as TypeScript K. This is
//! intentionally not just flock: old and new workers must exclude each other.
use crate::{
    Error, Result,
    error::invalid,
    storage::{ensure_dir, exists, now_ms},
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

pub fn process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        if pid > i32::MAX as u32 {
            return false;
        }
        // EPERM proves existence too; never interpret a permission error as death.
        unsafe {
            libc::kill(pid as i32, 0) == 0
                || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, GetLastError},
            System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        };
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                // Access denied and uncertain errors do not authorize takeover.
                return GetLastError() != ERROR_INVALID_PARAMETER;
            }
            let mut code = 0;
            let queried = GetExitCodeProcess(process, &mut code);
            CloseHandle(process);
            queried == 0 || code == 259 // STILL_ACTIVE
        }
    }
    #[cfg(not(any(unix, windows)))]
    compile_error!("K process fencing is unsupported on this platform");
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    pid: u32,
    acquired_at_ms: u64,
}
pub struct UpgradeLock {
    lock: PathBuf,
    claim: PathBuf,
    released: bool,
    retained: bool,
}
impl UpgradeLock {
    pub fn acquire(root: &Path) -> Result<Self> {
        Self::acquire_at(root, now_ms())
    }
    pub fn acquire_at(root: &Path, timestamp_ms: u64) -> Result<Self> {
        ensure_dir(root)?;
        let claims = root.join("upgrade.lock.claims");
        ensure_dir(&claims)?;
        let name = format!("{}-{}", std::process::id(), uuid::Uuid::new_v4());
        let claim = claims.join(&name);
        fs::create_dir(&claim)?;
        let mut guard = Self {
            lock: root.join("upgrade.lock"),
            claim,
            released: false,
            retained: false,
        };
        let attempt = (|| {
            for other in fs::read_dir(claims)? {
                let other = other?;
                let s = other.file_name();
                let s = s
                    .to_str()
                    .ok_or_else(|| invalid("UPGRADE_LOCK_UNREADABLE"))?;
                if s == name {
                    continue;
                }
                let pid = s
                    .split('-')
                    .next()
                    .and_then(|s| s.parse::<u32>().ok())
                    .filter(|p| *p > 0)
                    .ok_or_else(|| invalid("UPGRADE_LOCK_UNREADABLE"))?;
                if process_alive(pid) {
                    return Err(Error::Locked(pid));
                }
                match fs::remove_dir(other.path()) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.into()),
                }
            }
            for _ in 0..50 {
                let mut opts = OpenOptions::new();
                opts.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    opts.mode(0o600);
                }
                match opts.open(&guard.lock) {
                    Ok(mut f) => {
                        f.write_all(&serde_json::to_vec(&Record {
                            pid: std::process::id(),
                            acquired_at_ms: timestamp_ms,
                        })?)?;
                        f.sync_all()?;
                        return Ok(());
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                        match fs::read(&guard.lock) {
                            Ok(bytes) => {
                                if let Ok(record) = serde_json::from_slice::<Record>(&bytes)
                                    && process_alive(record.pid)
                                {
                                    return Err(Error::Locked(record.pid));
                                }
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                            Err(e) => return Err(e.into()),
                        }
                        fs::remove_file(&guard.lock)?;
                    }
                    Err(e) => return Err(e.into()),
                }
            }
            Err(invalid("UPGRADE_LOCK_UNRESOLVABLE"))
        })();
        if let Err(e) = attempt {
            guard.released = true;
            let _ = fs::remove_dir(&guard.claim);
            return Err(e);
        }
        Ok(guard)
    }
    /// A host call may still be running. Keep our claim until this process dies.
    pub fn retain_until_exit(&mut self) {
        self.retained = true;
    }
    pub fn release(&mut self) -> Result<()> {
        if self.released || self.retained {
            return Ok(());
        }
        if exists(&self.claim)? {
            match fs::remove_file(&self.lock) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
            fs::remove_dir(&self.claim)?;
        }
        self.released = true;
        Ok(())
    }
}
impl Drop for UpgradeLock {
    fn drop(&mut self) {
        let _ = self.release();
    }
}
