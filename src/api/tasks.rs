//! Task, message, group, agent-activity, and event-replay endpoints. Handlers
//! stay thin: validation and state live in `CoordinationService`, and no
//! endpoint here ever starts a runtime.
use std::collections::{BTreeMap, HashMap};

use axum::{
    extract::{rejection::JsonRejection, Path, RawQuery, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{error::ApiError, routes::ApiState};
use crate::coordination::{
    model::{task_room, CoordError, MessageKind, TaskStatus},
    policy::Plan,
    service::SubmitTask,
    store::TaskFilter,
};
use crate::{memory::Caller, runtime::is_rotation};

pub(super) fn routes() -> Router<ApiState> {
    Router::new()
        .route("/api/v1/tasks", post(submit).get(list))
        .route("/api/v1/tasks/{id}", get(show))
        .route("/api/v1/tasks/{id}/attempts", get(attempts))
        .route("/api/v1/tasks/{id}/cancel", post(cancel))
        .route("/api/v1/tasks/{id}/pause", post(pause))
        .route("/api/v1/tasks/{id}/resume", post(resume))
        .route("/api/v1/tasks/{id}/input", post(input))
        .route("/api/v1/tasks/{id}/steer", post(steer))
        .route("/api/v1/tasks/{id}/context-metrics", get(context_metrics))
        .route(
            "/api/v1/agents/{id}",
            get(agent)
                .put(super::agents::update)
                .delete(super::agents::remove),
        )
        .route("/api/v1/agent-instances", get(instances))
        .route("/api/v1/messages", post(send_message).get(messages))
        .route("/api/v1/groups", post(create_group))
        .route("/api/v1/groups/{id}", get(group))
        .route("/api/v1/events", get(events))
        .route("/api/v1/access/personas", get(access_personas))
        .route("/api/v1/access/audit", get(access_audit))
}

fn coord_error(error: CoordError) -> Response {
    let (status, code) = match &error {
        CoordError::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
        CoordError::Invalid(_) => (StatusCode::BAD_REQUEST, "invalid_request"),
        CoordError::Forbidden(_) => (StatusCode::FORBIDDEN, "forbidden"),
        CoordError::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
        CoordError::Disabled => (StatusCode::CONFLICT, "coordination_disabled"),
        CoordError::Budget(_) => (StatusCode::CONFLICT, "budget_exhausted"),
        CoordError::Internal(detail) => {
            eprintln!("coordination internal error: {detail}");
            return ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "request could not be completed",
            )
            .into_response();
        }
    };
    ApiError::owned(status, code, error.to_string()).into_response()
}

fn bad_json() -> Response {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "invalid_json",
        "invalid request body",
    )
    .into_response()
}

pub(super) fn query(raw: Option<String>) -> HashMap<String, String> {
    fn decode(text: &str) -> String {
        let bytes = text.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            match bytes[i] {
                b'+' => out.push(b' '),
                b'%' if bytes
                    .get(i + 1..i + 3)
                    .is_some_and(|h| h.iter().all(u8::is_ascii_hexdigit)) =>
                {
                    out.push(u8::from_str_radix(&text[i + 1..i + 3], 16).unwrap_or(b'?'));
                    i += 2;
                }
                other => out.push(other),
            }
            i += 1;
        }
        String::from_utf8_lossy(&out).into_owned()
    }
    raw.unwrap_or_default()
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .map(|(k, v)| (decode(k), decode(v)))
        .collect()
}

pub(super) fn number(
    params: &HashMap<String, String>,
    key: &str,
    default: i64,
) -> Result<i64, ApiError> {
    match params.get(key) {
        None => Ok(default),
        Some(v) => v.parse().map_err(|_| {
            ApiError::owned(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                format!("query '{key}' must be an integer"),
            )
        }),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SubmitBody {
    objective: String,
    #[serde(default)]
    acceptance: Vec<String>,
    #[serde(default)]
    capabilities: Vec<String>,
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    plan: Option<Plan>,
    #[serde(default)]
    idempotency_key: Option<String>,
}

async fn submit(
    State(state): State<ApiState>,
    payload: Result<Json<SubmitBody>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload else {
        return bad_json();
    };
    match state.core.coordination().submit(SubmitTask {
        objective: body.objective,
        acceptance: body.acceptance,
        capabilities: body.capabilities,
        workspace: body.workspace,
        plan: body.plan,
        idempotency_key: body.idempotency_key,
    }) {
        Ok(detail) => {
            let id = detail.task.id.clone();
            (StatusCode::ACCEPTED, Json(json!({"id": id, "status_url": format!("/api/v1/tasks/{id}"), "event_high_water": state.core.coordination().high_water().unwrap_or(0), "task": detail}))).into_response()
        }
        Err(error) => coord_error(error),
    }
}

async fn list(State(state): State<ApiState>, RawQuery(raw): RawQuery) -> Response {
    let params = query(raw);
    let limit = match number(&params, "limit", 50) {
        Ok(v) => v.clamp(1, 200) as usize,
        Err(response) => return response.into_response(),
    };
    let status = match params.get("status").map(|s| TaskStatus::parse(s)) {
        Some(None) => {
            return ApiError::new(StatusCode::BAD_REQUEST, "invalid_request", "unknown status")
                .into_response()
        }
        Some(Some(status)) => Some(status),
        None => None,
    };
    let filter = TaskFilter {
        root: params.get("root").map(String::as_str),
        status,
        owner: params.get("owner").map(String::as_str),
        roots_only: params.get("all").map(String::as_str) != Some("true")
            && !params.contains_key("root"),
        after: params.get("after").map(String::as_str),
        limit,
    };
    let service = state.core.coordination();
    match service.list_tasks(&filter) {
        Ok(tasks) => {
            let next_after = (tasks.len() == limit)
                .then(|| tasks.last().map(|t| t.id.clone()))
                .flatten();
            Json(json!({"tasks": tasks, "next_after": next_after, "event_high_water": service.high_water().unwrap_or(0)})).into_response()
        }
        Err(error) => coord_error(error),
    }
}

async fn show(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    let service = state.core.coordination();
    match service.detail(&id) {
        Ok(detail) => {
            Json(json!({"task": detail, "event_high_water": service.high_water().unwrap_or(0)}))
                .into_response()
        }
        Err(error) => coord_error(error),
    }
}

async fn attempts(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    match state.core.coordination().attempts(&id) {
        Ok(attempts) => Json(json!({"attempts": attempts})).into_response(),
        Err(error) => coord_error(error),
    }
}

async fn cancel(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    match state.core.coordination().cancel(&id, "user") {
        Ok(detail) => Json(json!({"task": detail})).into_response(),
        Err(error) => coord_error(error),
    }
}

async fn pause(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    match state.core.coordination().pause(&id, "user") {
        Ok(detail) => Json(json!({"task": detail})).into_response(),
        Err(error) => coord_error(error),
    }
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct ResumeBody {
    #[serde(default)]
    retry: bool,
    #[serde(default)]
    extra_dispatches: u32,
    #[serde(default)]
    extra_secs: u64,
}

async fn resume(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    raw: axum::body::Bytes,
) -> Response {
    let body: ResumeBody = if raw.iter().all(u8::is_ascii_whitespace) {
        ResumeBody::default()
    } else {
        match serde_json::from_slice(&raw) {
            Ok(body) => body,
            Err(_) => return bad_json(),
        }
    };
    match state.core.coordination().resume(
        &id,
        body.retry,
        body.extra_dispatches.min(1000),
        body.extra_secs.min(86_400),
        "user",
    ) {
        Ok(detail) => Json(json!({"task": detail})).into_response(),
        Err(error) => coord_error(error),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InputBody {
    answer: String,
}

async fn input(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    payload: Result<Json<InputBody>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload else {
        return bad_json();
    };
    match state
        .core
        .coordination()
        .provide_input(&id, &body.answer, "user")
    {
        Ok(detail) => Json(json!({"task": detail})).into_response(),
        Err(error) => coord_error(error),
    }
}

#[derive(Deserialize)]
struct SteerBody {
    message: String,
}

/// Push a message into the task's running attempt now (it is also kept as task feedback).
async fn steer(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    payload: Result<Json<SteerBody>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload else {
        return bad_json();
    };
    match state
        .core
        .coordination()
        .steer_task(&id, &body.message, "user")
    {
        Ok(outcome) => Json(json!({"steer": outcome})).into_response(),
        Err(error) => coord_error(error),
    }
}

async fn context_metrics(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    let service = state.core.coordination();
    let result = service.detail(&id).and_then(|detail| {
        let attempts = service.store().read(|db| db.attempts_for_task(&id, 200))?;
        Ok((detail, attempts))
    });
    match result {
        Ok((detail, attempts)) => {
            let epochs = match state.core.memory().room_runtime_epochs(
                &Caller::trusted_user("api"),
                &task_room(&id),
                500,
            ) {
                Ok(epochs) => epochs,
                Err(_) => {
                    return ApiError::new(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "internal",
                        "runtime epochs could not be read",
                    )
                    .into_response()
                }
            };
            let mut rotations_by_reason: BTreeMap<&str, u64> = BTreeMap::new();
            for reason in epochs.iter().filter_map(|e| e.end_reason.as_deref()) {
                if is_rotation(reason) {
                    *rotations_by_reason.entry(reason).or_default() += 1;
                }
            }
            let per_attempt: Vec<Value> = attempts.iter().map(|a| json!({"attempt_id": a.id, "kind": a.kind, "state": a.state, "runtime_epoch": a.runtime_epoch, "context": a.context_metrics})).collect();
            let runtime_epochs: Vec<Value> = epochs.iter().map(|e| json!({"id": e.id, "persona": e.agent_instance_id.persona_id, "runtime": e.runtime, "started_at": e.started_at, "ended_at": e.ended_at, "end_reason": e.end_reason})).collect();
            Json(json!({
                "task_id": id,
                "budget": detail.usage,
                "attempts": per_attempt,
                "runtime_epochs": runtime_epochs,
                "rotations_observed": rotations_by_reason.values().sum::<u64>(),
                "rotations_by_reason": rotations_by_reason,
                "note": "estimated_tokens is bytes/4; context estimates are not billing usage; inspect /api/v1/usage for measured billing counters and unknown prompts",
            }))
            .into_response()
        }
        Err(error) => coord_error(error),
    }
}

async fn agent(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    let service = state.core.coordination();
    let Some(persona) = state.core.agents().get(&id) else {
        return ApiError::new(StatusCode::NOT_FOUND, "not_found", "persona was not found")
            .into_response();
    };
    let activity = service
        .activity()
        .ok()
        .and_then(|all| all.into_iter().find(|a| a.persona == id));
    let permissions = state
        .core
        .access()
        .grants(&id)
        .map(|grants| grants.permissions)
        .unwrap_or_default();
    Json(json!({
        "id": persona.name,
        "capabilities": persona.capabilities,
        "permissions": permissions,
        "config": super::agents::config_view(&persona),
        "activity": activity
    }))
    .into_response()
}

async fn access_personas(State(state): State<ApiState>) -> Response {
    let personas: Vec<_> = state.core.access().all().into_iter().map(|(id, grants)| json!({"id": id, "roles": grants.roles, "permissions": grants.permissions, "restricted": grants.restricted})).collect();
    Json(json!({"personas": personas})).into_response()
}

async fn access_audit(State(state): State<ApiState>, RawQuery(raw): RawQuery) -> Response {
    let params = query(raw);
    let limit = match number(&params, "limit", 50) {
        Ok(v) => v.clamp(1, 1000) as usize,
        Err(response) => return response.into_response(),
    };
    let filter = crate::access::AuditFilter {
        persona: params.get("persona").cloned(),
        denied_only: params.get("denied").map(String::as_str) == Some("true"),
        limit,
    };
    match state.core.access().audit().list(&filter) {
        Ok(entries) => Json(json!({"entries": entries})).into_response(),
        Err(error) => ApiError::owned(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            format!("reading audit log: {error}"),
        )
        .into_response(),
    }
}

async fn instances(State(state): State<ApiState>) -> Response {
    let service = state.core.coordination();
    match service.activity() {
        Ok(activity) => Json(json!({"scheduler_enabled": service.enabled(), "agents": activity}))
            .into_response(),
        Err(error) => coord_error(error),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MessageBody {
    task_id: String,
    to: Vec<String>,
    #[serde(default)]
    kind: Option<String>,
    body: String,
}

async fn send_message(
    State(state): State<ApiState>,
    payload: Result<Json<MessageBody>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload else {
        return bad_json();
    };
    let kind = match body.kind.as_deref().map(MessageKind::parse) {
        None => MessageKind::Request,
        Some(Some(kind)) => kind,
        Some(None) => {
            return ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "unknown message kind",
            )
            .into_response()
        }
    };
    match state
        .core
        .coordination()
        .operator_message(&body.task_id, &body.to, kind, &body.body)
    {
        Ok(message) => (StatusCode::ACCEPTED, Json(json!({"message": message}))).into_response(),
        Err(error) => coord_error(error),
    }
}

async fn messages(State(state): State<ApiState>, RawQuery(raw): RawQuery) -> Response {
    let params = query(raw);
    let Some(root) = params.get("root") else {
        return ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "query 'root' is required",
        )
        .into_response();
    };
    let limit = match number(&params, "limit", 50) {
        Ok(v) => v.clamp(1, 200) as usize,
        Err(response) => return response.into_response(),
    };
    match state.core.coordination().messages(
        root,
        params.get("task").map(String::as_str),
        params.get("thread").map(String::as_str),
        params.get("after").map(String::as_str),
        limit,
    ) {
        Ok(items) => {
            let next_after = (items.len() == limit)
                .then(|| items.last().map(|(m, _)| m.id.clone()))
                .flatten();
            let items: Vec<Value> = items
                .into_iter()
                .map(|(message, deliveries)| json!({"message": message, "deliveries": deliveries}))
                .collect();
            Json(json!({"messages": items, "next_after": next_after})).into_response()
        }
        Err(error) => coord_error(error),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GroupBody {
    task_id: String,
    purpose: String,
    members: Vec<String>,
}

async fn create_group(
    State(state): State<ApiState>,
    payload: Result<Json<GroupBody>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload else {
        return bad_json();
    };
    match state
        .core
        .coordination()
        .operator_group(&body.task_id, &body.purpose, &body.members)
    {
        Ok((group, reused)) => (
            (if reused {
                StatusCode::OK
            } else {
                StatusCode::CREATED
            }),
            Json(json!({"group": group, "reused": reused})),
        )
            .into_response(),
        Err(error) => coord_error(error),
    }
}

async fn group(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    match state.core.coordination().group(&id) {
        Ok(group) => Json(json!({"group": group})).into_response(),
        Err(error) => coord_error(error),
    }
}

/// Durable replay: `after` is the last sequence the client has seen. Pair a
/// snapshot's `event_high_water` with `after` to resume without gaps.
async fn events(State(state): State<ApiState>, RawQuery(raw): RawQuery) -> Response {
    let params = query(raw);
    let after = match number(&params, "after", 0) {
        Ok(v) => v.max(0),
        Err(response) => return response.into_response(),
    };
    let limit = match number(&params, "limit", 100) {
        Ok(v) => v.clamp(1, 500) as usize,
        Err(response) => return response.into_response(),
    };
    match state.core.coordination().events_after(
        after,
        params.get("root").map(String::as_str),
        limit,
    ) {
        Ok((events, high_water)) => {
            let next_after = events.last().map(|e| e.seq).unwrap_or(after);
            Json(json!({"events": events, "next_after": next_after, "event_high_water": high_water, "has_more": events.len() == limit})).into_response()
        }
        Err(error) => coord_error(error),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::{
        body::Body,
        http::{header::CONTENT_TYPE, Request},
        Router,
    };
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use tokio::sync::watch;
    use tower::ServiceExt;

    use super::*;
    use crate::{
        config::{AgentConfig, CoordinationConfig, HivemindConfig},
        core::HivemindCore,
    };

    struct Fixture {
        core: Arc<HivemindCore>,
        app: Router,
        directory: std::path::PathBuf,
        _shutdown: watch::Sender<bool>,
    }

    impl Fixture {
        fn new(enabled: bool) -> Self {
            let directory = std::env::temp_dir().join(format!(
                "hivemind-api-coord-{}",
                crate::coordination::model::new_id("t")
            ));
            std::fs::create_dir_all(&directory).unwrap();
            let mut config = HivemindConfig::default_poc();
            let persona = |name: &str, caps: &[&str], perms: &[&str]| AgentConfig {
                name: name.into(),
                runtime: "pi".into(),
                system_prompt: String::new(),
                workspace: ".".into(),
                model: None,
                reasoning: None,
                fast: None,
                fallback_models: Vec::new(),
                role: None,
                capabilities: caps.iter().map(|c| c.to_string()).collect(),
                permissions: perms.iter().map(|c| c.to_string()).collect(),
                roles: Vec::new(),
                tool_access: None,
                web: true,
                authorized_work: Vec::new(),
                unauthorized_work: Vec::new(),
            };
            config.agents = vec![
                persona("Lead", &[], &["coordinate", "review"]),
                persona("Back", &["backend"], &[]),
            ];
            config.conversation.reply_order.clear();
            config.coordination = CoordinationConfig {
                enabled,
                ..CoordinationConfig::default()
            };
            let core =
                Arc::new(HivemindCore::new(config, directory.join("hivemind.toml")).unwrap());
            let (shutdown, rx) = watch::channel(false);
            Self {
                app: super::super::router(core.clone(), rx),
                core,
                directory,
                _shutdown: shutdown,
            }
        }

        async fn call(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
            let mut request = Request::builder().method(method).uri(path);
            let body = match body {
                Some(body) => {
                    request = request.header(CONTENT_TYPE, "application/json");
                    Body::from(body.to_string())
                }
                None => Body::empty(),
            };
            let response = self
                .app
                .clone()
                .oneshot(request.body(body).unwrap())
                .await
                .unwrap();
            let status = response.status();
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            (
                status,
                serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            )
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn disabled_coordination_refuses_submission_but_reads_stay_available() {
        let fixture = Fixture::new(false);
        let (status, body) = fixture
            .call("POST", "/api/v1/tasks", Some(json!({"objective": "x"})))
            .await;
        assert_eq!(
            (status, body["error"]["code"].as_str()),
            (StatusCode::CONFLICT, Some("coordination_disabled"))
        );
        let (status, body) = fixture.call("GET", "/api/v1/tasks", None).await;
        assert_eq!(
            (status, body["tasks"].as_array().map(Vec::len)),
            (StatusCode::OK, Some(0))
        );
        let (status, body) = fixture.call("GET", "/api/v1/agent-instances", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["agents"].as_array().unwrap().len(), 2);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn access_endpoints_expose_effective_grants_and_the_filtered_audit_log() {
        let fixture = Fixture::new(false);
        let (status, body) = fixture.call("GET", "/api/v1/access/personas", None).await;
        assert_eq!(status, StatusCode::OK);
        let lead = body["personas"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == "Lead")
            .unwrap()
            .clone();
        assert!(
            lead["permissions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p == "task.decide"),
            "review implies task.decide: {lead}"
        );
        assert_eq!(lead["restricted"], false);

        fixture.core.access().audit().record(
            "Back",
            "memory.archive",
            "memory.archive",
            "room:r",
            false,
            "roles [worker] lack 'memory.archive'",
        );
        fixture.core.access().audit().record(
            "Lead",
            "group.manage",
            "groups.create",
            "task:t",
            true,
            "authorized",
        );
        let (_, denied) = fixture
            .call("GET", "/api/v1/access/audit?denied=true", None)
            .await;
        assert_eq!(denied["entries"].as_array().unwrap().len(), 1);
        assert_eq!(denied["entries"][0]["persona"], "Back");
        let (_, lead_only) = fixture
            .call("GET", "/api/v1/access/audit?persona=Lead&limit=5", None)
            .await;
        assert_eq!(lead_only["entries"][0]["allowed"], true);
        let (status, _) = fixture
            .call("GET", "/api/v1/access/audit?limit=x", None)
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn submit_once_then_reconstruct_status_and_events_and_cancel() {
        let fixture = Fixture::new(true);
        let plan = json!({"tasks": [{"key": "api", "objective": "build api", "acceptance": ["works"], "capabilities": ["backend"]}]});
        let (status, body) = fixture
            .call(
                "POST",
                "/api/v1/tasks",
                Some(json!({"objective": "ship it", "plan": plan, "idempotency_key": "job-1"})),
            )
            .await;
        assert_eq!(status, StatusCode::ACCEPTED, "{body}");
        let id = body["id"].as_str().unwrap().to_owned();
        assert_eq!(body["status_url"], format!("/api/v1/tasks/{id}"));
        let (_, again) = fixture
            .call(
                "POST",
                "/api/v1/tasks",
                Some(json!({"objective": "ship it", "idempotency_key": "job-1"})),
            )
            .await;
        assert_eq!(again["id"], id, "one submission creates one root");

        // "Reconnect": everything comes back from durable state alone.
        let (status, shown) = fixture
            .call("GET", &format!("/api/v1/tasks/{id}"), None)
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(shown["task"]["task"]["status"], "running");
        assert_eq!(shown["task"]["children"][0]["owner"], "Back");
        let high_water = shown["event_high_water"].as_i64().unwrap();
        let (_, events) = fixture
            .call(
                "GET",
                &format!("/api/v1/events?root={id}&after=0&limit=500"),
                None,
            )
            .await;
        assert_eq!(events["event_high_water"].as_i64().unwrap(), high_water);
        assert!(events["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["event_type"] == "task.plan_committed"));
        let (_, tail) = fixture
            .call(
                "GET",
                &format!("/api/v1/events?root={id}&after={high_water}"),
                None,
            )
            .await;
        assert!(tail["events"].as_array().unwrap().is_empty());
        let (_, list) = fixture
            .call("GET", "/api/v1/tasks?status=running", None)
            .await;
        assert_eq!(list["tasks"].as_array().unwrap().len(), 1);
        let (_, attempts) = fixture
            .call("GET", &format!("/api/v1/tasks/{id}/attempts"), None)
            .await;
        assert!(
            attempts["attempts"].as_array().unwrap().is_empty(),
            "reads never start work"
        );

        // Consistent, sanitized errors.
        for (method, path, body, code, expected) in [
            (
                "GET",
                "/api/v1/tasks/tk_missing",
                None,
                "not_found",
                StatusCode::NOT_FOUND,
            ),
            (
                "POST",
                "/api/v1/tasks",
                Some(json!({"objective": "  "})),
                "invalid_request",
                StatusCode::BAD_REQUEST,
            ),
            (
                "POST",
                "/api/v1/tasks",
                Some(json!({"nope": 1})),
                "invalid_json",
                StatusCode::BAD_REQUEST,
            ),
            (
                "GET",
                "/api/v1/tasks?status=bogus",
                None,
                "invalid_request",
                StatusCode::BAD_REQUEST,
            ),
            (
                "GET",
                "/api/v1/messages",
                None,
                "invalid_request",
                StatusCode::BAD_REQUEST,
            ),
        ] {
            let (status, body) = fixture.call(method, path, body).await;
            assert_eq!(
                (status, body["error"]["code"].as_str()),
                (expected, Some(code)),
                "{method} {path}"
            );
        }

        let (status, _) = fixture
            .call(
                "POST",
                "/api/v1/messages",
                Some(json!({"task_id": id, "to": ["Back"], "body": "hello"})),
            )
            .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        let (_, messages) = fixture
            .call("GET", &format!("/api/v1/messages?root={id}"), None)
            .await;
        assert_eq!(messages["messages"][0]["message"]["sender"], "user");
        assert_eq!(messages["messages"][0]["deliveries"][0]["state"], "queued");
        let (status, group) = fixture
            .call(
                "POST",
                "/api/v1/groups",
                Some(json!({"task_id": id, "purpose": "sync", "members": ["Lead", "Back"]})),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED);
        let gid = group["group"]["id"].as_str().unwrap();
        let (status, _) = fixture
            .call("GET", &format!("/api/v1/groups/{gid}"), None)
            .await;
        assert_eq!(status, StatusCode::OK);
        let (_, metrics) = fixture
            .call("GET", &format!("/api/v1/tasks/{id}/context-metrics"), None)
            .await;
        assert_eq!(metrics["budget"]["dispatch_limit"], 64);
        assert_eq!(metrics["rotations_observed"], 0);
        assert_eq!(metrics["runtime_epochs"], json!([]));

        let (status, cancelled) = fixture
            .call("POST", &format!("/api/v1/tasks/{id}/cancel"), None)
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(cancelled["task"]["task"]["status"], "cancelled");
        let (status, again) = fixture
            .call("POST", &format!("/api/v1/tasks/{id}/cancel"), None)
            .await;
        assert_eq!(
            (status, &again["task"]["task"]["status"]),
            (StatusCode::OK, &json!("cancelled")),
            "cancel is idempotent"
        );
        let (status, body) = fixture
            .call("POST", &format!("/api/v1/tasks/{id}/pause"), None)
            .await;
        assert_eq!(
            (status, body["error"]["code"].as_str()),
            (StatusCode::CONFLICT, Some("conflict"))
        );
        assert!(fixture
            .core
            .coordination()
            .store()
            .read(|db| db.running_attempts(None))
            .unwrap()
            .is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn steer_reaches_a_running_attempt_and_input_answers_its_open_question() {
        let fixture = Fixture::new(true);
        let plan = json!({"tasks": [{"key": "api", "objective": "build api", "acceptance": ["works"], "capabilities": ["backend"]}]});
        let (_, body) = fixture
            .call(
                "POST",
                "/api/v1/tasks",
                Some(json!({"objective": "ship it", "plan": plan})),
            )
            .await;
        let root = body["id"].as_str().unwrap().to_owned();
        let service = fixture.core.coordination();
        let steered: Arc<parking_lot::Mutex<Vec<String>>> = Arc::default();
        let sink = steered.clone();
        service.set_steerer(Arc::new(
            move |_: &crate::identity::AgentInstanceId, text: &str| {
                sink.lock().push(text.to_owned());
                true
            },
        ));
        let dispatch = service
            .claim(4, &|_| false, &std::collections::HashSet::new())
            .unwrap()
            .remove(0);
        let api = dispatch.task.id.clone();

        let (status, body) = fixture
            .call(
                "POST",
                &format!("/api/v1/tasks/{api}/steer"),
                Some(json!({"message": "use sqlite"})),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["steer"]["delivered_to"], json!(["Back"]));
        assert!(steered.lock()[0].contains("use sqlite"));
        let (status, body) = fixture
            .call(
                "POST",
                &format!("/api/v1/tasks/{root}/steer"),
                Some(json!({"message": "x"})),
            )
            .await;
        assert_eq!(
            (status, body["error"]["code"].as_str()),
            (StatusCode::CONFLICT, Some("conflict")),
            "nothing runs on the root"
        );
        let (status, _) = fixture
            .call(
                "POST",
                &format!("/api/v1/tasks/{api}/steer"),
                Some(json!({"nope": 1})),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let ctx = service
            .bind(&crate::coordination::model::task_room(&api), "Back")
            .unwrap()
            .unwrap();
        let (answer, _) = service.ask(&ctx, "which port?", None).unwrap();
        let (_, shown) = fixture
            .call("GET", &format!("/api/v1/tasks/{api}"), None)
            .await;
        assert_eq!(shown["task"]["questions"][0]["question"], "which port?");
        let (status, body) = fixture
            .call(
                "POST",
                &format!("/api/v1/tasks/{api}/input"),
                Some(json!({"answer": "8080"})),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(answer.await.unwrap().text, "8080");
        assert!(
            body["task"].get("questions").is_none(),
            "answered questions are gone"
        );
    }
}
