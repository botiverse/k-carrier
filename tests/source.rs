use k_carrier::{
    Result,
    artifact::{ReleaseContext, ReleaseSource, sha256},
    source::{Manifest, StaticManifestSource},
};
use serde_json::json;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[test]
fn malformed_manifest_cannot_supply_unchecked_artifact_identity() {
    let good = json!({"version":"2.0.0","targets":{"test":{"file":"artifact","sha256":sha256(b"x"),"size":1}}});
    assert!(Manifest::parse(&serde_json::to_vec(&good).unwrap()).is_ok());
    for bad in [
        json!(null),
        json!({"version":" ","targets":{}}),
        json!({"version":"2","targets":{"test":{"file":"x","sha256":"invalid","size":1}}}),
        json!({"version":"2","targets":{"test":{"file":"x","sha256":sha256(b"x"),"size":-1}}}),
    ] {
        assert!(Manifest::parse(&serde_json::to_vec(&bad).unwrap()).is_err());
    }
}
#[tokio::test]
async fn static_source_pins_versions_and_limits_real_http_manifests() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}", listener.local_addr()?);
    let body = Arc::new(Mutex::new(serde_json::to_vec(
        &json!({"version":"2.0.0","targets":{"test":{"file":"artifact","sha256":sha256(b"x"),"size":1}}}),
    )?));
    let shared = body.clone();
    let server = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let body = shared.lock().unwrap().clone();
            tokio::spawn(async move {
                let mut request = [0; 8192];
                let n = stream.read(&mut request).await.unwrap();
                assert!(String::from_utf8_lossy(&request[..n]).starts_with("GET /manifest.json "));
                if body == b"stall" {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
                let _ = stream
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await;
                let _ = stream.write_all(&body).await;
            });
        }
    });
    let result = async {
        let mut source = StaticManifestSource::new(base.clone())?;
        // A loopback fixture must not escape through the developer/CI proxy.
        // Environment proxy behavior has its own isolated real-process test.
        source.client = reqwest::Client::builder().no_proxy().build()?;
        let mut ctx = ReleaseContext {
            current_version: "1.0.0".into(),
            platform_key: "test".into(),
        };
        assert_eq!(
            source.check(&ctx).await?.unwrap().url,
            format!("{base}/artifact")
        );
        assert!(source.fetch("1.0.0", &ctx).await.is_err());
        assert_eq!(source.fetch("2.0.0", &ctx).await?.size, 1);
        for version in ["2.0.0", "3.0.0"] {
            ctx.current_version = version.into();
            assert!(source.check(&ctx).await?.is_none());
        }
        ctx.current_version = "2.0.0-rc.1".into();
        assert!(source.check(&ctx).await?.is_some());
        ctx.platform_key = "missing".into();
        assert!(source.fetch("2.0.0", &ctx).await.is_err());
        source.maximum_manifest_bytes = 4;
        assert!(source.fetch("2.0.0", &ctx).await.is_err());
        *body.lock().unwrap() = b"stall".to_vec();
        source.timeout = Duration::from_millis(40);
        assert!(
            source
                .fetch("2.0.0", &ctx)
                .await
                .unwrap_err()
                .to_string()
                .contains("timeout")
        );
        Ok::<_, k_carrier::Error>(())
    }
    .await;
    server.abort();
    result
}
