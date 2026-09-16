//! A CLI can use verified transfer and atomic self replacement without a Host.
//! Service installations should use Runner and the two-slot transaction instead.
use k_carrier::{
    Result,
    artifact::{Downloader, ReleaseContext, ReleaseSource, atomic_write_file},
    runner::platform_key,
    source::StaticManifestSource,
};
#[tokio::main]
async fn main() -> Result<()> {
    let version = option_env!("K_EXAMPLE_VERSION").unwrap_or("1.0.0");
    match std::env::args().nth(1).as_deref() {
        Some("--version") => println!("{version}"),
        Some("upgrade") => {
            let source = StaticManifestSource::new(
                std::env::var("K_RELEASE_BASE")
                    .map_err(|_| k_carrier::error::invalid("K_RELEASE_BASE required"))?,
            )?;
            let context = ReleaseContext {
                current_version: version.into(),
                platform_key: platform_key(),
            };
            let release = source
                .check(&context)
                .await?
                .ok_or_else(|| k_carrier::error::invalid("no newer release"))?;
            let work = tempfile::tempdir()?;
            let artifact = Downloader::new()?
                .download(&release, Some(work.path()), None)
                .await?;
            atomic_write_file(&std::env::current_exe()?, &artifact)?;
        }
        _ => return Err(k_carrier::error::invalid("expected --version or upgrade")),
    }
    Ok(())
}
