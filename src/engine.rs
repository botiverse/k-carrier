//! The state machine has no direct disk/process/time dependencies. All effects
//! are explicit so every effect boundary can be crashed by the Rust harness.
use crate::{
    Error, Result,
    error::invalid,
    host::Host,
    state::{Evidence, JournalEntry, Phase, Slot},
    storage::Effects,
};
use async_trait::async_trait;
use std::{collections::BTreeMap, future::Future, path::Path, time::Duration};

#[async_trait]
pub trait Predicates: Send + Sync {
    async fn evaluate(&self, evidence: &Evidence, target: &str) -> Result<Option<String>>;
}
pub struct VersionPredicate;
#[async_trait]
impl Predicates for VersionPredicate {
    async fn evaluate(&self, evidence: &Evidence, target: &str) -> Result<Option<String>> {
        evidence.validate()?;
        Ok((evidence.version != target).then(|| {
            format!(
                "live process reports {}, expected {target}",
                evidence.version
            )
        }))
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineOutcome {
    Promoted(String),
    RolledBack(String),
    UpToDate,
}
pub struct Engine<'a> {
    effects: &'a dyn Effects,
    host: &'a dyn Host,
    predicates: &'a dyn Predicates,
    now: &'a (dyn Fn() -> u64 + Send + Sync),
    budget: Duration,
    seq: u64,
}
impl<'a> Engine<'a> {
    pub fn new(
        effects: &'a dyn Effects,
        host: &'a dyn Host,
        predicates: &'a dyn Predicates,
        now: &'a (dyn Fn() -> u64 + Send + Sync),
        budget_ms: u64,
    ) -> Result<Self> {
        if budget_ms == 0 || budget_ms > 2_147_483_647 {
            return Err(invalid("invalid host call budget"));
        }
        Ok(Self {
            effects,
            host,
            predicates,
            now,
            budget: Duration::from_millis(budget_ms),
            seq: 0,
        })
    }
    async fn bounded<T>(&self, label: &str, call: impl Future<Output = Result<T>>) -> Result<T> {
        tokio::time::timeout(self.budget, call)
            .await
            .unwrap_or_else(|_| Err(Error::Uncertain(format!("HOST_CALL_TIMEOUT: {label}"))))
    }
    async fn journal(&mut self, intent: Phase, mut detail: BTreeMap<String, String>) -> Result<()> {
        detail.insert("formatVersion".into(), "1".into());
        let entry = JournalEntry {
            seq: self.seq,
            timestamp_ms: (self.now)(),
            intent,
            detail,
        };
        self.effects.append(&entry).await?;
        self.seq += 1;
        Ok(())
    }
    pub async fn recover(&mut self) -> Result<()> {
        // Validate persistent input before invoking any host effect, including fence.
        let entries = self.effects.read_journal().await?;
        for e in &entries {
            e.validate()?;
        }
        self.seq = entries.last().map_or(0, |e| e.seq + 1);
        self.bounded("fence", self.host.fence()).await?;
        let Some(last) = entries.last() else {
            return Ok(());
        };
        match last.intent {
            Phase::Idle => Ok(()),
            Phase::Promoted => {
                self.effects.promote().await?;
                self.bounded("resume", self.host.resume()).await
            }
            Phase::RolledBack => {
                self.bounded("stop", self.host.stop(Slot::Experiment))
                    .await?;
                self.bounded("start", self.host.start(Slot::Stable)).await?;
                self.bounded("resume", self.host.resume()).await?;
                self.effects.clear().await
            }
            Phase::Staged => self.rollback("crash before handover", true).await,
            Phase::HandingOver | Phase::RunningExperiment | Phase::Readback => {
                self.rollback(
                    &format!(
                        "crash during {}",
                        serde_json::to_value(last.intent)?
                            .as_str()
                            .unwrap_or("unknown")
                    ),
                    false,
                )
                .await
            }
        }
    }
    pub async fn upgrade(&mut self, version: &str, bytes: &Path) -> Result<EngineOutcome> {
        let versions = self.effects.versions().await?;
        let stable = versions
            .get("stable")
            .and_then(Option::as_deref)
            .ok_or_else(|| invalid("stable slot required before upgrade"))?;
        if stable == version {
            return Ok(EngineOutcome::UpToDate);
        }
        let prior = match self.bounded("probe", self.host.probe()).await {
            Ok(e) => Some(e),
            Err(e) if e.is_uncertain() => return Err(e),
            Err(_) => None,
        };
        let mut detail = BTreeMap::from([("version".into(), version.into())]);
        self.journal(Phase::Staged, detail.clone()).await?;
        self.effects.stage(version, bytes).await?;
        if let Some(e) = &prior {
            detail.insert("priorStartId".into(), e.start_id.clone());
        }
        self.journal(Phase::HandingOver, detail.clone()).await?;
        self.bounded("quiesce", self.host.quiesce()).await?;
        self.bounded("stop", self.host.stop(Slot::Stable)).await?;
        self.bounded("start", self.host.start(Slot::Experiment))
            .await?;
        detail.remove("priorStartId");
        self.journal(Phase::RunningExperiment, detail.clone())
            .await?;
        let evidence = match self.bounded("probe", self.host.probe()).await {
            Ok(e) => e,
            Err(e) if e.is_uncertain() => return Err(e),
            Err(e) => {
                return self
                    .rollback_outcome(&format!("experiment probe failed: {e}"))
                    .await;
            }
        };
        self.journal(Phase::Readback, detail.clone()).await?;
        if prior
            .as_ref()
            .is_some_and(|e| e.start_id == evidence.start_id)
        {
            return self
                .rollback_outcome("live process is still the pre-upgrade incarnation")
                .await;
        }
        if let Some(reason) = self
            .bounded("readback", self.predicates.evaluate(&evidence, version))
            .await?
        {
            return self
                .rollback_outcome(&format!("predicates refused: {reason}"))
                .await;
        }
        self.journal(Phase::Promoted, detail).await?;
        self.effects.promote().await?;
        self.bounded("resume", self.host.resume()).await?;
        Ok(EngineOutcome::Promoted(version.into()))
    }
    async fn rollback_outcome(&mut self, reason: &str) -> Result<EngineOutcome> {
        self.rollback(reason, false).await?;
        Ok(EngineOutcome::RolledBack(reason.into()))
    }
    async fn rollback(&mut self, reason: &str, skip_restart: bool) -> Result<()> {
        self.journal(
            Phase::RolledBack,
            BTreeMap::from([("reason".into(), reason.into())]),
        )
        .await?;
        if !skip_restart {
            self.bounded("stop", self.host.stop(Slot::Experiment))
                .await?;
            self.bounded("start", self.host.start(Slot::Stable)).await?;
            self.bounded("resume", self.host.resume()).await?;
        }
        self.effects.clear().await
    }
}
