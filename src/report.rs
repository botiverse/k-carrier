use crate::{
    Result,
    engine::Predicates,
    error::invalid,
    state::{Evidence, Phase, Provenance},
    storage::{Effects, FileStore, ensure_dir, exists, now_ms, sync_dir, write_json},
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Write,
    sync::{Arc, Mutex},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PredicateResult {
    pub passed: bool,
    pub source: String,
    pub observed_at_ms: u64,
    pub detail: BTreeMap<String, String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvergenceReport {
    pub version: String,
    pub binary_at_target: PredicateResult,
    #[serde(deserialize_with = "crate::state::required_nullable")]
    pub host_lifecycle_converged: Option<PredicateResult>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ReportRead {
    Genesis,
    Observed { report: ConvergenceReport },
    Unreadable { reason: String },
}
#[async_trait]
pub trait ReadbackSurface: Send + Sync {
    fn id(&self) -> &str;
    async fn read(&self) -> Result<(String, String)>;
}
pub struct Convergence<'a> {
    pub surfaces: &'a [Arc<dyn ReadbackSurface>],
    pub expected_target: String,
    pub clock: &'a (dyn Fn() -> u64 + Send + Sync),
    observed: Mutex<(Option<Evidence>, Option<PredicateResult>)>,
}
impl<'a> Convergence<'a> {
    pub fn new(surfaces: &'a [Arc<dyn ReadbackSurface>], expected_target: String) -> Result<Self> {
        let mut ids = BTreeSet::new();
        for s in surfaces {
            if s.id().is_empty() || !ids.insert(s.id()) {
                return Err(invalid("duplicate or empty readback surface id"));
            }
        }
        Ok(Self {
            surfaces,
            expected_target,
            clock: &now_ms,
            observed: Mutex::new((None, None)),
        })
    }
    pub fn report(&self, version: &str) -> ConvergenceReport {
        let (evidence, lifecycle) = self.observed.lock().unwrap().clone();
        ConvergenceReport {
            version: version.into(),
            binary_at_target: PredicateResult {
                passed: evidence.as_ref().is_some_and(|e| e.version == version),
                source: "host.healthProbe".into(),
                observed_at_ms: (self.clock)(),
                detail: evidence
                    .map(|e| {
                        BTreeMap::from([
                            ("version".into(), e.version),
                            ("pid".into(), e.pid.to_string()),
                            ("startId".into(), e.start_id),
                        ])
                    })
                    .unwrap_or_default(),
            },
            host_lifecycle_converged: lifecycle.or_else(|| {
                (!self.surfaces.is_empty()).then(|| PredicateResult {
                    passed: false,
                    source: "not-converged".into(),
                    observed_at_ms: (self.clock)(),
                    detail: BTreeMap::new(),
                })
            }),
        }
    }
}
#[async_trait]
impl Predicates for Convergence<'_> {
    async fn evaluate(&self, evidence: &Evidence, target: &str) -> Result<Option<String>> {
        evidence.validate()?;
        self.observed.lock().unwrap().0 = Some(evidence.clone());
        if evidence.version != target {
            return Ok(Some(format!(
                "live process reports {}, expected {target}",
                evidence.version
            )));
        }
        if self.surfaces.is_empty() {
            return Ok(None);
        }
        let mut result = PredicateResult {
            passed: true,
            source: String::new(),
            observed_at_ms: (self.clock)(),
            detail: BTreeMap::new(),
        };
        let mut sources = vec![];
        for surface in self.surfaces {
            match surface.read().await {
                Ok((value, _)) if value.contains(&self.expected_target) => {
                    result.detail.insert(surface.id().into(), value);
                    sources.push(surface.id());
                }
                Ok((value, _)) => {
                    result.passed = false;
                    result.source = surface.id().into();
                    result.detail = BTreeMap::from([
                        ("expected".into(), self.expected_target.clone()),
                        ("got".into(), value),
                    ]);
                    break;
                }
                Err(e) => {
                    result.passed = false;
                    result.source = surface.id().into();
                    result.detail = BTreeMap::from([("error".into(), e.to_string())]);
                    break;
                }
            }
        }
        if result.passed {
            result.source = sources.join(",");
        }
        let refusal = (!result.passed)
            .then(|| format!("lifecycle surface {} did not converge", result.source));
        self.observed.lock().unwrap().1 = Some(result);
        Ok(refusal)
    }
}
impl FileStore {
    pub fn persist_report(&self, report: &ConvergenceReport) -> Result<()> {
        write_json(&self.root.join("report.json"), report)
    }
    pub fn read_report(&self) -> ReportRead {
        match fs::read(self.root.join("report.json")) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(report) => ReportRead::Observed { report },
                Err(e) => ReportRead::Unreadable {
                    reason: format!("corrupt report.json: {e}"),
                },
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => ReportRead::Genesis,
            Err(e) => ReportRead::Unreadable {
                reason: format!("cannot read report.json: {e}"),
            },
        }
    }
    pub async fn transaction_state(&self) -> Result<TxnState> {
        let last = self.read_journal().await?.last().cloned();
        let phase = last.as_ref().map_or(Phase::Idle, |e| e.intent);
        let stable = self
            .version(crate::state::Slot::Stable)?
            .unwrap_or_else(|| "0.0.0".into());
        match phase {
            Phase::Idle => Ok(TxnState::Idle {
                stable_version: stable,
            }),
            Phase::Promoted => Ok(TxnState::Promoted {
                stable_version: stable,
            }),
            Phase::RolledBack => Ok(TxnState::RolledBack {
                stable_version: stable,
                rollback_reason: last.and_then(|e| e.detail.get("reason").cloned()),
            }),
            Phase::Staged | Phase::HandingOver | Phase::RunningExperiment | Phase::Readback => {
                let experiment =
                    self.version(crate::state::Slot::Experiment)?
                        .ok_or_else(|| {
                            invalid("TXN_STATE_INCONSISTENT: in-flight phase has no experiment")
                        })?;
                let state = match phase {
                    Phase::Staged => TxnState::Staged {
                        stable_version: stable,
                        experiment_version: experiment,
                    },
                    Phase::HandingOver => TxnState::HandingOver {
                        stable_version: stable,
                        experiment_version: experiment,
                    },
                    Phase::RunningExperiment => TxnState::RunningExperiment {
                        stable_version: stable,
                        experiment_version: experiment,
                    },
                    Phase::Readback => TxnState::Readback {
                        stable_version: stable,
                        experiment_version: experiment,
                    },
                    _ => unreachable!(),
                };
                Ok(state)
            }
        }
    }
}
#[derive(Debug, Clone)]
pub enum TxnState {
    Idle {
        stable_version: String,
    },
    Promoted {
        stable_version: String,
    },
    RolledBack {
        stable_version: String,
        rollback_reason: Option<String>,
    },
    Staged {
        stable_version: String,
        experiment_version: String,
    },
    HandingOver {
        stable_version: String,
        experiment_version: String,
    },
    RunningExperiment {
        stable_version: String,
        experiment_version: String,
    },
    Readback {
        stable_version: String,
        experiment_version: String,
    },
}
impl Serialize for TxnState {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        let reason = match self {
            Self::RolledBack {
                rollback_reason, ..
            } => rollback_reason.as_deref(),
            _ => None,
        };
        serde_json::json!({"phase":self.phase(), "stableVersion":self.stable(),
            "experimentVersion":self.experiment(), "rollbackReason":reason})
        .serialize(serializer)
    }
}
impl TxnState {
    pub fn phase(&self) -> Phase {
        match self {
            Self::Idle { .. } => Phase::Idle,
            Self::Promoted { .. } => Phase::Promoted,
            Self::RolledBack { .. } => Phase::RolledBack,
            Self::Staged { .. } => Phase::Staged,
            Self::HandingOver { .. } => Phase::HandingOver,
            Self::RunningExperiment { .. } => Phase::RunningExperiment,
            Self::Readback { .. } => Phase::Readback,
        }
    }
    pub fn stable(&self) -> &str {
        match self {
            Self::Idle { stable_version }
            | Self::Promoted { stable_version }
            | Self::RolledBack { stable_version, .. }
            | Self::Staged { stable_version, .. }
            | Self::HandingOver { stable_version, .. }
            | Self::RunningExperiment { stable_version, .. }
            | Self::Readback { stable_version, .. } => stable_version,
        }
    }
    pub fn experiment(&self) -> Option<&str> {
        match self {
            Self::Staged {
                experiment_version, ..
            }
            | Self::HandingOver {
                experiment_version, ..
            }
            | Self::RunningExperiment {
                experiment_version, ..
            }
            | Self::Readback {
                experiment_version, ..
            } => Some(experiment_version),
            _ => None,
        }
    }
}
pub fn retire_reason(read: ReportRead) -> std::result::Result<(), String> {
    match read {
        ReportRead::Genesis => Err("cannot retire: no upgrade has converged yet".into()),
        ReportRead::Unreadable { reason } => Err(format!(
            "cannot retire: last convergence report cannot be read ({reason})"
        )),
        ReportRead::Observed { report } => match report.host_lifecycle_converged {
            None => Err("cannot retire: no OS-lifecycle surface was observed".into()),
            Some(p) if p.passed => Ok(()),
            Some(_) => Err("cannot retire: host_lifecycle_converged did not pass".into()),
        },
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProvenanceEntry {
    pub seq: u64,
    pub who: String,
    pub carrier: String,
    pub when: u64,
    pub version: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ProvenanceRead {
    Genesis,
    Observed { entries: Vec<ProvenanceEntry> },
    Unreadable { reason: String },
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceSummary {
    pub recorded: usize,
    pub reconciles: usize,
    pub not_observed: usize,
    pub unreadable: usize,
}
pub fn summarize_provenance(reads: &[ProvenanceRead]) -> ProvenanceSummary {
    let mut summary = ProvenanceSummary::default();
    for read in reads {
        match read {
            ProvenanceRead::Genesis => summary.not_observed += 1,
            ProvenanceRead::Unreadable { .. } => summary.unreadable += 1,
            ProvenanceRead::Observed { entries } => {
                summary.recorded += 1;
                summary.reconciles += entries.len();
            }
        }
    }
    summary
}
impl FileStore {
    pub fn read_provenance(&self) -> ProvenanceRead {
        let path = self.root.join("provenance.jsonl");
        let result = (|| -> Result<Option<Vec<ProvenanceEntry>>> {
            if !exists(&path)? {
                return Ok(None);
            }
            let bytes = fs::read(&path)?;
            let mut out: Vec<ProvenanceEntry> = vec![];
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
                let entry: ProvenanceEntry = serde_json::from_slice(line)?;
                if out.last().is_some_and(|e| e.seq >= entry.seq) {
                    return Err(invalid("PROVENANCE_SEQ_REWRITE"));
                }
                out.push(entry);
            }
            Ok(Some(out))
        })();
        match result {
            Ok(None) => ProvenanceRead::Genesis,
            Ok(Some(entries)) => ProvenanceRead::Observed { entries },
            Err(e) => ProvenanceRead::Unreadable {
                reason: e.to_string(),
            },
        }
    }
    pub fn append_provenance(
        &self,
        identity: &Provenance,
        version: &str,
        explicit: Option<u64>,
    ) -> Result<ProvenanceEntry> {
        self.append_provenance_at(identity, version, explicit, now_ms())
    }
    pub fn append_provenance_at(
        &self,
        identity: &Provenance,
        version: &str,
        explicit: Option<u64>,
        timestamp_ms: u64,
    ) -> Result<ProvenanceEntry> {
        let last = match self.read_provenance() {
            ProvenanceRead::Unreadable { reason } => {
                return Err(invalid(format!("PROVENANCE_HISTORY_UNREADABLE: {reason}")));
            }
            ProvenanceRead::Genesis => None,
            ProvenanceRead::Observed { entries } => entries.last().map(|e| e.seq),
        };
        let seq = explicit.unwrap_or_else(|| last.map_or(0, |n| n + 1));
        if last.is_some_and(|n| n >= seq) {
            return Err(invalid("PROVENANCE_SEQ_REWRITE"));
        }
        let entry = ProvenanceEntry {
            seq,
            who: identity.who.clone(),
            carrier: identity.carrier.clone(),
            version: version.into(),
            when: timestamp_ms,
        };
        ensure_dir(&self.root)?;
        let path = self.root.join("provenance.jsonl");
        if exists(&path)? {
            let bytes = fs::read(&path)?;
            let end = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |n| n + 1);
            let f = OpenOptions::new().write(true).open(&path)?;
            f.set_len(end as u64)?;
            f.sync_all()?;
        }
        let mut options = OpenOptions::new();
        options.append(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut f = options.open(path)?;
        let mut bytes = serde_json::to_vec(&entry)?;
        bytes.push(b'\n');
        f.write_all(&bytes)?;
        f.sync_all()?;
        sync_dir(&self.root)?;
        Ok(entry)
    }
}
