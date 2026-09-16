//! The supervisor survives the resident service. It only retries after observing
//! worker exit and accepts a terminal receipt bound to the original request.
use crate::{
    Result,
    artifact::{Downloader, Release, sha256, verify},
    error::invalid,
    protocol::{Request, Response},
    state::OperationRead,
    storage::{ensure_dir, remove_dir, sync_dir, write_durable, write_json},
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    time::{Instant, timeout},
};

#[derive(Debug, Clone)]
pub struct LaunchOptions {
    pub execution_ms: u64,
    pub recovery_ms: u64,
    pub total_ms: u64,
    pub recovery_attempts: u8,
    pub env: std::collections::BTreeMap<String, String>,
}
impl Default for LaunchOptions {
    fn default() -> Self {
        Self {
            execution_ms: 600_000,
            recovery_ms: 120_000,
            total_ms: 840_000,
            recovery_attempts: 2,
            env: Default::default(),
        }
    }
}
impl LaunchOptions {
    fn validate(&self) -> Result<()> {
        if [self.execution_ms, self.recovery_ms, self.total_ms]
            .iter()
            .any(|n| *n == 0 || *n > 2_147_483_647)
            || self.recovery_attempts > 10
        {
            return Err(invalid("invalid runner budget"));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    pub exit_code: u8,
    pub response: Option<Response>,
    pub recovery_file: Option<PathBuf>,
    pub error: Option<String>,
    pub attempts: u8,
}
#[derive(Debug, Serialize, Deserialize)]
struct RecoveryDescriptor {
    file: PathBuf,
    sha256: String,
    size: u64,
    request: Request,
}
struct Attempt {
    code: u8,
    response: Option<Response>,
    fenced: bool,
}

async fn run(
    file: &Path,
    request: &Request,
    budget: Duration,
    env: &std::collections::BTreeMap<String, String>,
) -> Attempt {
    let mut child = match Command::new(file)
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => {
            return Attempt {
                code: 1,
                response: None,
                fenced: true,
            };
        }
    };
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let attempt = timeout(budget, async {
        input.write_all(&serde_json::to_vec(request)?).await?;
        input.shutdown().await?;
        drop(input);
        let mut bytes = vec![];
        output.take(65537).read_to_end(&mut bytes).await?;
        if bytes.len() > 65536 {
            return Err(invalid("RUNNER_RESPONSE_TOO_LARGE"));
        }
        let status = child.wait().await?;
        let code = status.code().filter(|n| *n >= 0 && *n <= 255).unwrap_or(1) as u8;
        let response = Response::parse(&bytes)
            .ok()
            .filter(|r| r.action == request.action() && r.exit_code == code);
        Ok::<_, crate::Error>(Attempt {
            code,
            response,
            fenced: true,
        })
    })
    .await;
    if let Ok(Ok(attempt)) = attempt {
        return attempt;
    }
    let _ = child.start_kill();
    let fenced = matches!(
        timeout(Duration::from_secs(1), child.wait()).await,
        Ok(Ok(_))
    );
    Attempt {
        code: 3,
        response: None,
        fenced,
    }
}
fn settled(response: &Response, request: &Request) -> bool {
    if response.error.is_some() {
        return false;
    }
    match request.expected() {
        Some(expected) => {
            matches!(&response.operation,OperationRead::Observed{operation} if operation.id==expected.id && operation.target_version==expected.target_version && operation.outcome.is_some_and(|o|o.exit_code()==response.exit_code))
        }
        None => {
            response.exit_code != 3
                && match &response.operation {
                    OperationRead::Genesis => true,
                    OperationRead::Observed { operation } => operation.outcome.is_some(),
                    OperationRead::Unreadable { .. } => false,
                }
        }
    }
}
pub async fn supervise_release(
    release: &Release,
    request: &Request,
    scratch: &Path,
    options: &LaunchOptions,
    downloader: &Downloader,
) -> Result<LaunchResult> {
    request.validate()?;
    crate::host::isolate_standard_handles()?;
    options.validate()?;
    let bytes = downloader.download(release, None, None).await?;
    supervise_bytes(&bytes, request, scratch, options).await
}
/// Embedded native installers use their own trusted executable bytes; this
/// avoids a fake local HTTP server and does not expose arbitrary file selection
/// in the untrusted runner protocol.
pub async fn supervise_bytes(
    bytes: &[u8],
    request: &Request,
    scratch: &Path,
    options: &LaunchOptions,
) -> Result<LaunchResult> {
    request.validate()?;
    crate::host::isolate_standard_handles()?;
    options.validate()?;
    ensure_dir(scratch)?;
    let dir = scratch.join(format!("k-runner-{}", uuid::Uuid::new_v4()));
    ensure_dir(&dir)?;
    let file = dir.join(if cfg!(windows) {
        "runner.exe"
    } else {
        "runner.bin"
    });
    let recovery_file = dir.join("recovery.json");
    let recover = Request::Recover {
        protocol_version: 1,
        expected: request.expected(),
    };
    write_durable(&file, bytes, true)?;
    write_json(
        &recovery_file,
        &RecoveryDescriptor {
            file: file.clone(),
            sha256: sha256(bytes),
            size: bytes.len() as u64,
            request: recover.clone(),
        },
    )?;
    sync_dir(&dir)?;
    let deadline = Instant::now() + Duration::from_millis(options.total_ms);
    let mut attempts = 0;
    let mut response = None;
    for index in 0..=options.recovery_attempts {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        let budget = Duration::from_millis(if index == 0 {
            options.execution_ms
        } else {
            options.recovery_ms
        })
        .min(remaining);
        let attempt = run(
            &file,
            if index == 0 { request } else { &recover },
            budget,
            &options.env,
        )
        .await;
        attempts += 1;
        let done = attempt
            .response
            .as_ref()
            .is_some_and(|r| settled(r, request));
        response = attempt.response;
        if attempt.fenced && (matches!(request, Request::Status { .. }) || done) {
            remove_dir(&dir)?;
            return Ok(LaunchResult {
                exit_code: if response.is_none() && attempt.code == 0 {
                    1
                } else {
                    attempt.code
                },
                response,
                recovery_file: None,
                error: None,
                attempts,
            });
        }
        if !attempt.fenced || request.expected().is_none() {
            break;
        }
    }
    Ok(LaunchResult{exit_code:3,response,recovery_file:Some(recovery_file),error:Some("RECOVERY_UNRESOLVED: retained helper and invocation; transaction evidence is unchanged".into()),attempts})
}
pub async fn resume_runner(recovery_file: &Path, options: &LaunchOptions) -> Result<LaunchResult> {
    let descriptor: RecoveryDescriptor = serde_json::from_slice(&fs::read(recovery_file)?)?;
    descriptor.request.validate()?;
    if !matches!(
        &descriptor.request,
        Request::Recover {
            expected: Some(_),
            ..
        }
    ) {
        return Err(invalid("INVALID_RECOVERY_DESCRIPTOR"));
    }
    let bytes = fs::read(&descriptor.file)?;
    verify(&bytes, descriptor.size, &descriptor.sha256)
        .map_err(|_| invalid("RECOVERY_ARTIFACT_MISMATCH"))?;
    let scratch = recovery_file
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| invalid("INVALID_RECOVERY_DESCRIPTOR"))?;
    let result = supervise_bytes(&bytes, &descriptor.request, scratch, options).await?;
    if result.recovery_file.is_none() {
        fs::remove_file(&descriptor.file)?;
        fs::remove_file(recovery_file)?;
    }
    Ok(result)
}
