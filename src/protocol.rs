use crate::{Result, error::invalid, state::OperationRead};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Expected {
    pub id: String,
    pub target_version: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
pub enum Request {
    Upgrade {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        id: String,
        #[serde(rename = "targetVersion")]
        target_version: String,
        consented: bool,
    },
    Recover {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        expected: Option<Expected>,
    },
    Status {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
    },
}
fn text(value: &str) -> bool {
    !value.is_empty() && value.trim() == value && value.encode_utf16().count() <= 256
}
impl Request {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > 65536 {
            return Err(invalid("RUNNER_PROTOCOL_INVALID: request too large"));
        }
        let value: Value = serde_json::from_slice(bytes)?;
        if value.get("protocolVersion") != Some(&Value::from(1)) {
            return Err(invalid("RUNNER_PROTOCOL_UNSUPPORTED"));
        }
        if value.get("expected") == Some(&Value::Null) {
            return Err(invalid("RUNNER_PROTOCOL_INVALID: null expected"));
        }
        let request: Self = serde_json::from_value(value)?;
        request.validate()?;
        Ok(request)
    }
    pub fn action(&self) -> &'static str {
        match self {
            Self::Upgrade { .. } => "upgrade",
            Self::Recover { .. } => "recover",
            Self::Status { .. } => "status",
        }
    }
    pub fn validate(&self) -> Result<()> {
        let (version, identity) = match self {
            Self::Upgrade {
                protocol_version,
                id,
                target_version,
                ..
            } => (*protocol_version, Some((id, target_version))),
            Self::Recover {
                protocol_version,
                expected,
            } => (
                *protocol_version,
                expected.as_ref().map(|e| (&e.id, &e.target_version)),
            ),
            Self::Status { protocol_version } => (*protocol_version, None),
        };
        if version != 1 {
            return Err(invalid("RUNNER_PROTOCOL_UNSUPPORTED"));
        }
        if identity.is_some_and(|(id, target)| !text(id) || !text(target)) {
            return Err(invalid("RUNNER_PROTOCOL_INVALID: invalid identity"));
        }
        Ok(())
    }
    pub fn expected(&self) -> Option<Expected> {
        match self {
            Self::Upgrade {
                id, target_version, ..
            } => Some(Expected {
                id: id.clone(),
                target_version: target_version.clone(),
            }),
            Self::Recover { expected, .. } => expected.clone(),
            Self::Status { .. } => None,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub protocol_version: u32,
    pub action: String,
    pub exit_code: u8,
    pub result: String,
    pub operation: OperationRead,
    #[serde(deserialize_with = "crate::state::required_nullable")]
    pub error: Option<String>,
}
impl Response {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > 65536 {
            return Err(invalid("RUNNER_RESPONSE_INVALID: response too large"));
        }
        let response: Self = serde_json::from_slice(bytes)?;
        if response.protocol_version != 1
            || !["upgrade", "recover", "status"].contains(&response.action.as_str())
            || response.exit_code > 3
        {
            return Err(invalid("RUNNER_RESPONSE_INVALID"));
        }
        if let OperationRead::Observed { operation } = &response.operation {
            operation.validate()?;
        }
        Ok(response)
    }
}
