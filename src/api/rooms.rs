//! Read-only room endpoints: which rooms exist, their state, and paged message history.
use axum::extract::rejection::JsonRejection;
use axum::{
    extract::{Path, RawQuery, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
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
        .route(
            "/api/v1/rooms/{id}/threads",
            get(threads).post(create_thread),
        )
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
            let discussion = room_is_discussion(&state, &id);
            let targets = reply_targets(&page, discussion);
            let items: Vec<Value> = page
                .into_iter()
                .zip(targets)
                .map(|(m, t)| {
                    let mut item = json!({"id": m.id, "turn_id": m.turn_id, "speaker": m.speaker, "content": m.content, "created_at": m.created_at});
                    if let Some(t) = t {
                        item["reply_to"] = t.reply_to;
                        item["also_saw"] = json!(t.also_saw);
                    }
                    item
                })
                .collect();
            Json(json!({"room_id": id, "messages": items, "next_before": next_before}))
                .into_response()
        }
        Err(_) => internal(),
    }
}

/// Whether replies in this room see earlier same-turn replies (Discussion mode).
fn room_is_discussion(state: &ApiState, room_id: &str) -> bool {
    let target = if room_id.starts_with("thread-") {
        ConversationTarget::Thread {
            thread_id: room_id.into(),
        }
    } else if let Some(target) = crate::core::parent_target(room_id) {
        target
    } else {
        return false;
    };
    state
        .core
        .resolve_target(&target)
        .map(|room| room.mode == crate::config::ConversationMode::Discussion)
        .unwrap_or(false)
}

struct ReplyTarget {
    /// The user message this turn answers: `{"speaker": "user", "id": ...}`.
    reply_to: Value,
    /// Earlier same-turn speakers whose replies this agent also read.
    also_saw: Vec<String>,
}

/// Every agent reply answers the user message that opened its turn; in a
/// Discussion room it also reads the earlier replies of that turn. Derived
/// from turn structure, so it needs no stored field.
fn reply_targets(
    page: &[crate::memory::ArchivedMessage],
    discussion: bool,
) -> Vec<Option<ReplyTarget>> {
    let mut out = Vec::with_capacity(page.len());
    let mut turn: Option<&str> = None;
    let mut user_id: Option<&str> = None;
    let mut seen: Vec<String> = Vec::new();
    for m in page {
        if turn != Some(m.turn_id.as_str()) {
            turn = Some(m.turn_id.as_str());
            user_id = None;
            seen.clear();
        }
        if m.speaker == "user" {
            user_id = Some(m.id.as_str());
            out.push(None);
            continue;
        }
        out.push(Some(ReplyTarget {
            reply_to: json!({"speaker": "user", "id": user_id}),
            also_saw: if discussion { seen.clone() } else { Vec::new() },
        }));
        seen.push(m.speaker.clone());
    }
    out
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

#[cfg(test)]
mod reply_target_tests {
    use super::*;
    use crate::memory::ArchivedMessage;

    fn msg(id: &str, turn: &str, speaker: &str) -> ArchivedMessage {
        ArchivedMessage {
            id: id.into(),
            room_id: "group-g".into(),
            turn_id: turn.into(),
            speaker: speaker.into(),
            content: String::new(),
            created_at: 0,
        }
    }

    #[test]
    fn replies_target_the_turn_user_message_and_discussion_adds_earlier_speakers() {
        let page = vec![
            msg("u1", "t1", "user"),
            msg("a1", "t1", "Reviewer"),
            msg("a2", "t1", "Engineer"),
            msg("u2", "t2", "user"),
            msg("a3", "t2", "Engineer"),
        ];
        let discussion = reply_targets(&page, true);
        assert!(discussion[0].is_none());
        assert_eq!(discussion[1].as_ref().unwrap().reply_to["id"], "u1");
        assert!(discussion[1].as_ref().unwrap().also_saw.is_empty());
        assert_eq!(discussion[2].as_ref().unwrap().also_saw, vec!["Reviewer"]);
        assert_eq!(discussion[4].as_ref().unwrap().reply_to["id"], "u2");
        assert!(discussion[4].as_ref().unwrap().also_saw.is_empty());
        let broadcast = reply_targets(&page, false);
        assert!(broadcast[2].as_ref().unwrap().also_saw.is_empty());
    }
}
