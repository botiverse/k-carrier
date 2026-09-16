//! Independently supervised runner for native-service and native-controller.
//! Configuration is trusted installer input, never part of the runner request.
use k_carrier::{
    Result,
    error::invalid,
    host::CommandHost,
    protocol::Request,
    runner::Runner,
    serve::serve_runner,
    source::StaticManifestSource,
    storage::{FileStore, bootstrap_stable},
    supervisor::{LaunchOptions, supervise_bytes},
};
use std::{path::PathBuf, sync::Arc};
use tokio::io::AsyncReadExt;
fn setting(name: &str) -> Result<String> {
    std::env::var(name).map_err(|_| invalid(format!("{name} required")))
}
async fn runner() -> Result<Runner> {
    let root = PathBuf::from(setting("K_EXAMPLE_ROOT")?);
    let mut host = CommandHost::new(
        vec![setting("K_EXAMPLE_CONTROLLER")?],
        root.join("state"),
        10000,
    )?;
    host.cwd = Some(root.clone());
    Runner::new(
        FileStore::new(root.join("state")),
        Arc::new(host),
        Arc::new(StaticManifestSource::new(setting("K_RELEASE_BASE")?)?),
    )
}
#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let root = PathBuf::from(setting("K_EXAMPLE_ROOT")?);
    if !root.is_absolute() {
        return Err(invalid("absolute K_EXAMPLE_ROOT required"));
    }
    std::fs::create_dir_all(&root)?;
    if args.first().map(String::as_str) == Some("bootstrap") && args.len() == 3 {
        bootstrap_stable(&root.join("state"), &args[1], &PathBuf::from(&args[2]))?;
        use k_carrier::host::Host;
        let mut host = CommandHost::new(
            vec![setting("K_EXAMPLE_CONTROLLER")?],
            root.join("state"),
            10000,
        )?;
        host.cwd = Some(root);
        host.start(k_carrier::state::Slot::Stable).await?;
        return Ok(());
    }
    if std::env::var_os("K_EXAMPLE_WORKER").is_some() {
        let code = serve_runner(runner, tokio::io::stdin(), tokio::io::stdout()).await?;
        std::process::exit(code as i32);
    }
    let mut input = vec![];
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tokio::io::stdin().take(16385).read_to_end(&mut input),
    )
    .await
    .map_err(|_| invalid("RUNNER_INPUT_TIMEOUT"))??;
    let request = Request::parse(&input)?;
    let mut options = LaunchOptions::default();
    options.env.insert("K_EXAMPLE_WORKER".into(), "1".into());
    let result = supervise_bytes(
        &std::fs::read(std::env::current_exe()?)?,
        &request,
        &root.join("workers"),
        &options,
    )
    .await?;
    println!("{}", serde_json::to_string(&result)?);
    std::process::exit(result.exit_code as i32);
}
