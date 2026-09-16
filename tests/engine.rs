use async_trait::async_trait;
use k_carrier::{
    Error, Result,
    engine::{Engine, EngineOutcome, VersionPredicate},
    host::Host,
    state::*,
    storage::{Effects, FileStore, now_ms},
};
use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tempfile::tempdir;

struct World {
    store: FileStore,
    trace: Mutex<Vec<String>>,
    running: Mutex<Option<Slot>>,
    parked: AtomicBool,
    incarnation: AtomicUsize,
    stale: AtomicBool,
    hang: AtomicBool,
    crash_at: AtomicUsize,
    effect: AtomicUsize,
}
impl World {
    fn step(&self, label: &str) -> Result<()> {
        self.trace.lock().unwrap().push(label.into());
        let i = self.effect.fetch_add(1, Ordering::SeqCst) + 1;
        if self.crash_at.load(Ordering::SeqCst) == i {
            return Err(Error::Uncertain("synthetic worker crash".into()));
        }
        Ok(())
    }
}
#[async_trait]
impl Effects for World {
    async fn read_journal(&self) -> Result<Vec<JournalEntry>> {
        self.store.read_journal().await
    }
    async fn append(&self, entry: &JournalEntry) -> Result<()> {
        self.step(&format!("before-journal:{:?}", entry.intent))?;
        self.store.append(entry).await?;
        self.step(&format!("journal:{:?}", entry.intent))
    }
    async fn versions(&self) -> Result<BTreeMap<String, Option<String>>> {
        self.store.versions().await
    }
    async fn stage(&self, v: &str, p: &Path) -> Result<()> {
        self.step("before-stage")?;
        self.store.stage(v, p).await?;
        self.step("stage")
    }
    async fn promote(&self) -> Result<()> {
        self.step("before-promote")?;
        self.store.promote().await?;
        self.step("promote")
    }
    async fn clear(&self) -> Result<()> {
        self.step("before-clear")?;
        self.store.clear().await?;
        self.step("clear")
    }
}
#[async_trait]
impl Host for World {
    async fn quiesce(&self) -> Result<()> {
        self.step("before-quiesce")?;
        self.parked.store(true, Ordering::SeqCst);
        self.step("quiesce")
    }
    async fn stop(&self, _: Slot) -> Result<()> {
        self.step("before-stop")?;
        *self.running.lock().unwrap() = None;
        self.step("stop")
    }
    async fn start(&self, slot: Slot) -> Result<()> {
        self.step("before-start")?;
        let mut running = self.running.lock().unwrap();
        // Redo start of the already-live stable instance is idempotent.
        if running.is_some() && *running != Some(slot) {
            return Err(Error::Invalid("dual-run".into()));
        }
        if running.is_none() {
            self.incarnation.fetch_add(1, Ordering::SeqCst);
        }
        *running = Some(slot);
        drop(running);
        self.step("start")
    }
    async fn probe(&self) -> Result<Evidence> {
        if self.hang.load(Ordering::SeqCst) {
            std::future::pending::<()>().await;
        }
        self.step("probe")?;
        let slot = self
            .running
            .lock()
            .unwrap()
            .ok_or_else(|| Error::Invalid("not running".into()))?;
        Ok(Evidence {
            version: self.store.version(slot)?.unwrap(),
            pid: 42,
            start_id: if self.stale.load(Ordering::SeqCst) {
                "old".into()
            } else {
                self.incarnation.load(Ordering::SeqCst).to_string()
            },
        })
    }
    async fn resume(&self) -> Result<()> {
        self.step("before-resume")?;
        self.parked.store(false, Ordering::SeqCst);
        self.step("resume")
    }
}
fn setup(root: &Path) -> Result<Arc<World>> {
    let store = FileStore::new(root.join("state"));
    fs::write(root.join("old"), b"old")?;
    fs::write(root.join("new"), b"new")?;
    store.bootstrap_locked("1", &root.join("old"))?;
    Ok(Arc::new(World {
        store,
        trace: Mutex::new(vec![]),
        running: Mutex::new(Some(Slot::Stable)),
        parked: AtomicBool::new(false),
        incarnation: AtomicUsize::new(1),
        stale: AtomicBool::new(false),
        hang: AtomicBool::new(false),
        crash_at: AtomicUsize::new(0),
        effect: AtomicUsize::new(0),
    }))
}
#[tokio::test]
async fn promote_requires_wal_and_fresh_live_incarnation() -> Result<()> {
    let root = tempdir()?;
    let w = setup(root.path())?;
    let mut engine = Engine::new(&*w, &*w, &VersionPredicate, &now_ms, 1000)?;
    engine.recover().await?;
    assert_eq!(
        engine.upgrade("2", &root.path().join("new")).await?,
        EngineOutcome::Promoted("2".into())
    );
    let trace = w.trace.lock().unwrap().clone();
    for (intent, action) in [
        ("journal:Staged", "stage"),
        ("journal:HandingOver", "quiesce"),
        ("journal:Promoted", "promote"),
    ] {
        assert!(
            trace.iter().position(|x| x == intent).unwrap()
                < trace.iter().position(|x| x == action).unwrap()
        );
    }
    assert_eq!(w.store.version(Slot::Stable)?.as_deref(), Some("2"));
    assert!(!w.parked.load(Ordering::SeqCst));
    let root2 = tempdir()?;
    let w = setup(root2.path())?;
    w.stale.store(true, Ordering::SeqCst);
    let mut engine = Engine::new(&*w, &*w, &VersionPredicate, &now_ms, 1000)?;
    engine.recover().await?;
    assert!(matches!(
        engine.upgrade("2", &root2.path().join("new")).await?,
        EngineOutcome::RolledBack(_)
    ));
    assert_eq!(w.store.version(Slot::Stable)?.as_deref(), Some("1"));
    assert_eq!(*w.running.lock().unwrap(), Some(Slot::Stable));
    Ok(())
}
#[tokio::test]
async fn every_upgrade_effect_boundary_recovers_from_durable_intent() -> Result<()> {
    let baseline = tempdir()?;
    let w = setup(baseline.path())?;
    let mut e = Engine::new(&*w, &*w, &VersionPredicate, &now_ms, 1000)?;
    e.recover().await?;
    e.upgrade("2", &baseline.path().join("new")).await?;
    let count = w.effect.load(Ordering::SeqCst);
    assert!(count > 20);
    for point in 1..=count {
        let root = tempdir()?;
        let w = setup(root.path())?;
        w.crash_at.store(point, Ordering::SeqCst);
        let mut e = Engine::new(&*w, &*w, &VersionPredicate, &now_ms, 1000)?;
        e.recover().await?;
        assert!(
            e.upgrade("2", &root.path().join("new")).await.is_err(),
            "missed boundary {point}"
        );
        w.crash_at.store(0, Ordering::SeqCst);
        let committed = w
            .store
            .read_journal()
            .await?
            .last()
            .is_some_and(|e| e.intent == Phase::Promoted);
        let mut successor = Engine::new(&*w, &*w, &VersionPredicate, &now_ms, 1000)?;
        successor.recover().await?;
        assert_eq!(
            w.store.version(Slot::Stable)?.as_deref(),
            Some(if committed { "2" } else { "1" }),
            "boundary {point}"
        );
        assert_eq!(w.store.version(Slot::Experiment)?, None, "boundary {point}");
        assert!(!w.parked.load(Ordering::SeqCst), "boundary {point}");
        assert!(w.running.lock().unwrap().is_some(), "boundary {point}");
    }
    Ok(())
}
#[tokio::test]
async fn hung_probe_is_uncertain_and_cannot_start_handover() -> Result<()> {
    let root = tempdir()?;
    let w = setup(root.path())?;
    w.hang.store(true, Ordering::SeqCst);
    let mut e = Engine::new(&*w, &*w, &VersionPredicate, &now_ms, 10)?;
    e.recover().await?;
    assert!(
        e.upgrade("2", &root.path().join("new"))
            .await
            .unwrap_err()
            .is_uncertain()
    );
    assert!(w.store.read_journal().await?.is_empty());
    assert_eq!(*w.running.lock().unwrap(), Some(Slot::Stable));
    Ok(())
}
