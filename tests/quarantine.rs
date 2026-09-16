use k_carrier::{
    Result,
    lock::UpgradeLock,
    quarantine::{Status, quarantine_state},
    state::{Operation, OperationPhase},
    storage::FileStore,
};
use std::{collections::BTreeMap, fs};
use tempfile::tempdir;

#[test]
fn quarantine_preserves_bytes_and_is_idempotent_without_replacing_a_destination() -> Result<()> {
    let temp = tempdir()?;
    let root = temp.path().join("state");
    let dest = temp.path().join("audit");
    assert_eq!(
        quarantine_state(&root, &dest, 1, false, None)?.status,
        Status::NotFound
    );
    fs::create_dir(&root)?;
    fs::write(root.join("artifact"), b"synthetic artifact")?;
    let moved = quarantine_state(&root, &dest, 2, false, None)?;
    assert_eq!(moved.status, Status::Quarantined);
    assert!(!root.exists());
    assert_eq!(fs::read(dest.join("artifact"))?, b"synthetic artifact");
    let repeat = quarantine_state(&root, &dest, 3, false, None)?;
    assert_eq!(repeat.status, Status::AlreadyQuarantined);
    assert_eq!(repeat.receipt.timestamp_ms, 2);
    fs::create_dir(&root)?;
    fs::write(root.join("new"), b"new install")?;
    assert!(quarantine_state(&root, &dest, 4, false, None).is_err());
    assert_eq!(fs::read(root.join("new"))?, b"new install");
    Ok(())
}
#[test]
fn active_lock_unreadable_state_and_unproven_handoff_cannot_be_quarantined() -> Result<()> {
    let temp = tempdir()?;
    let root = temp.path().join("state");
    let dest = temp.path().join("audit");
    let mut lock = UpgradeLock::acquire(&root)?;
    assert!(quarantine_state(&root, &dest, 1, true, Some(&|| Ok(()))).is_err());
    lock.release()?;
    fs::write(root.join("operation.json"), b"{corrupt")?;
    assert!(quarantine_state(&root, &dest, 1, false, None).is_err());
    let operation = Operation {
        format_version: 1,
        id: "test-op".into(),
        started_at_ms: 1,
        updated_at_ms: 1,
        from_version: "1".into(),
        target_version: "2".into(),
        previous_stable_version: "1".into(),
        phase: OperationPhase::Checking,
        outcome: None,
        reason: None,
        provenance: None,
        metadata: BTreeMap::new(),
    };
    FileStore::new(&root).persist_operation(&operation)?;
    assert!(quarantine_state(&root, &dest, 2, false, None).is_err());
    assert!(
        quarantine_state(
            &root,
            &dest,
            2,
            false,
            Some(&|| Err(k_carrier::error::invalid("host unsafe")))
        )
        .is_err()
    );
    let result = quarantine_state(
        &root,
        &dest,
        2,
        false,
        Some(&|| {
            assert!(
                UpgradeLock::acquire(&root).is_err(),
                "handoff must run under K lock"
            );
            Ok(())
        }),
    )?;
    assert_eq!(result.receipt.operation_id, "test-op");
    Ok(())
}
#[test]
fn unreadable_opt_in_preserves_corruption_and_rejects_descendant_aliases() -> Result<()> {
    let temp = tempdir()?;
    let root = temp.path().join("state");
    fs::create_dir(&root)?;
    fs::write(root.join("operation.json"), b"{corrupt")?;
    assert!(quarantine_state(&root, &root.join("audit"), 1, true, None).is_err());
    #[cfg(unix)]
    {
        let alias = temp.path().join("alias");
        std::os::unix::fs::symlink(&root, &alias)?;
        assert!(quarantine_state(&root, &alias.join("audit"), 1, true, None).is_err());
    }
    let dest = temp.path().join("audit");
    quarantine_state(&root, &dest, 1, true, None)?;
    assert_eq!(fs::read(dest.join("operation.json"))?, b"{corrupt");
    Ok(())
}
