//! Native verification entry point. Model simulation is standalone; verification
//! profiles run the packaged Rust integration suites through Cargo.
use k_carrier::{
    Result,
    error::invalid,
    harness::{Mutation, simulate},
};
use serde_json::json;
use std::{collections::BTreeMap, path::PathBuf, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};
const SWAP: &[&str] = &[
    "download",
    "durable",
    "source",
    "protocol",
    "quarantine",
    "serve",
];
const SERVICE: &[&str] = &[
    "download",
    "durable",
    "source",
    "protocol",
    "quarantine",
    "serve",
    "engine",
    "runner",
    "process",
    "invariants",
    "simulation",
    "acceptance",
];
fn number(s: &str) -> Result<u32> {
    s.strip_prefix("0x")
        .map_or_else(|| s.parse(), |v| u32::from_str_radix(v, 16))
        .map_err(|_| invalid("HARNESS_INVALID_ARGUMENT: expected uint32"))
}
async fn profile(suites: &[&str], profile: &str, json_output: bool) -> Result<u8> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    if !manifest.is_file() {
        return Err(invalid(
            "HARNESS_SOURCE_REQUIRED: verification profiles require the crate source and Cargo",
        ));
    }
    let started = std::time::Instant::now();
    let mut command = Command::new("cargo");
    command
        .arg("test")
        .arg("--locked")
        .arg("--manifest-path")
        .arg(manifest);
    for suite in suites {
        command.arg("--test").arg(suite);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn()?;
    let mut output = child.stdout.take().unwrap().take(1024 * 1024);
    let mut bytes = vec![];
    let result = tokio::time::timeout(Duration::from_secs(900), async {
        output.read_to_end(&mut bytes).await?;
        child.wait().await
    })
    .await;
    let status = match result {
        Ok(status) => status?,
        Err(_) => {
            #[cfg(unix)]
            if let Some(pid) = child.id() {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(invalid("HARNESS_TIMEOUT"));
        }
    };
    let output = String::from_utf8_lossy(&bytes);
    // Cargo success with zero tests cannot produce an acceptance receipt.
    let completed = output
        .lines()
        .filter(|s| s.starts_with("test result: ok.") && !s.contains("ok. 0 passed;"))
        .count();
    let passed = status.success() && completed == suites.len();
    let receipt = json!({"mode":"profile","profile":profile,"scope":"Rust integration suites; platform service acceptance is separate",
        "suites":suites,"completedSuites":completed,"durationMs":started.elapsed().as_millis(),"result":if passed {"pass"} else {"fail"}});
    if json_output {
        println!("{receipt}");
    } else {
        print!("{output}");
        println!("{receipt}");
    }
    Ok(if passed { 0 } else { 1 })
}
async fn run() -> Result<u8> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["--help"] {
        println!(
            "k-harness --list [--profile swap|service] [--json]\nk-harness --profile swap|service [--json]\nk-harness sim [--seed N | --seeds N --start-seed N] [--json]\nk-harness --bin PATH [--target k.target.json] [--target-version V] [--profile swap|service] [--json]\nk-harness --adapter CONTROLLER --target adapter.json [--profile service] [--json]\nSimulation accepts --record-failures PATH. Profiles require Cargo and crate source. Legacy Node interoperability is a separate cargo test --features legacy-interop --test legacy gate."
        );
        return Ok(0);
    }
    let mut options = BTreeMap::new();
    let mut flags = std::collections::BTreeSet::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if ["sim", "--json", "--list"].contains(&arg.as_str()) {
            if !flags.insert(arg.as_str()) {
                return Err(invalid("HARNESS_DUPLICATE_ARGUMENT"));
            }
        } else if [
            "--profile",
            "--seed",
            "--seeds",
            "--start-seed",
            "--record-failures",
            "--bin",
            "--target",
            "--target-version",
            "--adapter",
        ]
        .contains(&arg.as_str())
        {
            index += 1;
            let value = args
                .get(index)
                .ok_or_else(|| invalid("HARNESS_MISSING_ARGUMENT"))?;
            if options.insert(arg.as_str(), value.as_str()).is_some() {
                return Err(invalid("HARNESS_DUPLICATE_ARGUMENT"));
            }
        } else {
            return Err(invalid(format!("HARNESS_UNKNOWN_ARGUMENT: {arg}")));
        }
        index += 1;
    }
    if flags.contains("sim") {
        if options.contains_key("--bin")
            || options.contains_key("--adapter")
            || options.contains_key("--target")
            || options.contains_key("--target-version")
            || options.contains_key("--profile")
            || flags.contains("--list")
            || (options.contains_key("--seed")
                && (options.contains_key("--seeds") || options.contains_key("--start-seed")))
            || (options.contains_key("--start-seed") && !options.contains_key("--seeds"))
        {
            return Err(invalid("HARNESS_CONFLICTING_ARGUMENTS"));
        }
        let seeds = if let Some(seed) = options.get("--seed") {
            vec![number(seed)?]
        } else if let Some(count) = options.get("--seeds") {
            let count = number(count)?;
            if count == 0 || count > 1_000_000 {
                return Err(invalid("HARNESS_INVALID_SEED_COUNT"));
            }
            let start = number(options.get("--start-seed").unwrap_or(&"1"))?;
            (0..count).map(|n| start.wrapping_add(n)).collect()
        } else {
            vec![
                1,
                2,
                3,
                5,
                8,
                13,
                21,
                34,
                55,
                89,
                144,
                233,
                377,
                610,
                987,
                1597,
                2584,
                4181,
                6765,
                10946,
                0x12345678,
                0x6a09e667,
                0x9e3779b9,
                u32::MAX,
            ]
        };
        let mut results = vec![];
        for seed in seeds {
            match simulate(seed, 20, Mutation::None).await {
                Ok(receipt) => results.push(serde_json::to_value(receipt)?),
                Err(error) => results.push(json!({"seed":seed,"result":"fail","error":error.to_string(),"replay":format!("k-harness sim --seed {seed}")})),
            }
        }
        let failure_records: Vec<_> = results
            .iter()
            .filter(|r| r["result"] == "fail")
            .map(|r| k_carrier::corpus::Failure {
                seed: r["seed"].as_u64().unwrap() as u32,
                failure: r["error"].as_str().unwrap().into(),
                replay: r["replay"].as_str().unwrap().into(),
                transcript_sha256: k_carrier::artifact::sha256(r.to_string().as_bytes()),
            })
            .collect();
        k_carrier::corpus::record_failures(
            std::path::Path::new(
                options
                    .get("--record-failures")
                    .unwrap_or(&".k-harness/sim-failures.json"),
            ),
            &failure_records,
        )?;
        let failures = results.iter().filter(|r| r["result"] == "fail").count();
        println!(
            "{}",
            json!({"mode":"sim","summary":{"pass":results.len()-failures,"fail":failures,"total":results.len()},"results":results,"result":if failures==0 {"pass"} else {"fail"}})
        );
        return Ok(if failures == 0 { 0 } else { 1 });
    }
    if options.contains_key("--bin") || options.contains_key("--adapter") {
        if flags.contains("--list")
            || (options.contains_key("--bin") && options.contains_key("--adapter"))
            || options.keys().any(|key| {
                ![
                    "--bin",
                    "--adapter",
                    "--profile",
                    "--target",
                    "--target-version",
                ]
                .contains(key)
            })
        {
            return Err(invalid("HARNESS_CONFLICTING_ARGUMENTS"));
        }
        let selected =
            options
                .get("--profile")
                .copied()
                .unwrap_or(if options.contains_key("--bin") {
                    "swap"
                } else {
                    "service"
                });
        if !["swap", "service"].contains(&selected) {
            return Err(invalid("HARNESS_INVALID_PROFILE"));
        }
        let receipt = if let Some(bin) = options.get("--bin") {
            let binary = PathBuf::from(bin);
            let target = options
                .get("--target")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    binary
                        .parent()
                        .unwrap_or(std::path::Path::new("."))
                        .join("k.target.json")
                });
            k_carrier::acceptance::run_bin(
                &binary,
                &target,
                options.get("--target-version").unwrap_or(&"2.0.0"),
                selected,
            )
            .await?
        } else {
            if options.contains_key("--target-version") {
                return Err(invalid("HARNESS_CONFLICTING_ARGUMENTS"));
            }
            let target = options
                .get("--target")
                .ok_or_else(|| invalid("HARNESS_ADAPTER_TARGET_REQUIRED"))?;
            k_carrier::acceptance::run_adapter(
                std::path::Path::new(options["--adapter"]),
                std::path::Path::new(target),
                selected,
            )
            .await?
        };
        println!("{}", serde_json::to_string(&receipt)?);
        return Ok(if receipt.result == "pass" { 0 } else { 1 });
    }
    if options.keys().any(|key| *key != "--profile") {
        return Err(invalid("HARNESS_ARGUMENT_REQUIRES_SIM"));
    }
    let selected = options.get("--profile").copied().unwrap_or("service");
    let suites = match selected {
        "swap" => SWAP,
        "service" => SERVICE,
        _ => return Err(invalid("HARNESS_INVALID_PROFILE")),
    };
    if flags.contains("--list") {
        println!("{}", json!({"profile":selected,"suites":suites}));
        return Ok(0);
    }
    if !options.contains_key("--profile") {
        return Err(invalid("HARNESS_PROFILE_REQUIRED"));
    }
    profile(suites, selected, flags.contains("--json")).await
}
#[tokio::main]
async fn main() {
    let code = match run().await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("{}", json!({"result":"fail","error":error.to_string()}));
            1
        }
    };
    std::process::exit(code as i32);
}
