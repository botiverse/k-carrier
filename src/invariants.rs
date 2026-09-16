//! Shared observation-based checks for adopters, fault harnesses and simulations.
//! These concern one K-managed identity. Safety alone does not prove liveness.
use crate::state::{Phase, Slot};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveProcess {
    pub slot: Slot,
    pub pid: u32,
    pub start_id: String,
    pub version: String,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Slots {
    pub stable: Option<String>,
    pub experiment: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldSnapshot {
    pub phase: Phase,
    pub slots: Slots,
    pub live_processes: Vec<LiveProcess>,
    pub journal_intents: Vec<Phase>,
    pub workload_digest: Option<String>,
    pub prior_incarnation_start_id: Option<String>,
    pub install_ownership: Option<Ownership>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Ownership {
    #[serde(rename = "self")]
    SelfOwned,
    ManagedElsewhere,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HostAssumption {
    QuiesceResumeInverse,
    ProbeFromLiveProcess,
    CompatibilityDeclared,
    DataFormatBackwardCompatible,
    ExclusiveHandoff,
    ResidentService,
}
pub struct Invariant {
    pub id: &'static str,
    pub assumes: &'static [HostAssumption],
    pub check: fn(&WorldSnapshot) -> Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Violation {
    pub invariant_id: String,
    pub reason: String,
}
pub const BUILT_IN_INVARIANTS: &[Invariant] = &[
    Invariant {
        id: "k.never-dual-run",
        assumes: &[HostAssumption::ExclusiveHandoff],
        check: |s| {
            (s.live_processes.len() > 1)
                .then(|| format!("{} live incarnations", s.live_processes.len()))
        },
    },
    Invariant {
        id: "k.never-bricked",
        assumes: &[],
        check: |s| {
            (s.slots.stable.is_none() && s.slots.experiment.is_none())
                .then(|| "both slots empty".into())
        },
    },
    Invariant {
        id: "k.live-process-matches-slot",
        assumes: &[],
        check: |s| {
            s.live_processes.iter().find_map(|p| {
                let version = match p.slot {
                    Slot::Stable => &s.slots.stable,
                    Slot::Experiment => &s.slots.experiment,
                };
                version
                    .as_ref()
                    .filter(|v| **v != p.version)
                    .map(|v| format!("slot holds {v} but live process reports {}", p.version))
            })
        },
    },
    Invariant {
        id: "k.journal-precedes-phase",
        assumes: &[],
        check: |s| {
            (s.phase != Phase::Idle && !s.journal_intents.contains(&s.phase))
                .then(|| format!("phase {:?} has no journal intent", s.phase))
        },
    },
    Invariant {
        id: "k.terminal-leaves-no-experiment",
        assumes: &[],
        check: |s| {
            (matches!(s.phase, Phase::Promoted | Phase::RolledBack) && s.slots.experiment.is_some())
                .then(|| "terminal transaction retains experiment".into())
        },
    },
    Invariant {
        id: "k.managed-copy-never-self-upgrades",
        assumes: &[],
        check: |s| {
            (s.install_ownership == Some(Ownership::ManagedElsewhere) && s.phase != Phase::Idle)
                .then(|| "externally managed installation entered a transaction".into())
        },
    },
];
pub fn check_invariants(snapshot: &WorldSnapshot, invariants: &[Invariant]) -> Vec<Violation> {
    invariants
        .iter()
        .filter_map(|i| {
            (i.check)(snapshot).map(|reason| Violation {
                invariant_id: i.id.into(),
                reason,
            })
        })
        .collect()
}
pub const WORKLOAD_PRESERVED_ASSUMES: &[HostAssumption] = &[HostAssumption::QuiesceResumeInverse];
pub fn workload_preserved(before: &WorldSnapshot, after: &WorldSnapshot) -> Option<String> {
    match (&before.workload_digest, &after.workload_digest) {
        (Some(a), Some(b)) if a != b => Some("workload digest changed across transition".into()),
        _ => None,
    }
}
fn terminal(phase: Phase) -> bool {
    matches!(phase, Phase::Idle | Phase::Promoted | Phase::RolledBack)
}
pub fn reaches_terminal_within(trace: &[Phase], max_steps: usize) -> Option<String> {
    if trace.last().is_some_and(|p| terminal(*p)) {
        return None;
    }
    (trace.len() >= max_steps).then(|| {
        format!(
            "transaction has not reached terminal after {} steps (limit {max_steps})",
            trace.len()
        )
    })
}
pub const SERVICE_SETTLES_LIVE_ASSUMES: &[HostAssumption] = &[HostAssumption::ResidentService];
pub fn service_settles_live(
    observations: &[WorldSnapshot],
    max_observations: usize,
) -> Option<String> {
    let first = observations.iter().position(|s| terminal(s.phase))?;
    for s in observations.iter().skip(first).take(max_observations) {
        if s.slots
            .stable
            .as_ref()
            .is_some_and(|v| s.live_processes.iter().any(|p| &p.version == v))
        {
            return None;
        }
    }
    Some(format!(
        "terminal transaction has no live stable incarnation within {max_observations} observations"
    ))
}
