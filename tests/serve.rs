use k_carrier::{Result, serve::serve_runner};
use std::sync::atomic::{AtomicUsize, Ordering};
#[tokio::test]
async fn invalid_wire_input_cannot_construct_an_adapter() -> Result<()> {
    let calls = AtomicUsize::new(0);
    for input in [
        b"not-json".to_vec(),
        br#"{"protocolVersion":2,"action":"status"}"#.to_vec(),
        vec![b' '; 16385],
    ] {
        let mut output = vec![];
        let code = serve_runner(
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err(k_carrier::error::invalid("should not create"))
            },
            input.as_slice(),
            &mut output,
        )
        .await?;
        assert_eq!(code, 1);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let response: serde_json::Value = serde_json::from_slice(&output)?;
        assert_eq!(response["exitCode"], 1);
        assert!(
            response.get("operation").is_none(),
            "parser errors cannot manufacture receipts"
        );
    }
    Ok(())
}
