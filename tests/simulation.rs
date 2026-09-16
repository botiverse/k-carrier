use k_carrier::{
    Result,
    engine::{Engine, VersionPredicate},
    harness::{FakeHost, Mutation, simulate},
    invariants::{service_settles_live, workload_preserved},
};
use std::path::Path;

#[tokio::test]
async fn every_crash_boundary_recovers_and_seeded_schedules_replay() -> Result<()> {
    let world = FakeHost::new("1");
    let mut engine = Engine::new(&world, &world, &VersionPredicate, &|| 1, 1000)?;
    engine.recover().await?;
    engine.upgrade("2", Path::new("synthetic")).await?;
    let count = world.boundaries();
    assert!(count > 20);
    for boundary in 1..=count {
        let world = FakeHost::new("1");
        let initial = world.snapshot();
        world.inject_crash(Some(boundary));
        let mut engine = Engine::new(&world, &world, &VersionPredicate, &|| 1, 1000)?;
        engine.recover().await?;
        assert!(
            engine.upgrade("2", Path::new("synthetic")).await.is_err(),
            "boundary {boundary}"
        );
        world.inject_crash(None);
        let mut recovery = Engine::new(&world, &world, &VersionPredicate, &|| 2, 1000)?;
        recovery.recover().await?;
        let after = world.snapshot();
        assert!(workload_preserved(&initial, &after).is_none());
        assert!(service_settles_live(&[after], 1).is_none());
        assert!(!world.parked());
    }
    for seed in 0..256 {
        let first = simulate(seed, 20, Mutation::None).await?;
        let replay = simulate(seed, 20, Mutation::None).await?;
        assert_eq!(serde_json::to_value(first)?, serde_json::to_value(replay)?);
    }
    Ok(())
}
#[tokio::test]
async fn fault_harness_catches_its_own_safety_and_liveness_mutations() {
    for mutation in [
        Mutation::LoseStable,
        Mutation::DropJournal,
        Mutation::DualRun,
        Mutation::LoseWorkload,
        Mutation::NeverResume,
    ] {
        let mut detected = false;
        for seed in 1..=32 {
            if simulate(seed, 4, mutation).await.is_err() {
                detected = true;
                break;
            }
        }
        assert!(detected, "surviving mutation {mutation:?}");
    }
}
