use k_carrier::{
    Result,
    artifact::{Downloader, Release, Representation, TransferPolicy, partial_path, sha256},
};
use std::{
    fs,
    io::Write,
    sync::{Arc, Mutex},
    time::Duration,
};
use tempfile::tempdir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};
struct Server {
    url: String,
    task: JoinHandle<()>,
    requests: Arc<Mutex<Vec<String>>>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn server(body: Vec<u8>, mode: &'static str) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/artifact", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(vec![]));
    let seen = requests.clone();
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let mut request = vec![];
            loop {
                let mut byte = [0];
                if stream.read_exact(&mut byte).await.is_err() {
                    break;
                }
                request.push(byte[0]);
                if request.ends_with(b"\r\n\r\n") {
                    break;
                }
                if request.len() > 8192 {
                    break;
                }
            }
            let request = String::from_utf8_lossy(&request).to_lowercase();
            seen.lock().unwrap().push(request.clone());
            if mode == "response-stall" {
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
            let start = request
                .lines()
                .find_map(|line| line.strip_prefix("range: bytes="))
                .and_then(|s| s.trim_end_matches('-').parse::<usize>().ok())
                .unwrap_or(0);
            let (status, extra, send) = if start > 0 && mode != "ignore-range" {
                let first = if mode == "bad-range" { 0 } else { start };
                (
                    206,
                    format!(
                        "Content-Range: bytes {first}-{}/{}\r\n",
                        body.len() - 1,
                        body.len()
                    ),
                    body[start..].to_vec(),
                )
            } else {
                (200, String::new(), body.clone())
            };
            let headers = format!(
                "HTTP/1.1 {status} OK\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n",
                send.len()
            );
            if stream.write_all(headers.as_bytes()).await.is_err() {
                continue;
            }
            if mode == "idle-stall" {
                let half = send.len() / 2;
                let _ = stream.write_all(&send[..half]).await;
                tokio::time::sleep(Duration::from_secs(1)).await;
                let _ = stream.write_all(&send[half..]).await;
            } else if mode == "slow-progress" {
                for byte in send {
                    if stream.write_all(&[byte]).await.is_err() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            } else {
                let _ = stream.write_all(&send).await;
            }
        }
    });
    Server {
        url,
        task,
        requests,
    }
}
fn downloader() -> Downloader {
    Downloader {
        client: reqwest::Client::builder().no_proxy().build().unwrap(),
        policy: TransferPolicy {
            response_ms: 100,
            idle_ms: 100,
            minimum_bytes_per_second: 1,
            maximum_overall_ms: 1000,
        },
    }
}
fn release(url: &str, bytes: &[u8]) -> Release {
    Release {
        version: "2".into(),
        url: url.into(),
        sha256: sha256(bytes),
        size: bytes.len() as u64,
        gzip: None,
    }
}
#[tokio::test]
async fn resume_accepts_exact_ranges_and_restarts_when_ignored() -> Result<()> {
    for mode in ["range", "ignore-range"] {
        let body = b"verified-new-artifact";
        let s = server(body.to_vec(), mode).await;
        let root = tempdir()?;
        fs::write(partial_path(root.path(), &s.url), &body[..4])?;
        assert_eq!(
            downloader()
                .download(&release(&s.url, body), Some(root.path()), None)
                .await?,
            body
        );
        assert!(s.requests.lock().unwrap()[0].contains("range: bytes=4-"));
    }
    Ok(())
}
#[tokio::test]
async fn complete_partial_with_expected_digest_is_used_without_a_request() -> Result<()> {
    let body = b"verified-new-artifact";
    let s = server(body.to_vec(), "range").await;
    let root = tempdir()?;
    let part = partial_path(root.path(), &s.url);
    fs::write(&part, body)?;
    let seen = Arc::new(Mutex::new(vec![]));
    let sink = seen.clone();
    let progress: k_carrier::artifact::Progress =
        Arc::new(move |got, total| sink.lock().unwrap().push((got, total)));
    assert_eq!(
        downloader()
            .download(&release(&s.url, body), Some(root.path()), Some(progress))
            .await?,
        body
    );
    assert!(s.requests.lock().unwrap().is_empty());
    let size = body.len() as u64;
    assert_eq!(*seen.lock().unwrap(), vec![(size, size)]);
    Ok(())
}
#[tokio::test]
async fn complete_partial_with_wrong_digest_or_oversize_is_replaced_by_one_full_download()
-> Result<()> {
    let body = b"verified-new-artifact";
    let wrong = b"verified-old-artifact";
    assert_eq!(wrong.len(), body.len());
    let oversized = [&body[..], b"-trailing"].concat();
    for stale in [&wrong[..], &oversized[..]] {
        let s = server(body.to_vec(), "range").await;
        let root = tempdir()?;
        let part = partial_path(root.path(), &s.url);
        fs::write(&part, stale)?;
        assert_eq!(
            downloader()
                .download(&release(&s.url, body), Some(root.path()), None)
                .await?,
            body
        );
        let requests = s.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(!requests[0].contains("range:"), "{}", requests[0]);
        assert_eq!(fs::read(&part)?, body);
    }
    Ok(())
}
#[tokio::test]
async fn complete_gzip_partial_is_checked_compressed_then_decoded() -> Result<()> {
    let body = b"canonical executable bytes";
    let mut gzip = flate2::write::GzEncoder::new(vec![], flate2::Compression::default());
    gzip.write_all(body)?;
    let gzip = gzip.finish()?;
    let s = server(gzip.clone(), "range").await;
    let mut r = release("https://not-fetched.invalid/canonical", body);
    r.gzip = Some(Representation {
        url: s.url.clone(),
        sha256: sha256(&gzip),
        size: gzip.len() as u64,
    });
    let root = tempdir()?;
    let part = partial_path(root.path(), &s.url);
    fs::write(&part, &gzip)?;
    assert_eq!(
        downloader().download(&r, Some(root.path()), None).await?,
        body
    );
    assert!(s.requests.lock().unwrap().is_empty());
    r.sha256 = sha256(b"wrong canonical");
    assert!(
        downloader()
            .download(&r, Some(root.path()), None)
            .await
            .unwrap_err()
            .to_string()
            .contains("SHA256_MISMATCH")
    );
    assert!(s.requests.lock().unwrap().is_empty());
    assert!(!part.exists());
    Ok(())
}
/// One full download from zero, no Range header, and the fresh bytes left in
/// the .part.
#[cfg(unix)]
fn assert_one_full_download(s: &Server, part: &std::path::Path, body: &[u8]) {
    let requests = s.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(!requests[0].contains("range:"), "{}", requests[0]);
    let meta = fs::symlink_metadata(part).unwrap();
    assert!(meta.is_file() && !meta.file_type().is_symlink());
    assert_eq!(fs::read(part).unwrap(), body);
}
#[cfg(unix)]
#[tokio::test]
async fn symlink_partial_is_removed_and_downloaded_from_zero() -> Result<()> {
    let body = b"verified-new-artifact";
    // Full size (would pass the digest) and short (would be resumed).
    for linked in [&body[..], &body[..4]] {
        let s = server(body.to_vec(), "range").await;
        let root = tempdir()?;
        let target = root.path().join("elsewhere");
        fs::write(&target, linked)?;
        let part = partial_path(root.path(), &s.url);
        std::os::unix::fs::symlink(&target, &part)?;
        assert_eq!(
            downloader()
                .download(&release(&s.url, body), Some(root.path()), None)
                .await?,
            body
        );
        assert_one_full_download(&s, &part, body);
        assert_eq!(fs::read(&target)?, linked, "the link target was touched");
    }
    Ok(())
}
#[cfg(unix)]
#[tokio::test]
async fn unreadable_partial_is_removed_and_downloaded_from_zero() -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        eprintln!("skipped: root can read a mode 0000 file");
        return Ok(());
    }
    let body = b"verified-new-artifact";
    for stale in [&body[..], &body[..4]] {
        let s = server(body.to_vec(), "range").await;
        let root = tempdir()?;
        let part = partial_path(root.path(), &s.url);
        fs::write(&part, stale)?;
        fs::set_permissions(&part, fs::Permissions::from_mode(0o000))?;
        assert_eq!(
            downloader()
                .download(&release(&s.url, body), Some(root.path()), None)
                .await?,
            body
        );
        assert_one_full_download(&s, &part, body);
    }
    Ok(())
}
#[cfg(unix)]
#[tokio::test]
async fn non_regular_partial_that_cannot_be_removed_stops_the_download() -> Result<()> {
    let body = b"verified-new-artifact";
    let s = server(body.to_vec(), "range").await;
    let root = tempdir()?;
    let part = partial_path(root.path(), &s.url);
    fs::create_dir(&part)?;
    fs::write(part.join("keep"), b"x")?;
    assert!(
        downloader()
            .download(&release(&s.url, body), Some(root.path()), None)
            .await
            .is_err()
    );
    assert!(s.requests.lock().unwrap().is_empty());
    assert!(part.join("keep").exists());
    Ok(())
}
#[tokio::test]
async fn wrong_range_corrupt_prefix_and_oversize_never_install() -> Result<()> {
    let body = b"verified-new-artifact";
    let s = server(body.to_vec(), "bad-range").await;
    let root = tempdir()?;
    fs::write(partial_path(root.path(), &s.url), &body[..4])?;
    assert!(
        downloader()
            .download(&release(&s.url, body), Some(root.path()), None)
            .await
            .unwrap_err()
            .to_string()
            .contains("Content-Range")
    );
    let s = server(body.to_vec(), "range").await;
    fs::write(partial_path(root.path(), &s.url), b"evil")?;
    assert!(
        downloader()
            .download(&release(&s.url, body), Some(root.path()), None)
            .await
            .unwrap_err()
            .to_string()
            .contains("SHA256_MISMATCH")
    );
    assert!(!partial_path(root.path(), &s.url).exists());
    let s = server(body.to_vec(), "range").await;
    let tiny = release(&s.url, b"v");
    assert!(
        downloader()
            .download(&tiny, Some(root.path()), None)
            .await
            .unwrap_err()
            .to_string()
            .contains("SIZE_MISMATCH")
    );
    assert!(!partial_path(root.path(), &s.url).exists());
    Ok(())
}
#[tokio::test]
async fn independent_response_idle_and_overall_deadlines_preserve_partial() -> Result<()> {
    for (mode, reason) in [
        ("response-stall", "response timeout"),
        ("idle-stall", "idle timeout"),
        ("slow-progress", "overall timeout"),
    ] {
        let body = b"012345678901234567890123456789";
        let s = server(body.to_vec(), mode).await;
        let root = tempdir()?;
        let mut d = downloader();
        d.policy.maximum_overall_ms = 250;
        let error = d
            .download(&release(&s.url, body), Some(root.path()), None)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains(reason), "{mode}: {error}");
        if mode != "response-stall" {
            let size = fs::metadata(partial_path(root.path(), &s.url))?.len();
            assert!(size > 0 && size < body.len() as u64);
        }
    }
    Ok(())
}
#[tokio::test]
async fn gzip_checks_transport_and_decoded_identity_and_bounds_expansion() -> Result<()> {
    let body = b"canonical executable bytes";
    let mut gzip = flate2::write::GzEncoder::new(vec![], flate2::Compression::default());
    gzip.write_all(body)?;
    let gzip = gzip.finish()?;
    let s = server(gzip.clone(), "range").await;
    let mut r = release("https://not-fetched.invalid/canonical", body);
    r.gzip = Some(Representation {
        url: s.url.clone(),
        sha256: sha256(&gzip),
        size: gzip.len() as u64,
    });
    let root = tempdir()?;
    assert_eq!(
        downloader().download(&r, Some(root.path()), None).await?,
        body
    );
    r.size = 2;
    assert!(
        downloader()
            .download(&r, Some(root.path()), None)
            .await
            .unwrap_err()
            .to_string()
            .contains("SIZE_MISMATCH")
    );
    assert!(!partial_path(root.path(), &s.url).exists());
    r.size = body.len() as u64;
    r.sha256 = sha256(b"wrong canonical");
    assert!(
        downloader()
            .download(&r, None, None)
            .await
            .unwrap_err()
            .to_string()
            .contains("SHA256_MISMATCH")
    );
    Ok(())
}

#[tokio::test]
async fn proxy_environment_is_honored_by_a_real_isolated_process() -> Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 8192];
        let n = stream.read(&mut request).await.unwrap();
        assert!(
            String::from_utf8_lossy(&request[..n])
                .starts_with("GET http://k-proxy.invalid/artifact ")
        );
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 20\r\nConnection: close\r\n\r\nverified proxy bytes").await.unwrap();
    });
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio::process::Command::new(env!("CARGO_BIN_EXE_k-test-fixture"))
            .args(["--proxy-download", "http://k-proxy.invalid/artifact"])
            .env("HTTP_PROXY", format!("http://{address}"))
            .env("http_proxy", format!("http://{address}"))
            .env("NO_PROXY", "")
            .env("no_proxy", "")
            .env_remove("REQUEST_METHOD")
            .kill_on_drop(true)
            .output(),
    )
    .await;
    if !matches!(&result,Ok(Ok(o)) if o.status.success()) {
        server.abort();
    }
    let output = result.expect("proxy download deadline")?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    server.await.unwrap();
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "20");
    Ok(())
}
