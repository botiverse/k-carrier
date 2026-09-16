use async_trait::async_trait;
use k_carrier::{
    Result,
    artifact::{Release, ReleaseContext, ReleaseSource, sha256},
    host::Host,
    protocol::Request,
    report::{ProvenanceRead, ReadbackSurface},
    runner::{Hooks, Policy, Runner},
    state::*,
    storage::FileStore,
};
use std::{
    fs,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tempfile::tempdir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
struct Source {
    url: String,
    calls: AtomicUsize,
}
#[async_trait]
impl ReleaseSource for Source {
    async fn check(&self, _: &ReleaseContext) -> Result<Option<Release>> {
        Ok(None)
    }
    async fn fetch(&self, version: &str, _: &ReleaseContext) -> Result<Release> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(Release {
            version: version.into(),
            url: self.url.clone(),
            sha256: sha256(b"new"),
            size: 3,
            gzip: None,
        })
    }
}
struct TestHost {
    store: FileStore,
    slot: Mutex<Option<Slot>>,
    incarnation: AtomicUsize,
    calls: AtomicUsize,
}
#[async_trait]
impl Host for TestHost {
    async fn quiesce(&self) -> Result<()> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn stop(&self, _: Slot) -> Result<()> {
        *self.slot.lock().unwrap() = None;
        Ok(())
    }
    async fn start(&self, slot: Slot) -> Result<()> {
        *self.slot.lock().unwrap() = Some(slot);
        self.incarnation.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn probe(&self) -> Result<Evidence> {
        let slot = self.slot.lock().unwrap().unwrap();
        Ok(Evidence {
            version: self
                .store
                .version(slot)?
                .unwrap_or_else(|| self.store.version(Slot::Stable).unwrap().unwrap()),
            pid: 42,
            start_id: self.incarnation.load(Ordering::SeqCst).to_string(),
        })
    }
    async fn resume(&self) -> Result<()> {
        if self.store.version(Slot::Experiment)?.is_none() {
            *self.slot.lock().unwrap() = Some(Slot::Stable);
        }
        Ok(())
    }
}
struct TestHooks {
    managed: bool,
    refusal: Option<String>,
}
#[async_trait]
impl Hooks for TestHooks {
    fn managed_elsewhere(&self) -> bool {
        self.managed
    }
    async fn compatibility(&self, _: &str, _: &str) -> Result<Option<String>> {
        Ok(self.refusal.clone())
    }
}
struct Surface {
    value: String,
}
#[async_trait]
impl ReadbackSurface for Surface {
    fn id(&self) -> &str {
        "test.actual-surface"
    }
    async fn read(&self) -> Result<(String, String)> {
        Ok((self.value.clone(), self.id().into()))
    }
}
struct Fixture {
    root: tempfile::TempDir,
    runner: Runner,
    host: Arc<TestHost>,
    source: Arc<Source>,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
async fn setup() -> Result<Fixture> {
    let root = tempdir()?;
    let store = FileStore::new(root.path().join("state"));
    fs::write(root.path().join("old"), b"old")?;
    store.bootstrap_locked("1", &root.path().join("old"))?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/artifact", listener.local_addr()?);
    let server = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let mut b = [0; 4096];
            let _ = stream.read(&mut b).await;
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nnew")
                .await;
        }
    });
    let source = Arc::new(Source {
        url,
        calls: AtomicUsize::new(0),
    });
    let host = Arc::new(TestHost {
        store: store.clone(),
        slot: Mutex::new(Some(Slot::Stable)),
        incarnation: AtomicUsize::new(1),
        calls: AtomicUsize::new(0),
    });
    let mut runner = Runner::new(store, host.clone(), source.clone())?;
    runner.provenance_enabled = true;
    runner.downloader.client = reqwest::Client::builder().no_proxy().build()?;
    Ok(Fixture {
        root,
        runner,
        host,
        source,
        server,
    })
}
fn request(id: &str, version: &str, consented: bool) -> Request {
    Request::Upgrade {
        protocol_version: 1,
        id: id.into(),
        target_version: version.into(),
        consented,
    }
}
#[tokio::test]
async fn injected_clock_stamps_operation_wal_report_and_provenance() -> Result<()> {
    use k_carrier::{report::ReportRead, storage::Effects};
    let mut f = setup().await?;
    f.runner.clock = Arc::new(|| 42);
    let response = f.runner.execute(&request("clock", "2", true)).await?;
    assert_eq!(response.exit_code, 0);
    let OperationRead::Observed { operation } = response.operation else {
        panic!("missing receipt")
    };
    assert_eq!(operation.started_at_ms, 42);
    assert_eq!(operation.updated_at_ms, 42);
    assert!(
        f.runner
            .store
            .read_journal()
            .await?
            .iter()
            .all(|e| e.timestamp_ms == 42)
    );
    assert!(
        matches!(f.runner.store.read_report(), ReportRead::Observed { report } if report.binary_at_target.observed_at_ms == 42)
    );
    assert!(
        matches!(f.runner.store.read_provenance(), ProvenanceRead::Observed { entries } if entries.len()==1 && entries[0].when==42)
    );
    Ok(())
}
#[tokio::test]
async fn receipts_replay_without_side_effects_and_archive_older_operations() -> Result<()> {
    let f = setup().await?;
    let first = f.runner.execute(&request("op1", "2", true)).await?;
    assert_eq!(first.exit_code, 0);
    assert_eq!(first.result, "promoted");
    let replay = f.runner.execute(&request("op1", "2", true)).await?;
    assert_eq!(replay.result, "replayed");
    assert_eq!(f.source.calls.load(Ordering::SeqCst), 1);
    assert_eq!(f.host.calls.load(Ordering::SeqCst), 1);
    let conflict = f.runner.execute(&request("op1", "3", true)).await?;
    assert!(conflict.error.unwrap().contains("OPERATION_ID_CONFLICT"));
    let second = f.runner.execute(&request("op2", "3", true)).await?;
    assert_eq!(second.exit_code, 0);
    let replay = f.runner.execute(&request("op1", "2", true)).await?;
    assert_eq!(replay.result, "replayed");
    assert_eq!(replay.exit_code, 0);
    assert_eq!(f.source.calls.load(Ordering::SeqCst), 2);
    assert_eq!(f.runner.store.version(Slot::Stable)?.as_deref(), Some("3"));
    match f.runner.store.read_provenance() {
        ProvenanceRead::Observed { entries } => {
            assert_eq!(entries.len(), 2);
            assert_eq!(entries[0].version, "2");
            assert_eq!(entries[1].version, "3");
        }
        other => panic!("{other:?}"),
    }
    assert!(f.runner.retire_legacy_manager().is_err());
    let status = f.runner.status().await?;
    assert_eq!(status["predicates"]["version"], "3");
    assert!(status["predicates"]["hostLifecycleConverged"].is_null());
    Ok(())
}
#[tokio::test]
async fn policy_ownership_and_compatibility_holds_do_not_stage_or_record_provenance() -> Result<()>
{
    for policy in [Policy::Confirm, Policy::NotifyOnly] {
        let mut f = setup().await?;
        f.runner.policy = policy;
        let held = f.runner.execute(&request("held", "2", false)).await?;
        assert_eq!(held.exit_code, 2);
        assert_eq!(f.host.calls.load(Ordering::SeqCst), 0);
        assert!(!f.runner.store.root.join("incoming").exists());
        assert!(matches!(
            f.runner.store.read_provenance(),
            ProvenanceRead::Genesis
        ));
    }
    let mut f = setup().await?;
    f.runner.hooks = Arc::new(TestHooks {
        managed: true,
        refusal: None,
    });
    let held = f.runner.execute(&request("managed", "2", true)).await?;
    assert_eq!(held.exit_code, 2);
    assert_eq!(f.source.calls.load(Ordering::SeqCst), 0);
    f.runner.hooks = Arc::new(TestHooks {
        managed: false,
        refusal: Some("unsupported migration".into()),
    });
    let held = f
        .runner
        .execute(&request("incompatible", "2", true))
        .await?;
    assert_eq!(held.exit_code, 2);
    assert_eq!(f.host.calls.load(Ordering::SeqCst), 0);
    Ok(())
}
#[tokio::test]
async fn lifecycle_metadata_cannot_promote_or_authorize_retirement() -> Result<()> {
    let mut f = setup().await?;
    f.runner.surfaces.push(Arc::new(Surface {
        value: "version 2 upgrade count 1".into(),
    }));
    let response = f
        .runner
        .execute(&request("stale-surface", "2", true))
        .await?;
    assert_eq!(response.exit_code, 1);
    assert_eq!(response.result, "rolled-back");
    assert_eq!(f.runner.store.version(Slot::Stable)?.as_deref(), Some("1"));
    assert!(f.runner.retire_legacy_manager().is_err());
    f.runner.surfaces.clear();
    f.runner.surfaces.push(Arc::new(Surface {
        value: f
            .runner
            .store
            .artifact(Slot::Experiment)
            .to_string_lossy()
            .into_owned(),
    }));
    let response = f
        .runner
        .execute(&request("good-surface", "2", true))
        .await?;
    assert_eq!(response.exit_code, 0);
    assert!(f.runner.retire_legacy_manager().is_ok());
    fs::write(f.runner.store.root.join("report.json"), b"corrupt")?;
    assert!(
        f.runner
            .retire_legacy_manager()
            .unwrap_err()
            .contains("cannot be read")
    );
    assert_eq!(f.runner.status().await?["predicates"]["kind"], "unreadable");
    assert!(f.root.path().exists());
    Ok(())
}

#[tokio::test]
async fn candidate_preparation_failure_keeps_service_and_replays_without_download() -> Result<()> {
    use k_carrier::{error::invalid, storage::Effects};
    struct RejectCandidate(AtomicUsize);
    #[async_trait]
    impl Hooks for RejectCandidate {
        async fn prepare_candidate(
            &self,
            artifact: &std::path::Path,
            release: &Release,
        ) -> Result<()> {
            assert_eq!(fs::read(artifact)?, b"new");
            assert_eq!(release.version, "2");
            self.0.fetch_add(1, Ordering::SeqCst);
            Err(invalid("candidate self-check failed"))
        }
    }
    let mut f = setup().await?;
    let hooks = Arc::new(RejectCandidate(AtomicUsize::new(0)));
    f.runner.hooks = hooks.clone();
    let before = f.host.probe().await?;
    let result = f
        .runner
        .execute(&request("rejected-candidate", "2", true))
        .await?;
    assert_eq!(result.exit_code, 1);
    let OperationRead::Observed { operation } = result.operation else {
        panic!("missing receipt")
    };
    assert_eq!(operation.outcome, Some(Outcome::Failed));
    assert_eq!(f.host.probe().await?, before);
    assert_eq!(f.host.calls.load(Ordering::SeqCst), 0);
    assert_eq!(f.runner.store.version(Slot::Stable)?.as_deref(), Some("1"));
    assert!(f.runner.store.version(Slot::Experiment)?.is_none());
    assert!(
        f.runner
            .store
            .read_journal()
            .await?
            .iter()
            .all(|e| e.intent == Phase::Idle)
    );
    let replay = f
        .runner
        .execute(&request("rejected-candidate", "2", true))
        .await?;
    assert_eq!(replay.exit_code, 1);
    assert_eq!(replay.result, "replayed");
    assert_eq!(hooks.0.load(Ordering::SeqCst), 1);
    assert_eq!(f.source.calls.load(Ordering::SeqCst), 1);
    Ok(())
}

#[tokio::test]
async fn completed_rollback_does_not_restart_a_subsequently_stopped_service() -> Result<()> {
    let mut f = setup().await?;
    f.runner.surfaces.push(Arc::new(Surface {
        value: "wrong-artifact".into(),
    }));
    let result = f
        .runner
        .execute(&request("live-refused", "2", true))
        .await?;
    assert_eq!(result.exit_code, 1);
    let OperationRead::Observed { operation } = result.operation else {
        panic!("missing receipt")
    };
    assert_eq!(operation.outcome, Some(Outcome::RolledBack));
    f.host.stop(Slot::Stable).await?;
    let starts = f.host.incarnation.load(Ordering::SeqCst);
    f.runner.recover(None).await?;
    assert!(f.host.slot.lock().unwrap().is_none());
    f.runner.policy = Policy::Confirm;
    let held = f
        .runner
        .execute(&request("unconfirmed-next", "2", false))
        .await?;
    assert_eq!(held.exit_code, 2);
    assert!(f.host.slot.lock().unwrap().is_none());
    assert_eq!(f.host.incarnation.load(Ordering::SeqCst), starts);
    Ok(())
}

#[tokio::test]
async fn lock_contention_is_held_without_creating_a_receipt_or_calling_the_host() -> Result<()> {
    let f = setup().await?;
    let mut lock = k_carrier::lock::UpgradeLock::acquire(&f.runner.store.root)?;
    for request in [request("contender", "2", true), Request::Recover { protocol_version: 1, expected: None }] {
        let response = f.runner.execute(&request).await?;
        assert_eq!(response.exit_code, 2);
        assert_eq!(response.result, "busy");
        assert!(matches!(response.operation, OperationRead::Genesis));
    }
    fs::write(f.runner.store.root.join("operation.json"), b"{corrupt")?;
    assert_eq!(f.runner.execute(&request("blocked", "2", true)).await?.exit_code, 2);
    assert_eq!(f.source.calls.load(Ordering::SeqCst), 0);
    assert_eq!(f.host.calls.load(Ordering::SeqCst), 0);
    lock.release()?;
    Ok(())
}

#[tokio::test]
async fn unreadable_recovery_is_unresolved_but_raw_status_is_a_read_error() -> Result<()> {
    let f = setup().await?;
    let corrupt = b"{corrupt";
    fs::write(f.runner.store.root.join("operation.json"), corrupt)?;
    for request in [request("broken", "2", true), Request::Recover { protocol_version: 1, expected: None }] {
        let response = f.runner.execute(&request).await?;
        assert_eq!(response.exit_code, 3);
        assert!(matches!(response.operation, OperationRead::Unreadable { .. }));
    }
    assert_eq!(f.runner.execute(&Request::Status { protocol_version: 1 }).await?.exit_code, 1);
    assert_eq!(fs::read(f.runner.store.root.join("operation.json"))?, corrupt);
    assert_eq!(f.source.calls.load(Ordering::SeqCst), 0);
    assert_eq!(f.host.calls.load(Ordering::SeqCst), 0);
    Ok(())
}
