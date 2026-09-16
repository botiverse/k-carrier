//! Deterministic failure corpus, merged under the same exclusive K lock.
use crate::{Result, error::invalid, lock::UpgradeLock, storage::write_json};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::Path};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Failure {
    pub seed: u32,
    pub failure: String,
    pub replay: String,
    pub transcript_sha256: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Corpus {
    format_version: u8,
    failures: Vec<Failure>,
}
pub fn record_failures(path: &Path, failures: &[Failure]) -> Result<()> {
    if failures.is_empty() {
        return Ok(());
    }
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(dir)?;
    let lock_dir = dir.join(format!(
        ".corpus-lock-{}",
        crate::artifact::sha256(
            path.file_name()
                .ok_or_else(|| invalid("CORPUS_PATH_INVALID"))?
                .as_encoded_bytes()
        )
    ));
    let mut lock = UpgradeLock::acquire(&lock_dir)?;
    let mut merged = BTreeMap::new();
    match fs::read(path) {
        Ok(bytes) => {
            let corpus: Corpus = serde_json::from_slice(&bytes)?;
            if corpus.format_version != 1 {
                return Err(invalid("CORPUS_FORMAT_UNSUPPORTED"));
            }
            for f in corpus.failures {
                merged.insert((f.seed, f.transcript_sha256.clone()), f);
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    for f in failures {
        merged.insert((f.seed, f.transcript_sha256.clone()), f.clone());
    }
    write_json(
        path,
        &Corpus {
            format_version: 1,
            failures: merged.into_values().collect(),
        },
    )?;
    lock.release()?;
    // Keep the empty shared lock namespace: removing it can race a new claimant.
    Ok(())
}
