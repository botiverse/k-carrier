//! Migration-only compatibility against the previous Node implementation.
use k_carrier::{Result, lock::UpgradeLock, state::*, storage::FileStore};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader},
    process::{Command, Stdio},
};
use tempfile::tempdir;

#[test]
fn receipts_reports_and_provenance_roundtrip_through_legacy_typescript() -> Result<()> {
    use k_carrier::report::{ConvergenceReport, PredicateResult, ProvenanceRead, ReportRead};
    let root = tempdir()?;
    let store = FileStore::new(root.path());
    let op = Operation {
        format_version: 1,
        id: "interop".into(),
        started_at_ms: 1,
        updated_at_ms: 2,
        from_version: "1".into(),
        target_version: "2".into(),
        previous_stable_version: "1".into(),
        phase: OperationPhase::Promoted,
        outcome: Some(Outcome::Promoted),
        reason: None,
        provenance: None,
        metadata: BTreeMap::new(),
    };
    store.persist_operation(&op)?;
    store.persist_report(&ConvergenceReport {
        version: "2".into(),
        binary_at_target: PredicateResult {
            passed: true,
            source: "host.healthProbe".into(),
            observed_at_ms: 2,
            detail: BTreeMap::new(),
        },
        host_lifecycle_converged: None,
    })?;
    store.append_provenance(
        &Provenance {
            who: "rust".into(),
            carrier: "fixture".into(),
        },
        "2",
        None,
    )?;
    let script = r#"
import assert from 'node:assert/strict';
import {loadOperation,persistOperation} from './core/src/operation.ts';
import {loadLastReport,persistReport} from './core/src/status/reportStore.ts';
import {fileProvenanceJournal} from './core/src/provenance/journal.ts';
const root=process.env.K_TEST_ROOT;
const op=await loadOperation(root);assert.equal(op.kind,'observed');assert.equal(op.operation.outcome,'promoted');
await persistOperation(root,{...op.operation,metadata:{writtenBy:'typescript'}});
const report=await loadLastReport(root);assert.equal(report.kind,'observed');assert.equal(report.report.hostLifecycleConverged,null);
await persistReport(root,{...report.report,version:'legacy-roundtrip'});
const provenance=fileProvenanceJournal(root);const read=await provenance.read();assert.equal(read.kind,'observed');assert.equal(read.entries[0].who,'rust');
await provenance.append({who:'typescript',carrier:'fixture',version:'3'});
"#;
    let output = Command::new("node")
        .args(["--input-type=module", "-e", script])
        .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("legacy"))
        .env("K_TEST_ROOT", root.path())
        .output()?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        matches!(store.read_operation(), OperationRead::Observed { operation } if operation.metadata.get("writtenBy").map(String::as_str)==Some("typescript"))
    );
    assert!(
        matches!(store.read_report(), ReportRead::Observed { report } if report.version=="legacy-roundtrip")
    );
    assert!(
        matches!(store.read_provenance(), ProvenanceRead::Observed { entries } if entries.len()==2 && entries[1].who=="typescript" && entries[1].seq==1)
    );
    Ok(())
}

#[test]
fn rust_and_typescript_locks_exclude_each_other_and_recover_dead_owner() -> Result<()> {
    let root = tempdir()?;
    let script = "import {acquireUpgradeLock} from './core/src/txn/lock.ts'; const lock=await acquireUpgradeLock(process.env.K_TEST_ROOT,Date.now()); console.log('acquired'); process.stdin.resume(); process.stdin.on('data',async()=>{await lock.release();process.exit(0)});";
    let spawn = || {
        Command::new("node")
            .args(["--input-type=module", "-e", script])
            .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("legacy"))
            .env("K_TEST_ROOT", root.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
    };
    let mut lock = UpgradeLock::acquire(root.path())?;
    let mut denied = spawn()?;
    assert!(!denied.wait()?.success());
    lock.release()?;
    let mut child = spawn()?;
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut line)?;
    assert_eq!(line.trim(), "acquired");
    let refused = UpgradeLock::acquire(root.path());
    child.kill()?;
    child.wait()?;
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
