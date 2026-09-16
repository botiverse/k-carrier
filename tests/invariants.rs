use k_carrier::{
    invariants::*,
    state::{Phase, Slot},
};
fn healthy() -> WorldSnapshot {
    WorldSnapshot {
        phase: Phase::Idle,
        slots: Slots {
            stable: Some("1".into()),
            experiment: None,
        },
        live_processes: vec![LiveProcess {
            slot: Slot::Stable,
            pid: 42,
            start_id: "boot".into(),
            version: "1".into(),
        }],
        journal_intents: vec![],
        workload_digest: Some("jobs".into()),
        prior_incarnation_start_id: None,
        install_ownership: Some(Ownership::SelfOwned),
    }
}
#[test]
fn every_safety_oracle_rejects_its_specific_mutation() {
    let base = healthy();
    assert!(check_invariants(&base, BUILT_IN_INVARIANTS).is_empty());
    let mutations: [fn(&mut WorldSnapshot); 6] = [
        |s| s.live_processes.push(s.live_processes[0].clone()),
        |s| s.slots.stable = None,
        |s| s.live_processes[0].version = "wrong".into(),
        |s| s.phase = Phase::Staged,
        |s| {
            s.phase = Phase::Promoted;
            s.journal_intents.push(Phase::Promoted);
            s.slots.experiment = Some("2".into());
        },
        |s| {
            s.phase = Phase::Staged;
            s.journal_intents.push(Phase::Staged);
            s.install_ownership = Some(Ownership::ManagedElsewhere);
        },
    ];
    for (oracle, mutate) in BUILT_IN_INVARIANTS.iter().zip(mutations) {
        let mut bad = base.clone();
        mutate(&mut bad);
        assert!(
            (oracle.check)(&bad).is_some(),
            "oracle {} survived its mutation",
            oracle.id
        );
    }
    assert_eq!(
        BUILT_IN_INVARIANTS[0].assumes,
        &[HostAssumption::ExclusiveHandoff]
    );
}
#[test]
fn safety_cannot_substitute_for_liveness_and_workload_contracts() {
    let before = healthy();
    let mut dead = before.clone();
    dead.live_processes.clear();
    assert!(check_invariants(&dead, BUILT_IN_INVARIANTS).is_empty());
    assert!(service_settles_live(&[dead.clone()], 1).is_some());
    assert!(service_settles_live(&[dead, before.clone()], 2).is_none());
    assert!(reaches_terminal_within(&[Phase::Staged; 5], 5).is_some());
    assert!(reaches_terminal_within(&[Phase::Staged, Phase::Promoted], 2).is_none());
    let mut changed = before.clone();
    changed.workload_digest = Some("lost".into());
    assert!(workload_preserved(&before, &changed).is_some());
    changed.workload_digest = None;
    assert!(workload_preserved(&before, &changed).is_none());
}
