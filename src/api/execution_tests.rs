//! Operator-facing execution integration tests with a real fixture RPC child.
use super::*;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::{os::unix::fs::PermissionsExt, path::PathBuf, sync::Arc, time::Duration};
use tokio_tungstenite::{connect_async, tungstenite::client::IntoClientRequest};
use tower::ServiceExt;

struct Fixture {
    dir: PathBuf,
    core: Arc<HivemindCore>,
    env: Option<String>,
}
impl Fixture {
    fn new(auth: bool) -> Self {
        let dir = std::env::temp_dir().join(crate::coordination::model::new_id("execution-api"));
        std::fs::create_dir_all(&dir).unwrap();
        let binary = dir.join("pi");
        std::fs::write(&binary,r#"#!/bin/sh
while IFS= read -r request; do
 case "$request" in
 *'"type":"get_session_stats"'*) printf '%s\n' '{"type":"response","command":"get_session_stats","success":true,"data":{}}' ;;
 *'"type":"prompt"'*)
   case "$request" in *HANG*) echo $$ > active.pid; sleep 300 ;; esac
   printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hello"}}'
   printf '%s\n' '{"type":"tool_execution_start","toolName":"read","toolCallId":"x","args":{"secret":"do-not-stream"}}'
   printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hello"}],"usage":{"input":7,"output":3,"cacheRead":1,"cacheWrite":1}}}'
   printf '%s\n' '{"type":"agent_settled"}' ;;
 esac
done
"#).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut config = crate::config::HivemindConfig::default_poc();
        config.agents.truncate(1);
        config.agents[0].workspace = dir.display().to_string();
        config.conversation.reply_order = vec!["Engineer".into()];
        config.runtime.pi_binary = binary.display().to_string();
        let env = auth.then(|| {
            format!(
                "HIVEMIND_TOKEN_TEST_{}",
                crate::coordination::model::new_id("v")
            )
        });
        if let Some(name) = &env {
            std::env::set_var(name, "a".repeat(40));
            config.server.token_env = Some(name.clone());
            config.server.allowed_origins = vec!["https://ui.example".into()];
        }
        let core = Arc::new(HivemindCore::new(config, dir.join("hivemind.toml")).unwrap());
        Self { dir, core, env }
    }
    fn app(&self) -> Router {
        router(self.core.clone(), watch::channel(false).1)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(name) = &self.env {
            std::env::remove_var(name);
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
async fn call(app: Router, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    let response = app
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
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
async fn async_submission_streams_with_the_same_durable_id_and_measures_usage() {
    let fixture = Fixture::new(false);
    let app = fixture.app();
    let mut events = fixture.core.events().subscribe();
    let request =
        json!({"target":{"type":"main"},"message":"hello","wait":false,"idempotency_key":"once"});
    let (status, accepted) = call(app.clone(), "POST", "/api/v1/turns", request.clone()).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let id = accepted["turn_id"].as_str().unwrap();
    let (_, duplicate) = call(app.clone(), "POST", "/api/v1/turns", request).await;
    assert_eq!(duplicate["turn_id"], id);
    let (status,_)=call(app.clone(),"POST","/api/v1/turns",json!({"target":{"type":"main"},"message":"different","wait":false,"idempotency_key":"once"})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let worker = tokio::spawn(jobs::run(fixture.core.clone()));
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = events.recv().await.unwrap();
            if let crate::events::DomainEventKind::RuntimeProgress {
                turn_id,
                kind,
                text,
                ..
            } = &event.payload
            {
                assert_eq!(turn_id, id);
                if kind == "text" {
                    assert_eq!(text, "hello");
                    break;
                }
            }
        }
    })
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let j = fixture.core.execution().get(id).unwrap().unwrap();
            if j.status == "completed" {
                assert_eq!(j.result.unwrap()["turn_id"], id);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let (_, result) = call(app, "GET", &format!("/api/v1/turns/{id}"), json!(null)).await;
    assert_eq!(result["status"], "completed");
    assert_eq!(
        fixture.core.execution().usage(Some("main")).unwrap()["measured_tokens"],
        12
    );
    fixture.core.shutdown().await;
    worker.await.unwrap();
}
#[tokio::test]
async fn active_cancel_closes_the_epoch_and_does_not_complete_the_job() {
    let fixture = Fixture::new(false);
    let app = fixture.app();
    let (_, accepted) = call(
        app.clone(),
        "POST",
        "/api/v1/turns",
        json!({"target":{"type":"main"},"message":"HANG","wait":false}),
    )
    .await;
    let id = accepted["turn_id"].as_str().unwrap();
    let worker = tokio::spawn(jobs::run(fixture.core.clone()));
    tokio::time::timeout(Duration::from_secs(5), async {
        while !fixture.dir.join("active.pid").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        call(
            app,
            "POST",
            &format!("/api/v1/turns/{id}/cancel"),
            json!(null)
        )
        .await
        .0,
        StatusCode::OK
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let epochs = fixture
                .core
                .memory()
                .room_runtime_epochs(&crate::memory::Caller::trusted_user("test"), "main", 10)
                .unwrap();
            if epochs
                .iter()
                .any(|e| e.end_reason.as_deref() == Some("prompt_cancelled"))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        fixture.core.execution().get(id).unwrap().unwrap().status,
        "cancelled"
    );
    assert_eq!(
        fixture.core.execution().usage(Some("main")).unwrap()["unknown_prompts"],
        1
    );
    fixture.core.shutdown().await;
    worker.await.unwrap();
}
#[tokio::test]
async fn authentication_covers_http_origins_and_websocket_handshakes() {
    let fixture = Fixture::new(true);
    let app = fixture.app();
    assert_eq!(
        call(app.clone(), "GET", "/api/v1/health", json!(null))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/health")
                .header("authorization", format!("Bearer {}", "a".repeat(40)))
                .header("origin", "https://ui.example")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["access-control-allow-origin"],
        "https://ui.example"
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/health")
                .header("authorization", format!("Bearer {}", "a".repeat(40)))
                .header("origin", "https://evil.example")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        call(
            app.clone(),
            "GET",
            &format!("/api/v1/health?token={}", "a".repeat(40)),
            json!(null)
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let url = format!("ws://{address}/api/v1/ws");
    assert!(connect_async(&url).await.is_err());
    let mut request = url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("origin", "https://ui.example".parse().unwrap());
    request.headers_mut().insert(
        "sec-websocket-protocol",
        format!("hivemind.v1, hivemind.auth.{}", "a".repeat(40))
            .parse()
            .unwrap(),
    );
    let (socket, response) = connect_async(request).await.unwrap();
    assert_eq!(response.headers()["sec-websocket-protocol"], "hivemind.v1");
    drop(socket);
    server.abort();
    fixture.core.shutdown().await;
}
