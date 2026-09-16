//! Example application: no K dependency. Its version is compiled in.
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let version = option_env!("K_EXAMPLE_VERSION").unwrap_or("1.0.0");
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("{version}");
        return Ok(());
    }
    if version == "broken-candidate" {
        std::process::exit(23);
    }
    let root = PathBuf::from(std::env::args().nth(1).ok_or("state directory required")?);
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let id = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
    );
    let evidence = format!(
        "{{\"version\":\"{version}\",\"pid\":{},\"startId\":\"{id}\"}}",
        std::process::id()
    );
    let ready = root.join("service.json");
    fs::write(
        root.join("service.tmp"),
        format!(
            "{{\"address\":\"{}\",\"id\":\"{id}\"}}",
            listener.local_addr()?
        ),
    )?;
    fs::rename(root.join("service.tmp"), &ready)?;
    for socket in listener.incoming() {
        let mut socket = socket?;
        socket.set_read_timeout(Some(std::time::Duration::from_secs(2)))?;
        let mut buf = vec![];
        loop {
            let mut byte = [0];
            match socket.read(&mut byte) {
                Ok(1) if byte[0] != b'\n' && buf.len() < 512 => buf.push(byte[0]),
                _ => break,
            }
        }
        let request = std::str::from_utf8(&buf)?;
        // The per-incarnation token prevents a stale controller from stopping
        // a different service that has reused the old TCP address.
        if request == format!("stop {id}") {
            socket.write_all(b"stopped")?;
            break;
        }
        if request == format!("probe {id}") {
            socket.write_all(evidence.as_bytes())?;
        }
    }
    fs::remove_file(ready)?;
    Ok(())
}
