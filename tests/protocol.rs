use k_carrier::protocol::Request;
use serde_json::{Value, json};
#[test]
fn incomplete_nullable_receipts_cannot_authorize_supervisor_completion() {
    use k_carrier::protocol::Response;
    let receipt = json!({"formatVersion":1,"id":"op","startedAtMs":1,"updatedAtMs":2,
        "fromVersion":"1","targetVersion":"2","previousStableVersion":"1","phase":"promoted",
        "outcome":"promoted","reason":null,"provenance":null,"metadata":{}});
    let response = json!({"protocolVersion":1,"action":"upgrade","exitCode":0,"result":"promoted",
        "operation":{"kind":"observed","operation":receipt},"error":null});
    assert!(Response::parse(&serde_json::to_vec(&response).unwrap()).is_ok());
    for field in ["outcome", "reason", "provenance"] {
        let mut corrupt = response.clone();
        corrupt["operation"]["operation"]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(
            Response::parse(&serde_json::to_vec(&corrupt).unwrap()).is_err(),
            "{field}"
        );
    }
    let mut corrupt = response;
    corrupt.as_object_mut().unwrap().remove("error");
    assert!(Response::parse(&serde_json::to_vec(&corrupt).unwrap()).is_err());
}
#[test]
fn strict_request_boundary_rejects_unknown_fields_versions_and_types() {
    for value in [
        json!({"protocolVersion":1,"action":"status"}),
        json!({"protocolVersion":1,"action":"recover"}),
        json!({"protocolVersion":1,"action":"recover","expected":{"id":"op","targetVersion":"2"}}),
        json!({"protocolVersion":1,"action":"upgrade","id":"op","targetVersion":"2","consented":true}),
    ] {
        let bytes = serde_json::to_vec(&value).unwrap();
        let r = Request::parse(&bytes).unwrap();
        assert_eq!(serde_json::to_value(r).unwrap(), value);
    }
    for value in [
        Value::Null,
        json!([]),
        json!({"protocolVersion":2,"action":"status"}),
        json!({"protocolVersion":1,"action":"status","url":"https://evil.invalid"}),
        json!({"protocolVersion":1,"action":"recover","expected":null}),
        json!({"protocolVersion":1,"action":"recover","expected":{"id":"x","targetVersion":"2","unknown":true}}),
        json!({"protocolVersion":1,"action":"upgrade","id":" ","targetVersion":"2","consented":true}),
        json!({"protocolVersion":1,"action":"upgrade","id":"op","targetVersion":"2","consented":1}),
    ] {
        assert!(
            Request::parse(&serde_json::to_vec(&value).unwrap()).is_err(),
            "{value}"
        );
    }
}
