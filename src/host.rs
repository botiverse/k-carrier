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
            // A failed host may also print malformed output. Parse leniently
            // so its exit identity is not replaced by a JSON parse error.
            let parsed = serde_json::from_slice::<Value>(&bytes);
            if !status.success() && parsed.is_err() {
                let code = status
                    .code()
                    .map_or_else(|| "signal".to_string(), |code| code.to_string());
                return Err(invalid(format!(
                    "HOST_COMMAND_FAILED: {action} (exit {code}): host response was not valid JSON"
                )));
            }
            let value = parsed?;
            if value.get("protocolVersion") == Some(&json!(1))
                && value.get("ok") == Some(&json!(false))
                && value.get("uncertain") == Some(&json!(true))
            {
                return Err(Error::Uncertain(format!(
                    "HOST_EFFECT_UNRESOLVED: {action}"
                )));
            }
            if !status.success() {
                // Keep the host's own reason and exit code (issue slock#8609):
                // without them a rollback only says "HOST_COMMAND_FAILED". The
                // host writes this text for operators; it is bounded and
                // stripped of control characters before it reaches receipts.
                let code = status
                    .code()
                    .map_or_else(|| "signal".to_string(), |code| code.to_string());
                let detail = value
                    .get("error")
                    .and_then(Value::as_str)
                    .map(host_error_detail)
                    .filter(|detail| !detail.is_empty())
                    .map_or_else(String::new, |detail| format!(": {detail}"));
                return Err(invalid(format!(
                    "HOST_COMMAND_FAILED: {action} (exit {code}){detail}"
                )));
            }
            if value.get("protocolVersion") != Some(&json!(1))
                || value.get("ok") != Some(&json!(true))
            {
                return Err(invalid(format!("HOST_PROTOCOL_INVALID: {action}")));
            }
            if action == "probe" && value["evidence"]["pid"].as_u64() == Some(u64::from(pid)) {
                return Err(invalid(
                    "HOST_EVIDENCE_INVALID: controller cannot attest itself",
                ));
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
        if !exited {
            return Err(Error::Uncertain(format!(
                "HOST_PROCESS_UNRESOLVED: {action}"
            )));
        }
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

const HOST_ERROR_DETAIL_MAX_CHARS: usize = 240;

/// A host-supplied failure reason, reduced to one bounded printable line.
const CREDENTIAL_MARKERS: &[&str] = &[
    "authorization",
    "bearer",
    "token",
    "secret",
    "password",
    "passwd",
    "api_key",
    "api key",
    "api-key",
    "apikey",
    "access_key",
    "access key",
    "access-key",
    "client_secret",
    "client secret",
    "client-secret",
    "cookie",
    "database_url",
    "database-url",
];

fn has_credential_marker(line: &str) -> bool {
    let line = line.to_ascii_lowercase();
    CREDENTIAL_MARKERS
        .iter()
        .any(|marker| line.contains(marker))
}

/// `scheme://user@host` or `scheme://user:pass@host`: a token used as the
/// username is as sensitive as a password.
fn has_url_userinfo(line: &str) -> bool {
    let mut rest = line;
    while let Some(index) = rest.find("://") {
        let after = &rest[index + 3..];
        let authority = after
            .split(|c: char| c.is_whitespace() || matches!(c, '/' | '?' | '#'))
            .next()
            .unwrap_or_default();
        if authority.rfind('@').is_some_and(|at| at > 0) {
            return true;
        }
        rest = after;
    }
    false
}

fn redact_opaque_word(word: &str) -> &str {
    let opaque = word.len() >= 24
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-+".contains(c));
    if opaque { "<redacted>" } else { word }
}

/// The host's reason reaches the terminal and the receipt, so redact it before
/// it is shortened. Redaction works on whole lines of the raw text: a line that
/// names a credential or carries URL userinfo is replaced entirely (a key and
/// its value may be split by spaces, quotes or a line break), and a credential
/// line ending in `:` or `=` also takes the next non-empty line.
fn redact_host_error(raw: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut redact_next = false;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let carried = std::mem::take(&mut redact_next);
        let credential = has_credential_marker(line);
        if credential && matches!(trimmed.chars().last(), Some(':' | '=')) {
            redact_next = true;
        }
        if carried || credential || has_url_userinfo(line) {
            out.push("<redacted>");
            continue;
        }
        out.extend(line.split_whitespace().map(redact_opaque_word));
    }
    out.join(" ")
}

fn host_error_detail(raw: &str) -> String {
    let redacted = redact_host_error(raw);
    let mut out = String::new();
    let mut chars = 0;
    for ch in redacted.chars() {
        let ch = if ch.is_control() { ' ' } else { ch };
        if ch == ' ' && out.ends_with(' ') {
            continue;
        }
        if chars == HOST_ERROR_DETAIL_MAX_CHARS {
            out.push('…');
            break;
        }
        out.push(ch);
        chars += 1;
    }
    out.trim().to_string()
}

#[cfg(test)]
mod host_error_detail_tests {
    use super::host_error_detail;

    #[test]
    fn credential_lines_are_redacted_before_display() {
        for (raw, leaked) in [
            ("login failed: password = hunter2", "hunter2"),
            ("token : abc", "abc"),
            ("Authorization: Basic c2hvcnQ=", "c2hvcnQ="),
            ("Cookie: theme=dark; sid=abc123", "abc123"),
            (
                "clone https://ghp_shortTok@github.com/o/r.git failed",
                "ghp_shortTok",
            ),
            ("connect postgres://u:pw123@h/db refused", "pw123"),
            (
                "config:\n  password:\n\n    short-secret-value\nnext",
                "short-secret-value",
            ),
        ] {
            let detail = host_error_detail(raw);
            assert!(
                !detail.contains(leaked),
                "{raw:?} leaked {leaked:?} as {detail:?}"
            );
            assert!(detail.contains("<redacted>"), "{raw:?} -> {detail:?}");
        }
    }

    #[test]
    fn harmless_reason_is_kept() {
        assert_eq!(
            host_error_detail("launchctl bootstrap failed: Input/output error"),
            "launchctl bootstrap failed: Input/output error",
        );
        assert_eq!(
            host_error_detail("config:\n  password:\n    x\nservice exited"),
            "config: <redacted> <redacted> service exited"
        );
    }
}
