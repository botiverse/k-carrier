use k_carrier::{
    Result,
    state::*,
    storage::{Effects, FileStore, now_ms},
};
use std::{collections::BTreeMap, fs, io::Write};
use tempfile::tempdir;

fn entry(seq: u64, phase: Phase) -> JournalEntry {
    JournalEntry {
        seq,
        timestamp_ms: 1,
        intent: phase,
        detail: BTreeMap::from([("formatVersion".into(), "1".into())]),
    }
}
#[tokio::test]
async fn torn_tail_is_repaired_but_complete_corruption_and_new_formats_fail_closed() -> Result<()> {
    let root = tempdir()?;
    let store = FileStore::new(root.path());
    store.append(&entry(0, Phase::Idle)).await?;
    let path = root.path().join("journal.jsonl");
    let mut f = fs::OpenOptions::new().append(true).open(&path)?;
    f.write_all(b"{\"seq\":1,")?;
    assert_eq!(store.read_journal().await?.len(), 1);
    store.append(&entry(1, Phase::Staged)).await?;
    assert_eq!(store.read_journal().await?.len(), 2);
    let good = fs::read(&path)?;
    fs::write(&path, b"{bad}\n")?;
    assert!(store.read_journal().await.is_err());
    fs::write(
        &path,
        String::from_utf8(good)
            .unwrap()
            .replace("\"formatVersion\":\"1\"", "\"formatVersion\":\"2\""),
    )?;
    assert!(store.read_journal().await.is_err());
    Ok(())
}
#[tokio::test]
async fn slots_redo_interrupted_promotion_without_losing_last_copy() -> Result<()> {
    let root = tempdir()?;
    let store = FileStore::new(root.path().join("state"));
    let source = root.path().join("binary");
    fs::write(&source, b"old")?;
    assert!(store.bootstrap_locked("1", &source)?);
    assert!(!store.bootstrap_locked("0", &source)?);
    fs::write(&source, b"new")?;
    store.stage("2", &source).await?;
    fs::rename(
        store.slot(Slot::Stable),
        store.root.join("slots/stable.old"),
    )?;
    store.promote().await?;
    store.promote().await?;
    assert_eq!(store.version(Slot::Stable)?.as_deref(), Some("2"));
    assert_eq!(fs::read(store.artifact(Slot::Stable))?, b"new");
    assert_eq!(store.version(Slot::Experiment)?, None);
    assert!(!store.root.join("slots/stable.old").exists());
    Ok(())
}
#[test]
fn bootstrap_refuses_partial_or_active_state() -> Result<()> {
    let root = tempdir()?;
    let store = FileStore::new(root.path());
    let source = root.path().join("source");
    fs::write(&source, b"trusted")?;
    fs::write(root.path().join("journal.jsonl"), "")?;
    assert!(store.bootstrap_locked("1", &source).is_err());
    assert!(!store.slot(Slot::Stable).exists());
    fs::remove_file(root.path().join("journal.jsonl"))?;
    fs::create_dir_all(store.slot(Slot::Stable))?;
    assert!(store.bootstrap_locked("1", &source).is_err());
    Ok(())
}
#[test]
fn receipt_roundtrip_archive_conflict_and_future_format() -> Result<()> {
    let root = tempdir()?;
    let store = FileStore::new(root.path());
    let op = Operation {
        format_version: 1,
        id: "test-request".into(),
        started_at_ms: now_ms(),
        updated_at_ms: now_ms(),
        from_version: "1".into(),
        target_version: "2".into(),
        previous_stable_version: "1".into(),
        phase: OperationPhase::Promoted,
        outcome: Some(Outcome::Promoted),
        reason: None,
        provenance: Some(Provenance {
            who: "test".into(),
            carrier: "fixture".into(),
        }),
        metadata: BTreeMap::new(),
    };
    store.persist_operation(&op)?;
    store.archive(&op)?;
    store.archive(&op)?;
    assert_eq!(
        store.read_operation(),
        OperationRead::Observed {
            operation: op.clone()
        }
    );
    assert_eq!(store.read_archive(&op.id), store.read_operation());
    let mut bad = op.clone();
    bad.target_version = "3".into();
    assert!(store.archive(&bad).is_err());
    bad.format_version = 2;
    assert!(store.persist_operation(&bad).is_err());
    fs::write(
        root.path().join("operation.json"),
        serde_json::to_vec(&bad)?,
    )?;
    assert!(matches!(
        store.read_operation(),
        OperationRead::Unreadable { .. }
    ));
    Ok(())
}
