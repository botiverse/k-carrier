use crate::state::Phase;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Stage {
    Checking,
    Downloading,
    Verifying,
    Staging,
    HandingOver,
    Probing,
    Promoted,
    RolledBack,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpgradeProgress {
    pub stage: Stage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Bytes on disk, including any verified resumable partial.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloaded: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
}
pub fn stage_for_phase(phase: Phase) -> Option<Stage> {
    match phase {
        Phase::Idle => None,
        Phase::Staged => Some(Stage::Staging),
        Phase::HandingOver => Some(Stage::HandingOver),
        Phase::RunningExperiment | Phase::Readback => Some(Stage::Probing),
        Phase::Promoted => Some(Stage::Promoted),
        Phase::RolledBack => Some(Stage::RolledBack),
    }
}
