use crate::{
    Error, Result,
    artifact::{Downloader, Release, ReleaseContext, ReleaseSource},
    engine::{Engine, EngineOutcome},
    error::invalid,
    host::Host,
    lock::UpgradeLock,
    protocol::{Expected, Request, Response},
    report::{Convergence, ReadbackSurface, ReportRead, TxnState, retire_reason},
    state::*,
    storage::{Effects, FileStore, now_ms, write_durable},
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path, sync::Arc};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Policy {
    Auto,
    Confirm,
    NotifyOnly,
}
#[async_trait]
pub trait Hooks: Send + Sync {
    fn managed_elsewhere(&self) -> bool {
        false
    }
    async fn compatibility(&self, _from: &str, _to: &str) -> Result<Option<String>> {
        Ok(None)
    }
    /// Validate the acquired executable and durably capture product state before
    /// the first handover intent. This may run a bounded self-check, but must not
    /// stop, publish, or start the installed service. Recovery never calls it.
    async fn prepare_candidate(&self, _artifact: &Path, _release: &Release) -> Result<()> {
        Ok(())
    }
    async fn notify(&self, _kind: &str, _detail: BTreeMap<String, String>) -> Result<()> {
        Ok(())
    }
    fn progress(&self, _stage: &str, _version: Option<&str>, _bytes: Option<(u64, u64)>) {}
}
pub struct DefaultHooks;
#[async_trait]
impl Hooks for DefaultHooks {}
#[derive(Debug, Clone)]
pub struct OperationDescriptor {
    pub id: String,
    pub started_at_ms: u64,
    pub provenance: Option<Provenance>,
    pub metadata: BTreeMap<String, String>,
}
#[derive(Debug, Clone, Default)]
pub struct UpgradeOptions {
    pub consented: bool,
    pub provenance: Option<Provenance>,
    pub operation: Option<OperationDescriptor>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "result", rename_all = "kebab-case")]
pub enum UpgradeOutcome {
    Promoted {
        report: crate::report::ConvergenceReport,
    },
    RolledBack {
        reason: String,
        report: Option<crate::report::ConvergenceReport>,
    },
    Held {
        reason: String,
    },
    UpToDate,
}
pub struct Runner {
    pub clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    pub store: FileStore,
    pub host: Arc<dyn Host>,
    pub source: Arc<dyn ReleaseSource>,
    pub hooks: Arc<dyn Hooks>,
    pub policy: Policy,
    pub host_budget_ms: u64,
    pub downloader: Downloader,
    pub surfaces: Vec<Arc<dyn ReadbackSurface>>,
    pub provenance_enabled: bool,
    pub provenance_identity: Provenance,
}
pub fn platform_key() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("{os}-{arch}")
}
impl Runner {
    pub fn new(
        store: FileStore,
        host: Arc<dyn Host>,
        source: Arc<dyn ReleaseSource>,
    ) -> Result<Self> {
        Ok(Self {
            clock: Arc::new(now_ms),
            store,
            host,
            source,
            hooks: Arc::new(DefaultHooks),
            policy: Policy::Auto,
            host_budget_ms: 120_000,
            downloader: Downloader::new()?,
            surfaces: vec![],
            provenance_enabled: false,
            provenance_identity: Provenance {
                who: "local".into(),
                carrier: "auto".into(),
            },
        })
    }
    fn convergence(&self) -> Result<Convergence<'_>> {
        let mut convergence = Convergence::new(
            &self.surfaces,
            self.store
                .artifact(Slot::Experiment)
                .to_string_lossy()
                .into_owned(),
        )?;
        convergence.clock = self.clock.as_ref();
        Ok(convergence)
    }
    fn emit(&self, stage: &str, version: Option<&str>, bytes: Option<(u64, u64)>) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.hooks.progress(stage, version, bytes)
        }));
    }
    fn read_required(&self) -> Result<Option<Operation>> {
        match self.store.read_operation() {
            OperationRead::Genesis => Ok(None),
            OperationRead::Observed { operation } => Ok(Some(operation)),
            OperationRead::Unreadable { reason } => Err(invalid(reason)),
        }
    }
    fn prior(&self, expected: &Expected, recover: bool) -> Result<()> {
        let current = self.read_required()?;
        let prior = match self.store.read_archive(&expected.id) {
            OperationRead::Unreadable { reason } => return Err(invalid(reason)),
            OperationRead::Observed { operation } => Some(operation),
            OperationRead::Genesis => current,
        };
        match prior {
            Some(operation) if operation.id == expected.id => {
                if operation.target_version != expected.target_version {
                    return Err(invalid("OPERATION_ID_CONFLICT"));
                }
                if operation.outcome.is_some() {
                    return Err(Error::Replay(Box::new(operation)));
                }
                Ok(())
            }
            _ if recover => Err(invalid("RECOVERY_OPERATION_NOT_FOUND")),
            _ => Ok(()),
        }
    }
    fn transition(
        &self,
        op: &mut Option<Operation>,
        phase: OperationPhase,
        outcome: Option<Outcome>,
        reason: Option<String>,
    ) -> Result<()> {
        if let Some(op) = op {
            op.phase = phase;
            op.updated_at_ms = (self.clock)();
            if outcome.is_some() {
                op.outcome = outcome;
            }
            if reason.is_some() {
                op.reason = reason;
            }
            self.store.persist_operation(op)?;
        }
        Ok(())
    }
    async fn settle(&self) -> Result<()> {
        let mut op = self.read_required()?;
        let Some(record) = &op else {
            return Ok(());
        };
        if record.outcome.is_some() {
            return Ok(());
        }
        let state = self.store.transaction_state().await?;
        if state.phase() == Phase::Promoted && state.stable() == record.target_version {
            self.transition(
                &mut op,
                OperationPhase::Promoted,
                Some(Outcome::Promoted),
                None,
            )
        } else if state.phase().at_rest() {
            let reason = match &state {
                TxnState::RolledBack {
                    rollback_reason: Some(r),
                    ..
                } => r.clone(),
                _ => format!(
                    "recovery settled at {:?} with stable {}",
                    state.phase(),
                    state.stable()
                ),
            };
            self.transition(
                &mut op,
                OperationPhase::RolledBack,
                Some(Outcome::RolledBack),
                Some(reason),
            )
        } else {
            Ok(())
        }
    }
    async fn recover_engine(&self, engine: &mut Engine<'_>) -> Result<()> {
        if let Some(operation) = self.read_required()?
            && let Some(outcome) = operation.outcome
        {
            let state = self.store.transaction_state().await?;
            let expected = if outcome == Outcome::Promoted {
                &operation.target_version
            } else {
                &operation.from_version
            };
            if !state.phase().at_rest() || state.stable() != expected {
                return Err(invalid("SETTLED_OPERATION_STATE_MISMATCH"));
            }
            return engine.observe_settled().await;
        }
        engine.recover().await
    }
    pub async fn recover(&self, expected: Option<&Expected>) -> Result<()> {
        let mut lock = UpgradeLock::acquire_at(&self.store.root, (self.clock)())?;
        let result = async {
            self.read_required()?;
            if let Some(expected) = expected {
                self.prior(expected, true)?;
            }
            let convergence = self.convergence()?;
            let mut engine = Engine::new(
                &self.store,
                &*self.host,
                &convergence,
                self.clock.as_ref(),
                self.host_budget_ms,
            )?;
            self.recover_engine(&mut engine).await?;
            self.settle().await
        }
        .await;
        if result.as_ref().is_err_and(Error::is_uncertain) {
            lock.retain_until_exit();
        } else {
            lock.release()?;
        }
        result
    }
    pub async fn check(&self) -> Result<(String, Option<String>)> {
        let current = self.store.transaction_state().await?.stable().to_owned();
        let target = self
            .source
            .check(&ReleaseContext {
                current_version: current.clone(),
                platform_key: platform_key(),
            })
            .await?
            .map(|r| r.version);
        Ok((current, target))
    }
    pub async fn upgrade(&self) -> Result<UpgradeOutcome> {
        self.drive(None, UpgradeOptions::default()).await
    }
    pub async fn upgrade_to(
        &self,
        version: &str,
        options: UpgradeOptions,
    ) -> Result<UpgradeOutcome> {
        self.drive(Some(version), options).await
    }
    async fn drive(&self, target: Option<&str>, options: UpgradeOptions) -> Result<UpgradeOutcome> {
        if self.hooks.managed_elsewhere() {
            self.hooks
                .notify(
                    "held",
                    BTreeMap::from([("reason".into(), "managed-elsewhere".into())]),
                )
                .await?;
            return Ok(UpgradeOutcome::Held {
                reason: "this install is managed by another manager".into(),
            });
        }
        let mut lock = UpgradeLock::acquire_at(&self.store.root, (self.clock)())?;
        let result = self.drive_locked(target, options).await;
        if result.as_ref().is_err_and(Error::is_uncertain) {
            lock.retain_until_exit();
        } else {
            lock.release()?;
        }
        result
    }
    async fn drive_locked(
        &self,
        target: Option<&str>,
        options: UpgradeOptions,
    ) -> Result<UpgradeOutcome> {
        self.read_required()?;
        if let Some(desc) = &options.operation {
            self.prior(
                &Expected {
                    id: desc.id.clone(),
                    target_version: target.unwrap_or("").into(),
                },
                false,
            )?;
        }
        let convergence = self.convergence()?;
        let mut engine = Engine::new(
            &self.store,
            &*self.host,
            &convergence,
            self.clock.as_ref(),
            self.host_budget_ms,
        )?;
        self.recover_engine(&mut engine).await?;
        self.settle().await?;
        let previous = self.read_required()?;
        if let (Some(desc), Some(prior)) = (&options.operation, &previous) {
            if prior.id == desc.id && prior.outcome.is_some() {
                return Err(Error::Replay(Box::new(prior.clone())));
            }
            if prior.id != desc.id {
                if prior.outcome.is_none() {
                    return Err(invalid("OPERATION_IN_PROGRESS"));
                }
                self.store.archive(prior)?;
            }
        }
        let current = self.store.transaction_state().await?.stable().to_owned();
        let mut operation = options.operation.as_ref().map(|desc| Operation {
            format_version: 1,
            id: desc.id.clone(),
            started_at_ms: desc.started_at_ms,
            updated_at_ms: (self.clock)(),
            from_version: current.clone(),
            target_version: target.unwrap_or(&current).into(),
            previous_stable_version: current.clone(),
            phase: OperationPhase::Checking,
            outcome: None,
            reason: None,
            provenance: desc.provenance.clone().or(options.provenance.clone()),
            metadata: desc.metadata.clone(),
        });
        if let Some(op) = &operation {
            self.store.persist_operation(op)?;
        }
        self.emit("checking", None, None);
        let context = ReleaseContext {
            current_version: current.clone(),
            platform_key: platform_key(),
        };
        let picked = match target {
            Some(version) => self.source.fetch(version, &context).await.map(Some),
            None => self.source.check(&context).await,
        };
        let release = match picked {
            Ok(r) => r,
            Err(e) => {
                if options.consented && e.to_string().contains("PINNED_VERSION_MISMATCH") {
                    return self
                        .hold(&mut operation, "consented-version-unavailable", "held")
                        .await;
                }
                self.transition(
                    &mut operation,
                    OperationPhase::Failed,
                    Some(Outcome::Failed),
                    Some(e.to_string()),
                )?;
                return Err(e);
            }
        };
        let Some(release) = release else {
            self.transition(
                &mut operation,
                OperationPhase::UpToDate,
                Some(Outcome::UpToDate),
                None,
            )?;
            return Ok(UpgradeOutcome::UpToDate);
        };
        if target.is_some_and(|v| release.version != v) {
            self.transition(
                &mut operation,
                OperationPhase::Failed,
                Some(Outcome::Failed),
                Some("target-version-mismatch".into()),
            )?;
            return Err(invalid("PINNED_VERSION_MISMATCH"));
        }
        if !options.consented {
            match self.policy {
                Policy::Auto => {}
                Policy::NotifyOnly => {
                    return self.hold(&mut operation, "notify-only", "held").await;
                }
                Policy::Confirm => {
                    return self
                        .hold(&mut operation, "confirmation-required", "confirm-request")
                        .await;
                }
            }
        }
        if let Some(reason) = self.hooks.compatibility(&current, &release.version).await? {
            return self.hold(&mut operation, &reason, "held").await;
        }
        self.transition(&mut operation, OperationPhase::Downloading, None, None)?;
        self.emit("downloading", Some(&release.version), None);
        let hooks = self.hooks.clone();
        let version = release.version.clone();
        let progress = Arc::new(move |got, total| {
            hooks.progress("downloading", Some(&version), Some((got, total)))
        });
        let bytes = self
            .downloader
            .download(
                &release,
                Some(&self.store.root.join("incoming")),
                Some(progress),
            )
            .await?;
        self.transition(&mut operation, OperationPhase::Verifying, None, None)?;
        self.emit("verifying", Some(&release.version), None);
        self.transition(&mut operation, OperationPhase::Staging, None, None)?;
        self.emit("staging", Some(&release.version), None);
        let artifact = self.store.root.join("incoming/artifact.bin");
        write_durable(&artifact, &bytes, true)?;
        let preparation = tokio::time::timeout(
            std::time::Duration::from_millis(self.host_budget_ms),
            self.hooks.prepare_candidate(&artifact, &release),
        )
        .await
        .unwrap_or_else(|_| Err(invalid("CANDIDATE_PREPARATION_TIMEOUT")));
        if let Err(error) = preparation {
            self.transition(
                &mut operation,
                OperationPhase::Failed,
                Some(Outcome::Failed),
                Some(error.to_string()),
            )?;
            return Err(error);
        }
        if self.provenance_enabled {
            self.store.append_provenance_at(
                options
                    .provenance
                    .as_ref()
                    .unwrap_or(&self.provenance_identity),
                &release.version,
                None,
                (self.clock)(),
            )?;
        }
        self.transition(&mut operation, OperationPhase::HandingOver, None, None)?;
        self.emit("handing-over", Some(&release.version), None);
        let outcome = match engine.upgrade(&release.version, &artifact).await {
            Ok(o) => o,
            Err(e) => {
                self.transition(
                    &mut operation,
                    OperationPhase::Recovering,
                    None,
                    Some(e.to_string()),
                )?;
                return Err(e);
            }
        };
        match outcome {
            EngineOutcome::Promoted(version) => {
                self.emit("promoted", Some(&version), None);
                let report = convergence.report(&version);
                self.hooks
                    .notify("promoted", BTreeMap::from([("version".into(), version)]))
                    .await?;
                self.store.persist_report(&report)?;
                self.transition(
                    &mut operation,
                    OperationPhase::Promoted,
                    Some(Outcome::Promoted),
                    None,
                )?;
                Ok(UpgradeOutcome::Promoted { report })
            }
            EngineOutcome::RolledBack(reason) => {
                self.emit("rolled-back", Some(&release.version), None);
                self.hooks
                    .notify(
                        "rolled-back",
                        BTreeMap::from([("reason".into(), reason.clone())]),
                    )
                    .await?;
                self.transition(
                    &mut operation,
                    OperationPhase::RolledBack,
                    Some(Outcome::RolledBack),
                    Some(reason.clone()),
                )?;
                Ok(UpgradeOutcome::RolledBack {
                    reason,
                    report: None,
                })
            }
            EngineOutcome::UpToDate => {
                self.transition(
                    &mut operation,
                    OperationPhase::UpToDate,
                    Some(Outcome::UpToDate),
                    None,
                )?;
                Ok(UpgradeOutcome::UpToDate)
            }
        }
    }
    async fn hold(
        &self,
        operation: &mut Option<Operation>,
        reason: &str,
        kind: &str,
    ) -> Result<UpgradeOutcome> {
        self.transition(
            operation,
            OperationPhase::Held,
            Some(Outcome::Held),
            Some(reason.into()),
        )?;
        let mut detail = BTreeMap::from([("reason".into(), reason.into())]);
        if let Some(op) = operation {
            detail.insert("version".into(), op.target_version.clone());
            detail.insert("current".into(), op.from_version.clone());
        }
        self.hooks.notify(kind, detail).await?;
        Ok(UpgradeOutcome::Held {
            reason: reason.into(),
        })
    }
    pub async fn rollback(&self, reason: &str) -> Result<UpgradeOutcome> {
        let mut lock = UpgradeLock::acquire_at(&self.store.root, (self.clock)())?;
        let result = async {
            let last = self.store.read_journal().await?.last().map(|e| e.intent);
            let in_flight = last.is_some_and(|p| !p.at_rest());
            if !in_flight && self.hooks.managed_elsewhere() {
                return Ok(UpgradeOutcome::Held {
                    reason: "managed-elsewhere".into(),
                });
            }
            let convergence = self.convergence()?;
            let mut engine = Engine::new(
                &self.store,
                &*self.host,
                &convergence,
                self.clock.as_ref(),
                self.host_budget_ms,
            )?;
            engine.recover().await?;
            self.store.clear().await?;
            self.hooks
                .notify(
                    "rolled-back",
                    BTreeMap::from([("reason".into(), reason.into())]),
                )
                .await?;
            Ok(UpgradeOutcome::RolledBack {
                reason: reason.into(),
                report: None,
            })
        }
        .await;
        if result.as_ref().is_err_and(Error::is_uncertain) {
            lock.retain_until_exit();
        } else {
            lock.release()?;
        }
        result
    }
    pub fn retire_legacy_manager(&self) -> std::result::Result<(), String> {
        retire_reason(self.store.read_report())
    }
    pub async fn status(&self) -> Result<Value> {
        let state = self.store.transaction_state().await?;
        let predicates = match self.store.read_report() {
            ReportRead::Genesis => json!({"kind":"genesis"}),
            ReportRead::Unreadable { reason } => json!({"kind":"unreadable","reason":reason}),
            ReportRead::Observed { report } => {
                let mut v = serde_json::to_value(report)?;
                v["kind"] = json!("observed");
                v
            }
        };
        Ok(
            json!({"phase":state.phase(),"stable":state.stable(),"experiment":state.experiment(),"predicates":predicates,"policy":self.policy,"provenance":if self.provenance_enabled {serde_json::to_value(self.store.read_provenance())?}else{Value::Null}}),
        )
    }
    pub async fn execute(&self, request: &Request) -> Result<Response> {
        request.validate()?;
        let result = async {
            match request {
                Request::Status { .. } => Ok(("observed", 0)),
                Request::Recover { expected, .. } => {
                    self.recover(expected.as_ref()).await?;
                    Ok(("recovered", 0))
                }
                Request::Upgrade {
                    id,
                    target_version,
                    consented,
                    ..
                } => {
                    let options = UpgradeOptions {
                        consented: *consented,
                        operation: Some(OperationDescriptor {
                            id: id.clone(),
                            started_at_ms: (self.clock)(),
                            provenance: Some(Provenance {
                                who: "local-operator".into(),
                                carrier: "external-runner".into(),
                            }),
                            metadata: BTreeMap::new(),
                        }),
                        ..Default::default()
                    };
                    match self.upgrade_to(target_version, options).await? {
                        UpgradeOutcome::Promoted { .. } => Ok(("promoted", 0)),
                        UpgradeOutcome::RolledBack { .. } => Ok(("rolled-back", 1)),
                        UpgradeOutcome::Held { .. } => Ok(("held", 2)),
                        UpgradeOutcome::UpToDate => Ok(("up-to-date", 0)),
                    }
                }
            }
        }
        .await;
        let mut operation = self.store.read_operation();
        let (result, mut code, error) = match result {
            Ok((result, code)) => (result, code, None),
            Err(Error::Replay(record)) => {
                operation = OperationRead::Observed { operation: *record };
                ("replayed", operation.exit_code(), None)
            }
            Err(e @ Error::Locked(_)) => ("busy", 2, Some(e.to_string())),
            Err(e) => {
                let active = matches!(&operation,OperationRead::Observed{operation} if operation.outcome.is_none());
                let unresolved = active || e.is_uncertain()
                    || matches!(&operation, OperationRead::Unreadable { .. });
                (
                    if unresolved {
                        "recovery-required"
                    } else {
                        "failed"
                    },
                    if unresolved { 3 } else { 1 },
                    Some(e.to_string()),
                )
            }
        };
        if matches!(request, Request::Upgrade { .. }) && code == 0 {
            let expected = request.expected().unwrap();
            if !matches!(&operation,OperationRead::Observed{operation} if operation.id==expected.id && operation.target_version==expected.target_version)
            {
                return Ok(Response {
                    protocol_version: 1,
                    action: request.action().into(),
                    exit_code: 1,
                    result: "failed".into(),
                    operation,
                    error: Some("RUNNER_RECEIPT_MISMATCH".into()),
                });
            }
        }
        if !matches!(request, Request::Status { .. }) && code == 0 {
            code = operation.exit_code();
        }
        if matches!(operation, OperationRead::Unreadable { .. }) && code != 2 {
            code = if matches!(request, Request::Status { .. }) { 1 } else { 3 };
        }
        Ok(Response {
            protocol_version: 1,
            action: request.action().into(),
            exit_code: code,
            result: result.into(),
            operation,
            error,
        })
    }
}
