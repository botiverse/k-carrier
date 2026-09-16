//! Native test process; never linked into or shipped with a product installer.
use k_carrier::{
    protocol::Request,
    state::*,
    storage::{FileStore, now_ms},
};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::PathBuf,
};
fn main() {
    if let Err(e) = run() {
        eprintln!("fixture error: {e}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().nth(1).as_deref() == Some("--cold-evidence") {
        println!("{}", serde_json::json!({"version":"2","pid":std::process::id(),"startId":uuid::Uuid::new_v4().to_string()}));
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--hold-lock") {
        let root = PathBuf::from(std::env::var_os("K_FIXTURE_ROOT").ok_or("missing root")?);
        let _lock = k_carrier::lock::UpgradeLock::acquire(&root)?;
        println!("acquired");
        std::io::stdout().flush()?;
        let mut byte = [0];
        std::io::stdin().read_exact(&mut byte)?;
        return Ok(());
    }
    if let Some(url) = std::env::args()
        .nth(1)
        .filter(|v| v == "--proxy-download")
        .and_then(|_| std::env::args().nth(2))
    {
        let rt = tokio::runtime::Runtime::new()?;
        let bytes = rt.block_on(async {
            let release = k_carrier::artifact::Release {
                version: "proxy".into(),
                url,
                sha256: k_carrier::artifact::sha256(b"verified proxy bytes"),
                size: 20,
                gzip: None,
            };
            k_carrier::artifact::Downloader::new()?
                .download(&release, None, None)
                .await
        })?;
        println!("{}", bytes.len());
        return Ok(());
    }
    let mut input = String::new();
    std::io::stdin().take(65537).read_to_string(&mut input)?;
    let root = std::env::var_os("K_FIXTURE_ROOT")
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir()?);
    if std::env::args().any(|a| a == "--controller") {
        let value: serde_json::Value = serde_json::from_str(&input)?;
        let action = value["action"].as_str().ok_or("missing action")?;
        if action == "probe" && root.join("probe-hang").exists() {
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
        if root.join("large-output").exists() {
            std::io::stdout().write_all(&vec![b'x'; 70000])?;
            return Ok(());
        }
        if root.join("effect-uncertain").exists() {
            println!("{}", serde_json::json!({"protocolVersion":1,"ok":false,"uncertain":true}));
            std::process::exit(1);
        }
        let output = if action == "probe" {
            let evidence = if root.join("controller-self-evidence").exists() {
                serde_json::json!({"version":"2","pid":std::process::id(),"startId":"invalid-self"})
            } else {
                let output = std::process::Command::new(std::env::current_exe()?).arg("--cold-evidence").output()?;
                if !output.status.success() { return Err("cold evidence failed".into()); }
                serde_json::from_slice::<serde_json::Value>(&output.stdout)?
            };
            serde_json::json!({"protocolVersion":1,"ok":true,"evidence":evidence})
        } else {
            serde_json::json!({"protocolVersion":1,"ok":true})
        };
        println!("{output}");
        return Ok(());
    }
    let request = Request::parse(input.as_bytes())?;
    let expected = request.expected().ok_or("test expects identity")?;
    let mut pids = fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(root.join("pids"))?;
    writeln!(pids, "{}", std::process::id())?;
    let count_file = root.join("attempts");
    let count = fs::read_to_string(&count_file)
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0)
        + 1;
    fs::write(count_file, count.to_string())?;
    let mode = std::env::var("K_FIXTURE_MODE").unwrap_or_default();
    if mode == "busy" {
        println!("{}", serde_json::json!({"protocolVersion":1,"action":request.action(),"exitCode":2,
            "result":"busy","operation":{"kind":"genesis"},"error":"UPGRADE_IN_PROGRESS: holder pid 42"}));
        std::process::exit(2);
    }
    let store = FileStore::new(root.join("state"));
    let outcome = if matches!(request, Request::Recover { .. }) {
        Outcome::RolledBack
    } else {
        Outcome::Promoted
    };
    let mut operation = Operation {
        format_version: 1,
        id: expected.id,
        target_version: expected.target_version,
        from_version: "1".into(),
        previous_stable_version: "1".into(),
        started_at_ms: now_ms(),
        updated_at_ms: now_ms(),
        phase: OperationPhase::HandingOver,
        outcome: None,
        reason: None,
        provenance: None,
        metadata: BTreeMap::new(),
    };
    store.persist_operation(&operation)?;
    if mode == "hang" {
        std::thread::sleep(std::time::Duration::from_secs(60));
    }
    if mode == "crash-first" && count == 1 {
        #[cfg(unix)]
        unsafe {
            libc::kill(std::process::id() as i32, libc::SIGKILL);
        }
        std::process::exit(99);
    }
    if mode == "lie" {
        operation.id = "different-request".into();
    }
    operation.phase = outcome.phase();
    operation.outcome = Some(outcome);
    store.persist_operation(&operation)?;
    let code = outcome.exit_code();
    println!(
        "{}",
        serde_json::to_string(&k_carrier::protocol::Response {
            protocol_version: 1,
            action: request.action().into(),
            exit_code: code,
            result: "fixture-complete".into(),
            operation: OperationRead::Observed { operation },
            error: None
        })?
    );
    std::process::exit(code as i32)
}
