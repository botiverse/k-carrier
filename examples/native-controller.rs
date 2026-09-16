//! Minimal portable example controller. Production applications should bind
//! their own authenticated local control endpoint and lifecycle manager.
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    net::TcpStream,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
fn exchange(action: &str) -> Result<String, Box<dyn std::error::Error>> {
    let ready: Value = serde_json::from_slice(&fs::read("service.json")?)?;
    let address = ready["address"].as_str().ok_or("missing address")?;
    let parsed: std::net::SocketAddr = address.parse()?;
    if !parsed.ip().is_loopback() {
        return Err("not loopback".into());
    }
    let mut socket = TcpStream::connect_timeout(&parsed, Duration::from_secs(1))?;
    socket.set_read_timeout(Some(Duration::from_secs(2)))?;
    socket.set_write_timeout(Some(Duration::from_secs(2)))?;
    writeln!(
        socket,
        "{action} {}",
        ready["id"].as_str().ok_or("missing id")?
    )?;
    let mut text = String::new();
    socket.take(65537).read_to_string(&mut text)?;
    Ok(text)
}
fn run() -> Result<Value, Box<dyn std::error::Error>> {
    k_carrier::host::isolate_standard_handles()?;
    let mut bytes = vec![];
    std::io::stdin().take(16385).read_to_end(&mut bytes)?;
    let request: Value = serde_json::from_slice(&bytes)?;
    if request["protocolVersion"] != 1 {
        return Err("invalid protocol".into());
    }
    match request["action"].as_str().ok_or("missing action")? {
        "fence" | "quiesce" | "resume" => {}
        "start" => {
            if exchange("probe").is_ok() {
                return Ok(json!({"protocolVersion":1,"ok":true}));
            }
            let artifact = request["artifactPath"].as_str().ok_or("missing artifact")?;
            let root = std::env::current_dir()?;
            // Keep the running image outside slot directories so promotion can
            // rename those directories on Windows as well as Unix.
            let runtime = root.join(format!(
                "active-{}{}",
                uuid::Uuid::new_v4(),
                std::env::consts::EXE_SUFFIX
            ));
            fs::copy(artifact, &runtime)?;
            let mut child = Command::new(&runtime)
                .arg(&root)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()?;
            let started = Instant::now();
            while exchange("probe").is_err() {
                if child.try_wait()?.is_some() {
                    return Err("service exited during start".into());
                }
                if started.elapsed() > Duration::from_secs(5) {
                    child.kill()?;
                    child.wait()?;
                    return Err("service start timeout".into());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        "stop" => {
            if exchange("probe").is_ok() {
                let evidence: Value = serde_json::from_str(&exchange("probe")?)?;
                let pid = evidence["pid"].as_u64().ok_or("invalid pid")? as u32;
                exchange("stop")?;
                let started = Instant::now();
                while Path::new("service.json").exists() || k_carrier::lock::process_alive(pid) {
                    if started.elapsed() > Duration::from_secs(5) {
                        return Err("service stop timeout".into());
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
        "probe" => {
            return Ok(
                json!({"protocolVersion":1,"ok":true,"evidence":serde_json::from_str::<Value>(&exchange("probe")?)?}),
            );
        }
        _ => return Err("unknown action".into()),
    }
    Ok(json!({"protocolVersion":1,"ok":true}))
}
fn main() {
    match run() {
        Ok(v) => println!("{v}"),
        Err(e) => {
            println!(
                "{}",
                json!({"protocolVersion":1,"ok":false,"error":e.to_string()})
            );
            std::process::exit(1);
        }
    }
}
