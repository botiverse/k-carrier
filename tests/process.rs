use k_carrier::{
    Result,
    host::{CommandHost, Host},
    protocol::Request,
    supervisor::{LaunchOptions, resume_runner, supervise_bytes},
};
use std::{collections::BTreeMap, fs, time::Duration};
use tempfile::tempdir;
fn fixture() -> &'static str {
    env!("CARGO_BIN_EXE_k-test-fixture")
}
#[tokio::test]
async fn native_controller_protocol_and_timeout_leave_no_process_records() -> Result<()> {
    let root = tempdir()?;
    let mut host = CommandHost::new(
        vec![fixture().into(), "--controller".into()],
        root.path().join("state"),
        3000,
    )?;
    host.cwd = Some(root.path().into());
    host.fence().await?;
    host.quiesce().await?;
    let evidence = host.probe().await?;
    assert_eq!(evidence.version, "2");
    assert_eq!(
        fs::read_dir(root.path().join("state/controllers"))?.count(),
        0
    );
    host.timeout = Duration::from_millis(100);
    fs::write(root.path().join("probe-hang"), b"fixture")?;
    assert!(host.probe().await.unwrap_err().is_uncertain());
    assert_eq!(
        fs::read_dir(root.path().join("state/controllers"))?.count(),
        0
    );
    fs::remove_file(root.path().join("probe-hang"))?;
    fs::write(root.path().join("large-output"), b"fixture")?;
    assert!(host.probe().await.unwrap_err().is_uncertain());
    Ok(())
}
#[tokio::test]
async fn real_worker_sigkill_recovers_only_with_bound_receipt() -> Result<()> {
    let root = tempdir()?;
    let bytes = fs::read(fixture())?;
    let options = LaunchOptions {
        execution_ms: 5000,
        recovery_ms: 5000,
        total_ms: 12000,
        recovery_attempts: 2,
        env: BTreeMap::from([
            (
                "K_FIXTURE_ROOT".into(),
                root.path().to_string_lossy().into_owned(),
            ),
            ("K_FIXTURE_MODE".into(), "crash-first".into()),
        ]),
    };
    let request = Request::Upgrade {
        protocol_version: 1,
        id: "isolated-op".into(),
        target_version: "2".into(),
        consented: true,
    };
    let result = supervise_bytes(&bytes, &request, &root.path().join("scratch"), &options).await?;
    assert_eq!(result.exit_code, 1);
    assert_eq!(result.attempts, 2);
    assert!(result.recovery_file.is_none());
    assert!(result.error.is_none());
    assert_eq!(fs::read_to_string(root.path().join("attempts"))?, "2");
    assert_eq!(fs::read_dir(root.path().join("scratch"))?.count(), 0);
    Ok(())
}
#[tokio::test]
async fn mismatched_receipts_are_unresolved_and_offline_recovery_verifies_bytes() -> Result<()> {
    let root = tempdir()?;
    let bytes = fs::read(fixture())?;
    let mut options = LaunchOptions {
        execution_ms: 5000,
        recovery_ms: 5000,
        total_ms: 12000,
        recovery_attempts: 1,
        env: BTreeMap::from([
            (
                "K_FIXTURE_ROOT".into(),
                root.path().to_string_lossy().into_owned(),
            ),
            ("K_FIXTURE_MODE".into(), "lie".into()),
        ]),
    };
    let request = Request::Upgrade {
        protocol_version: 1,
        id: "isolated-op".into(),
        target_version: "2".into(),
        consented: true,
    };
    let result = supervise_bytes(&bytes, &request, &root.path().join("scratch"), &options).await?;
    assert_eq!(result.exit_code, 3);
    assert_eq!(result.attempts, 2);
    let descriptor = result.recovery_file.unwrap();
    assert!(descriptor.exists());
    let original = fs::read(&descriptor)?;
    let mut altered: serde_json::Value = serde_json::from_slice(&original)?;
    altered["sha256"] = serde_json::json!("0".repeat(64));
    fs::write(&descriptor, serde_json::to_vec(&altered)?)?;
    assert!(
        resume_runner(&descriptor, &options)
            .await
            .unwrap_err()
            .to_string()
            .contains("RECOVERY_ARTIFACT_MISMATCH")
    );
    fs::write(&descriptor, original)?;
    options
        .env
        .insert("K_FIXTURE_MODE".into(), "healthy".into());
    let resumed = resume_runner(&descriptor, &options).await?;
    assert_eq!(resumed.exit_code, 1);
    assert!(resumed.recovery_file.is_none());
    assert!(!descriptor.exists());
    Ok(())
}
#[tokio::test]
async fn hung_workers_are_reaped_before_retry_and_total_work_is_bounded() -> Result<()> {
    let root = tempdir()?;
    let bytes = fs::read(fixture())?;
    let options = LaunchOptions {
        execution_ms: 2000,
        recovery_ms: 2000,
        total_ms: 5000,
        recovery_attempts: 1,
        env: BTreeMap::from([
            (
                "K_FIXTURE_ROOT".into(),
                root.path().to_string_lossy().into_owned(),
            ),
            ("K_FIXTURE_MODE".into(), "hang".into()),
        ]),
    };
    let request = Request::Upgrade {
        protocol_version: 1,
        id: "isolated-op".into(),
        target_version: "2".into(),
        consented: true,
    };
    let result = tokio::time::timeout(
        Duration::from_secs(7),
        supervise_bytes(&bytes, &request, &root.path().join("scratch"), &options),
    )
    .await
    .unwrap()?;
    assert_eq!(result.exit_code, 3);
    assert_eq!(result.attempts, 2);
    assert!(result.recovery_file.is_some());
    for pid in fs::read_to_string(root.path().join("pids"))?.lines() {
        assert!(
            !k_carrier::lock::process_alive(pid.parse().unwrap()),
            "worker must be reaped"
        );
    }
    Ok(())
}

#[tokio::test]
async fn native_controller_preserves_uncertainty_and_cannot_attest_itself() -> Result<()> {
    let root = tempdir()?;
    let mut host = CommandHost::new(
        vec![fixture().into(), "--controller".into()],
        root.path().join("state"),
        3000,
    )?;
    host.cwd = Some(root.path().into());
    fs::write(root.path().join("effect-uncertain"), b"fixture")?;
    assert!(host.probe().await.unwrap_err().is_uncertain());
    assert!(
        host.stop(k_carrier::state::Slot::Stable)
            .await
            .unwrap_err()
            .is_uncertain()
    );
    fs::remove_file(root.path().join("effect-uncertain"))?;
    fs::write(root.path().join("controller-self-evidence"), b"fixture")?;
    assert!(
        host.probe()
            .await
            .unwrap_err()
            .to_string()
            .contains("HOST_EVIDENCE_INVALID")
    );
    Ok(())
}

#[tokio::test]
async fn rejected_upgrade_is_held_without_recovering_another_writers_transaction() -> Result<()> {
    let root = tempdir()?;
    let options = LaunchOptions {
        execution_ms: 5000,
        recovery_ms: 5000,
        total_ms: 12000,
        recovery_attempts: 2,
        env: BTreeMap::from([
            (
                "K_FIXTURE_ROOT".into(),
                root.path().to_string_lossy().into_owned(),
            ),
            ("K_FIXTURE_MODE".into(), "busy".into()),
        ]),
    };
    let result = supervise_bytes(
        &fs::read(fixture())?,
        &Request::Upgrade {
            protocol_version: 1,
            id: "held".into(),
            target_version: "2".into(),
            consented: true,
        },
        &root.path().join("scratch"),
        &options,
    )
    .await?;
    assert_eq!(result.exit_code, 2);
    assert_eq!(result.attempts, 1);
    assert!(result.recovery_file.is_none());
    let recovery = supervise_bytes(
        &fs::read(fixture())?,
        &Request::Recover {
            protocol_version: 1,
            expected: Some(k_carrier::protocol::Expected {
                id: "interrupted".into(),
                target_version: "2".into(),
            }),
        },
        &root.path().join("scratch"),
        &options,
    )
    .await?;
    assert_eq!(recovery.exit_code, 3);
    assert!(recovery.recovery_file.is_some());
    Ok(())
}
