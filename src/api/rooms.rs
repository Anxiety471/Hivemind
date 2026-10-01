//! Read-only room endpoints: which rooms exist, their state, and paged message history.
use axum::{
    extract::{Path, RawQuery, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
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
    let mut rooms: Vec<Value> = Vec::new();
    for (kind, room) in configured(&state) {
        let mut value = describe(kind, &room);
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
