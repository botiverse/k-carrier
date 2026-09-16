//! Fixed v1 records and real-process locking, independent of any old runtime.
use k_carrier::{
    Result, lock::UpgradeLock, report::ReportRead, state::OperationRead, storage::FileStore,
};
use std::{
    fs,
    io::{BufRead, BufReader},
    process::{Command, Stdio},
};
use tempfile::tempdir;

#[test]
fn fixed_v1_records_remain_readable_and_require_nullable_fields() -> Result<()> {
    let root = tempdir()?;
    let store = FileStore::new(root.path());
    let receipt = r#"{"formatVersion":1,"id":"v1-fixture","startedAtMs":1,"updatedAtMs":2,"fromVersion":"1","targetVersion":"2","previousStableVersion":"1","phase":"promoted","outcome":"promoted","reason":null,"provenance":null,"metadata":{}}"#;
    fs::write(root.path().join("operation.json"), receipt)?;
    let OperationRead::Observed { operation } = store.read_operation() else {
        panic!("v1 receipt rejected")
    };
    store.archive(&operation)?;
    assert_eq!(store.read_archive("v1-fixture"), store.read_operation());
    fs::write(
        root.path().join("provenance.jsonl"),
        "{\"seq\":0,\"who\":\"fixture\",\"carrier\":\"manual\",\"version\":\"2\",\"when\":2}\n",
    )?;
    let next = store.append_provenance(
        &k_carrier::state::Provenance {
            who: "native".into(),
            carrier: "fixture".into(),
        },
        "3",
        None,
    )?;
    assert_eq!(next.seq, 1);
    assert!(
        matches!(store.read_provenance(), k_carrier::report::ProvenanceRead::Observed { entries } if entries.len() == 2 && entries[0].who == "fixture")
    );
    store.persist_operation(&operation)?;
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&fs::read(
            root.path().join("operation.json")
        )?)?,
        serde_json::from_str::<serde_json::Value>(receipt)?
    );
    let report = r#"{"version":"2","binaryAtTarget":{"passed":true,"source":"host.healthProbe","observedAtMs":2,"detail":{}},"hostLifecycleConverged":null}"#;
    fs::write(root.path().join("report.json"), report)?;
    assert!(
        matches!(store.read_report(), ReportRead::Observed { report } if report.host_lifecycle_converged.is_none())
    );
    fs::write(
        root.path().join("report.json"),
        report.replace(",\"hostLifecycleConverged\":null", ""),
    )?;
    assert!(matches!(store.read_report(), ReportRead::Unreadable { .. }));
    fs::write(
        root.path().join("operation.json"),
        receipt.replace(",\"reason\":null", ""),
    )?;
    assert!(matches!(
        store.read_operation(),
        OperationRead::Unreadable { .. }
    ));
    Ok(())
}

#[test]
fn processes_exclude_each_other_and_reclaim_dead_owner() -> Result<()> {
    let root = tempdir()?;
    fs::write(
        root.path().join("upgrade.lock"),
        format!("{{\"pid\":{},\"acquiredAtMs\":1}}", std::process::id()),
    )?;
    assert!(matches!(
        UpgradeLock::acquire(root.path()),
        Err(k_carrier::Error::Locked(_))
    ));
    fs::remove_file(root.path().join("upgrade.lock"))?;
    let spawn = || {
        Command::new(env!("CARGO_BIN_EXE_k-test-fixture"))
            .arg("--hold-lock")
            .env("K_FIXTURE_ROOT", root.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
    };
    let mut lock = UpgradeLock::acquire(root.path())?;
    let mut denied = spawn()?;
    assert!(!denied.wait()?.success());
    lock.release()?;
    let mut owner = spawn()?;
    let mut line = String::new();
    let ready = BufReader::new(owner.stdout.take().unwrap()).read_line(&mut line);
    let refused = UpgradeLock::acquire(root.path());
    // Reap our child before assertions, including the failure path.
    let _ = owner.kill();
    owner.wait()?;
    ready?;
    assert_eq!(line.trim(), "acquired");
    assert!(matches!(refused, Err(k_carrier::Error::Locked(_))));
    let mut recovered = UpgradeLock::acquire(root.path())?;
    recovered.release()?;
    assert!(!root.path().join("upgrade.lock").exists());
    assert_eq!(
        fs::read_dir(root.path().join("upgrade.lock.claims"))?.count(),
        0
    );
    Ok(())
}
