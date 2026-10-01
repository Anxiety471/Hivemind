use axum::{
    extract::{ws::WebSocketUpgrade, Path, State},
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
        .route("/api/v1/tasks", get(tasks))
        .route("/api/v1/tasks/{id}", get(task_detail))
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

/// A task thread as clients see it. The brief and the worker's report are
/// included; workspace paths and process ids are not.
#[derive(Serialize)]
struct TaskView {
    id: String,
    room_id: String,
    thread_room_id: String,
    requested_by: String,
    worker: String,
    status: crate::tasks::TaskStatus,
    attempt: u32,
    retry_of: Option<String>,
    brief: String,
    report: Option<String>,
    followup: Option<String>,
    created_at_ms: u64,
}

impl From<crate::tasks::TaskRecord> for TaskView {
    fn from(task: crate::tasks::TaskRecord) -> Self {
        Self {
            id: task.id,
            room_id: task.room_id,
            thread_room_id: task.thread_room_id,
            requested_by: task.requested_by,
            worker: task.worker,
            status: task.status,
            attempt: task.attempt,
            retry_of: task.retry_of,
            brief: task.brief,
            report: task.report,
            followup: task.followup,
            created_at_ms: task.created_at_ms,
        }
    }
}

#[derive(Serialize)]
struct Tasks {
    tasks: Vec<TaskView>,
}

async fn tasks(State(state): State<ApiState>) -> Json<Tasks> {
    Json(Tasks {
        tasks: state
            .core
            .tasks()
            .list()
            .into_iter()
            .map(TaskView::from)
            .collect(),
    })
}

#[derive(Serialize)]
struct ThreadMessage {
    speaker: String,
    content: String,
}

#[derive(Serialize)]
struct TaskDetail {
    #[serde(flatten)]
    task: TaskView,
    /// The task thread's transcript, oldest first.
    messages: Vec<ThreadMessage>,
}

async fn task_detail(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<Json<TaskDetail>, Response> {
    let not_found =
        || ApiError::new(StatusCode::NOT_FOUND, "not_found", "task not found").into_response();
    let task = state.core.tasks().get(&id).ok_or_else(not_found)?;
    let messages = state
        .core
        .conversation()
        .room_history(&task.thread_room_id)
        .map(|history| {
            history
                .events
                .into_iter()
                .map(|event| ThreadMessage {
                    speaker: event.speaker,
                    content: event.content,
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Json(TaskDetail {
        task: task.into(),
        messages,
    }))
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
    use crate::config::HivemindConfig;
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

    #[tokio::test]
    async fn tasks_expose_brief_and_report_but_not_paths_and_threads_have_transcripts() {
        let test_core = TestCore::new();
        let tasks_dir = test_core.directory.join(".hivemind/tasks");
        std::fs::create_dir_all(&tasks_dir).unwrap();
        let record = crate::tasks::TaskRecord {
            id: "task-1-1".into(),
            room_id: "solo-Maomao".into(),
            requested_by: "Maomao".into(),
            worker: "Albedo".into(),
            thread_room_id: "task/task-1-1".into(),
            workspace: "/secret/workspace".into(),
            brief: "edit the README".into(),
            status: crate::tasks::TaskStatus::Completed,
            report: Some("README edited".into()),
            attempt: 2,
            retry_of: Some("task-0-1".into()),
            followup: None,
            owner_pid: std::process::id(),
            created_at_ms: 5,
        };
        std::fs::write(
            tasks_dir.join("task-1-1.json"),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
        test_core
            .core
            .conversation()
            .post_report("task/task-1-1", "user", "hello worker")
            .await
            .unwrap();
        let app = router(test_core.core.clone(), watch::channel(false).1);

        let (status, _, list) = request(app.clone(), "GET", "/api/v1/tasks").await;
        assert_eq!(status, StatusCode::OK);
        let task = &list["tasks"][0];
        assert_eq!(task["brief"], "edit the README");
        assert_eq!(task["report"], "README edited");
        assert_eq!(task["status"], "completed");
        assert_eq!(task["attempt"], 2);
        assert_eq!(task["retry_of"], "task-0-1");
        assert_eq!(task["thread_room_id"], "task/task-1-1");

        let (status, _, detail) = request(app.clone(), "GET", "/api/v1/tasks/task-1-1").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(detail["brief"], "edit the README");
        assert_eq!(
            detail["messages"],
            json!([{"speaker": "user", "content": "hello worker"}])
        );
        for body in [list.to_string(), detail.to_string()] {
            assert!(
                !body.contains("workspace") && !body.contains("owner_pid"),
                "{body}"
            );
        }

        for missing in ["/api/v1/tasks/task-9-9", "/api/v1/tasks/..%2Fsecret"] {
            let (status, _, error) = request(app.clone(), "GET", missing).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{missing}");
            assert_eq!(error["error"]["code"], "not_found");
        }
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

        let (status, _, tasks) = request(app.clone(), "GET", "/api/v1/tasks").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(tasks, json!({"tasks": []}));

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
        test_core
            .core
            .events()
            .publish(crate::events::DomainEventKind::AgentReplyFailed {
                room_id: "room-safe".into(),
                turn_id: "turn-safe".into(),
                agent_id: "internal-agent".into(),
                instance_id: "instance-safe".into(),
                error_code: "provider_failure".into(),
                message: "private provider detail".into(),
            });
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
        test_core
            .core
            .events()
            .publish(crate::events::DomainEventKind::RuntimeStarted {
                agent_id: "internal-agent".into(),
                instance_id: "instance-safe".into(),
                runtime: "pi".into(),
            });
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
}
