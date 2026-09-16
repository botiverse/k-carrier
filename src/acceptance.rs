//! Native adopter acceptance. Targets declare commands/data in JSON rather than
//! loading code into the verifier. All work uses a temporary sandbox.
use crate::{
    Result,
    artifact::sha256,
    engine::{Engine, EngineOutcome, VersionPredicate},
    error::invalid,
    host::{CommandHost, Host},
    lock::process_alive,
    report::ConvergenceReport,
    runner::platform_key,
    state::{Evidence, Phase, Slot},
    storage::{FileStore, now_ms},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    process::Command,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub id: String,
    pub status: String,
    pub error: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct Receipt {
    pub mode: String,
    pub profile: String,
    pub checks: Vec<Check>,
    pub result: String,
}
impl Receipt {
    fn new(mode: &str, profile: &str) -> Self {
        Self {
            mode: mode.into(),
            profile: profile.into(),
            checks: vec![],
            result: "pass".into(),
        }
    }
    fn check(&mut self, id: &str, result: Result<()>) -> bool {
        let error = result.err().map(|e| e.to_string());
        let pass = error.is_none();
        self.checks.push(Check {
            id: id.into(),
            status: if pass { "pass" } else { "fail" }.into(),
            error,
        });
        if !pass {
            self.result = "fail".into();
        }
        pass
    }
}
fn require(ok: bool, code: &str) -> Result<()> {
    if ok { Ok(()) } else { Err(invalid(code)) }
}

/// A command's output is bounded independently from its execution time.
pub async fn command(
    program: &Path,
    args: &[String],
    cwd: &Path,
    env: &BTreeMap<String, String>,
) -> Result<String> {
    let mut c = Command::new(program);
    c.args(args)
        .current_dir(cwd)
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    c.process_group(0);
    let mut child = c.spawn()?;
    let mut stdout = child.stdout.take().unwrap().take(65537);
    let mut bytes = vec![];
    let run = tokio::time::timeout(Duration::from_secs(30), async {
        stdout.read_to_end(&mut bytes).await?;
        require(bytes.len() <= 65536, "CONTRACT_OUTPUT_TOO_LARGE")?;
        require(child.wait().await?.success(), "CONTRACT_CMD_EXIT")
    })
    .await;
    let result = run.unwrap_or_else(|_| Err(invalid("CONTRACT_CMD_TIMEOUT")));
    if result.is_err() {
        #[cfg(unix)]
        if let Some(pid) = child.id() {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    result?;
    String::from_utf8(bytes).map_err(|_| invalid("CONTRACT_OUTPUT_INVALID"))
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlackBoxTarget {
    pub version: Vec<String>,
    pub self_upgrade: Vec<String>,
    pub status: Option<Vec<String>>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// A real candidate for this application, relative to the target file.
    pub artifact: PathBuf,
}
pub fn validate_status(text: &str) -> Result<()> {
    let v: Value = serde_json::from_str(text)?;
    let evidence: Evidence = serde_json::from_value(
        v.get("ProcessEvidence")
            .cloned()
            .ok_or_else(|| invalid("CONTRACT_STATUS_EVIDENCE"))?,
    )?;
    evidence.validate()?;
    let txn = v
        .get("TxnState")
        .ok_or_else(|| invalid("CONTRACT_STATUS_TRANSACTION"))?;
    serde_json::from_value::<Phase>(
        txn.get("phase")
            .cloned()
            .ok_or_else(|| invalid("CONTRACT_STATUS_PHASE"))?,
    )?;
    require(
        txn.get("stableVersion").is_some_and(Value::is_string),
        "CONTRACT_STATUS_STABLE",
    )?;
    for field in ["experimentVersion", "rollbackReason"] {
        require(
            txn.get(field).is_some_and(|v| v.is_null() || v.is_string()),
            "CONTRACT_STATUS_NULLABLE_MISSING",
        )?;
    }
    let report = v
        .get("ConvergenceReport")
        .ok_or_else(|| invalid("CONTRACT_STATUS_REPORT"))?;
    require(
        report.get("hostLifecycleConverged").is_some(),
        "CONTRACT_STATUS_LIFECYCLE_MISSING",
    )?;
    serde_json::from_value::<ConvergenceReport>(report.clone())?;
    Ok(())
}
pub async fn run_bin(
    bin: &Path,
    target_file: &Path,
    version: &str,
    profile: &str,
) -> Result<Receipt> {
    let mut receipt = Receipt::new("bin", profile);
    let declarations = fs::read(target_file)
        .map_err(|_| invalid("BLACKBOX_TARGET_REQUIRED: declare k.target.json"))?;
    let target: BlackBoxTarget =
        serde_json::from_slice(&declarations).map_err(|_| invalid("BLACKBOX_TARGET_INVALID"))?;
    require(
        !target.version.is_empty() && !target.self_upgrade.is_empty(),
        "BLACKBOX_TARGET_INVALID: empty command",
    )?;
    require(
        !version.trim().is_empty(),
        "BLACKBOX_TARGET_INVALID: empty version",
    )?;
    let bin = fs::canonicalize(bin)?;
    let artifact = fs::read(
        target_file
            .parent()
            .unwrap_or(Path::new("."))
            .join(target.artifact),
    )?;
    let sandbox = tempfile::tempdir()?;
    let executable = sandbox.path().join(
        bin.file_name()
            .ok_or_else(|| invalid("CONTRACT_BIN_MISSING"))?,
    );
    fs::copy(&bin, &executable)?;
    let manifest = serde_json::to_vec(
        &json!({"version":version,"targets":{platform_key():{"file":"artifact","sha256":sha256(&artifact),"size":artifact.len()}}}),
    )?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let mut env = target.env;
    env.insert(
        "K_RELEASE_BASE".into(),
        format!("http://{}", listener.local_addr()?),
    );
    let before = sha256(&fs::read(&executable)?);
    let server = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            // A single bounded connection owns no detached tasks after cleanup.
            let _ = tokio::time::timeout(Duration::from_secs(5), async {
                let mut request = [0; 8192];
                let n = stream.read(&mut request).await?;
                let path = String::from_utf8_lossy(&request[..n]);
                let body = if path.starts_with("GET /manifest.json ") {
                    &manifest
                } else if path.starts_with("GET /artifact ") {
                    &artifact
                } else {
                    return Ok::<(), std::io::Error>(());
                };
                stream
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await?;
                stream.write_all(body).await
            })
            .await;
        }
    });
    let first = command(&executable, &target.version, sandbox.path(), &env)
        .await
        .and_then(|s| require(!s.trim().is_empty(), "CONTRACT_CMD_EMPTY_OUTPUT"));
    if receipt.check("contract.version-command", first) {
        let upgraded = async {
            command(&executable, &target.self_upgrade, sandbox.path(), &env).await?;
            require(
                sha256(&fs::read(&executable)?) != before,
                "CONTRACT_UPGRADE_SELF_UNCHANGED",
            )?;
            let actual = command(&executable, &target.version, sandbox.path(), &env).await?;
            require(actual.trim() == version, "CONTRACT_NEXT_RUN_VERSION")
        }
        .await;
        receipt.check("contract.self-upgrade", upgraded);
        if profile == "service" {
            let status = async {
                let args = target
                    .status
                    .as_ref()
                    .ok_or_else(|| invalid("CONTRACT_STATUS_REQUIRED"))?;
                validate_status(&command(&executable, args, sandbox.path(), &env).await?)
            }
            .await;
            receipt.check("contract.status", status);
        }
    }
    server.abort();
    let _ = server.await;
    Ok(receipt)
}

/// The controller receives the standard K JSON protocol and runs with the
/// sandbox as cwd. It must own only processes/resources below that directory.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdapterTarget {
    pub stable_artifact: PathBuf,
    pub candidate_artifact: PathBuf,
    pub broken_artifact: PathBuf,
    pub stable_version: String,
    pub target_version: String,
    #[serde(default)]
    pub args: Vec<String>,
}
pub async fn run_adapter(controller: &Path, target_file: &Path, profile: &str) -> Result<Receipt> {
    let target: AdapterTarget = serde_json::from_slice(&fs::read(target_file)?)?;
    require(
        !target.stable_version.is_empty()
            && !target.target_version.is_empty()
            && target.stable_version != target.target_version,
        "HARNESS_ADAPTER_INVALID_VERSIONS",
    )?;
    let parent = target_file.parent().unwrap_or(Path::new("."));
    let stable = fs::canonicalize(parent.join(&target.stable_artifact))?;
    let candidate = fs::canonicalize(parent.join(&target.candidate_artifact))?;
    let broken = fs::canonicalize(parent.join(&target.broken_artifact))?;
    require(
        sha256(&fs::read(&broken)?) != sha256(&fs::read(&candidate)?),
        "HARNESS_ADAPTER_BROKEN_ARTIFACT_UNCHANGED",
    )?;
    let controller = fs::canonicalize(controller)?;
    let sandbox = tempfile::tempdir()?;
    let store = FileStore::new(sandbox.path().join("state"));
    crate::storage::bootstrap_stable(&store.root, &target.stable_version, &stable)?;
    let mut command = vec![controller.to_string_lossy().into_owned()];
    command.extend(target.args);
    let mut host = CommandHost::new(command, &store.root, 10000)?;
    host.cwd = Some(sandbox.path().into());
    let mut receipt = Receipt::new("adapter", profile);
    let checks = async {
        host.start(Slot::Stable).await?;
        let initial = host.probe().await?;
        require(
            process_alive(initial.pid) && initial.version == target.stable_version,
            "HARNESS_PROBE_NOT_LIVE",
        )?;
        let mut engine = Engine::new(&store, &host, &VersionPredicate, &now_ms, 12000)?;
        require(
            matches!(
                engine.upgrade(&target.target_version, &candidate).await?,
                EngineOutcome::Promoted(_)
            ),
            "HARNESS_UPGRADE_NOT_PROMOTED",
        )?;
        let upgraded = host.probe().await?;
        require(
            process_alive(upgraded.pid)
                && upgraded.version == target.target_version
                && upgraded.start_id != initial.start_id,
            "HARNESS_PROBE_NOT_NEW_INCARNATION",
        )?;
        receipt.check("adapter.service-upgrade", Ok(()));
        // A real broken executable must exercise rollback, not just return a
        // nominal error while continuing to report the healthy candidate.
        let failed = engine.upgrade("broken-candidate", &broken).await;
        require(
            !matches!(
                failed,
                Ok(EngineOutcome::Promoted(_)) | Ok(EngineOutcome::UpToDate)
            ),
            "HARNESS_BROKEN_RELEASE_DID_NOT_REFUSE",
        )?;
        // An explicit start error, like a killed worker, leaves a WAL intent.
        // Recovery must consume that intent and restore the previous service.
        engine.recover().await?;
        require(
            store.transaction_state().await?.phase() == Phase::RolledBack,
            "HARNESS_BROKEN_RELEASE_DID_NOT_ROLL_BACK",
        )?;
        let restored = host.probe().await?;
        require(
            process_alive(restored.pid) && restored.version == target.target_version,
            "HARNESS_ROLLBACK_NOT_LIVE",
        )?;
        receipt.check("adapter.service-rollback", Ok(()));
        host.stop(Slot::Stable).await?;
        require(
            host.probe().await.is_err(),
            "HARNESS_PROBE_ACCEPTS_DEAD_PROCESS",
        )?;
        receipt.check("adapter.probe-binds-live-process", Ok(()));
        Ok(())
    }
    .await;
    receipt.check("adapter.contract", checks);
    // Cleanup is itself a gate, even after a contract failure.
    receipt.check("adapter.cleanup", host.fence().await);
    receipt.check(
        "adapter.cleanup-experiment",
        host.stop(Slot::Experiment).await,
    );
    receipt.check("adapter.cleanup-stable", host.stop(Slot::Stable).await);
    Ok(receipt)
}
