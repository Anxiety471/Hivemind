//! Operator-facing execution integration tests with a real fixture RPC child.
//!
//! Every test here drives a `#!/bin/sh` fixture binary marked executable, so the
//! whole module is POSIX-only and is declared `#[cfg(all(test, unix))]` in
//! `src/api/mod.rs`.

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
async fn a_busy_room_does_not_block_other_rooms_but_keeps_its_own_order() {
    let fixture = Fixture::new(false);
    let app = fixture.app();
    let submit = |target: Value, message: &'static str| {
        let app = app.clone();
        async move {
            let (status, job) = call(
                app,
                "POST",
                "/api/v1/turns",
                json!({"target": target, "message": message, "wait": false}),
            )
            .await;
            assert_eq!(status, StatusCode::ACCEPTED);
            job["turn_id"].as_str().unwrap().to_owned()
        }
    };
    let status_of = |id: String| {
        let core = fixture.core.clone();
        async move { core.execution().get(&id).unwrap().unwrap().status }
    };
    let slow = submit(json!({"type":"main"}), "HANG").await;
    let queued_behind = submit(json!({"type":"main"}), "same room, later").await;
    let other = submit(json!({"type":"solo","id":"Engineer"}), "other room").await;
    let worker = tokio::spawn(jobs::run(fixture.core.clone()));
    tokio::time::timeout(Duration::from_secs(5), async {
        while !fixture.dir.join("active.pid").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the slow room started");
    // The other room finishes while the first is still stuck in its turn.
    tokio::time::timeout(Duration::from_secs(5), async {
        while status_of(other.clone()).await != "completed" {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("an independent room is not queued behind the busy one");
    assert_eq!(status_of(slow.clone()).await, "running");
    // Within the busy room, the later message keeps waiting its turn.
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(status_of(queued_behind.clone()).await, "queued");
    for id in [&slow, &queued_behind] {
        call(
            app.clone(),
            "POST",
            &format!("/api/v1/turns/{id}/cancel"),
            json!(null),
        )
        .await;
    }
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

#[tokio::test]
async fn a_published_markdown_artifact_opens_as_a_formatted_page() {
    let fixture = Fixture::new(false);
    let library = fixture.core.artifacts();
    library.set_base_url("http://127.0.0.1:7474").unwrap();
    let artifact = library
        .create(crate::artifacts::NewArtifact {
            title: "Release notes",
            filename: "notes.md",
            description: "",
            media_type: crate::artifacts::media_type("notes.md"),
            content: b"# Hello\n\n- one\n",
            room: "",
            persona: "operator",
        })
        .unwrap();
    let url = library.publish(&artifact.id).unwrap().unwrap().url.unwrap();
    let token = url.rsplit('/').next().unwrap().to_owned();
    let response = fixture
        .app()
        .oneshot(
            Request::builder()
                .uri(format!("/artifacts/{token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["content-type"],
        "text/html; charset=utf-8"
    );
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    let page = response.into_body().collect().await.unwrap().to_bytes();
    let page = String::from_utf8(page.to_vec()).unwrap();
    assert!(page.contains("<title>Release notes</title>"));
    assert!(page.contains("<div class=\"library-preview\">"));
    assert!(page.contains("<div class=\"markdown\">"));
    assert!(page.contains("<h3>Hello</h3>"));
    assert!(page.contains("<li>one</li>"));
    let raw = fixture
        .app()
        .oneshot(
            Request::builder()
                .uri(format!("/artifacts/{token}?raw=1"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(raw.headers()["content-type"], "text/markdown");
    let raw = raw.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(raw.as_ref(), b"# Hello\n\n- one\n");
    fixture.core.shutdown().await;
}

#[tokio::test]
async fn a_published_image_opens_framed_with_its_bytes_behind_raw() {
    const CONTENT: &[u8] = b"\x89PNG\r\n\x1a\n\x00raw image bytes";
    let fixture = Fixture::new(false);
    let library = fixture.core.artifacts();
    library.set_base_url("http://127.0.0.1:7474").unwrap();
    let artifact = library
        .create(crate::artifacts::NewArtifact {
            title: "Chart",
            filename: "chart.png",
            description: "",
            media_type: crate::artifacts::media_type("chart.png"),
            content: CONTENT,
            room: "",
            persona: "operator",
        })
        .unwrap();
    let url = library.publish(&artifact.id).unwrap().unwrap().url.unwrap();
    let token = url.rsplit('/').next().unwrap().to_owned();
    let response = fixture
        .app()
        .oneshot(
            Request::builder()
                .uri(format!("/artifacts/{token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["content-type"],
        "text/html; charset=utf-8"
    );
    assert!(response.headers()["content-security-policy"]
        .to_str()
        .unwrap()
        .contains("img-src 'self'"));
    let page = response.into_body().collect().await.unwrap().to_bytes();
    let page = String::from_utf8(page.to_vec()).unwrap();
    assert!(page.contains("<title>Chart</title>"));
    assert!(
        page.contains("<div class=\"library-preview\"><img src=\"?raw=1\" alt=\"Chart\"></div>")
    );
    let raw = fixture
        .app()
        .oneshot(
            Request::builder()
                .uri(format!("/artifacts/{token}?raw=1"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(raw.headers()["content-type"], "image/png");
    let raw = raw.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(raw.as_ref(), CONTENT);
    fixture.core.shutdown().await;
}
#[tokio::test]
async fn room_schedules_list_and_cancel_a_chat_wakeup_only() {
    let fixture = Fixture::new(false);
    let app = fixture.app();
    let execution = fixture.core.execution();
    let target = json!({"type":"main"});
    let now = crate::execution::now();
    execution
        .insert_chat_wakeup(
            "wk_live",
            "main",
            &target,
            "Intent: poll",
            now + 60,
            crate::wakeup::MAX_PENDING_CHAT_WAKEUPS,
            None,
            Some("poller"),
            Some(120),
            None,
        )
        .unwrap();
    execution
        .insert_chat_wakeup(
            "wk_done",
            "main",
            &target,
            "Intent: once",
            now + 60,
            crate::wakeup::MAX_PENDING_CHAT_WAKEUPS,
            None,
            None,
            None,
            None,
        )
        .unwrap();
    execution.complete_chat_wakeup("wk_done", 1).unwrap();
    let (status, listed) = call(
        app.clone(),
        "GET",
        "/api/v1/rooms/main/schedules",
        json!(null),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["room_id"], "main");
    let schedules = listed["schedules"].as_array().unwrap();
    assert_eq!(schedules.len(), 2);
    // Newest first: the completed one-shot was stored second.
    assert_eq!(schedules[0]["id"], "wk_done");
    assert_eq!(schedules[0]["state"], "completed");
    assert_eq!(schedules[0]["repeat_seconds"], json!(null));
    assert_eq!(schedules[1]["id"], "wk_live");
    assert_eq!(schedules[1]["label"], "poller");
    assert_eq!(schedules[1]["message"], "Intent: poll");
    assert_eq!(schedules[1]["repeat_seconds"], 120);
    assert_eq!(schedules[1]["fires"], 0);
    // A live schedule can be stopped, and the reply reports the new state.
    let (status, stopped) = call(
        app.clone(),
        "DELETE",
        "/api/v1/rooms/main/schedules/wk_live",
        json!(null),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stopped["schedule"]["id"], "wk_live");
    assert_eq!(stopped["schedule"]["state"], "cancelled");
    // Stopping again, or stopping a completed row, is a conflict.
    for id in ["wk_live", "wk_done"] {
        let (status, _) = call(
            app.clone(),
            "DELETE",
            &format!("/api/v1/rooms/main/schedules/{id}"),
            json!(null),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{id}");
    }
    // Unknown ids and rooms without schedules are 404, never a silent success.
    let (status, _) = call(
        app.clone(),
        "DELETE",
        "/api/v1/rooms/main/schedules/wk_missing",
        json!(null),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(
        app.clone(),
        "DELETE",
        "/api/v1/rooms/solo-Engineer/schedules/wk_live",
        json!(null),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(app, "GET", "/api/v1/rooms/task-tk_1/schedules", json!(null)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    fixture.core.shutdown().await;
}
#[tokio::test]
async fn a_recurring_chat_wakeup_fires_once_per_period_under_a_per_fire_key() {
    let fixture = Fixture::new(false);
    let execution = fixture.core.execution();
    let now = crate::execution::now();
    execution
        .insert_chat_wakeup(
            "wk_rep",
            "main",
            &json!({"type":"main"}),
            "Intent: poll",
            now - 1,
            crate::wakeup::MAX_PENDING_CHAT_WAKEUPS,
            None,
            Some("poller"),
            Some(1),
            Some(2),
        )
        .unwrap();
    let worker = tokio::spawn(jobs::run(fixture.core.clone()));
    // Both fires land as two distinct turns, each carrying the marker and the
    // same clean body, and the second one only after the first was recorded.
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let listed = execution.chat_wakeups_for("main").unwrap();
            if listed[0].state == "completed" && listed[0].fires == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the bounded recurring schedule completed its two fires");
    for key in ["wk_rep:0", "wk_rep:1"] {
        let job = execution
            .job_by_idem(key)
            .unwrap()
            .unwrap_or_else(|| panic!("{key} was submitted"));
        assert_eq!(job.room_id, "main");
        assert_eq!(job.origin, crate::execution::ORIGIN_HOST);
        assert!(
            job.message
                .starts_with("[Hivemind wakeup wk_rep: you scheduled this"),
            "{}",
            job.message
        );
        assert!(job.message.ends_with("Intent: poll"), "{}", job.message);
    }
    // The bounded schedule never fires a third time.
    assert!(execution.job_by_idem("wk_rep:2").unwrap().is_none());
    // The turn reaches room history with the delivery marker and the clean
    // body, so the future self sees exactly what it scheduled.
    let caller = crate::memory::Caller::trusted_user("test");
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let messages = fixture
                .core
                .memory()
                .room_messages_page(&caller, "main", None, 50)
                .unwrap();
            if messages
                .iter()
                .filter(|m| {
                    m.content
                        .starts_with("[Hivemind wakeup wk_rep: you scheduled this")
                        && m.content.ends_with("Intent: poll")
                })
                .count()
                == 2
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("both delivered wakeup bodies were archived into room history");
    assert_eq!(execution.pending_chat_wakeups("main", None).unwrap(), 0);
    fixture.core.shutdown().await;
    worker.await.unwrap();
}
