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
pub(super) struct ApiState {
    pub(super) core: Arc<HivemindCore>,
    pub(super) shutdown: watch::Receiver<bool>,
    pub(super) auth: Arc<super::auth::Auth>,
}

pub(super) fn router(core: Arc<HivemindCore>, shutdown: watch::Receiver<bool>) -> Router {
    let auth = super::auth::Auth::load(&core.config().server)
        .expect("server authentication must be validated before constructing the router");
    let state = ApiState {
        core,
        shutdown,
        auth,
    };
    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/info", get(info))
        .merge(super::artifacts::routes())
        .merge(super::jobs::routes())
        .merge(super::tasks::routes())
        .merge(super::issues::routes())
        .merge(super::rooms::routes())
        .merge(super::room_settings::routes())
        .merge(super::schedules::routes())
        .merge(super::chat_groups::routes())
        .merge(super::workspaces::routes())
        .merge(super::catalog::routes())
        .merge(super::runtime::routes())
        .merge(super::skills::routes())
        .merge(super::setup::routes())
        .route("/api/v1/agents", get(agents).post(super::agents::create))
        .route("/api/v1/turns", post(submit_turn))
        .route("/api/v1/ws", get(ws))
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            super::cors::layer,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            super::auth::layer,
        ))
        .with_state(state)
}

#[derive(Deserialize)]
struct TurnRequestBody {
    target: TurnTargetBody,
    message: String,
    /// `false` returns 202 immediately; progress and replies arrive over the WebSocket.
    #[serde(default = "wait_default")]
    wait: bool,
    #[serde(default)]
    idempotency_key: Option<String>,
}

fn wait_default() -> bool {
    true
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum TurnTargetBody {
    Main,
    Solo { id: String },
    Group { id: String },
    Thread { id: String },
}

impl TurnTargetBody {
    pub(super) fn target(self) -> ConversationTarget {
        match self {
            Self::Main => ConversationTarget::Main,
            Self::Solo { id } => ConversationTarget::Solo { persona_id: id },
            Self::Group { id } => ConversationTarget::Group { group_id: id },
            Self::Thread { id } => ConversationTarget::Thread { thread_id: id },
        }
    }
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
    let target_json = serde_json::to_value(&request.target).expect("serializable target");
    let target = request.target.target();
    if request.message.trim().is_empty() {
        return ApiError::new(
            StatusCode::BAD_REQUEST,
            "empty_message",
            "message must not be empty",
        )
        .into_response();
    }
    if !request.wait {
        let resolved = match state.core.resolve_target(&target) {
            Ok(resolved) => resolved,
            Err(TargetResolutionError::Invalid(_)) => {
                return ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_target",
                    "target is invalid",
                )
                .into_response()
            }
            Err(TargetResolutionError::NotFound(_)) => {
                return ApiError::new(
                    StatusCode::NOT_FOUND,
                    "target_not_found",
                    "target was not found",
                )
                .into_response()
            }
        };
        if state.core.is_shutting_down() {
            return ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "core_shutting_down",
                "core is shutting down",
            )
            .into_response();
        }
        return match state.core.execution().submit(&resolved.room_id, &target_json, &request.message, request.idempotency_key.as_deref(), crate::execution::ORIGIN_USER) {
            Ok(job) => (StatusCode::ACCEPTED, Json(serde_json::json!({"turn_id":job.turn_id,"room_id":job.room_id,"status":job.status,"status_url":format!("/api/v1/turns/{}",job.turn_id),"accepted":true}))).into_response(),
            Err(error) if error.to_string().contains("idempotency") => ApiError::new(StatusCode::CONFLICT,"idempotency_conflict","idempotency key does not match request").into_response(),
            Err(_) => ApiError::new(StatusCode::BAD_REQUEST,"submission_failed","turn could not be stored").into_response(),
        };
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
        .protocols(["hivemind.v1"])
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
        fn with_config(config: HivemindConfig) -> Self {
            let directory = std::env::temp_dir().join(format!(
                "hivemind-api-test-{}-{}",
                std::process::id(),
                TEMP_ID.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&directory).unwrap();
            let config_path = directory.join("hivemind.toml");
            let core = HivemindCore::new(config, &config_path).unwrap();
            Self {
                core: Arc::new(core),
                directory,
            }
        }

        fn new() -> Self {
            Self::with_config(HivemindConfig::default_poc())
        }

        fn unconfigured() -> Self {
            Self::with_config(HivemindConfig::default())
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

    #[tokio::test]
    async fn library_uploads_are_private_and_shares_are_revocable_read_only_capabilities() {
        const TOKEN: &str = "library_test_operator_token_1234567890";
        std::env::set_var("HIVEMIND_LIBRARY_TEST_TOKEN", TOKEN);
        let mut config = HivemindConfig::default_poc();
        config.server.token_env = Some("HIVEMIND_LIBRARY_TEST_TOKEN".into());
        config.server.public_base_url = Some("https://hive.example".into());
        let fixture = TestCore::with_config(config);
        let app = router(fixture.core.clone(), watch::channel(false).1);
        std::env::remove_var("HIVEMIND_LIBRARY_TEST_TOKEN");
        let unauthenticated = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/library")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);
        let response = app.clone().oneshot(Request::builder().method("POST").uri("/api/v1/library")
            .header(CONTENT_TYPE, "application/json").header("authorization", format!("Bearer {TOKEN}"))
            .body(Body::from(json!({"title":"User report", "filename":"report.html", "content_base64":"PGgxPkhlbGxvPC9oMT4=", "room_id":"solo-Engineer"}).to_string())).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let result: Value = serde_json::from_slice(&bytes).unwrap();
        let id = result["artifact"]["id"].as_str().unwrap();
        assert_eq!(result["artifact"]["published"], false);
        assert_eq!(result["artifact"]["persona_id"], "operator");
        assert_eq!(result["artifact"]["room_id"], "solo-Engineer");
        let published = fixture.core.artifacts().publish(id).unwrap().unwrap();
        let url = published.url.unwrap();
        let path = url.strip_prefix("https://hive.example").unwrap();
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[CONTENT_TYPE], "text/html");
        assert!(response.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .starts_with("sandbox;"));
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(
            response.into_body().collect().await.unwrap().to_bytes(),
            "<h1>Hello</h1>"
        );
        let mutation = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(mutation.status(), StatusCode::UNAUTHORIZED);
        let private = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/v1/library/{id}/content"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(private.status(), StatusCode::UNAUTHORIZED);
        fixture.core.artifacts().unpublish(id).unwrap();
        let revoked = app
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(revoked.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn browser_setup_persists_and_activates_the_first_personas_once() {
        let test_core = TestCore::unconfigured();
        let app = router(test_core.core.clone(), watch::channel(false).1);
        let (status, _, state) = request(app.clone(), "GET", "/api/v1/setup").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(state["setup_required"], true);

        let workspace = std::env::current_dir().unwrap().display().to_string();
        let (status, saved) = request_json(
            app.clone(),
            "POST",
            "/api/v1/setup",
            json!({"personas":[{
                "id":"Web Engineer",
                "role":"Software Engineer",
                "runtime":"pi",
                "workspace":workspace,
                "system_prompt":"You build software carefully.",
                "model":"provider/model-id"
            }]}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(saved["saved"], true);
        assert_eq!(saved["persona_count"], 1);
        assert_eq!(test_core.core.agents().list()[0].name, "Web Engineer");

        let (status, _, state) = request(app.clone(), "GET", "/api/v1/setup").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(state["setup_required"], false);
        let config_path = test_core.directory.join("hivemind.toml");
        let stored = HivemindConfig::load(&config_path).unwrap();
        assert_eq!(stored.agents[0].runtime, "pi");
        assert_eq!(stored.agents[0].model.as_deref(), Some("provider/model-id"));

        let (status, _) = request_json(
            app,
            "POST",
            "/api/v1/setup",
            json!({"personas":[{
                "id":"Second attempt",
                "runtime":"pi",
                "workspace":workspace,
                "system_prompt":""
            }]}),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            HivemindConfig::load(&config_path).unwrap().agents[0].name,
            "Web Engineer"
        );
    }

    #[tokio::test]
    async fn browser_setup_bounds_personas_and_defers_workspace_validation() {
        let test_core = TestCore::unconfigured();
        let app = router(test_core.core.clone(), watch::channel(false).1);
        let too_many_personas: Vec<Value> = (0..33)
            .map(|index| {
                json!({
                    "id": format!("Persona {index}"),
                    "runtime": "pi",
                    "workspace": "."
                })
            })
            .collect();
        let (status, _) = request_json(
            app.clone(),
            "POST",
            "/api/v1/setup",
            json!({"personas": too_many_personas}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(test_core.core.setup_required());

        let workspace = test_core.directory.join("not-created");
        assert!(!workspace.exists());
        let (status, saved) = request_json(
            app,
            "POST",
            "/api/v1/setup",
            json!({"personas":[{
                "id":"Web Engineer",
                "runtime":"pi",
                "workspace":workspace.display().to_string()
            }]}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(saved["saved"], true);
        assert_eq!(
            test_core.core.agents().list()[0].workspace,
            crate::config::absolute_workspace(&workspace.display().to_string())
        );
        assert!(!workspace.exists());
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
    async fn rooms_expose_listing_detail_and_paged_history() {
        use crate::memory::{ArchiveParticipant, ArchivedMessage, ArchivedTurn, Caller};
        let test_core = TestCore::new();
        let app = router(test_core.core.clone(), watch::channel(false).1);
        let (status, _, body) = request(app.clone(), "GET", "/api/v1/rooms").await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["rooms"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == "main" && r["kind"] == "main"));
        let (status, _, body) = request(app.clone(), "GET", "/api/v1/rooms/nope").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "not_found");

        let messages = (0..5)
            .map(|i| ArchivedMessage {
                id: format!("m{i}"),
                room_id: "main".into(),
                turn_id: "t1".into(),
                speaker: "user".into(),
                content: format!("hello {i}"),
                created_at: 100 + i,
            })
            .collect();
        test_core
            .core
            .memory()
            .append_archive_turn(
                &Caller::trusted_user("test"),
                ArchivedTurn {
                    id: "t1".into(),
                    room_id: "main".into(),
                    started_at: 100,
                    completed_at: Some(105),
                    metadata: json!({}),
                    participants: vec![ArchiveParticipant {
                        participant_id: "user".into(),
                        role: None,
                    }],
                    messages,
                },
            )
            .unwrap();
        let (_, _, body) = request(app.clone(), "GET", "/api/v1/rooms/main").await;
        assert_eq!(body["room"]["message_count"], 5);
        let (_, _, page) = request(app.clone(), "GET", "/api/v1/rooms/main/messages?limit=2").await;
        let ids: Vec<_> = page["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["id"].clone())
            .collect();
        assert_eq!(ids, vec![json!("m3"), json!("m4")]);
        assert_eq!(page["next_before"], "m3");

        let (status, res) = request_json(
            app.clone(),
            "POST",
            "/api/v1/rooms/main/steer",
            json!({"message": "live instruction"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(res["room_id"], "main");
        assert_eq!(res["delivered_to"], json!([]));

        let (status, _res) = request_json(
            app.clone(),
            "POST",
            "/api/v1/rooms/main/steer",
            json!({"message": "  "}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (_, _, older) =
            request(app, "GET", "/api/v1/rooms/main/messages?limit=2&before=m3").await;
        let ids: Vec<_> = older["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["id"].clone())
            .collect();
        assert_eq!(ids, vec![json!("m1"), json!("m2")]);
    }

    #[tokio::test]
    async fn threads_anchor_to_a_message_and_accept_turns_in_their_own_room() {
        use crate::memory::{ArchiveParticipant, ArchivedMessage, ArchivedTurn, Caller};
        let test_core = TestCore::new();
        let app = router(test_core.core.clone(), watch::channel(false).1);
        let mut events = test_core.core.events().subscribe();
        test_core
            .core
            .memory()
            .append_archive_turn(
                &Caller::trusted_user("test"),
                ArchivedTurn {
                    id: "t1".into(),
                    room_id: "main".into(),
                    started_at: 1,
                    completed_at: Some(2),
                    metadata: json!({}),
                    participants: vec![ArchiveParticipant {
                        participant_id: "user".into(),
                        role: None,
                    }],
                    messages: vec![ArchivedMessage {
                        id: "m1".into(),
                        room_id: "main".into(),
                        turn_id: "t1".into(),
                        speaker: "user".into(),
                        content: "anchor".into(),
                        created_at: 1,
                    }],
                },
            )
            .unwrap();
        let (status, created) = request_json(
            app.clone(),
            "POST",
            "/api/v1/rooms/main/threads",
            json!({"anchor_message_id":"m1","name":"Side"}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let thread_id = created["thread"]["id"].as_str().unwrap().to_owned();
        assert_eq!(created["thread"]["parent_room_id"], "main");
        let event = events.recv().await.unwrap();
        assert!(
            matches!(&event.payload, crate::events::DomainEventKind::ThreadCreated { thread_id: id, .. } if *id == thread_id)
        );

        let (status, again) = request_json(
            app.clone(),
            "POST",
            "/api/v1/rooms/main/threads",
            json!({"anchor_message_id":"m1"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(again["thread"]["id"], thread_id.as_str());
        let (status, body) = request_json(
            app.clone(),
            "POST",
            "/api/v1/rooms/main/threads",
            json!({"anchor_message_id":"nope"}),
        )
        .await;
        assert_eq!(
            (status, body["error"]["code"].as_str()),
            (StatusCode::NOT_FOUND, Some("anchor_not_found"))
        );
        let (status, _) = request_json(
            app.clone(),
            "POST",
            "/api/v1/rooms/ghost/threads",
            json!({"anchor_message_id":"m1"}),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = request_json(
            app.clone(),
            "POST",
            &format!("/api/v1/rooms/{thread_id}/threads"),
            json!({"anchor_message_id":"m1"}),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let (_, _, list) = request(app.clone(), "GET", "/api/v1/rooms/main/threads").await;
        assert_eq!(list["threads"][0]["anchor_message_id"], "m1");
        let (_, _, rooms) = request(app.clone(), "GET", "/api/v1/rooms").await;
        assert!(!rooms["rooms"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == thread_id.as_str()));
        let (_, _, room) = request(app.clone(), "GET", &format!("/api/v1/rooms/{thread_id}")).await;
        assert_eq!(room["room"]["kind"], "thread");
        assert_eq!(room["room"]["parent_room_id"], "main");
        assert!(!room["room"]["participants"].as_array().unwrap().is_empty());

        let (status, body) = request_json(
            app.clone(),
            "POST",
            "/api/v1/turns",
            json!({"target":{"type":"thread","id":thread_id},"message":"hi","wait":false}),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        assert_eq!(body["room_id"], thread_id.as_str());
        let (status, body) = request_json(
            app,
            "POST",
            "/api/v1/turns",
            json!({"target":{"type":"thread","id":"missing"},"message":"hi"}),
        )
        .await;
        assert_eq!(
            (status, body["error"]["code"].as_str()),
            (StatusCode::NOT_FOUND, Some("target_not_found"))
        );
    }

    #[tokio::test]
    async fn chat_groups_can_be_created_edited_and_deleted_over_http() {
        let test_core = TestCore::new();
        let path = test_core.directory.join("hivemind.toml");
        std::fs::write(
            &path,
            toml::to_string(&HivemindConfig::default_poc()).unwrap(),
        )
        .unwrap();
        let app = router(test_core.core.clone(), watch::channel(false).1);

        let (status, body) = request_json(
            app.clone(),
            "POST",
            "/api/v1/chat-groups",
            json!({"id":"dev","members":["Engineer"]}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(body["group"]["room_id"], "group-dev");
        let (status, body) = request_json(
            app.clone(),
            "POST",
            "/api/v1/chat-groups",
            json!({"id":"dev"}),
        )
        .await;
        assert_eq!(
            (status, body["error"]["code"].as_str()),
            (StatusCode::CONFLICT, Some("invalid_request"))
        );
        let (status, _) = request_json(
            app.clone(),
            "POST",
            "/api/v1/chat-groups",
            json!({"id":"x","members":["Ghost"]}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let (status, body) = request_json(
            app.clone(),
            "PATCH",
            "/api/v1/chat-groups/dev",
            json!({"members":["Engineer","Reviewer"],"mode":"discussion","member_roles":{"Reviewer":"critic"},"reply_order":["Reviewer","Engineer"]}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["group"]["mode"], "discussion");
        assert_eq!(
            body["group"]["reply_order"],
            json!(["Reviewer", "Engineer"])
        );
        let (status, _) = request_json(
            app.clone(),
            "PATCH",
            "/api/v1/chat-groups/dev",
            json!({"reply_order":["Nobody"]}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = request_json(
            app.clone(),
            "PATCH",
            "/api/v1/chat-groups/none",
            json!({"mode":"broadcast"}),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // Persisted to the config file and visible as a room.
        assert!(HivemindConfig::load(&path)
            .unwrap()
            .groups
            .iter()
            .any(|g| g.name == "dev" && g.members.len() == 2));
        let (_, _, rooms) = request(app.clone(), "GET", "/api/v1/rooms").await;
        assert!(rooms["rooms"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == "group-dev"));
        let (_, _, one) = request(app.clone(), "GET", "/api/v1/chat-groups/dev").await;
        assert_eq!(one["group"]["members"], json!(["Engineer", "Reviewer"]));

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/v1/chat-groups/dev")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let (_, _, list) = request(app, "GET", "/api/v1/chat-groups").await;
        assert!(list["groups"].as_array().unwrap().is_empty());
    }

    fn write_config(test_core: &TestCore) -> PathBuf {
        let path = test_core.directory.join("hivemind.toml");
        std::fs::write(
            &path,
            toml::to_string(&HivemindConfig::default_poc()).unwrap(),
        )
        .unwrap();
        path
    }

    #[tokio::test]
    async fn agents_can_be_created_updated_and_deleted_and_survive_a_restart() {
        let test_core = TestCore::new();
        let path = write_config(&test_core);
        let app = router(test_core.core.clone(), watch::channel(false).1);
        let dir = test_core.directory.join("ws");
        std::fs::create_dir_all(&dir).unwrap();
        let dir_text = dir.canonicalize().unwrap().to_string_lossy().into_owned();

        let (status, body) = request_json(
            app.clone(),
            "POST",
            "/api/v1/agents",
            json!({"id":"Designer","runtime":"pi","workspace":dir_text,"system_prompt":"Be kind","capabilities":["design"],"model":"x/y"}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        assert_eq!(body["config"]["workspace"], dir_text.as_str());
        let (_, _, list) = request(app.clone(), "GET", "/api/v1/agents").await;
        assert!(list["agents"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["name"] == "Designer"));
        // The new agent is a live conversation target right away.
        let (_, _, rooms) = request(app.clone(), "GET", "/api/v1/rooms").await;
        assert!(rooms["rooms"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == "solo-Designer"));
        // And it is in the file, so a restart keeps it.
        let reloaded = HivemindConfig::load(&path).unwrap();
        let saved = reloaded
            .agents
            .iter()
            .find(|a| a.name == "Designer")
            .unwrap();
        assert_eq!(saved.system_prompt, "Be kind");
        assert_eq!(saved.capabilities, ["design"]);
        assert_eq!(saved.model.as_deref(), Some("x/y"));

        for (body, status) in [
            (json!({"id":"Designer"}), StatusCode::CONFLICT),
            (
                json!({"id":"Bad","runtime":"nope"}),
                StatusCode::BAD_REQUEST,
            ),
            (json!({"id":"main"}), StatusCode::BAD_REQUEST),
            (json!({"id":"  "}), StatusCode::BAD_REQUEST),
            (json!({"runtime":"pi"}), StatusCode::BAD_REQUEST),
            (
                json!({"id":"Rel","workspace":"relative/dir"}),
                StatusCode::BAD_REQUEST,
            ),
            (
                json!({"id":"Gone","workspace":"/definitely/not/here"}),
                StatusCode::BAD_REQUEST,
            ),
            (
                json!({"id":"Roles","roles":["no-such-role"]}),
                StatusCode::BAD_REQUEST,
            ),
            (json!({"id":"Extra","bogus":1}), StatusCode::BAD_REQUEST),
        ] {
            let (got, response) =
                request_json(app.clone(), "POST", "/api/v1/agents", body.clone()).await;
            assert_eq!(got, status, "{body} -> {response}");
        }
        let (_, response) = request_json(
            app.clone(),
            "POST",
            "/api/v1/agents",
            json!({"id":"Gone","workspace":"/definitely/not/here"}),
        )
        .await;
        assert!(
            response["error"]["message"]
                .as_str()
                .unwrap()
                .contains("does not exist"),
            "{response}"
        );
        assert_eq!(
            HivemindConfig::load(&path).unwrap().agents.len(),
            3,
            "rejected requests never reach the file"
        );

        let (status, body) = request_json(
            app.clone(),
            "PUT",
            "/api/v1/agents/Designer",
            json!({"runtime":"omp","system_prompt":"Be terse","workspace":dir_text,"fast":true}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["config"]["system_prompt"], "Be terse");
        let (_, _, detail) = request(app.clone(), "GET", "/api/v1/agents/Designer").await;
        assert_eq!(detail["config"]["runtime"], "omp");
        assert_eq!(detail["config"]["fast"], true);
        assert!(
            detail["config"]["model"].is_null(),
            "omitted fields are cleared"
        );
        let reloaded = HivemindConfig::load(&path).unwrap();
        assert_eq!(
            reloaded
                .agents
                .iter()
                .find(|a| a.name == "Designer")
                .unwrap()
                .system_prompt,
            "Be terse"
        );
        let (status, _) = request_json(
            app.clone(),
            "PUT",
            "/api/v1/agents/Designer",
            json!({"id":"Other"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = request_json(app.clone(), "PUT", "/api/v1/agents/Ghost", json!({})).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // An agent a group still uses cannot be deleted from under it.
        let (status, _) = request_json(
            app.clone(),
            "POST",
            "/api/v1/chat-groups",
            json!({"id":"crew","members":["Designer"]}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let delete = |app: Router, id: &'static str| async move {
            app.oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/v1/agents/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
            .status()
        };
        assert_eq!(delete(app.clone(), "Designer").await, StatusCode::CONFLICT);
        let (status, _) = request_json(
            app.clone(),
            "PATCH",
            "/api/v1/chat-groups/crew",
            json!({"members":["Engineer"]}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            delete(app.clone(), "Designer").await,
            StatusCode::NO_CONTENT
        );
        assert_eq!(delete(app.clone(), "Designer").await, StatusCode::NOT_FOUND);
        let (_, _, list) = request(app.clone(), "GET", "/api/v1/agents").await;
        assert!(!list["agents"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["name"] == "Designer"));
        assert!(!HivemindConfig::load(&path)
            .unwrap()
            .agents
            .iter()
            .any(|a| a.name == "Designer"));
        // The last agent stays.
        assert_eq!(delete(app.clone(), "Engineer").await, StatusCode::CONFLICT);
        let status = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/v1/chat-groups/crew")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
            .status();
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert_eq!(
            delete(app.clone(), "Engineer").await,
            StatusCode::NO_CONTENT
        );
        assert_eq!(delete(app, "Reviewer").await, StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn workspaces_can_be_added_alongside_existing_ones() {
        let test_core = TestCore::new();
        let path = write_config(&test_core);
        let app = router(test_core.core.clone(), watch::channel(false).1);
        let canon = |name: &str| {
            let dir = test_core.directory.join(name);
            std::fs::create_dir_all(&dir).unwrap();
            dir.canonicalize().unwrap().to_string_lossy().into_owned()
        };
        let (first, second) = (canon("one"), canon("two"));

        let (status, body) = request_json(
            app.clone(),
            "POST",
            "/api/v1/workspaces",
            json!({"path": first}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        let (status, body) = request_json(
            app.clone(),
            "POST",
            "/api/v1/workspaces",
            json!({"path": second}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(body["known"], json!([first, second]));
        assert_eq!(
            body["personas"].as_array().unwrap().len(),
            2,
            "existing data stays"
        );
        assert!(
            body["roots"].as_array().unwrap().is_empty(),
            "adding never restricts"
        );
        assert_eq!(
            HivemindConfig::load(&path).unwrap().workspaces.known,
            [first.clone(), second.clone()]
        );

        for (body, status) in [
            (json!({"path": first}), StatusCode::CONFLICT),
            (json!({"path": "relative"}), StatusCode::BAD_REQUEST),
            (json!({"path": "/does/not/exist"}), StatusCode::BAD_REQUEST),
            (json!({"nope": 1}), StatusCode::BAD_REQUEST),
        ] {
            let (got, _) = request_json(app.clone(), "POST", "/api/v1/workspaces", body).await;
            assert_eq!(got, status);
        }

        // Each workspace is independently selectable by a persona.
        let (status, _) = request_json(
            app.clone(),
            "PUT",
            "/api/v1/workspaces/personas/Engineer",
            json!({"path": second}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (_, _, body) = request(app.clone(), "GET", "/api/v1/workspaces").await;
        let workspace_of = |name: &str| {
            body["personas"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["id"] == name)
                .unwrap()["workspace"]
                .clone()
        };
        assert_eq!(workspace_of("Engineer"), second.as_str());
        assert_ne!(workspace_of("Reviewer"), second.as_str());

        // One in use cannot be removed; an unused one can.
        let (status, body) = request_json(
            app.clone(),
            "DELETE",
            "/api/v1/workspaces",
            json!({"path": second}),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        let (status, body) = request_json(
            app.clone(),
            "DELETE",
            "/api/v1/workspaces",
            json!({"path": first}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["known"], json!([second]));
        let (status, _) = request_json(
            app,
            "DELETE",
            "/api/v1/workspaces",
            json!({"path": "/never/added"}),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn workspace_changes_survive_agent_and_conversation_edits() {
        let test_core = TestCore::new();
        let path = write_config(&test_core);
        let app = router(test_core.core.clone(), watch::channel(false).1);
        let workspace = test_core.directory.join("selected");
        std::fs::create_dir_all(&workspace).unwrap();
        let workspace = workspace.canonicalize().unwrap().display().to_string();
        let (status, body) = request_json(
            app.clone(),
            "PATCH",
            "/api/v1/rooms/solo-Engineer/settings",
            json!({"workspace":workspace}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (_, _, agent) = request(app.clone(), "GET", "/api/v1/agents/Engineer").await;
        assert_eq!(agent["config"]["workspace"], workspace);
        let (status, body) = request_json(
            app.clone(),
            "PATCH",
            "/api/v1/rooms/main/settings",
            json!({"reply_order":["Reviewer","Engineer"]}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (_, _, room) =
            request(app.clone(), "GET", "/api/v1/rooms/solo-Engineer/settings").await;
        assert_eq!(room["settings"]["workspace"], workspace);
        for (method, endpoint, body, expected) in [
            (
                "POST",
                "/api/v1/agents",
                json!({"id":"Designer","runtime":"pi","workspace":workspace}),
                StatusCode::CREATED,
            ),
            (
                "PUT",
                "/api/v1/agents/Reviewer",
                json!({"runtime":"pi","workspace":workspace,"system_prompt":"Updated"}),
                StatusCode::OK,
            ),
        ] {
            let (status, body) = request_json(app.clone(), method, endpoint, body).await;
            assert_eq!(status, expected, "{body}");
            let reloaded = HivemindConfig::load(&path).unwrap();
            assert_eq!(
                reloaded
                    .agents
                    .iter()
                    .find(|a| a.name == "Engineer")
                    .unwrap()
                    .workspace,
                workspace
            );
        }
        // The older workspace API and workspace tools use this same store.
        let (status, body) = request_json(
            app.clone(),
            "PUT",
            "/api/v1/workspaces/personas/Engineer",
            json!({"path":test_core.directory.display().to_string()}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/v1/agents/Designer")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let reloaded = HivemindConfig::load(&path).unwrap();
        let restarted = HivemindCore::new(reloaded, &path).unwrap();
        assert_eq!(
            restarted.agents().get("Engineer").unwrap().workspace,
            test_core
                .directory
                .canonicalize()
                .unwrap()
                .display()
                .to_string()
        );
    }

    #[tokio::test]
    async fn group_follow_up_budget_is_adjustable_including_unlimited() {
        let test_core = TestCore::new();
        write_config(&test_core);
        let app = router(test_core.core.clone(), watch::channel(false).1);
        let (status, body) = request_json(
            app.clone(),
            "POST",
            "/api/v1/chat-groups",
            json!({"id":"crew","members":["Engineer"]}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        let url = "/api/v1/rooms/group-crew/settings";
        let (_, _, shown) = request(app.clone(), "GET", url).await;
        assert!(shown["settings"]["follow_up_limit"].is_null());
        assert!(shown["settings"]["default_follow_up_limit"].is_number());
        use crate::memory::{ArchiveParticipant, ArchivedMessage, ArchivedTurn, Caller};
        test_core
            .core
            .memory()
            .append_archive_turn(
                &Caller::trusted_user("test"),
                ArchivedTurn {
                    id: "t-crew".into(),
                    room_id: "group-crew".into(),
                    started_at: 1,
                    completed_at: Some(2),
                    metadata: json!({}),
                    participants: vec![ArchiveParticipant {
                        participant_id: "Engineer".into(),
                        role: None,
                    }],
                    messages: vec![ArchivedMessage {
                        id: "m-crew".into(),
                        room_id: "group-crew".into(),
                        turn_id: "t-crew".into(),
                        speaker: "Engineer".into(),
                        content: "hello".into(),
                        created_at: 1,
                    }],
                },
            )
            .unwrap();
        let (status, created) = request_json(
            app.clone(),
            "POST",
            "/api/v1/rooms/group-crew/threads",
            json!({"anchor_message_id":"m-crew","name":"Discussion"}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let thread_id = created["thread"]["id"].as_str().unwrap();
        let default_limit = test_core.core.config().conversation.mention_limit;

        for (value, expected, expected_budget) in [
            (json!(7), json!(7), 7),
            (
                json!("unlimited"),
                json!("unlimited"),
                crate::conversation::UNLIMITED_FOLLOW_UP_CEILING,
            ),
            (json!(null), json!(null), default_limit),
        ] {
            let (status, body) =
                request_json(app.clone(), "PATCH", url, json!({"follow_up_limit": value})).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["settings"]["follow_up_limit"], expected);
            assert_eq!(
                test_core.core.conversation().follow_up_budget("group-crew"),
                expected_budget
            );
            assert_eq!(
                test_core.core.conversation().follow_up_budget(thread_id),
                expected_budget
            );
        }
        for bad in [json!(-1), json!(65), json!("lots"), json!(1.5)] {
            let (status, _) =
                request_json(app.clone(), "PATCH", url, json!({"follow_up_limit": bad})).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
        }
        // Only groups have the control.
        let (status, _) = request_json(
            app.clone(),
            "PATCH",
            "/api/v1/rooms/main/settings",
            json!({"follow_up_limit": 3}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn room_settings_strip_exactly_one_prefix() {
        let test_core = TestCore::new();
        write_config(&test_core);
        let app = router(test_core.core.clone(), watch::channel(false).1);
        for id in ["crew", "group-crew"] {
            let (status, body) = request_json(
                app.clone(),
                "POST",
                "/api/v1/chat-groups",
                json!({"id":id,"members":["Engineer"]}),
            )
            .await;
            assert_eq!(status, StatusCode::CREATED, "{body}");
        }
        let (status, body) = request_json(
            app.clone(),
            "PATCH",
            "/api/v1/rooms/group-group-crew/settings",
            json!({"mode":"broadcast"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["settings"]["mode"], "broadcast");
        let (_, _, other) = request(app.clone(), "GET", "/api/v1/rooms/group-crew/settings").await;
        assert_eq!(other["settings"]["mode"], "discussion");
        let workspace = test_core
            .directory
            .canonicalize()
            .unwrap()
            .display()
            .to_string();
        let (status, body) = request_json(
            app.clone(),
            "POST",
            "/api/v1/agents",
            json!({"id":"solo-Reviewer","runtime":"pi","workspace":workspace}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        let (status, body) = request_json(
            app.clone(),
            "PATCH",
            "/api/v1/rooms/solo-solo-Reviewer/settings",
            json!({"workspace":workspace,"nickname":"Prefixed"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (_, _, saved) = request(
            app.clone(),
            "GET",
            "/api/v1/rooms/solo-solo-Reviewer/settings",
        )
        .await;
        assert_eq!(saved["settings"]["nickname"], "Prefixed");
        assert_eq!(saved["settings"]["workspace"], workspace);
        let (_, _, other) = request(app, "GET", "/api/v1/rooms/solo-Reviewer/settings").await;
        assert!(other["settings"]["nickname"].is_null());
    }

    #[tokio::test]
    async fn room_settings_apply_per_conversation_kind() {
        let test_core = TestCore::new();
        let path = write_config(&test_core);
        let app = router(test_core.core.clone(), watch::channel(false).1);
        let dir = test_core.directory.join("shared");
        std::fs::create_dir_all(&dir).unwrap();
        let dir_text = dir.canonicalize().unwrap().to_string_lossy().into_owned();
        let (status, _) = request_json(
            app.clone(),
            "POST",
            "/api/v1/chat-groups",
            json!({"id":"crew","members":["Engineer","Reviewer"]}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);

        // Unavailable controls explain themselves instead of silently vanishing.
        let (_, _, main) = request(app.clone(), "GET", "/api/v1/rooms/main/settings").await;
        assert_eq!(main["kind"], "main");
        assert!(main["unavailable"]["mode"]
            .as_str()
            .unwrap()
            .contains("broadcasts"));
        assert!(main["unavailable"]["reply_order"].is_null());
        let (_, _, solo) =
            request(app.clone(), "GET", "/api/v1/rooms/solo-Engineer/settings").await;
        assert!(solo["unavailable"]["reply_order"].is_string());
        assert!(solo["unavailable"]["mode"].is_string());
        assert!(solo["unavailable"]["workspace"].is_null());
        let (_, _, group) = request(app.clone(), "GET", "/api/v1/rooms/group-crew/settings").await;
        assert!(group["unavailable"]["mode"].is_null());
        assert_eq!(group["members"], json!(["Engineer", "Reviewer"]));

        // Common settings round-trip and show up on the room itself.
        let (status, body) = request_json(
            app.clone(),
            "PATCH",
            "/api/v1/rooms/main/settings",
            json!({"nickname":"Town hall","pinned":true,"reply_order":["Reviewer","Engineer"]}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["settings"]["nickname"], "Town hall");
        assert_eq!(
            body["settings"]["reply_order"],
            json!(["Reviewer", "Engineer"])
        );
        let (_, _, room) = request(app.clone(), "GET", "/api/v1/rooms/main").await;
        assert_eq!(room["room"]["settings"]["pinned"], true);
        let (_, _, rooms) = request(app.clone(), "GET", "/api/v1/rooms").await;
        let main_row = rooms["rooms"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == "main")
            .unwrap();
        assert_eq!(main_row["settings"]["nickname"], "Town hall");
        assert_eq!(
            HivemindConfig::load(&path)
                .unwrap()
                .conversation
                .reply_order,
            ["Reviewer", "Engineer"]
        );
        let names: Vec<_> = test_core
            .core
            .agents()
            .list()
            .iter()
            .map(|a| a.name.clone())
            .collect();
        assert_eq!(
            names,
            ["Reviewer", "Engineer"],
            "the live order changed too"
        );

        // Group-only settings.
        let (status, body) = request_json(
            app.clone(),
            "PATCH",
            "/api/v1/rooms/group-crew/settings",
            json!({"mode":"discussion","workspace":dir_text,"muted":true}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["settings"]["mode"], "discussion");
        assert_eq!(body["settings"]["workspace"], dir_text.as_str());
        let (_, _, chat_group) = request(app.clone(), "GET", "/api/v1/chat-groups/crew").await;
        assert_eq!(chat_group["group"]["mode"], "discussion");
        let (status, body) = request_json(
            app.clone(),
            "PATCH",
            "/api/v1/rooms/group-crew/settings",
            json!({"workspace":null}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["settings"]["workspace"].is_null());
        assert_eq!(
            body["settings"]["mode"], "discussion",
            "other settings untouched"
        );

        // A direct message can move its agent's workspace but has no mode or order.
        let (status, body) = request_json(
            app.clone(),
            "PATCH",
            "/api/v1/rooms/solo-Engineer/settings",
            json!({"workspace":dir_text}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["settings"]["workspace"], dir_text.as_str());

        for (room, body, code) in [
            (
                "solo-Engineer",
                json!({"mode":"discussion"}),
                "not_applicable",
            ),
            (
                "solo-Engineer",
                json!({"reply_order":["Engineer"]}),
                "not_applicable",
            ),
            (
                "solo-Engineer",
                json!({"workspace":null}),
                "invalid_request",
            ),
            ("main", json!({"mode":"discussion"}), "not_applicable"),
            ("main", json!({"workspace":dir_text}), "not_applicable"),
            ("main", json!({"reply_order":["Ghost"]}), "invalid_request"),
            (
                "main",
                json!({"reply_order":["Engineer","Engineer"]}),
                "invalid_request",
            ),
            (
                "group-crew",
                json!({"reply_order":["Nobody"]}),
                "invalid_request",
            ),
            (
                "main",
                json!({"nickname":"x".repeat(61)}),
                "invalid_request",
            ),
            ("main", json!({"colour":"red"}), "invalid_json"),
        ] {
            let (status, response) = request_json(
                app.clone(),
                "PATCH",
                &format!("/api/v1/rooms/{room}/settings"),
                body.clone(),
            )
            .await;
            assert_eq!(
                status,
                StatusCode::BAD_REQUEST,
                "{room} {body} -> {response}"
            );
            assert_eq!(response["error"]["code"], code, "{room} {body}");
        }
        for room in [
            "task-1",
            "thread-1",
            "solo-Ghost",
            "group-ghost",
            "nonsense",
        ] {
            let (status, _, _) = request(
                app.clone(),
                "GET",
                &format!("/api/v1/rooms/{room}/settings"),
            )
            .await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{room}");
        }
        let (_, _, main) = request(app, "GET", "/api/v1/rooms/main/settings").await;
        assert_eq!(
            main["settings"]["nickname"], "Town hall",
            "rejected patches change nothing"
        );
    }

    #[tokio::test]
    async fn workspaces_and_roles_are_readable_and_workspaces_changeable() {
        let test_core = TestCore::new();
        let path = test_core.directory.join("hivemind.toml");
        std::fs::write(
            &path,
            toml::to_string(&HivemindConfig::default_poc()).unwrap(),
        )
        .unwrap();
        let app = router(test_core.core.clone(), watch::channel(false).1);
        let dir = test_core.directory.join("project");
        std::fs::create_dir_all(&dir).unwrap();
        let dir_text = dir.canonicalize().unwrap().to_string_lossy().into_owned();

        let (_, _, body) = request(app.clone(), "GET", "/api/v1/workspaces").await;
        assert_eq!(body["personas"].as_array().unwrap().len(), 2);
        assert!(body["roots"].as_array().unwrap().is_empty());
        let (_, _, roles) = request(app.clone(), "GET", "/api/v1/access/roles").await;
        assert!(roles["builtin"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["name"] == "worker"));
        assert!(roles["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p == "workspace.exec"));
        let (status, _, unknown) =
            request(app.clone(), "GET", "/api/v1/runtimes/nope/models").await;
        assert_eq!(
            (status, unknown["error"]["code"].as_str()),
            (StatusCode::NOT_FOUND, Some("not_found"))
        );
        let (status, _, dirs) = request(app.clone(), "GET", "/api/v1/fs/dirs?path=/").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(dirs["path"], "/");

        let (status, _) = request_json(
            app.clone(),
            "POST",
            "/api/v1/chat-groups",
            json!({"id":"dev","members":["Engineer"]}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let (status, body) = request_json(
            app.clone(),
            "PUT",
            "/api/v1/workspaces/groups/dev",
            json!({"path": dir_text}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["groups"][0]["workspace"], dir_text.as_str());
        let (_, _, group) = request(app.clone(), "GET", "/api/v1/chat-groups/dev").await;
        assert_eq!(group["group"]["workspace"], dir_text.as_str());
        let (status, _) = request_json(
            app.clone(),
            "PUT",
            "/api/v1/workspaces/personas/Engineer",
            json!({"path": dir_text}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, body) = request_json(
            app.clone(),
            "PUT",
            "/api/v1/workspaces/personas/Engineer",
            json!({"path": "relative"}),
        )
        .await;
        assert_eq!(
            (status, body["error"]["code"].as_str()),
            (StatusCode::BAD_REQUEST, Some("invalid_request"))
        );
        let (status, _) = request_json(
            app.clone(),
            "PUT",
            "/api/v1/workspaces/personas/Ghost",
            json!({"path": dir_text}),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = request_json(
            app.clone(),
            "PUT",
            "/api/v1/workspaces/groups/dev",
            json!({"nope": 1}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/v1/workspaces/groups/dev")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let (_, _, group) = request(app, "GET", "/api/v1/chat-groups/dev").await;
        assert!(group["group"]["workspace"].is_null());
    }

    #[tokio::test]
    async fn non_blocking_turn_returns_accepted_and_still_validates_target() {
        let test_core = TestCore::new();
        let app = router(test_core.core.clone(), watch::channel(false).1);
        let (status, body) = request_json(
            app.clone(),
            "POST",
            "/api/v1/turns",
            json!({"target":{"type":"group","id":"missing"},"message":"hi","wait":false}),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "target_not_found");
        let (status, body) = request_json(
            app,
            "POST",
            "/api/v1/turns",
            json!({"target":{"type":"main"},"message":"hi","wait":false}),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        assert_eq!(body["room_id"], "main");
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
        // This test pins turn/event ids; follow-up replies are covered in conversation tests.
        config.conversation.mention_limit = 0;
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
            workspace: None,
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
    async fn websocket_room_subscription_filters_room_scoped_events() {
        let (address, shutdown, server, test_core) = websocket_server().await;
        let (mut socket, _) = connect_async(&format!("ws://{address}/api/v1/ws"))
            .await
            .unwrap();
        assert_eq!(receive_json(&mut socket).await["type"], "system.ready");
        socket
            .send(Message::Text(
                json!({"type":"events.subscribe","id":"s1","payload":{"room_ids":["a"]}})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let ack = receive_json(&mut socket).await;
        assert_eq!(
            (ack["type"].as_str(), ack["id"].as_str()),
            (Some("events.subscribed"), Some("s1"))
        );
        for room in ["b", "a"] {
            test_core
                .core
                .events()
                .publish(crate::events::DomainEventKind::TurnStarted {
                    room_id: room.into(),
                    turn_id: format!("turn-{room}"),
                });
        }
        let event = receive_json(&mut socket).await;
        assert_eq!(event["type"], "conversation.turn.started");
        assert_eq!(event["payload"]["room_id"], "a");
        socket
            .send(Message::Text(
                json!({"type":"events.subscribe","payload":{"room_ids":"bad"}})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        assert_eq!(
            receive_json(&mut socket).await["payload"]["code"],
            "invalid_subscription"
        );
        let _ = shutdown.send(true);
        server.abort();
    }

    #[tokio::test]
    async fn cors_allows_only_loopback_origins_and_answers_preflight() {
        let test_core = TestCore::new();
        let app = router(test_core.core.clone(), watch::channel(false).1);
        let call = |method: &'static str, origin: &'static str| {
            let app = app.clone();
            async move {
                app.oneshot(
                    Request::builder()
                        .method(method)
                        .uri("/api/v1/rooms")
                        .header("origin", origin)
                        .header("access-control-request-method", "POST")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap()
            }
        };
        let preflight = call("OPTIONS", "http://localhost:5173").await;
        assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            preflight.headers()["access-control-allow-origin"],
            "http://localhost:5173"
        );
        assert!(preflight.headers()["access-control-allow-methods"]
            .to_str()
            .unwrap()
            .contains("PATCH"));
        let normal = call("GET", "http://127.0.0.1:3000").await;
        assert_eq!(
            normal.headers()["access-control-allow-origin"],
            "http://127.0.0.1:3000"
        );
        let foreign = call("GET", "https://evil.example").await;
        assert!(foreign
            .headers()
            .get("access-control-allow-origin")
            .is_none());
        let tricky = call("GET", "http://localhost.evil.example").await;
        assert!(tricky
            .headers()
            .get("access-control-allow-origin")
            .is_none());
    }

    #[tokio::test]
    async fn runtime_sessions_list_and_rotate_validate_input() {
        let test_core = TestCore::new();
        let app = router(test_core.core.clone(), watch::channel(false).1);
        let (status, _, body) =
            request(app.clone(), "GET", "/api/v1/rooms/main/runtime-sessions").await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["sessions"].as_array().unwrap().is_empty());
        let id = AgentInstanceId::new("main", "Engineer").encode();
        let (status, body) = request_json(
            app.clone(),
            "POST",
            "/api/v1/runtime/rotate",
            json!({"agent_instance_id": id}),
        )
        .await;
        assert_eq!(
            (status, body["accepted"].as_bool()),
            (StatusCode::ACCEPTED, Some(true))
        );
        let (status, _) = request_json(
            app,
            "POST",
            "/api/v1/runtime/rotate",
            json!({"agent_instance_id":"junk"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
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
