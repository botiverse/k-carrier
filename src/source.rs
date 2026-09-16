//! Optional static-file release policy. Applications with another release
//! scheme implement `ReleaseSource` directly; this format is not engine law.
use crate::{
    Result,
    artifact::{Release, ReleaseContext, ReleaseSource},
    error::invalid,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, time::Duration};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestTarget {
    pub file: String,
    pub sha256: String,
    pub size: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub version: String,
    pub targets: BTreeMap<String, ManifestTarget>,
}
impl Manifest {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let manifest: Self =
            serde_json::from_slice(bytes).map_err(|_| invalid("MANIFEST_INVALID"))?;
        if manifest.version.trim().is_empty() || manifest.targets.is_empty() {
            return Err(invalid("MANIFEST_INVALID"));
        }
        for target in manifest.targets.values() {
            if target.file.trim().is_empty() {
                return Err(invalid("MANIFEST_INVALID"));
            }
            Release {
                version: manifest.version.clone(),
                url: target.file.clone(),
                sha256: target.sha256.clone(),
                size: target.size,
                gzip: None,
            }
            .validate()?;
        }
        Ok(manifest)
    }
    fn release(&self, base: &str, platform: &str) -> Result<Release> {
        let target = self
            .targets
            .get(platform)
            .ok_or_else(|| invalid("UNSUPPORTED_PLATFORM"))?;
        Ok(Release {
            version: self.version.clone(),
            url: format!("{}/{}", base.trim_end_matches('/'), target.file),
            sha256: target.sha256.clone(),
            size: target.size,
            gzip: None,
        })
    }
}
pub struct StaticManifestSource {
    base: String,
    pub client: reqwest::Client,
    pub timeout: Duration,
    pub maximum_manifest_bytes: usize,
}
impl StaticManifestSource {
    pub fn new(base: impl Into<String>) -> Result<Self> {
        let base = base.into();
        let url = reqwest::Url::parse(&base).map_err(|_| invalid("MANIFEST_URL_INVALID"))?;
        if !["http", "https"].contains(&url.scheme()) {
            return Err(invalid("MANIFEST_URL_INVALID"));
        }
        Ok(Self {
            base,
            client: reqwest::Client::builder().build()?,
            timeout: Duration::from_secs(30),
            maximum_manifest_bytes: 1024 * 1024,
        })
    }
    async fn manifest(&self) -> Result<Manifest> {
        tokio::time::timeout(self.timeout, async {
            let mut response = self
                .client
                .get(format!("{}/manifest.json", self.base.trim_end_matches('/')))
                .send()
                .await?;
            if !response.status().is_success() {
                return Err(invalid("DOWNLOAD_FAILED: manifest status"));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await? {
                if bytes.len().saturating_add(chunk.len()) > self.maximum_manifest_bytes {
                    return Err(invalid("MANIFEST_INVALID: too large"));
                }
                bytes.extend_from_slice(&chunk);
            }
            Manifest::parse(&bytes)
        })
        .await
        .map_err(|_| invalid("DOWNLOAD_FAILED: manifest timeout"))?
    }
}
// Preserve the static source's existing dotted-numeric policy: prereleases are
// below their release, and two prereleases with the same core compare equal.
fn newer(a: &str, b: &str) -> bool {
    let parts = |v: &str| {
        v.split('-')
            .next()
            .unwrap_or("")
            .split('.')
            .map(|s| s.parse::<i128>().unwrap_or(0))
            .collect::<Vec<_>>()
    };
    let (a_parts, b_parts) = (parts(a), parts(b));
    for i in 0..a_parts.len().max(b_parts.len()) {
        let cmp = a_parts
            .get(i)
            .unwrap_or(&0)
            .cmp(b_parts.get(i).unwrap_or(&0));
        if !cmp.is_eq() {
            return cmp.is_gt();
        }
    }
    !a.contains('-') && b.contains('-')
}
#[async_trait]
impl ReleaseSource for StaticManifestSource {
    async fn check(&self, context: &ReleaseContext) -> Result<Option<Release>> {
        let manifest = self.manifest().await?;
        if !newer(&manifest.version, &context.current_version) {
            return Ok(None);
        }
        manifest
            .release(&self.base, &context.platform_key)
            .map(Some)
    }
    async fn fetch(&self, version: &str, context: &ReleaseContext) -> Result<Release> {
        let manifest = self.manifest().await?;
        if manifest.version != version {
            return Err(invalid("PINNED_VERSION_MISMATCH"));
        }
        manifest.release(&self.base, &context.platform_key)
    }
}
