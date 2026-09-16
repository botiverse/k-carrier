use k_carrier::{
    Result,
    acceptance::{AdapterTarget, BlackBoxTarget, run_adapter, run_bin, validate_status},
    corpus::{Failure, record_failures},
};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};
fn compile(source: &Path, out: &Path, version: &str) {
    let result = Command::new("rustc")
        .args(["--edition=2024", "-C", "debuginfo=0", "-o"])
        .arg(out)
        .arg(source)
        .env("K_EXAMPLE_VERSION", version)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
#[tokio::test]
async fn external_native_controller_promotes_rolls_back_and_refuses_dead_probe() -> Result<()> {
    let root = tempfile::tempdir()?;
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/native-service.rs");
    for (file, version) in [
        ("stable", "1.0.0"),
        ("candidate", "2.0.0"),
        ("broken", "broken-candidate"),
    ] {
        compile(
            &source,
            &root
                .path()
                .join(format!("{file}{}", std::env::consts::EXE_SUFFIX)),
            version,
        );
    }
    let target = AdapterTarget {
        stable_artifact: PathBuf::from(format!("stable{}", std::env::consts::EXE_SUFFIX)),
        candidate_artifact: PathBuf::from(format!("candidate{}", std::env::consts::EXE_SUFFIX)),
        broken_artifact: PathBuf::from(format!("broken{}", std::env::consts::EXE_SUFFIX)),
        stable_version: "1.0.0".into(),
        target_version: "2.0.0".into(),
        args: vec![],
    };
    let file = root.path().join("adapter.json");
    fs::write(&file, serde_json::to_vec(&target)?)?;
    let receipt = run_adapter(
        Path::new(env!("CARGO_BIN_EXE_k-example-controller")),
        &file,
        "service",
    )
    .await?;
    assert_eq!(
        receipt.result,
        "pass",
        "{}",
        serde_json::to_string(&receipt)?
    );
    assert!(
        receipt
            .checks
            .iter()
            .any(|c| c.id == "adapter.service-rollback")
    );
    // A controller claiming success without starting the declared executable
    // must fail the very same acceptance function.
    let mut dishonest = target;
    dishonest.candidate_artifact = dishonest.stable_artifact.clone();
    fs::write(&file, serde_json::to_vec(&dishonest)?)?;
    let negative = run_adapter(
        Path::new(env!("CARGO_BIN_EXE_k-example-controller")),
        &file,
        "service",
    )
    .await?;
    assert_eq!(negative.result, "fail");
    Ok(())
}
#[tokio::test]
async fn blackbox_requires_byte_change_and_exact_next_version_in_a_copy() -> Result<()> {
    let root = tempfile::tempdir()?;
    let source = root.path().join("swap.rs");
    fs::write(
        &source,
        r#"use std::{env,fs};fn main(){if env::args().nth(1).as_deref()==Some("upgrade"){if env::var("NEGATIVE").is_ok(){return;}let exe=env::current_exe().unwrap();let tmp=exe.with_extension("new");fs::copy(env::var("CANDIDATE").unwrap(),&tmp).unwrap();#[cfg(windows)]fs::rename(&exe,exe.with_extension("old")).unwrap();fs::rename(tmp,exe).unwrap();}else{println!("{}",env!("K_EXAMPLE_VERSION"));}}"#,
    )?;
    let bin = root
        .path()
        .join(format!("original{}", std::env::consts::EXE_SUFFIX));
    let next = root
        .path()
        .join(format!("next{}", std::env::consts::EXE_SUFFIX));
    compile(&source, &bin, "1.0.0");
    compile(&source, &next, "2.0.0");
    let original = fs::read(&bin)?;
    let file = root.path().join("k.target.json");
    let mut target = BlackBoxTarget {
        version: vec!["--version".into()],
        self_upgrade: vec!["upgrade".into()],
        status: None,
        env: BTreeMap::from([("CANDIDATE".into(), next.to_string_lossy().into_owned())]),
        artifact: next,
    };
    fs::write(&file, serde_json::to_vec(&target)?)?;
    assert_eq!(run_bin(&bin, &file, "2.0.0", "swap").await?.result, "pass");
    assert_eq!(
        fs::read(&bin)?,
        original,
        "verifier must not replace the adopter's original binary"
    );
    target.env.insert("NEGATIVE".into(), "1".into());
    fs::write(&file, serde_json::to_vec(&target)?)?;
    assert_eq!(run_bin(&bin, &file, "2.0.0", "swap").await?.result, "fail");
    assert!(
        run_bin(&bin, &root.path().join("missing.json"), "2.0.0", "swap")
            .await
            .is_err()
    );
    Ok(())
}
#[test]
fn corpus_merges_deterministically_and_rejects_unknown_formats() -> Result<()> {
    let root = tempfile::tempdir()?;
    let file = root.path().join("failures.json");
    let failure = Failure {
        seed: 42,
        failure: "synthetic".into(),
        replay: "k-harness sim --seed 42".into(),
        transcript_sha256: "a".repeat(64),
    };
    record_failures(&file, std::slice::from_ref(&failure))?;
    let first = fs::read(&file)?;
    record_failures(&file, &[failure])?;
    assert_eq!(fs::read(&file)?, first);
    fs::write(&file, b"{\"formatVersion\":2,\"failures\":[]}")?;
    let bad = Failure {
        seed: 1,
        failure: "test".into(),
        replay: "test".into(),
        transcript_sha256: "b".repeat(64),
    };
    assert!(record_failures(&file, &[bad]).is_err());
    assert!(validate_status("{}").is_err());
    Ok(())
}
#[test]
fn native_cli_replays_seeds_and_rejects_conflicting_modes() -> Result<()> {
    let cli = env!("CARGO_BIN_EXE_k-harness");
    let first = Command::new(cli)
        .args(["sim", "--seed", "0x12345678", "--json"])
        .output()?;
    assert!(first.status.success());
    let replay = Command::new(cli)
        .args(["sim", "--seed", "305419896", "--json"])
        .output()?;
    assert_eq!(first.stdout, replay.stdout);
    for args in [
        vec!["sim", "--seed", "1", "--seeds", "2"],
        vec!["--profile", "unknown"],
        vec!["--adapter", "missing"],
        vec!["--target-version", "2"],
        vec!["sim", "--seeds", "0"],
        vec!["sim", "--seed", "1", "--seed", "2"],
    ] {
        assert!(!Command::new(cli).args(args).output()?.status.success());
    }
    let list = Command::new(cli)
        .args(["--list", "--profile", "service", "--json"])
        .output()?;
    assert!(list.status.success());
    assert!(
        !serde_json::from_slice::<serde_json::Value>(&list.stdout)?["suites"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    Ok(())
}
