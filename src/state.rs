use crate::{Result, error::invalid};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Idle,
    Staged,
    HandingOver,
    RunningExperiment,
    Readback,
    Promoted,
    RolledBack,
}
impl Phase {
    pub fn at_rest(self) -> bool {
        matches!(self, Self::Idle | Self::Promoted | Self::RolledBack)
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Slot {
    Stable,
    Experiment,
}
impl Slot {
    pub fn name(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Experiment => "experiment",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub version: String,
    pub pid: u32,
    pub start_id: String,
}
impl Evidence {
    pub fn validate(&self) -> Result<()> {
        if self.version.is_empty()
            || self.start_id.is_empty()
            || self.pid == 0
            || self.pid == std::process::id()
        {
            return Err(invalid("HOST_EVIDENCE_INVALID"));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub seq: u64,
    pub timestamp_ms: u64,
    pub intent: Phase,
    pub detail: BTreeMap<String, String>,
}
impl JournalEntry {
    pub fn validate(&self) -> Result<()> {
        if self.detail.get("formatVersion").map(String::as_str) != Some("1") {
            return Err(invalid("unsupported journal format"));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Provenance {
    pub who: String,
    pub carrier: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OperationPhase {
    Checking,
    Downloading,
    Verifying,
    Staging,
    HandingOver,
    Probing,
    Recovering,
    Promoted,
    RolledBack,
    Held,
    UpToDate,
    Failed,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    Promoted,
    RolledBack,
    Held,
    UpToDate,
    Failed,
}
impl Outcome {
    pub fn phase(self) -> OperationPhase {
        match self {
            Self::Promoted => OperationPhase::Promoted,
            Self::RolledBack => OperationPhase::RolledBack,
            Self::Held => OperationPhase::Held,
            Self::UpToDate => OperationPhase::UpToDate,
            Self::Failed => OperationPhase::Failed,
        }
    }
    pub fn exit_code(self) -> u8 {
        match self {
            Self::Promoted | Self::UpToDate => 0,
            Self::Held => 2,
            _ => 1,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub format_version: u32,
    pub id: String,
    pub started_at_ms: u64,
    pub updated_at_ms: u64,
    pub from_version: String,
    pub target_version: String,
    pub previous_stable_version: String,
    pub phase: OperationPhase,
    #[serde(deserialize_with = "required_nullable")]
    pub outcome: Option<Outcome>,
    #[serde(deserialize_with = "required_nullable")]
    pub reason: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub provenance: Option<Provenance>,
    pub metadata: BTreeMap<String, String>,
}
impl Operation {
    pub fn validate(&self) -> Result<()> {
        if self.format_version != 1 || self.id.is_empty() {
            return Err(invalid("operation record has an invalid shape"));
        }
        Ok(())
    }
}
// `Option` normally accepts an absent field. V1 requires the nullable fields
// to exist so a truncated or incomplete receipt cannot authorize completion.
pub(crate) fn required_nullable<'de, D, T>(
    deserializer: D,
) -> std::result::Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum OperationRead {
    Genesis,
    Observed { operation: Operation },
    Unreadable { reason: String },
}
impl OperationRead {
    pub fn exit_code(&self) -> u8 {
        match self {
            Self::Genesis => 0,
            Self::Unreadable { .. } => 1,
            Self::Observed { operation } => operation.outcome.map_or(3, Outcome::exit_code),
        }
    }
}

/// Transition metadata also drives the exhaustive crash matrix.
pub const TRANSITIONS: &[(Phase, Phase, &str)] = &[
    (Phase::Idle, Phase::Staged, "stage-experiment"),
    (Phase::Staged, Phase::HandingOver, "handover-to-experiment"),
    (
        Phase::HandingOver,
        Phase::RunningExperiment,
        "probe-experiment",
    ),
    (
        Phase::RunningExperiment,
        Phase::Readback,
        "evaluate-predicates",
    ),
    (Phase::Readback, Phase::Promoted, "promote-experiment"),
    (Phase::Staged, Phase::RolledBack, "restore-stable"),
    (Phase::HandingOver, Phase::RolledBack, "restore-stable"),
    (
        Phase::RunningExperiment,
        Phase::RolledBack,
        "restore-stable",
    ),
    (Phase::Readback, Phase::RolledBack, "restore-stable"),
];
