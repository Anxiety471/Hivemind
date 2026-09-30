use axum::{
    extract::{rejection::JsonRejection, ws::WebSocketUpgrade, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::watch;

use crate::core::{ConversationTarget, CoreError, HivemindCore, TargetResolutionError};

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
        .route("/api/v1/turns", post(submit_turn))
        .route("/api/v1/ws", get(ws))
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .with_state(state)
}

#[derive(Deserialize)]
struct TurnRequestBody {
    target: TurnTargetBody,
    message: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TurnTargetBody {
    Main,
    Solo { id: String },
    Group { id: String },
}

#[derive(Serialize)]
struct TurnResponse {
    turn_id: String,
    room_id: String,
    replies: Vec<TurnReplyBody>,
}

#[derive(Serialize)]
struct TurnReplyBody {
    persona_id: String,
    ok: bool,
    content: String,
}

async fn submit_turn(
    State(state): State<ApiState>,
    payload: std::result::Result<Json<TurnRequestBody>, JsonRejection>,
) -> Response {
    let Json(request) = match payload {
        Ok(request) => request,
        Err(_) => {
            return ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_json",
                "invalid request body",
            )
            .into_response()
        }
    };
    let target = match request.target {
        TurnTargetBody::Main => ConversationTarget::Main,
        TurnTargetBody::Solo { id } => ConversationTarget::Solo { persona_id: id },
        TurnTargetBody::Group { id } => ConversationTarget::Group { group_id: id },
    };
    if request.message.trim().is_empty() {
        return ApiError::new(
            StatusCode::BAD_REQUEST,
            "empty_message",
            "message must not be empty",
        )
        .into_response();
    }
    let outcome = match state.core.send_turn(&target, &request.message).await {
        Ok(outcome) => outcome,
        Err(error) => {
            if let Some(target_error) = error.downcast_ref::<TargetResolutionError>() {
                return match target_error {
                    TargetResolutionError::Invalid(_) => ApiError::new(
                        StatusCode::BAD_REQUEST,
                        "invalid_target",
                        "target is invalid",
                    )
                    .into_response(),
                    TargetResolutionError::NotFound(_) => ApiError::new(
                        StatusCode::NOT_FOUND,
                        "target_not_found",
                        "target was not found",
                    )
                    .into_response(),
                };
            }
            if error.downcast_ref::<CoreError>() == Some(&CoreError::ShuttingDown) {
                return ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "core_shutting_down",
                    "core is shutting down",
                )
                .into_response();
            }
            return ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "turn_failed",
                "turn could not be completed",
            )
            .into_response();
        }
    };
    Json(TurnResponse {
        turn_id: outcome.turn_id,
        room_id: outcome.room_id,
        replies: outcome
            .replies
            .into_iter()
            .map(|reply| match reply.result {
                Ok(content) => TurnReplyBody {
                    persona_id: reply.name,
                    ok: true,
                    content,
                },
                Err(_) => TurnReplyBody {
                    persona_id: reply.name,
                    ok: false,
                    content: "agent reply failed".into(),
                },
            })
            .collect(),
    })
    .into_response()
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
            name: agent.name.clone(),
            runtime: agent.runtime.clone(),
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
    use super::*;
    use crate::{config::HivemindConfig, identity::AgentInstanceId};
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
            Self {
                core: Arc::new(core),
                directory,
            }
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

    async fn request_json(
        app: Router,
        method: &str,
        path: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        let response = app
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap())
    }
    async fn post_json_over_tcp(
        address: SocketAddr,
        path: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpStream,
        };

        let body = body.to_string();
        let mut stream = TcpStream::connect(address).await.unwrap();
        stream
            .write_all(
                format!(
                    "POST {path} HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        let response = String::from_utf8(response).unwrap();
        let (headers, body) = response.split_once("\r\n\r\n").unwrap();
        let status = headers
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse::<u16>()
            .unwrap();
        (
            StatusCode::from_u16(status).unwrap(),
            serde_json::from_str(body).unwrap(),
        )
    }

    #[tokio::test]
    async fn turns_route_maps_invalid_and_unknown_targets_safely() {
        let test_core = TestCore::new();
        let app = router(test_core.core.clone(), watch::channel(false).1);
        for (target, expected_status, code) in [
            (
                json!({"type":"solo","id":"missing"}),
                StatusCode::NOT_FOUND,
                "target_not_found",
            ),
            (
                json!({"type":"group","id":"missing"}),
                StatusCode::NOT_FOUND,
                "target_not_found",
            ),
            (
                json!({"type":"group","id":""}),
                StatusCode::BAD_REQUEST,
                "invalid_target",
            ),
        ] {
            let (status, body) = request_json(
                app.clone(),
                "POST",
                "/api/v1/turns",
                json!({"target":target,"message":"hello"}),
            )
            .await;
            assert_eq!(status, expected_status);
            assert_eq!(body["error"]["code"], code);
            assert!(!body.to_string().contains("system_prompt"));
            assert!(!body.to_string().contains("provider"));
        }
        let (status, body) = request_json(
            app,
            "POST",
            "/api/v1/turns",
            json!({"target":{"type":"main"},"message":"  "}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "empty_message");
    }

    #[tokio::test]
    async fn turns_route_maps_core_shutdown_to_service_unavailable() {
        let test_core = TestCore::new();
        test_core.core.shutdown().await;
        let app = router(test_core.core.clone(), watch::channel(false).1);
        let (status, body) = request_json(
            app,
            "POST",
            "/api/v1/turns",
            json!({"target":{"type":"main"},"message":"hello"}),
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["error"]["code"], "core_shutting_down");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn post_turn_ids_reach_the_connected_websocket_stream() {
        use std::os::unix::fs::PermissionsExt;

        let mut config = HivemindConfig::default_poc();
        config.groups.push(crate::config::GroupConfig {
            name: "review".into(),
            members: vec!["Engineer".into(), "Reviewer".into()],
            mode: crate::config::ConversationMode::Discussion,
            member_roles: [
                ("Engineer".into(), "Reviewer".into()),
                ("Reviewer".into(), "Builder".into()),
            ]
            .into_iter()
            .collect(),
            reply_order: vec!["Reviewer".into(), "Engineer".into()],
        });
        let engineer_system_prompt = config
            .agents
            .iter()
            .find(|agent| agent.name == "Engineer")
            .unwrap()
            .system_prompt
            .clone();
        let directory = std::env::temp_dir().join(format!(
            "hivemind-api-turn-{}-{}",
            std::process::id(),
            TEMP_ID.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let binary = directory.join("fake-pi");
        let prompts = directory.join("prompts.jsonl");
        std::fs::write(
            &binary,
            r#"#!/bin/sh
while IFS= read -r request; do
  case "$request" in
    *'"type":"new_session"'*) echo '{"type":"response","command":"new_session","success":true}' ;;
    *'"type":"get_session_stats"'*) echo '{"type":"response","command":"get_session_stats","success":true,"data":{"contextUsage":{"tokens":1}}}' ;;
    *'"type":"prompt"'*)
      printf '%s\n' "$request" >> __PROMPTS__
      case "$request" in
        *"FAIL API safely"*) printf '%s\n' 'private provider detail; system_prompt=secret' >&2; exit 23 ;;
      esac
      echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"API reply"}]}}'
      echo '{"type":"agent_settled"}'
      ;;
  esac
done
 "#.replace("__PROMPTS__", &format!("'{}'", prompts.display())),
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&binary).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&binary, permissions).unwrap();
        config.runtime.pi_binary = binary.display().to_string();
        let core = Arc::new(HivemindCore::new(config, directory.join("hivemind.toml")).unwrap());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (_shutdown, shutdown_rx) = watch::channel(false);
        let ws_app = router(core.clone(), shutdown_rx);
        let server = tokio::spawn(async move {
            axum::serve(listener, ws_app).await.unwrap();
        });
        let (mut socket, response) = connect_async(&format!("ws://{address}/api/v1/ws"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
        assert_eq!(receive_json(&mut socket).await["type"], "system.ready");

        let (status, body) = post_json_over_tcp(
            address,
            "/api/v1/turns",
            json!({"target":{"type":"main"},"message":"hello from HTTP"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["room_id"], "main");
        assert_eq!(body["replies"][0]["persona_id"], "Engineer");
        assert_eq!(body["replies"][0]["ok"], true);
        assert_eq!(body["replies"][0]["content"], "API reply");
        let room_id = body["room_id"].as_str().unwrap();
        let turn_id = body["turn_id"].as_str().unwrap();

        let started = receive_json(&mut socket).await;
        assert_eq!(started["type"], "conversation.turn.started");
        assert_eq!(started["payload"]["room_id"], room_id);
        assert_eq!(started["payload"]["turn_id"], turn_id);
        let mut reply_count = 0;
        let completed = loop {
            let event = receive_json(&mut socket).await;
            if event["type"] == "agent.reply.completed" && event["payload"]["turn_id"] == turn_id {
                assert_eq!(event["payload"]["room_id"], room_id);
                reply_count += 1;
            }
            if event["type"] == "conversation.turn.completed"
                && event["payload"]["turn_id"] == turn_id
            {
                break event;
            }
        };
        assert_eq!(reply_count, 2);
        assert_eq!(completed["payload"]["room_id"], room_id);
        let (group_status, group_body) = post_json_over_tcp(
            address,
            "/api/v1/turns",
            json!({"target":{"type":"group","id":"review"},"message":"review the API group"}),
        )
        .await;
        assert_eq!(group_status, StatusCode::OK, "{group_body}");
        assert_eq!(group_body["room_id"], "group-review");
        assert_eq!(group_body["replies"][0]["persona_id"], "Reviewer");
        assert_eq!(group_body["replies"][1]["persona_id"], "Engineer");

        let group_started = receive_json(&mut socket).await;
        assert_eq!(group_started["type"], "conversation.turn.started");
        assert_eq!(group_started["payload"]["room_id"], group_body["room_id"]);
        assert_eq!(group_started["payload"]["turn_id"], group_body["turn_id"]);
        let mut reply_count = 0;
        let completed_turn = loop {
            let event = receive_json(&mut socket).await;
            if event["type"] == "agent.reply.completed"
                && event["payload"]["turn_id"] == group_body["turn_id"]
            {
                assert_eq!(event["payload"]["room_id"], group_body["room_id"]);
                reply_count += 1;
            }
            if event["type"] == "conversation.turn.completed"
                && event["payload"]["turn_id"] == group_body["turn_id"]
            {
                break event;
            }
        };
        assert_eq!(reply_count, 2);
        assert_eq!(completed_turn["payload"]["room_id"], group_body["room_id"]);

        let group_prompts: Vec<String> = std::fs::read_to_string(&prompts)
            .unwrap()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter_map(|request| request["message"].as_str().map(str::to_owned))
            .filter(|message| message.contains("review the API group"))
            .collect();
        assert_eq!(group_prompts.len(), 2);
        assert!(group_prompts[0].contains("- Reviewer — Builder"));
        assert!(group_prompts[0].contains("- Engineer — Reviewer"));
        assert!(group_prompts[1].contains("Reviewer: API reply"));
        let (solo_status, solo_body) = post_json_over_tcp(
            address,
            "/api/v1/turns",
            json!({"target":{"type":"solo","id":"Reviewer"},"message":"valid solo API turn"}),
        )
        .await;
        assert_eq!(solo_status, StatusCode::OK, "{solo_body}");
        assert_eq!(solo_body["room_id"], "solo-Reviewer");
        assert_eq!(solo_body["replies"].as_array().unwrap().len(), 1);
        assert_eq!(solo_body["replies"][0]["persona_id"], "Reviewer");
        assert_eq!(solo_body["replies"][0]["ok"], true);

        let solo_started = receive_json(&mut socket).await;
        assert_eq!(solo_started["type"], "conversation.turn.started");
        assert_eq!(solo_started["payload"]["room_id"], solo_body["room_id"]);
        assert_eq!(solo_started["payload"]["turn_id"], solo_body["turn_id"]);
        let mut solo_reply_seen = false;
        let solo_completed = loop {
            let event = receive_json(&mut socket).await;
            if event["type"] == "agent.reply.completed"
                && event["payload"]["turn_id"] == solo_body["turn_id"]
            {
                assert_eq!(event["payload"]["room_id"], solo_body["room_id"]);
                solo_reply_seen = true;
            }
            if event["type"] == "conversation.turn.completed"
                && event["payload"]["turn_id"] == solo_body["turn_id"]
            {
                break event;
            }
        };
        assert!(solo_reply_seen);
        assert_eq!(solo_completed["payload"]["room_id"], solo_body["room_id"]);

        let (failed_status, failed_body) = post_json_over_tcp(
            address,
            "/api/v1/turns",
            json!({"target":{"type":"solo","id":"Engineer"},"message":"FAIL API safely"}),
        )
        .await;
        assert_eq!(failed_status, StatusCode::OK, "{failed_body}");
        assert_eq!(failed_body["replies"][0]["ok"], false);
        assert_eq!(failed_body["replies"][0]["content"], "agent reply failed");
        assert!(!failed_body.to_string().contains("private provider detail"));
        assert!(!failed_body.to_string().contains("system_prompt"));
        assert!(!failed_body.to_string().contains("secret"));
        assert!(!failed_body.to_string().contains(&engineer_system_prompt));

        socket.close(None).await.unwrap();
        core.shutdown().await;
        server.abort();
        let _ = std::fs::remove_dir_all(directory);
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
                {"name":"Engineer","runtime":"pi"},
                {"name":"Reviewer","runtime":"pi"}
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
        test_core
            .core
            .events()
            .publish(crate::events::DomainEventKind::TurnStarted {
                room_id: "room-safe".into(),
                turn_id: "turn-safe".into(),
            });
        for socket in [&mut first, &mut second] {
            let event = receive_json(socket).await;
            assert_eq!(event["type"], "conversation.turn.started");
            assert_eq!(event["payload"]["event_version"], 1);
            assert_eq!(event["payload"]["room_id"], "room-safe");
            assert_eq!(event["payload"]["turn_id"], "turn-safe");
            assert!(event["payload"].get("agent_id").is_none());
        }
        test_core
            .core
            .events()
            .publish(crate::events::DomainEventKind::TurnCompleted {
                room_id: "room-safe".into(),
                turn_id: "turn-safe".into(),
                reply_count: 1,
            });
        for socket in [&mut first, &mut second] {
            let event = receive_json(socket).await;
            assert_eq!(event["type"], "conversation.turn.completed");
            assert_eq!(event["payload"]["reply_count"], 1);
            assert_eq!(event["payload"]["room_id"], "room-safe");
            assert_eq!(event["payload"]["turn_id"], "turn-safe");
        }
        let public_identity = AgentInstanceId::new("room-safe", "internal/agent");
        test_core
            .core
            .events()
            .publish(crate::events::DomainEventKind::AgentReplyFailed {
                room_id: "room-safe".into(),
                turn_id: "turn-safe".into(),
                agent_id: "internal/agent".into(),
                agent_instance_id: public_identity.clone(),
                error_code: "provider_failure".into(),
                message: "private provider detail".into(),
            });
        for socket in [&mut first, &mut second] {
            let event = receive_json(socket).await;
            assert_eq!(event["type"], "agent.reply.failed");
            assert_eq!(
                event["payload"]["agent_instance_id"],
                public_identity.encode()
            );
            assert_eq!(
                AgentInstanceId::decode(event["payload"]["agent_instance_id"].as_str().unwrap()),
                Some(public_identity.clone())
            );
            assert!(!event.to_string().contains("private provider detail"));
            assert_eq!(event["payload"]["room_id"], "room-safe");
            assert!(!event.to_string().contains("provider_failure"));
            assert!(event["payload"].get("agent_id").is_none());
            assert!(event["payload"].get("error_code").is_none());
        }
        test_core
            .core
            .events()
            .publish(crate::events::DomainEventKind::RuntimeStarted {
                agent_id: "internal/agent".into(),
                agent_instance_id: public_identity.clone(),
                runtime: "pi".into(),
            });
        for socket in [&mut first, &mut second] {
            let event = receive_json(socket).await;
            assert_eq!(event["type"], "runtime.started");
            assert_eq!(
                event["payload"]["agent_instance_id"],
                public_identity.encode()
            );
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
            test_core
                .core
                .events()
                .publish(crate::events::DomainEventKind::TurnStarted {
                    room_id: "room".into(),
                    turn_id: "turn".into(),
                });
        }

        let lagged = receive_json(&mut socket).await;
        assert_eq!(lagged["type"], "system.events_lagged");
        assert!(lagged["payload"]["missed_count"].as_u64().unwrap() > 0);
        assert_eq!(lagged["payload"]["refresh_required"], true);

        let _ = shutdown.send(true);
        server.abort();
    }

    #[tokio::test]
    async fn websocket_delivers_queued_events_before_shutdown_close() {
        let (address, shutdown, server, test_core) = websocket_server().await;
        let endpoint = format!("ws://{address}/api/v1/ws");
        let (mut socket, _) = connect_async(&endpoint).await.unwrap();
        assert_eq!(receive_json(&mut socket).await["type"], "system.ready");

        for _ in 0..5 {
            test_core
                .core
                .events()
                .publish(crate::events::DomainEventKind::TurnStarted {
                    room_id: "room".into(),
                    turn_id: "turn".into(),
                });
        }
        shutdown.send(true).unwrap();

        let mut frames = 0;
        loop {
            let message = tokio::time::timeout(Duration::from_secs(3), socket.next())
                .await
                .unwrap();
            match message {
                Some(Ok(Message::Text(_))) => frames += 1,
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            }
        }
        assert_eq!(frames, 5);
        server.abort();
    }

    #[tokio::test]
    async fn websocket_shutdown_close_is_bounded_without_queued_events() {
        let (address, shutdown, server, _test_core) = websocket_server().await;
        let endpoint = format!("ws://{address}/api/v1/ws");
        let (mut socket, _) = connect_async(&endpoint).await.unwrap();
        assert_eq!(receive_json(&mut socket).await["type"], "system.ready");
        shutdown.send(true).unwrap();
        let message = tokio::time::timeout(Duration::from_secs(3), socket.next())
            .await
            .unwrap();
        assert!(matches!(message, Some(Ok(Message::Close(_)))));
        server.abort();
    }
}
