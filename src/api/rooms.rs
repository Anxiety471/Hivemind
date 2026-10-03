//! Read-only room endpoints: which rooms exist, their state, and paged message history.
use axum::extract::rejection::JsonRejection;
use axum::{
    extract::{Path, RawQuery, State},
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
use crate::{
    core::{ConversationTarget, ResolvedConversationTarget},
    memory::Caller,
};

pub(super) fn routes() -> Router<ApiState> {
    Router::new()
        .route("/api/v1/rooms", get(list))
        .route("/api/v1/rooms/{id}", get(show))
        .route("/api/v1/rooms/{id}/messages", get(messages))
        .route("/api/v1/rooms/{id}/active", get(active))
        .route("/api/v1/rooms/{id}/steer", post(steer))
        .route(
            "/api/v1/rooms/{id}/threads",
            get(threads).post(create_thread),
        )
}

/// Personas whose reply is running in a room right now, so a client that was
/// away can show progress again instead of an apparently idle room.
async fn active(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    let agents = state.core.events().active_replies(&id);
    Json(json!({"room_id": id, "agents": agents})).into_response()
}

#[derive(Deserialize)]
struct SteerRoomBody {
    message: String,
}

/// Steer a message into any actively replying agents in a room now.
async fn steer(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    payload: Result<Json<SteerRoomBody>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload else {
        return bad_json();
    };
    let message = body.message.trim();
    if message.is_empty() {
        return ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_message",
            "message must not be empty",
        )
        .into_response();
    }
    let delivered_to = state.core.steer_room(&id, message);
    Json(json!({"room_id": id, "delivered_to": delivered_to})).into_response()
}

fn bad_json() -> Response {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "invalid_json",
        "request body must be valid JSON",
    )
    .into_response()
}

fn internal() -> Response {
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal_error",
        "request could not be completed",
    )
    .into_response()
}

fn caller() -> Caller {
    Caller::trusted_user("api")
}

/// The configured conversation targets, keyed by the room each one resolves to.
fn configured(state: &ApiState) -> Vec<(&'static str, ResolvedConversationTarget)> {
    let mut targets = vec![ConversationTarget::Main];
    targets.extend(
        state
            .core
            .agents()
            .list()
            .into_iter()
            .map(|agent| ConversationTarget::Solo {
                persona_id: agent.name.clone(),
            }),
    );
    targets.extend(
        state
            .core
            .config()
            .groups
            .iter()
            .map(|group| ConversationTarget::Group {
                group_id: group.name.clone(),
            }),
    );
    targets
        .iter()
        .filter_map(|target| {
            let kind = match target {
                ConversationTarget::Main => "main",
                ConversationTarget::Solo { .. } => "solo",
                ConversationTarget::Group { .. } => "group",
                ConversationTarget::Thread { .. } => "thread",
            };
            state.core.resolve_target(target).ok().map(|r| (kind, r))
        })
        .collect()
}

fn describe(kind: &str, room: &ResolvedConversationTarget) -> Value {
    json!({
        "id": room.room_id,
        "name": room.room_name,
        "kind": kind,
        "mode": room.mode,
        "participants": room.participants.iter().map(|p| json!({"persona_id": p.agent.name, "role": p.role})).collect::<Vec<_>>(),
    })
}

async fn list(State(state): State<ApiState>) -> Response {
    let summaries = match state.core.memory().room_summaries(&caller()) {
        Ok(rows) => rows,
        Err(_) => return internal(),
    };
    let stored = state
        .core
        .execution()
        .all_room_settings()
        .unwrap_or_default();
    let mut rooms: Vec<Value> = Vec::new();
    for (kind, room) in configured(&state) {
        let mut value = describe(kind, &room);
        value["settings"] = json!(stored
            .iter()
            .find(|(id, _)| *id == room.room_id)
            .map(|(_, s)| s.clone())
            .unwrap_or_default());
        let found = summaries.iter().find(|(id, ..)| *id == room.room_id);
        value["updated_at"] = json!(found.map(|s| s.2));
        value["message_count"] = json!(found.map_or(0, |s| s.3));
        rooms.push(value);
    }
    // Archived rooms no longer backed by a configured target (e.g. a deleted group).
    for (id, name, updated_at, count) in &summaries {
        if !rooms.iter().any(|r| r["id"] == *id) {
            rooms.push(json!({"id": id, "name": name, "kind": "archived", "participants": [], "updated_at": updated_at, "message_count": count}));
        }
    }
    Json(json!({"rooms": rooms})).into_response()
}

async fn show(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    if let Ok(Some(thread)) = state.core.memory().thread(&caller(), &id) {
        let mut value = match state.core.resolve_target(&ConversationTarget::Thread {
            thread_id: id.clone(),
        }) {
            Ok(room) => describe("thread", &room),
            Err(_) => json!({"id": id, "name": thread.name, "kind": "thread", "participants": []}),
        };
        value["parent_room_id"] = json!(thread.parent_room_id);
        value["anchor_message_id"] = json!(thread.anchor_message_id);
        value["updated_at"] = json!(thread.updated_at);
        value["message_count"] = json!(thread.message_count);
        if let Ok(history) = state.core.conversation().room_history(&id) {
            value["state"] = json!(history.state);
            value["summary"] = json!(history.summary);
        }
        return Json(json!({"room": value})).into_response();
    }
    let configured = configured(&state);
    let known = configured.iter().find(|(_, r)| r.room_id == id);
    let summary = match state.core.memory().room_summaries(&caller()) {
        Ok(rows) => rows.into_iter().find(|(room, ..)| *room == id),
        Err(_) => return internal(),
    };
    if known.is_none() && summary.is_none() {
        return ApiError::new(StatusCode::NOT_FOUND, "not_found", "room was not found")
            .into_response();
    }
    let mut value = match known {
        Some((kind, room)) => describe(kind, room),
        None => json!({"id": id, "kind": "archived", "participants": []}),
    };
    let history = match state.core.conversation().room_history(&id) {
        Ok(history) => history,
        Err(_) => return internal(),
    };
    value["settings"] = json!(state
        .core
        .execution()
        .room_settings(&id)
        .unwrap_or_default());
    value["updated_at"] = json!(summary.as_ref().map(|s| s.2));
    value["message_count"] = json!(summary.as_ref().map_or(0, |s| s.3));
    value["state"] = json!(history.state);
    value["summary"] = json!(history.summary);
    Json(json!({"room": value})).into_response()
}

async fn messages(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let params = query(raw);
    let limit = match number(&params, "limit", 50) {
        Ok(v) => v.clamp(1, 200) as usize,
        Err(response) => return response.into_response(),
    };
    let before = params.get("before").map(String::as_str);
    match state
        .core
        .memory()
        .room_messages_page(&caller(), &id, before, limit)
    {
        Ok(page) => {
            let next_before = (page.len() == limit)
                .then(|| page.first().map(|m| m.id.clone()))
                .flatten();
            let items: Vec<Value> = page
                .into_iter()
                .map(|m| json!({"id": m.id, "turn_id": m.turn_id, "speaker": m.speaker, "content": m.content, "created_at": m.created_at}))
                .collect();
            Json(json!({"room_id": id, "messages": items, "next_before": next_before}))
                .into_response()
        }
        Err(_) => internal(),
    }
}

async fn threads(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    match state.core.memory().threads(&caller(), &id) {
        Ok(threads) => Json(json!({"room_id": id, "threads": threads})).into_response(),
        Err(_) => internal(),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ThreadBody {
    anchor_message_id: String,
    #[serde(default)]
    name: Option<String>,
}

/// Start a thread on one message of a room, or return the existing one for that message.
async fn create_thread(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    payload: Result<Json<ThreadBody>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload else {
        return ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_json",
            "invalid request body",
        )
        .into_response();
    };
    if body.anchor_message_id.trim().is_empty() {
        return ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "anchor_message_id must not be empty",
        )
        .into_response();
    }
    // Only rooms that can be resumed with a turn may carry threads.
    if super::rooms::parent_exists(&state, &id).is_none() {
        return ApiError::new(StatusCode::NOT_FOUND, "not_found", "room was not found")
            .into_response();
    }
    let name = body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or("Thread");
    match state
        .core
        .memory()
        .create_thread(&caller(), &id, &body.anchor_message_id, name)
    {
        Ok((thread, created)) => {
            if created {
                state
                    .core
                    .events()
                    .publish(crate::events::DomainEventKind::ThreadCreated {
                        thread_id: thread.id.clone(),
                        parent_room_id: thread.parent_room_id.clone(),
                        anchor_message_id: thread.anchor_message_id.clone(),
                    });
            }
            (
                if created {
                    StatusCode::CREATED
                } else {
                    StatusCode::OK
                },
                Json(json!({"thread": thread, "created": created})),
            )
                .into_response()
        }
        Err(error) => {
            let message = error.to_string();
            if message.contains("anchor message not found") {
                ApiError::new(
                    StatusCode::NOT_FOUND,
                    "anchor_not_found",
                    "anchor message was not found in this room",
                )
                .into_response()
            } else if message.contains("nested") {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "threads cannot be nested",
                )
                .into_response()
            } else {
                internal()
            }
        }
    }
}

fn parent_exists(state: &ApiState, room_id: &str) -> Option<()> {
    crate::core::parent_target(room_id)
        .and_then(|target| state.core.resolve_target(&target).ok())
        .map(|_| ())
        .or_else(|| {
            // An archived room whose configured target is gone still has history to thread.
            state
                .core
                .memory()
                .room_summaries(&caller())
                .ok()?
                .iter()
                .any(|(id, ..)| id == room_id)
                .then_some(())
        })
}
