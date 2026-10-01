//! Workspace and role inspection, plus workspace changes for the operator.
//!
//! Changes go through the same validation as the agent `workspace.*` tools (absolute
//! existing directory, inside `[workspaces] roots` when configured) and are written to
//! the config file before they take effect.
use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{error::ApiError, routes::ApiState};
use crate::access::BUILTIN_ROLES;

pub(super) fn routes() -> Router<ApiState> {
    Router::new()
        .route(
            "/api/v1/workspaces/groups/{id}",
            put(set_group).delete(clear_group),
        )
        .route(
            "/api/v1/workspaces",
            get(list).post(add_known).delete(remove_known),
        )
        .route("/api/v1/workspaces/personas/{id}", put(set_persona))
        .route("/api/v1/access/roles", get(roles))
}

fn snapshot(state: &ApiState) -> Value {
    let workspaces = state.core.shared_workspaces();
    let (groups, personas) = workspaces.snapshot();
    json!({
        "roots": workspaces.roots(),
        "known": workspaces.known(),
        "groups": groups.into_iter().map(|(id, workspace)| json!({"id": id, "workspace": workspace})).collect::<Vec<_>>(),
        "personas": personas.into_iter().map(|(id, workspace)| json!({"id": id, "workspace": workspace})).collect::<Vec<_>>(),
    })
}

async fn list(State(state): State<ApiState>) -> Response {
    Json(snapshot(&state)).into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PathBody {
    path: String,
}

fn failure(error: anyhow::Error) -> Response {
    let message = error.to_string();
    if error.chain().any(|c| c.is::<std::io::Error>()) {
        eprintln!("workspace change failed: {error:#}");
        return ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "request could not be completed",
        )
        .into_response();
    }
    if message.contains("already exists") || message.contains("still in use") {
        return ApiError::owned(StatusCode::CONFLICT, "conflict", message).into_response();
    }
    if message.starts_with("unknown ") {
        return ApiError::owned(StatusCode::NOT_FOUND, "not_found", message).into_response();
    }
    ApiError::owned(StatusCode::BAD_REQUEST, "invalid_request", message).into_response()
}

fn bad_json() -> Response {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "invalid_json",
        "invalid request body",
    )
    .into_response()
}

/// Add another workspace; every existing one stays as it is.
async fn add_known(
    State(state): State<ApiState>,
    payload: Result<Json<PathBody>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload else {
        return bad_json();
    };
    match state.core.shared_workspaces().add_known(&body.path) {
        Ok(_) => (StatusCode::CREATED, Json(snapshot(&state))).into_response(),
        Err(error) => failure(error),
    }
}

async fn remove_known(
    State(state): State<ApiState>,
    payload: Result<Json<PathBody>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload else {
        return bad_json();
    };
    match state
        .core
        .shared_workspaces()
        .remove_known(body.path.trim())
    {
        Ok(()) => Json(snapshot(&state)).into_response(),
        Err(error) => failure(error),
    }
}

async fn set_group(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    payload: Result<Json<PathBody>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload else {
        return bad_json();
    };
    match state.core.shared_workspaces().set_group(&id, &body.path) {
        Ok(_) => Json(snapshot(&state)).into_response(),
        Err(error) => failure(error),
    }
}

async fn clear_group(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    match state.core.shared_workspaces().clear_group(&id) {
        Ok(()) => Json(snapshot(&state)).into_response(),
        Err(error) => failure(error),
    }
}

async fn set_persona(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    payload: Result<Json<PathBody>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload else {
        return bad_json();
    };
    match state.core.shared_workspaces().set_persona(&id, &body.path) {
        Ok(_) => Json(snapshot(&state)).into_response(),
        Err(error) => failure(error),
    }
}

/// Role definitions: the built-in roles and the user's custom ones, with the
/// permissions each grants directly (before implication).
async fn roles(State(state): State<ApiState>) -> Response {
    let builtin: Vec<Value> = BUILTIN_ROLES
        .iter()
        .map(|(name, permissions)| json!({"name": name, "permissions": permissions}))
        .collect();
    let custom: Vec<Value> = state
        .core
        .config()
        .roles
        .iter()
        .map(|(name, role)| json!({"name": name, "permissions": role.permissions}))
        .collect();
    Json(json!({"builtin": builtin, "custom": custom})).into_response()
}
