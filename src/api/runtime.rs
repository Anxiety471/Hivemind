//! Runtime session visibility and control. Reads never start a runtime.
use axum::{
    extract::{rejection::JsonRejection, Path, RawQuery, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    error::ApiError,
    routes::ApiState,
    tasks::{number, query},
};
use crate::{identity::AgentInstanceId, memory::Caller, runtime::is_rotation};

pub(super) fn routes() -> Router<ApiState> {
    Router::new()
        .route("/api/v1/rooms/{id}/runtime-sessions", get(sessions))
        .route("/api/v1/runtime/rotate", post(rotate))
}

/// Runtime epochs (one per live session of an agent in the room), oldest first.
/// `ended_at: null` marks a session that is still open.
async fn sessions(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let params = query(raw);
    let limit = match number(&params, "limit", 100) {
        Ok(v) => v.clamp(1, 500) as usize,
        Err(response) => return response.into_response(),
    };
    match state
        .core
        .memory()
        .room_runtime_epochs(&Caller::trusted_user("api"), &id, limit)
    {
        Ok(epochs) => {
            let items: Vec<Value> = epochs
                .into_iter()
                .map(|e| {
                    json!({
                        "id": e.id,
                        "agent_instance_id": e.agent_instance_id.encode(),
                        "persona_id": e.agent_instance_id.persona_id,
                        "runtime": e.runtime,
                        "started_at": e.started_at,
                        "ended_at": e.ended_at,
                        "end_reason": e.end_reason,
                        "rotation": e.end_reason.as_deref().map(is_rotation),
                    })
                })
                .collect();
            Json(json!({"room_id": id, "sessions": items})).into_response()
        }
        Err(_) => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "request could not be completed",
        )
        .into_response(),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RotateBody {
    agent_instance_id: String,
}

/// Stop one instance's live session so its next prompt starts a fresh one. Waits for an
/// in-flight prompt, so it runs in the background; watch `runtime.rotated` on the WebSocket.
async fn rotate(
    State(state): State<ApiState>,
    payload: Result<Json<RotateBody>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload else {
        return ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_json",
            "invalid request body",
        )
        .into_response();
    };
    let Some(instance) = AgentInstanceId::decode(&body.agent_instance_id) else {
        return ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "agent_instance_id is not a valid identity",
        )
        .into_response();
    };
    if state.core.is_shutting_down() {
        return ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "core_shutting_down",
            "core is shutting down",
        )
        .into_response();
    }
    let core = state.core.clone();
    tokio::spawn(async move { core.rotate_instance(&instance, "operator_rotate").await });
    (StatusCode::ACCEPTED, Json(json!({"accepted": true}))).into_response()
}
