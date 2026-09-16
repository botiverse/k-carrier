use crate::{
    Error, Result,
    error::invalid,
    lock::process_alive,
    state::{Evidence, Slot},
    storage::{FileStore, ensure_dir, sync_dir},
};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    time::{Instant, sleep, timeout},
};

/// Call at a native controller/worker entry point, before spawning anything.
/// On Windows an inherited protocol pipe remains inheritable even when a new
/// child's standard streams are redirected to NUL. Clearing that flag prevents
/// a resident grandchild from keeping the controller's response pipe open.
/// Explicit `Stdio::inherit()` still works because Command duplicates the handle.
pub fn isolate_standard_handles() -> Result<()> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::{HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation},
            System::Console::{
                GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
            },
        };
        for stream in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            // We only change the current process's inherited handles; never
            // close them, and never change an unrelated process's handle table.
            unsafe {
                let handle = GetStdHandle(stream);
                if !handle.is_null()
                    && handle != INVALID_HANDLE_VALUE
                    && SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) == 0
                {
                    return Err(std::io::Error::last_os_error().into());
                }
            }
        }
    }
    Ok(())
}

#[async_trait]
pub trait Host: Send + Sync {
    async fn fence(&self) -> Result<()> {
        Ok(())
    }
    async fn quiesce(&self) -> Result<()>;
    async fn stop(&self, slot: Slot) -> Result<()>;
    async fn start(&self, slot: Slot) -> Result<()>;
    async fn probe(&self) -> Result<Evidence>;
    async fn resume(&self) -> Result<()>;
}

pub struct CommandHost {
    pub command: Vec<String>,
    pub store: FileStore,
    pub cwd: Option<PathBuf>,
    pub timeout: Duration,
}
impl CommandHost {
    pub fn new(
        command: Vec<String>,
        state_dir: impl Into<PathBuf>,
        timeout_ms: u64,
    ) -> Result<Self> {
        if command.is_empty() || command[0].is_empty() || timeout_ms == 0 || timeout_ms > 120_000 {
            return Err(invalid("invalid controller configuration"));
        }
        Ok(Self {
            command,
            store: FileStore::new(state_dir),
            cwd: None,
            timeout: Duration::from_millis(timeout_ms),
        })
    }
    async fn call(&self, action: &str, slot: Option<Slot>) -> Result<Value> {
        isolate_standard_handles()?;
        let mut input = json!({"protocolVersion":1,"action":action});
        if let Some(slot) = slot {
            input["slot"] = json!(slot);
            input["artifactPath"] = json!(self.store.artifact(slot));
        }
        let dir = self.store.root.join("controllers");
        ensure_dir(&dir)?;
        let mut command = Command::new(&self.command[0]);
        command
            .args(&self.command[1..])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(cwd) = &self.cwd {
            command.current_dir(cwd);
        }
        let mut child = command.spawn()?;
        let pid = child.id().ok_or_else(|| invalid("HOST_SPAWN_FAILED"))?;
        let record = dir.join(format!("{pid}-{}.json", uuid::Uuid::new_v4()));
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| invalid("HOST_STDIN_MISSING"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| invalid("HOST_STDOUT_MISSING"))?;
        // Controller receives no effect until its lifetime is durable. If the
        // worker dies earlier, EOF carries no request and authorizes no action.
        let outcome = timeout(self.timeout, async {
            let mut opts = OpenOptions::new();
            opts.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut file = opts.open(&record)?;
            file.write_all(&serde_json::to_vec(&json!({"pid":pid}))?)?;
            file.sync_all()?;
            sync_dir(&dir)?;
            stdin.write_all(&serde_json::to_vec(&input)?).await?;
            stdin.shutdown().await?;
            drop(stdin);
            let mut bytes = vec![];
            stdout.take(65537).read_to_end(&mut bytes).await?;
            if bytes.len() > 65536 {
                return Err(Error::Uncertain("HOST_RESPONSE_TOO_LARGE".into()));
            }
            let status = child.wait().await?;
            if !status.success() {
                return Err(invalid(format!("HOST_COMMAND_FAILED: {action}")));
            }
            let value: Value = serde_json::from_slice(&bytes)?;
            if value.get("protocolVersion") != Some(&json!(1))
                || value.get("ok") != Some(&json!(true))
            {
                return Err(invalid(format!("HOST_PROTOCOL_INVALID: {action}")));
            }
            Ok(value)
        })
        .await
        .unwrap_or_else(|_| Err(Error::Uncertain(format!("HOST_CALL_TIMEOUT: {action}"))));
        // On timeout termination is attempted, but absence must be observed.
        // A retained record is fenced by the successor, not assumed harmless.
        if child.try_wait()?.is_none() {
            let _ = child.start_kill();
        }
        let exited = matches!(
            timeout(Duration::from_secs(1), child.wait()).await,
            Ok(Ok(_))
        );
        if exited {
            fs::remove_file(&record).or_else(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    Ok(())
                } else {
                    Err(e)
                }
            })?;
            sync_dir(&dir)?;
        }
        outcome
    }
}
#[async_trait]
impl Host for CommandHost {
    async fn fence(&self) -> Result<()> {
        let dir = self.store.root.join("controllers");
        ensure_dir(&dir)?;
        let deadline = Instant::now() + self.timeout;
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| invalid("HOST_FENCE_UNRESOLVED"))?;
            let pid = name
                .split('-')
                .next()
                .and_then(|s| s.parse::<u32>().ok())
                .filter(|p| *p > 0)
                .ok_or_else(|| invalid("HOST_FENCE_UNRESOLVED"))?;
            while process_alive(pid) {
                if Instant::now() >= deadline {
                    return Err(Error::Uncertain("HOST_CALL_TIMEOUT: fence".into()));
                }
                sleep(Duration::from_millis(20)).await;
            }
            fs::remove_file(entry.path())?;
        }
        sync_dir(&dir)?;
        self.call("fence", None).await.map(|_| ())
    }
    async fn quiesce(&self) -> Result<()> {
        self.call("quiesce", None).await.map(|_| ())
    }
    async fn stop(&self, slot: Slot) -> Result<()> {
        self.call("stop", Some(slot)).await.map(|_| ())
    }
    async fn start(&self, slot: Slot) -> Result<()> {
        self.call("start", Some(slot)).await.map(|_| ())
    }
    async fn resume(&self) -> Result<()> {
        self.call("resume", None).await.map(|_| ())
    }
    async fn probe(&self) -> Result<Evidence> {
        let v = self.call("probe", None).await?;
        let e: Evidence = serde_json::from_value(
            v.get("evidence")
                .cloned()
                .ok_or_else(|| invalid("HOST_EVIDENCE_INVALID"))?,
        )?;
        e.validate()?;
        Ok(e)
    }
}
