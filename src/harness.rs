//! Deterministic effect-boundary fault harness using the production Engine.
//! It proves model properties; real processes and platform services remain
//! separate integration gates.
use crate::{
    Error, Result,
    engine::{Engine, Predicates, VersionPredicate},
    host::Host,
    invariants::{
        BUILT_IN_INVARIANTS, LiveProcess, Ownership, Slots, WorldSnapshot, check_invariants,
        service_settles_live, workload_preserved,
    },
    state::{Evidence, JournalEntry, Phase, Slot},
    storage::Effects,
};
use async_trait::async_trait;
use serde::Serialize;
use std::{collections::BTreeMap, path::Path, sync::Mutex};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Mutation {
    #[default]
    None,
    LoseStable,
    DropJournal,
    DualRun,
    LoseWorkload,
    NeverResume,
}
struct State {
    phase: Phase,
    stable: Option<String>,
    experiment: Option<String>,
    journal: Vec<JournalEntry>,
    live: Vec<LiveProcess>,
    incarnation: u32,
    parked: bool,
    workload: String,
    boundary: usize,
    fail_at: Option<usize>,
    trace: Vec<String>,
    mutation: Mutation,
}
pub struct FakeHost {
    state: Mutex<State>,
}
impl FakeHost {
    pub fn new(version: &str) -> Self {
        Self {
            state: Mutex::new(State {
                phase: Phase::Idle,
                stable: Some(version.into()),
                experiment: None,
                journal: vec![],
                live: vec![LiveProcess {
                    slot: Slot::Stable,
                    pid: 1,
                    start_id: "boot-1".into(),
                    version: version.into(),
                }],
                incarnation: 1,
                parked: false,
                workload: "synthetic-workload".into(),
                boundary: 0,
                fail_at: None,
                trace: vec![],
                mutation: Mutation::None,
            }),
        }
    }
    pub fn inject_crash(&self, boundary: Option<usize>) {
        let mut s = self.state.lock().unwrap();
        s.boundary = 0;
        s.fail_at = boundary;
    }
    pub fn mutate(&self, mutation: Mutation) {
        self.state.lock().unwrap().mutation = mutation;
    }
    fn step(&self, label: &str) -> Result<()> {
        let mut s = self.state.lock().unwrap();
        s.boundary += 1;
        s.trace.push(label.into());
        if s.fail_at == Some(s.boundary) {
            s.fail_at = None;
            return Err(Error::Uncertain(format!("synthetic crash at {label}")));
        }
        let violations = check_invariants(&Self::snapshot_of(&s), BUILT_IN_INVARIANTS);
        if let Some(v) = violations.first() {
            return Err(Error::Uncertain(format!(
                "HARNESS_INVARIANT: {}: {}",
                v.invariant_id, v.reason
            )));
        }
        Ok(())
    }
    fn snapshot_of(s: &State) -> WorldSnapshot {
        WorldSnapshot {
            phase: s.phase,
            slots: Slots {
                stable: s.stable.clone(),
                experiment: s.experiment.clone(),
            },
            live_processes: s.live.clone(),
            journal_intents: s.journal.iter().map(|e| e.intent).collect(),
            workload_digest: Some(s.workload.clone()),
            prior_incarnation_start_id: None,
            install_ownership: Some(Ownership::SelfOwned),
        }
    }
    pub fn snapshot(&self) -> WorldSnapshot {
        Self::snapshot_of(&self.state.lock().unwrap())
    }
    pub fn trace(&self) -> Vec<String> {
        self.state.lock().unwrap().trace.clone()
    }
    pub fn parked(&self) -> bool {
        self.state.lock().unwrap().parked
    }
    pub fn boundaries(&self) -> usize {
        self.state.lock().unwrap().boundary
    }
}
#[async_trait]
impl Effects for FakeHost {
    async fn read_journal(&self) -> Result<Vec<JournalEntry>> {
        Ok(self.state.lock().unwrap().journal.clone())
    }
    async fn append(&self, entry: &JournalEntry) -> Result<()> {
        self.step("before:journal")?;
        {
            let mut s = self.state.lock().unwrap();
            if s.mutation != Mutation::DropJournal {
                s.journal.push(entry.clone());
            }
        }
        self.step("after:journal")
    }
    async fn versions(&self) -> Result<BTreeMap<String, Option<String>>> {
        let s = self.state.lock().unwrap();
        Ok(BTreeMap::from([
            ("stable".into(), s.stable.clone()),
            ("experiment".into(), s.experiment.clone()),
        ]))
    }
    async fn stage(&self, version: &str, _: &Path) -> Result<()> {
        self.step("before:stage")?;
        {
            let mut s = self.state.lock().unwrap();
            s.experiment = Some(version.into());
            s.phase = Phase::Staged;
            if s.mutation == Mutation::LoseStable {
                s.stable = None;
                s.experiment = None;
            }
        }
        self.step("after:stage")
    }
    async fn promote(&self) -> Result<()> {
        self.step("before:promote")?;
        {
            let mut s = self.state.lock().unwrap();
            if let Some(v) = s.experiment.take() {
                s.stable = Some(v);
            }
            for process in &mut s.live {
                process.slot = Slot::Stable;
            }
            s.phase = Phase::Promoted;
        }
        self.step("after:promote")
    }
    async fn clear(&self) -> Result<()> {
        self.step("before:clear")?;
        {
            let mut s = self.state.lock().unwrap();
            s.experiment = None;
            s.phase = Phase::RolledBack;
        }
        self.step("after:clear")
    }
}
#[async_trait]
impl Host for FakeHost {
    async fn quiesce(&self) -> Result<()> {
        self.step("before:quiesce")?;
        {
            let mut s = self.state.lock().unwrap();
            s.parked = true;
            s.phase = Phase::HandingOver;
        }
        self.step("after:quiesce")
    }
    async fn stop(&self, _: Slot) -> Result<()> {
        self.step("before:stop")?;
        {
            let mut s = self.state.lock().unwrap();
            if s.mutation != Mutation::DualRun {
                s.live.clear();
            }
        }
        self.step("after:stop")
    }
    async fn start(&self, slot: Slot) -> Result<()> {
        self.step("before:start")?;
        {
            let mut s = self.state.lock().unwrap();
            if s.live.iter().all(|p| p.slot != slot) {
                let version = match slot {
                    Slot::Stable => s.stable.clone(),
                    Slot::Experiment => s.experiment.clone(),
                }
                .ok_or_else(|| crate::error::invalid("missing model slot"))?;
                s.incarnation += 1;
                let pid = s.incarnation;
                s.live.push(LiveProcess {
                    slot,
                    version,
                    pid,
                    start_id: format!("boot-{pid}"),
                });
            }
        }
        self.step("after:start")
    }
    async fn probe(&self) -> Result<Evidence> {
        self.step("before:probe")?;
        let evidence = {
            let s = self.state.lock().unwrap();
            let p = s
                .live
                .first()
                .ok_or_else(|| crate::error::invalid("model service stopped"))?;
            Evidence {
                version: p.version.clone(),
                pid: p.pid,
                start_id: p.start_id.clone(),
            }
        };
        self.step("after:probe")?;
        Ok(evidence)
    }
    async fn resume(&self) -> Result<()> {
        self.step("before:resume")?;
        {
            let mut s = self.state.lock().unwrap();
            if s.mutation != Mutation::NeverResume {
                s.parked = false;
            }
            if s.mutation == Mutation::LoseWorkload {
                s.workload = "lost".into();
            }
        }
        self.step("after:resume")
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulationReceipt {
    pub seed: u32,
    pub scenario: &'static str,
    pub rounds: usize,
    pub crashes: usize,
    pub boundaries: usize,
    pub result: String,
}
struct SimulationPredicates {
    refuse: bool,
}
#[async_trait]
impl Predicates for SimulationPredicates {
    async fn evaluate(&self, evidence: &Evidence, target: &str) -> Result<Option<String>> {
        let invalid_version = VersionPredicate.evaluate(evidence, target).await?;
        Ok(invalid_version.or_else(|| self.refuse.then(|| "synthetic readback refusal".into())))
    }
}
pub async fn simulate(seed: u32, rounds: usize, mutation: Mutation) -> Result<SimulationReceipt> {
    let world = FakeHost::new("1");
    world.mutate(mutation);
    let initial = world.snapshot();
    let mut random = seed.max(1);
    let predicates = SimulationPredicates {
        refuse: seed % 5 == 0,
    };
    let mut crashes = 0;
    let mut boundaries = 0;
    for round in 0..rounds {
        random ^= random << 13;
        random ^= random >> 17;
        random ^= random << 5;
        let crash_at = (random % 44) as usize;
        world.inject_crash((crash_at != 0).then_some(crash_at));
        let mut engine = Engine::new(&world, &world, &predicates, &|| 1, 1000)?;
        let attempt = async {
            engine.recover().await?;
            engine
                .upgrade(&(round + 2).to_string(), Path::new("synthetic-artifact"))
                .await
        }
        .await;
        if let Err(error) = attempt {
            if !error.to_string().starts_with("synthetic crash") {
                return Err(error);
            }
            crashes += 1;
        }
        boundaries += world.boundaries();
        world.inject_crash(None);
        let mut recovery = Engine::new(&world, &world, &predicates, &|| 2, 1000)?;
        recovery.recover().await?;
        let snapshot = world.snapshot();
        if world.parked() {
            return Err(crate::error::invalid(
                "HARNESS_PARKED: recovery did not resume",
            ));
        }
        if let Some(reason) =
            workload_preserved(&initial, &snapshot).or_else(|| service_settles_live(&[snapshot], 1))
        {
            return Err(crate::error::invalid(reason));
        }
    }
    Ok(SimulationReceipt {
        seed,
        scenario: if predicates.refuse {
            "predicate-rollback"
        } else {
            "promote"
        },
        rounds,
        crashes,
        boundaries,
        result: "pass".into(),
    })
}
