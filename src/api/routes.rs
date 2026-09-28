use axum::{
    extract::{ws::WebSocketUpgrade, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::watch;

use crate::core::HivemindCore;

use super::{error::ApiError, websocket};

#[derive(Clone)]
struct ApiState {
    core: Arc<HivemindCore>,
    shutdown: watch::Receiver<bool>,
}

pub(super) fn router(core: Arc<HivemindCore>, shutdown: watch::Receiver<bool>) -> Router {
    let state = ApiState { core, shutdown };
    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/info", get(info))
        .route("/api/v1/agents", get(agents))
        .route("/api/v1/ws", get(ws))
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .with_state(state)
}

#[derive(Serialize)]
struct Health {
    status: &'static str,
    service: &'static str,
}

async fn health() -> Json<Health> {
    Json(Health {
        status: "ok",
        service: "hivemind",
    })
}

#[derive(Serialize)]
struct Info {
    name: &'static str,
    version: &'static str,
    api_version: &'static str,
    websocket: &'static str,
}

async fn info() -> Json<Info> {
    Json(Info {
        name: "hivemind",
        version: env!("CARGO_PKG_VERSION"),
        api_version: "v1",
        websocket: "/api/v1/ws",
    })
}
#[derive(Serialize)]
struct AgentMetadata {
    name: String,
    runtime: String,
}

#[derive(Serialize)]
struct Agents {
    agents: Vec<AgentMetadata>,
}

async fn agents(State(state): State<ApiState>) -> Json<Agents> {
    // Own only explicitly safe metadata; never serialize AgentConfig wholesale.
    let agents = state
        .core
        .agents()
        .list()
        .into_iter()
        .map(|agent| AgentMetadata {
            name: agent.name,
            runtime: agent.runtime,
        })
        .collect();
    Json(Agents { agents })
}

async fn ws(State(state): State<ApiState>, upgrade: WebSocketUpgrade) -> Response {
    upgrade
        .max_message_size(64 * 1024)
        .on_upgrade(move |socket| websocket::handle(socket, state.core, state.shutdown))
}

async fn not_found() -> Response {
    ApiError::new(StatusCode::NOT_FOUND, "not_found", "route not found").into_response()
}

async fn method_not_allowed() -> Response {
    ApiError::new(
        StatusCode::METHOD_NOT_ALLOWED,
        "method_not_allowed",
        "method not allowed",
    )
    .into_response()
}

#[cfg(test)]
mod tests {
    use crate::config::HivemindConfig;
    use super::*;
    use axum::{
        body::Body,
        http::{header::CONTENT_TYPE, Request},
    };
    use futures_util::{SinkExt, StreamExt};
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use std::{
        net::SocketAddr,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        sync::Arc,
        time::Duration,
    };
    use tokio::{net::TcpListener, sync::watch, task::JoinHandle};
    use tokio_tungstenite::{connect_async, tungstenite::Message};
    use tower::ServiceExt;

    static TEMP_ID: AtomicU64 = AtomicU64::new(0);

    struct TestCore {
        core: Arc<HivemindCore>,
        directory: PathBuf,
    }

    impl TestCore {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "hivemind-api-test-{}-{}",
                std::process::id(),
                TEMP_ID.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&directory).unwrap();
            let config_path = directory.join("hivemind.toml");
            let core = HivemindCore::new(HivemindConfig::default_poc(), &config_path).unwrap();
            Self { core: Arc::new(core), directory }
        }
    }

    impl Drop for TestCore {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    async fn request(app: Router, method: &str, path: &str) -> (StatusCode, String, Value) {
        let response = app
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let content_type = response.headers()[CONTENT_TYPE]
            .to_str()
            .unwrap()
            .to_owned();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let value = serde_json::from_slice(&body).unwrap();
        (status, content_type, value)
    }

    #[tokio::test]
    async fn health_info_agents_and_json_errors_are_stable_and_safe() {
        let test_core = TestCore::new();
        let app = router(test_core.core.clone(), watch::channel(false).1);
        let (status, content_type, health) = request(app.clone(), "GET", "/api/v1/health").await;
        assert_eq!(status, StatusCode::OK);
        assert!(content_type.starts_with("application/json"));
        assert_eq!(health, json!({"status":"ok","service":"hivemind"}));

        let (_, _, info) = request(app.clone(), "GET", "/api/v1/info").await;
        assert_eq!(info["name"], "hivemind");
        assert_eq!(info["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(info["api_version"], "v1");
        assert_eq!(info["websocket"], "/api/v1/ws");

        let (_, _, agents) = request(app.clone(), "GET", "/api/v1/agents").await;
        assert_eq!(
            agents["agents"],
            json!([
                {"name":"Maomao","runtime":"pi"},
                {"name":"Albedo","runtime":"pi"}
            ])
        );
        let serialized = agents.to_string();
        for secret_field in [
            "system_prompt",
            "workspace",
            "model",
            "reasoning",
            "fast",
            "api_key",
        ] {
            assert!(!serialized.contains(secret_field));
        }

        let (status, content_type, not_found) =
            request(app.clone(), "GET", "/api/v1/missing").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(content_type.starts_with("application/json"));
        assert_eq!(
            not_found,
            json!({"error":{"code":"not_found","message":"route not found"}})
        );

        let (status, content_type, method_error) = request(app, "POST", "/api/v1/health").await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        assert!(content_type.starts_with("application/json"));
        assert_eq!(method_error["error"]["code"], "method_not_allowed");
    }

    async fn websocket_server() -> (SocketAddr, watch::Sender<bool>, JoinHandle<()>, TestCore) {
        let test_core = TestCore::new();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let app = router(test_core.core.clone(), shutdown_rx);
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (address, shutdown_tx, task, test_core)
    }

    async fn receive_json(
        socket: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    ) -> Value {
        let message = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let Message::Text(text) = message else {
            panic!("expected JSON WebSocket text message")
        };
        serde_json::from_str(text.as_str()).unwrap()
    }

    #[tokio::test]
    async fn websocket_protocol_supports_ready_ping_errors_and_independent_clients() {
        let (address, shutdown, server, test_core) = websocket_server().await;
        let endpoint = format!("ws://{address}/api/v1/ws");
        let (mut first, response) = connect_async(&endpoint).await.unwrap();
        assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
        let ready = receive_json(&mut first).await;
        assert_eq!(ready["type"], "system.ready");
        assert_eq!(ready["payload"]["service"], "hivemind");
        assert_eq!(ready["payload"]["protocol_version"], 1);

        let (mut second, _) = connect_async(&endpoint).await.unwrap();
        assert_eq!(receive_json(&mut second).await["type"], "system.ready");
        test_core.core.events().publish(
            crate::events::DomainEventKind::TurnStarted {
                room_id: "room-safe".into(),
                turn_id: "turn-safe".into(),
            },
        );
        for socket in [&mut first, &mut second] {
            let event = receive_json(socket).await;
            assert_eq!(event["type"], "conversation.turn.started");
            assert_eq!(event["payload"]["event_version"], 1);
            assert_eq!(event["payload"]["room_id"], "room-safe");
            assert_eq!(event["payload"]["turn_id"], "turn-safe");
            assert!(event["payload"].get("agent_id").is_none());
        }
        test_core.core.events().publish(
            crate::events::DomainEventKind::TurnCompleted {
                room_id: "room-safe".into(),
                turn_id: "turn-safe".into(),
                reply_count: 1,
            },
        );
        for socket in [&mut first, &mut second] {
            let event = receive_json(socket).await;
            assert_eq!(event["type"], "conversation.turn.completed");
            assert_eq!(event["payload"]["reply_count"], 1);
            assert_eq!(event["payload"]["room_id"], "room-safe");
            assert_eq!(event["payload"]["turn_id"], "turn-safe");
        }
        test_core.core.events().publish(
            crate::events::DomainEventKind::AgentReplyFailed {
                room_id: "room-safe".into(),
                turn_id: "turn-safe".into(),
                agent_id: "internal-agent".into(),
                instance_id: "instance-safe".into(),
                error_code: "provider_failure".into(),
                message: "private provider detail".into(),
            },
        );
        for socket in [&mut first, &mut second] {
            let event = receive_json(socket).await;
            assert_eq!(event["type"], "agent.reply.failed");
            assert_eq!(event["payload"]["agent_instance_id"], "instance-safe");
            assert!(!event.to_string().contains("private provider detail"));
            assert_eq!(event["payload"]["room_id"], "room-safe");
            assert!(!event.to_string().contains("provider_failure"));
            assert!(event["payload"].get("agent_id").is_none());
            assert!(event["payload"].get("error_code").is_none());
        }
        test_core.core.events().publish(
            crate::events::DomainEventKind::RuntimeStarted {
                agent_id: "internal-agent".into(),
                instance_id: "instance-safe".into(),
                runtime: "pi".into(),
            },
        );
        for socket in [&mut first, &mut second] {
            let event = receive_json(socket).await;
            assert_eq!(event["type"], "runtime.started");
            assert_eq!(event["payload"]["agent_instance_id"], "instance-safe");
            assert_eq!(event["payload"]["runtime"], "pi");
            assert!(event["payload"].get("agent_id").is_none());
        }
        first
            .send(Message::Text(
                r#"{"type":"system.ping","id":"first-1","payload":{}}"#.into(),
            ))
            .await
            .unwrap();
        assert_eq!(
            receive_json(&mut first).await,
            json!({"type":"system.pong","id":"first-1","payload":{}})
        );
        second
            .send(Message::Text(
                r#"{"type":"system.ping","id":"second-2","payload":{}}"#.into(),
            ))
            .await
            .unwrap();
        assert_eq!(
            receive_json(&mut second).await,
            json!({"type":"system.pong","id":"second-2","payload":{}})
        );

        first.send(Message::Text("not-json".into())).await.unwrap();
        assert_eq!(
            receive_json(&mut first).await,
            json!({
                "type":"system.error",
                "payload":{"code":"malformed_message","message":"invalid websocket JSON envelope"}
            })
        );
        first
            .send(Message::Text(
                r#"{"type":"conversation.start","id":"unknown","payload":{}}"#.into(),
            ))
            .await
            .unwrap();
        assert_eq!(
            receive_json(&mut first).await,
            json!({
                "type":"system.error",
                "id":"unknown",
                "payload":{"code":"unsupported_message","message":"unsupported websocket message type"}
            })
        );
        first
            .send(Message::Text(
                r#"{"type":"system.ping","id":"still-open","payload":{}}"#.into(),
            ))
            .await
            .unwrap();
        assert_eq!(receive_json(&mut first).await["id"], "still-open");

        let _ = shutdown.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(2), first.next()).await;
        let _ = tokio::time::timeout(Duration::from_secs(2), second.next()).await;
        server.abort();
    }
    #[tokio::test]
    async fn websocket_reports_broadcast_lag_as_refresh_required() {
        let (address, shutdown, server, test_core) = websocket_server().await;
        let endpoint = format!("ws://{address}/api/v1/ws");
        let (mut socket, _) = connect_async(&endpoint).await.unwrap();
        assert_eq!(receive_json(&mut socket).await["type"], "system.ready");

        for _ in 0..300 {
            test_core.core.events().publish(
                crate::events::DomainEventKind::TurnStarted {
                    room_id: "room".into(),
                    turn_id: "turn".into(),
                },
            );
        }

        let lagged = receive_json(&mut socket).await;
        assert_eq!(lagged["type"], "system.events_lagged");
        assert!(lagged["payload"]["missed_count"].as_u64().unwrap() > 0);
        assert_eq!(lagged["payload"]["refresh_required"], true);

        let _ = shutdown.send(true);
        server.abort();
    }
}
