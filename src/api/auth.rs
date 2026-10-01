//! Operator authentication. Secrets are loaded from an environment variable,
//! never accepted in query strings, config responses, or event frames.
use super::{error::ApiError, routes::ApiState};
use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    pub bind: std::net::IpAddr,
    pub token_env: Option<String>,
    pub allowed_origins: Vec<String>,
}
impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1".parse().unwrap(),
            token_env: None,
            allowed_origins: Vec::new(),
        }
    }
}
pub struct Auth {
    token: Option<String>,
    origins: Vec<String>,
}
impl Auth {
    pub fn load(config: &ServerConfig) -> anyhow::Result<Arc<Self>> {
        let token = match &config.token_env {
            Some(name) => {
                let value = std::env::var(name)
                    .map_err(|_| anyhow::anyhow!("server.token_env variable is not set"))?;
                anyhow::ensure!(value.len() >= 32 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'), "operator token must contain at least 32 alphanumeric, hyphen, or underscore characters");
                Some(value)
            }
            None => None,
        };
        anyhow::ensure!(
            config.bind.is_loopback() || token.is_some(),
            "non-loopback bind requires server.token_env"
        );
        Ok(Arc::new(Self {
            token,
            origins: config.allowed_origins.clone(),
        }))
    }
    pub fn enabled(&self) -> bool {
        self.token.is_some()
    }
    fn accepts(&self, supplied: &str) -> bool {
        let Some(expected) = &self.token else {
            return true;
        };
        let a = expected.as_bytes();
        let b = supplied.as_bytes();
        let mut different = a.len() ^ b.len();
        for (i, byte) in a.iter().enumerate() {
            different |= usize::from(*byte ^ b.get(i).copied().unwrap_or(0));
        }
        different == 0
    }
    pub fn origin_allowed(&self, origin: &str) -> bool {
        self.origins.iter().any(|allowed| allowed == origin)
    }
}

pub(super) async fn layer(State(state): State<ApiState>, request: Request, next: Next) -> Response {
    let origin = request
        .headers()
        .get("origin")
        .and_then(|h| h.to_str().ok());
    if state.auth.enabled() {
        // Origins are validated even on a credentialed WebSocket handshake.
        if origin.is_some_and(|o| !state.auth.origin_allowed(o)) {
            return ApiError::new(
                StatusCode::FORBIDDEN,
                "origin_denied",
                "origin is not allowed",
            )
            .into_response();
        }
        if request.method() != axum::http::Method::OPTIONS {
            let supplied = request
                .headers()
                .get("authorization")
                .and_then(|h| h.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer "));
            // Browser WebSockets cannot set Authorization; use a dedicated subprotocol.
            let supplied = supplied.or_else(|| {
                (request.uri().path() == "/api/v1/ws")
                    .then(|| {
                        request
                            .headers()
                            .get("sec-websocket-protocol")
                            .and_then(|h| h.to_str().ok())
                            .and_then(|h| {
                                h.split(',')
                                    .map(str::trim)
                                    .find_map(|p| p.strip_prefix("hivemind.auth."))
                            })
                    })
                    .flatten()
            });
            if !supplied.is_some_and(|t| state.auth.accepts(t)) {
                return ApiError::new(
                    StatusCode::UNAUTHORIZED,
                    "unauthorized",
                    "operator authentication required",
                )
                .into_response();
            }
        }
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn comparison_and_remote_bind_fail_closed() {
        let auth = Auth {
            token: Some("a".repeat(32)),
            origins: vec!["https://ui.example".into()],
        };
        assert!(auth.accepts(&"a".repeat(32)));
        assert!(!auth.accepts(&"a".repeat(31)));
        assert!(!auth.accepts(&"b".repeat(32)));
        assert!(auth.origin_allowed("https://ui.example"));
        assert!(!auth.origin_allowed("https://ui.example.evil"));
        assert!(Auth::load(&ServerConfig {
            bind: "0.0.0.0".parse().unwrap(),
            ..Default::default()
        })
        .is_err());
    }
}
