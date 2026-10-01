//! Chat groups: the configured sets of agents a room can talk to (`group-<id>` rooms).
//!
//! Distinct from the coordination groups under `/api/v1/groups`, which belong to tasks.
use std::collections::HashMap;

use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{error::ApiError, routes::ApiState};
use crate::{
    commands::GroupCommand,
    config::{ConversationMode, GroupConfig},
};

pub(super) fn routes() -> Router<ApiState> {
    Router::new()
        .route("/api/v1/chat-groups", get(list).post(create))
        .route(
            "/api/v1/chat-groups/{id}",
            get(show).patch(update).delete(remove),
        )
}

fn view(group: &GroupConfig) -> Value {
    json!({
        "id": group.name,
        "room_id": format!("group-{}", group.name),
        "members": group.members,
        "mode": group.mode,
        "member_roles": group.member_roles,
        "reply_order": group.reply_order,
        "workspace": group.workspace,
    })
}

fn not_found() -> Response {
    ApiError::new(StatusCode::NOT_FOUND, "not_found", "group was not found").into_response()
}

fn bad_json() -> Response {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "invalid_json",
        "invalid request body",
    )
    .into_response()
}

fn exists(state: &ApiState, id: &str) -> bool {
    state.core.config().groups.iter().any(|g| g.name == id)
}

/// Validation failures are the caller's to fix; anything touching the config file is ours.
fn failure(error: anyhow::Error) -> Response {
    let message = error.to_string();
    let internal = error.chain().any(|cause| {
        cause.is::<std::io::Error>()
            || cause.is::<toml::de::Error>()
            || cause.is::<toml::ser::Error>()
            || cause.is::<toml_edit::TomlError>()
    });
    if internal {
        eprintln!("chat group change failed: {error:#}");
        return ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "request could not be completed",
        )
        .into_response();
    }
    let status = if message.contains("already") {
        StatusCode::CONFLICT
    } else if message.contains("no group named") {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::BAD_REQUEST
    };
    ApiError::owned(status, "invalid_request", message).into_response()
}

async fn list(State(state): State<ApiState>) -> Response {
    let groups: Vec<Value> = state.core.config().groups.iter().map(view).collect();
    Json(json!({"groups": groups})).into_response()
}

async fn show(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    match state.core.config().groups.iter().find(|g| g.name == id) {
        Some(group) => Json(json!({"group": view(group)})).into_response(),
        None => not_found(),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateBody {
    id: String,
    #[serde(default)]
    members: Vec<String>,
}

async fn create(
    State(state): State<ApiState>,
    payload: Result<Json<CreateBody>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload else {
        return bad_json();
    };
    let id = body.id.trim().to_owned();
    if let Err(error) = state.core.mutate_groups(GroupCommand::Create {
        name: id.clone(),
        agents: body.members,
    }) {
        return failure(error);
    }
    match state.core.config().groups.iter().find(|g| g.name == id) {
        Some(group) => (StatusCode::CREATED, Json(json!({"group": view(group)}))).into_response(),
        None => not_found(),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateBody {
    members: Option<Vec<String>>,
    mode: Option<ConversationMode>,
    member_roles: Option<HashMap<String, String>>,
    reply_order: Option<Vec<String>>,
}

async fn update(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    payload: Result<Json<UpdateBody>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload else {
        return bad_json();
    };
    if !exists(&state, &id) {
        return not_found();
    }
    if let Err(error) = state.core.mutate_groups(GroupCommand::Update {
        name: id.clone(),
        members: body.members,
        mode: body.mode,
        member_roles: body.member_roles,
        reply_order: body.reply_order,
    }) {
        return failure(error);
    }
    match state.core.config().groups.iter().find(|g| g.name == id) {
        Some(group) => Json(json!({"group": view(group)})).into_response(),
        None => not_found(),
    }
}

async fn remove(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    if !exists(&state, &id) {
        return not_found();
    }
    match state.core.mutate_groups(GroupCommand::Delete { name: id }) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => failure(error),
    }
}
