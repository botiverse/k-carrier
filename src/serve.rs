//! Bounded runner stdin/stdout protocol. A parsed request cannot select code.
use crate::{Result, error::invalid, protocol::Request, runner::Runner};
use std::{future::Future, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
pub async fn serve_runner<R, W, F, Fut>(create: F, input: R, mut output: W) -> Result<u8>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Runner>>,
{
    crate::host::isolate_standard_handles()?;
    let response = async {
        let mut bytes = Vec::new();
        tokio::time::timeout(
            Duration::from_secs(30),
            input.take(16385).read_to_end(&mut bytes),
        )
        .await
        .map_err(|_| invalid("RUNNER_INPUT_TIMEOUT"))??;
        if bytes.len() > 16384 {
            return Err(invalid("RUNNER_REQUEST_TOO_LARGE"));
        }
        let request = Request::parse(&bytes)?;
        let response = create().await?.execute(&request).await?;
        Ok((response.exit_code, serde_json::to_vec(&response)?))
    }
    .await;
    let (code, mut bytes) = response.unwrap_or_else(|e: crate::Error| {
        (
            1,
            serde_json::to_vec(&serde_json::json!({
                "protocolVersion":1,"result":"failed","exitCode":1,"error":e.to_string()
            }))
            .expect("serializing JSON strings cannot fail"),
        )
    });
    bytes.push(b'\n');
    output.write_all(&bytes).await?;
    output.flush().await?;
    Ok(code)
}
