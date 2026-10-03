use std::borrow::Cow;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
pub(super) struct Envelope {
    pub(super) r#type: String,
    #[serde(default)]
    pub(super) id: Option<String>,
    #[serde(default)]
    pub(super) payload: Value,
}

#[derive(Debug, Serialize)]
pub(super) struct Outbound {
    pub(super) r#type: Cow<'static, str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) id: Option<String>,
    pub(super) payload: Value,
}

impl Outbound {
    pub(super) fn event(
        r#type: impl Into<Cow<'static, str>>,
        id: Option<String>,
        payload: Value,
    ) -> Self {
        Self {
            r#type: r#type.into(),
            id,
            payload,
        }
    }
}
