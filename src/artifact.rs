//! Verified transfer. Hashes provide integrity against the supplied manifest,
//! not publisher authentication. TLS and release-source trust remain explicit.
use crate::{
    Result,
    error::invalid,
    storage::{ensure_dir, exists},
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::time::timeout;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Representation {
    pub url: String,
    pub sha256: String,
    pub size: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Release {
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gzip: Option<Representation>,
}
#[derive(Debug, Clone)]
pub struct ReleaseContext {
    pub current_version: String,
    pub platform_key: String,
}
#[async_trait]
pub trait ReleaseSource: Send + Sync {
    async fn check(&self, context: &ReleaseContext) -> Result<Option<Release>>;
    async fn fetch(&self, version: &str, context: &ReleaseContext) -> Result<Release>;
}
pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
/// Publish verified bytes as an executable using the platform's replacement
/// sequence. This does not supply publisher authentication.
pub fn atomic_write_file(path: &Path, bytes: &[u8]) -> Result<()> {
    crate::storage::write_durable(path, bytes, true)
        .map_err(|e| invalid(format!("SWAP_FAILED: {e}")))
}
pub fn partial_path(dir: &Path, url: &str) -> PathBuf {
    dir.join(format!("{}.part", sha256(url.as_bytes())))
}
fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
impl Release {
    pub fn validate(&self) -> Result<()> {
        if self.version.is_empty()
            || self.url.is_empty()
            || !valid_hash(&self.sha256)
            || self.size > 9_007_199_254_740_991
        {
            return Err(invalid("MANIFEST_INVALID"));
        }
        if let Some(gz) = &self.gzip
            && (gz.url.is_empty()
                || !valid_hash(&gz.sha256)
                || gz.size == 0
                || gz.size > 9_007_199_254_740_991)
        {
            return Err(invalid("MANIFEST_INVALID: gzip identity"));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Copy)]
pub struct TransferPolicy {
    pub response_ms: u64,
    pub idle_ms: u64,
    pub minimum_bytes_per_second: u64,
    pub maximum_overall_ms: u64,
}
impl Default for TransferPolicy {
    fn default() -> Self {
        Self {
            response_ms: 30_000,
            idle_ms: 30_000,
            minimum_bytes_per_second: 64 * 1024,
            maximum_overall_ms: 30 * 60_000,
        }
    }
}
#[derive(Debug, Clone, Copy)]
pub struct Budgets {
    pub response_ms: u64,
    pub idle_ms: u64,
    pub overall_ms: u64,
}
impl TransferPolicy {
    pub fn budgets(self, size: u64) -> Result<Budgets> {
        if self.response_ms == 0
            || self.idle_ms == 0
            || self.minimum_bytes_per_second == 0
            || self.maximum_overall_ms < self.response_ms
        {
            return Err(invalid("ARTIFACT_TRANSFER_POLICY_INVALID"));
        }
        let body = (u128::from(size) * 1000).div_ceil(u128::from(self.minimum_bytes_per_second));
        let total =
            (body + u128::from(self.response_ms)).min(u128::from(self.maximum_overall_ms)) as u64;
        Ok(Budgets {
            response_ms: self.response_ms,
            idle_ms: self.idle_ms,
            overall_ms: total,
        })
    }
}
pub type Progress = Arc<dyn Fn(u64, u64) + Send + Sync>;
/// What one network transfer saw, for diagnosing a failed download: the
/// CDN's `cf-ray` response header, the HTTP status, the body bytes received
/// in this transfer (not counting a resumed prefix) and the time from sending
/// the request to its end. `status` is `None` when no response arrived.
/// Reported once per `download` that sent a request, whether it succeeded
/// or failed (including on K's own timeouts); not for a data URL or a
/// complete `.part` used without a request.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TransferReport {
    pub cf_ray: Option<String>,
    pub status: Option<u16>,
    pub bytes_received: u64,
    pub elapsed_ms: u64,
}
pub type TransferSink = Arc<dyn Fn(&TransferReport) + Send + Sync>;
#[derive(Default)]
struct Observed {
    sent_at: Option<Instant>,
    cf_ray: Option<String>,
    status: Option<u16>,
    bytes_received: u64,
}
impl Observed {
    fn update(cell: &Mutex<Self>, change: impl FnOnce(&mut Self)) {
        if let Ok(mut observed) = cell.lock() {
            change(&mut observed);
        }
    }
}
/// A `cf-ray` value is a short ASCII id such as `8f1c2a3b4d5e6f70-SJC`;
/// anything else is not reported.
fn cf_ray(headers: &reqwest::header::HeaderMap) -> Option<String> {
    let value = headers.get("cf-ray")?.to_str().ok()?;
    (!value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-'))
    .then(|| value.to_owned())
}
pub struct Downloader {
    pub client: reqwest::Client,
    pub policy: TransferPolicy,
    /// Receives a `TransferReport` for each download that sent a request.
    pub report: Option<TransferSink>,
}
impl Downloader {
    pub fn new() -> Result<Self> {
        // reqwest's default system proxy support honors HTTP(S)_PROXY/NO_PROXY.
        Ok(Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::limited(10))
                .build()?,
            policy: TransferPolicy::default(),
            report: None,
        })
    }
    pub async fn download(
        &self,
        release: &Release,
        resume_dir: Option<&Path>,
        progress: Option<Progress>,
    ) -> Result<Vec<u8>> {
        release.validate()?;
        let transfer = match &release.gzip {
            Some(g) => Representation {
                url: g.url.clone(),
                sha256: g.sha256.clone(),
                size: g.size,
            },
            None => Representation {
                url: release.url.clone(),
                sha256: release.sha256.clone(),
                size: release.size,
            },
        };
        let budgets = self.policy.budgets(transfer.size)?;
        let observed = Mutex::new(Observed::default());
        let result = timeout(
            Duration::from_millis(budgets.overall_ms),
            self.transfer(&transfer, resume_dir, progress, budgets, &observed),
        )
        .await
        .map_err(|_| invalid("DOWNLOAD_FAILED: overall timeout"))
        .and_then(|result| result);
        self.emit_report(observed);
        let result = result?;
        if release.gzip.is_none() {
            return Ok(result);
        }
        let decoded = (|| -> Result<Vec<u8>> {
            let reader = flate2::read::MultiGzDecoder::new(result.as_slice());
            let mut bytes = vec![];
            reader
                .take(release.size.saturating_add(1))
                .read_to_end(&mut bytes)
                .map_err(|_| invalid("DOWNLOAD_FAILED: invalid gzip"))?;
            verify(&bytes, release.size, &release.sha256)?;
            Ok(bytes)
        })();
        if decoded.is_err()
            && let Some(dir) = resume_dir
        {
            remove_partial(&partial_path(dir, &transfer.url))?;
        }
        decoded
    }
    fn emit_report(&self, observed: Mutex<Observed>) {
        let (Some(sink), Ok(observed)) = (&self.report, observed.into_inner()) else {
            return;
        };
        let Some(sent_at) = observed.sent_at else {
            return;
        };
        let report = TransferReport {
            cf_ray: observed.cf_ray,
            status: observed.status,
            bytes_received: observed.bytes_received,
            elapsed_ms: u64::try_from(sent_at.elapsed().as_millis()).unwrap_or(u64::MAX),
        };
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sink(&report)));
    }
    async fn transfer(
        &self,
        release: &Representation,
        resume_dir: Option<&Path>,
        progress: Option<Progress>,
        budgets: Budgets,
        observed: &Mutex<Observed>,
    ) -> Result<Vec<u8>> {
        if let Some(data) = release.url.strip_prefix("data:") {
            use base64::Engine as _;
            let (metadata, encoded) = data
                .split_once(',')
                .ok_or_else(|| invalid("DOWNLOAD_FAILED: invalid data URL"))?;
            // Reject impossible representations before allocating decoded bytes.
            let maximum = if metadata.ends_with(";base64") {
                release.size.div_ceil(3).saturating_mul(4)
            } else {
                release.size.saturating_mul(3)
            };
            if encoded.len() as u64 > maximum {
                return Err(invalid("DOWNLOAD_FAILED: oversized data URL"));
            }
            let bytes = if metadata.ends_with(";base64") {
                base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|_| invalid("DOWNLOAD_FAILED: invalid base64"))?
            } else {
                percent_encoding::percent_decode_str(encoded).collect::<Vec<u8>>()
            };
            verify(&bytes, release.size, &release.sha256)?;
            if let Some(sink) = progress {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    sink(release.size, release.size)
                }));
            }
            return Ok(bytes);
        }
        let partial = resume_dir.map(|dir| partial_path(dir, &release.url));
        let mut offset = 0;
        let mut resumed: Vec<u8> = vec![];
        if let Some(path) = &partial
            && exists(path)?
        {
            // A .part K cannot use (a symlink, not a regular file, unreadable,
            // or failing its digest) is removed and the transfer starts from
            // zero. Only a failed removal stops the download.
            let meta = fs::symlink_metadata(path)?;
            if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > release.size {
                remove_partial(path)?;
            } else if meta.len() < release.size {
                match read_partial(path, meta.len()) {
                    Ok(bytes) => {
                        offset = meta.len();
                        resumed = bytes;
                    }
                    Err(_) => remove_partial(path)?,
                }
            } else {
                // A complete partial is accepted only on K's own digest check,
                // the same one that ends a network transfer. It is then used
                // without any request.
                if let Ok(bytes) = read_partial(path, release.size)
                    && verify(&bytes, release.size, &release.sha256).is_ok()
                {
                    if let Some(sink) = progress {
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            sink(release.size, release.size)
                        }));
                    }
                    return Ok(bytes);
                }
                remove_partial(path)?;
            }
        }
        let mut request = self
            .client
            .get(&release.url)
            .header("Accept-Encoding", "identity");
        if offset > 0 {
            request = request.header("Range", format!("bytes={offset}-"));
        }
        Observed::update(observed, |o| o.sent_at = Some(Instant::now()));
        let mut response = timeout(Duration::from_millis(budgets.response_ms), request.send())
            .await
            .map_err(|_| invalid("DOWNLOAD_FAILED: response timeout"))??;
        Observed::update(observed, |o| {
            o.status = Some(response.status().as_u16());
            o.cf_ray = cf_ray(response.headers());
        });
        if response.status() != reqwest::StatusCode::OK
            && response.status() != reqwest::StatusCode::PARTIAL_CONTENT
        {
            return Err(invalid(format!(
                "DOWNLOAD_FAILED: HTTP {}",
                response.status()
            )));
        }
        if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
            let range = response
                .headers()
                .get("Content-Range")
                .and_then(|h| h.to_str().ok())
                .ok_or_else(|| invalid("DOWNLOAD_FAILED: missing Content-Range"))?;
            let (first, last, total) = parse_content_range(range)?;
            if first != offset || total != release.size || last + 1 != release.size {
                return Err(invalid("DOWNLOAD_FAILED: mismatched Content-Range"));
            }
        } else {
            offset = 0;
        }
        let mut bytes = vec![];
        let mut file: Option<File> = None;
        if let Some(path) = &partial {
            ensure_dir(path.parent().unwrap())?;
            if offset > 0 {
                bytes = std::mem::take(&mut resumed);
            }
            file = Some(open_partial_write(path, offset > 0)?);
        }
        let emit = |n| {
            if let Some(sink) = &progress {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    sink(n, release.size)
                }));
            }
        };
        emit(offset);
        loop {
            let chunk = timeout(Duration::from_millis(budgets.idle_ms), response.chunk())
                .await
                .map_err(|_| invalid("DOWNLOAD_FAILED: idle timeout"))??;
            let Some(chunk) = chunk else {
                break;
            };
            Observed::update(observed, |o| o.bytes_received += chunk.len() as u64);
            if bytes.len() as u64 + chunk.len() as u64 > release.size {
                drop(file);
                if let Some(path) = &partial {
                    remove_partial(path)?;
                }
                return Err(invalid("SIZE_MISMATCH: response exceeds declared size"));
            }
            if let Some(file) = &mut file {
                file.write_all(&chunk)?;
            }
            bytes.extend_from_slice(&chunk);
            emit(bytes.len() as u64);
        }
        if let Some(file) = file {
            file.sync_all()?;
        }
        if let Err(e) = verify(&bytes, release.size, &release.sha256) {
            if let Some(path) = &partial {
                remove_partial(path)?;
            }
            return Err(e);
        }
        Ok(bytes)
    }
}
/// Read a partial file that was just checked to hold `expected` bytes. The
/// open refuses a final symlink (`O_NOFOLLOW` on unix; on Windows the reparse
/// point itself is opened and then refused), the open handle must be a
/// regular file of that size, and the read is bounded so a file that grows or
/// is swapped for a device cannot be read without limit.
fn read_partial(path: &Path, expected: u64) -> Result<Vec<u8>> {
    let mut opts = OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        opts.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = opts.open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() != expected {
        return Err(invalid("invalid partial file"));
    }
    let mut bytes = Vec::with_capacity(usize::try_from(expected).unwrap_or(0));
    file.take(expected.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 != expected {
        return Err(invalid("invalid partial file"));
    }
    Ok(bytes)
}
/// Open the partial file for writing (appending when resuming). Like
/// `read_partial`, the open refuses a final symlink: `O_NOFOLLOW` on unix; on
/// Windows `FILE_FLAG_OPEN_REPARSE_POINT` opens the reparse point itself
/// rather than its target. The open handle must then be a regular file that
/// is not a link, so a link planted between the removal and this open is
/// never written through.
fn open_partial_write(path: &Path, append: bool) -> Result<File> {
    let mut opts = OpenOptions::new();
    opts.write(true).create(true);
    if append {
        opts.append(true);
    } else {
        opts.truncate(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        opts.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = opts.open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err(invalid("invalid partial file"));
    }
    Ok(file)
}
fn remove_partial(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}
pub fn verify(bytes: &[u8], size: u64, hash: &str) -> Result<()> {
    if bytes.len() as u64 != size {
        return Err(invalid("SIZE_MISMATCH"));
    }
    if sha256(bytes) != hash {
        return Err(invalid("SHA256_MISMATCH"));
    }
    Ok(())
}
fn parse_content_range(input: &str) -> Result<(u64, u64, u64)> {
    let invalid_range = || invalid("DOWNLOAD_FAILED: invalid Content-Range");
    let value = input.strip_prefix("bytes ").ok_or_else(invalid_range)?;
    let (span, total) = value.split_once('/').ok_or_else(invalid_range)?;
    let (first, last) = span.split_once('-').ok_or_else(invalid_range)?;
    let first = first.parse::<u64>().map_err(|_| invalid_range())?;
    let last = last.parse::<u64>().map_err(|_| invalid_range())?;
    let total = total.parse::<u64>().map_err(|_| invalid_range())?;
    if first > last || last >= total {
        return Err(invalid_range());
    }
    Ok((first, last, total))
}

#[cfg(test)]
mod partial_write_tests {
    use super::open_partial_write;
    use std::{fs, io::Write, path::Path};

    /// Plant a symlink at `link` pointing to `target`. Windows needs a
    /// privilege (or developer mode) for this; without it the test is moot
    /// on a developer's machine, but on CI (`CI` set, as GitHub Actions
    /// does) it must work, so a green Windows job means the open really met
    /// a link.
    fn symlink(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).unwrap();
            true
        }
        #[cfg(windows)]
        {
            match std::os::windows::fs::symlink_file(target, link) {
                Ok(()) => true,
                Err(e) if std::env::var_os("CI").is_some() => {
                    panic!("CI must be able to create symlinks: {e}")
                }
                Err(e) => {
                    eprintln!("skipping: cannot create a symlink here: {e}");
                    false
                }
            }
        }
    }

    /// The open refuses the link (unix: `O_NOFOLLOW`; Windows: it opens the
    /// reparse point itself and the handle check rejects it), and nothing
    /// was written through it: the target is untouched or never created.
    fn assert_not_followed(part: &Path, target: &Path, before: Option<&[u8]>, append: bool) {
        let result = open_partial_write(part, append);
        assert!(
            result.is_err(),
            "the write open refuses a final symlink (append: {append})"
        );
        assert!(
            fs::symlink_metadata(part).unwrap().file_type().is_symlink(),
            "the link itself is left for the caller to remove"
        );
        match before {
            Some(bytes) => assert_eq!(fs::read(target).unwrap(), bytes),
            None => assert!(!target.exists(), "a dangling link's target is not created"),
        }
    }

    #[test]
    fn write_open_does_not_follow_a_symlink_to_an_existing_file() {
        for append in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let target = root.path().join("victim");
            fs::write(&target, b"keep").unwrap();
            let part = root.path().join("artifact.part");
            if !symlink(&target, &part) {
                return;
            }
            assert_not_followed(&part, &target, Some(b"keep"), append);
        }
    }

    #[test]
    fn write_open_does_not_follow_a_dangling_symlink() {
        for append in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let target = root.path().join("elsewhere");
            let part = root.path().join("artifact.part");
            if !symlink(&target, &part) {
                return;
            }
            assert_not_followed(&part, &target, None, append);
        }
    }

    #[test]
    fn write_open_creates_truncates_and_appends_a_regular_file() {
        let root = tempfile::tempdir().unwrap();
        let part = root.path().join("artifact.part");
        open_partial_write(&part, false)
            .unwrap()
            .write_all(b"abc")
            .unwrap();
        open_partial_write(&part, true)
            .unwrap()
            .write_all(b"def")
            .unwrap();
        assert_eq!(fs::read(&part).unwrap(), b"abcdef");
        open_partial_write(&part, false)
            .unwrap()
            .write_all(b"x")
            .unwrap();
        assert_eq!(fs::read(&part).unwrap(), b"x");
    }
}
