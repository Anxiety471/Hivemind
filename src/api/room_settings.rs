//! Per-conversation settings for the main conversation, direct messages, and group chats.
//!
//! One endpoint describes every control a room has, so the UI never hard-codes which
//! settings apply where: a control that does not apply says why instead of vanishing.
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
use crate::{commands::GroupCommand, config::ConversationMode, execution::RoomSettingsPatch};

pub(super) fn routes() -> Router<ApiState> {
    Router::new().route("/api/v1/rooms/{id}/settings", get(show).patch(update))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Main,
    Solo,
    Group,
}

fn kind_of(id: &str) -> Option<Kind> {
    if id == "main" {
        Some(Kind::Main)
    } else if id.starts_with("solo-") {
        Some(Kind::Solo)
    } else if id.starts_with("group-") {
        Some(Kind::Group)
    } else {
        None
    }
}

fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Main => "main",
        Kind::Solo => "solo",
        Kind::Group => "group",
    }
}

fn error(status: StatusCode, code: &'static str, message: String) -> Response {
    ApiError::owned(status, code, message).into_response()
}

fn not_configurable(id: &str) -> Response {
    error(
        StatusCode::NOT_FOUND,
        "not_found",
        format!("room '{id}' has no configurable settings; only the main conversation, direct messages and group chats do"),
    )
}

/// Current values plus, per control, whether it applies to this room kind.
#[allow(clippy::result_large_err)]
fn describe(state: &ApiState, id: &str, kind: Kind) -> Result<Value, Response> {
    let stored = state.core.execution().room_settings(id).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "request could not be completed".into(),
        )
    })?;
    let config = state.core.config();
    let group = (kind == Kind::Group)
        .then(|| id.strip_prefix("group-").expect("group room prefix"))
        .and_then(|name| config.groups.iter().find(|g| g.name == name));
    let persona = (kind == Kind::Solo)
        .then(|| id.strip_prefix("solo-").expect("solo room prefix"))
        .and_then(|name| state.core.agents().get(name));
    match kind {
        Kind::Group if group.is_none() => {
            return Err(error(
                StatusCode::NOT_FOUND,
                "not_found",
                "group was not found".into(),
            ))
        }
        Kind::Solo if persona.is_none() => {
            return Err(error(
                StatusCode::NOT_FOUND,
                "not_found",
                "agent was not found".into(),
            ))
        }
        _ => {}
    }
    let reply_order = match (kind, group) {
        (Kind::Group, Some(group)) => json!(group.reply_order),
        _ => json!(config.conversation.reply_order),
    };
    let workspace = match (kind, group, &persona) {
        (Kind::Group, Some(group), _) => state.core.shared_workspaces().group(&group.name),
        (Kind::Solo, _, Some(agent)) => state.core.shared_workspaces().persona(&agent.name),
        _ => None,
    };
    let members: Vec<String> = match kind {
        Kind::Group => group.map(|g| g.members.clone()).unwrap_or_default(),
        Kind::Main => state
            .core
            .agents()
            .list()
            .iter()
            .map(|a| a.name.clone())
            .collect(),
        Kind::Solo => Vec::new(),
    };
    let reason = |applies: bool, why: &str| (!applies).then(|| why.to_owned());
    Ok(json!({
        "room_id": id,
        "kind": kind_name(kind),
        "settings": {
            "nickname": stored.nickname,
            "pinned": stored.pinned,
            "muted": stored.muted,
            "mode": group.map(|g| g.mode),
            "reply_order": reply_order,
            "workspace": workspace,
        },
        "members": members,
        "unavailable": {
            "mode": reason(kind == Kind::Group, if kind == Kind::Main {
                "The main conversation always broadcasts to every agent."
            } else {
                "A direct message has a single agent, so there is no conversation mode."
            }),
            "reply_order": reason(kind != Kind::Solo, "A direct message has a single agent, so there is no reply order."),
            "workspace": reason(kind != Kind::Main, "The main conversation has no single workspace; each agent uses its own."),
        },
    }))
}

async fn show(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    let Some(kind) = kind_of(&id) else {
        return not_configurable(&id);
    };
    match describe(&state, &id, kind) {
        Ok(value) => Json(value).into_response(),
        Err(response) => response,
    }
}

/// `workspace: null` clears a group's shared workspace; absent fields are left alone.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SettingsBody {
    nickname: Option<String>,
    pinned: Option<bool>,
    muted: Option<bool>,
    mode: Option<ConversationMode>,
    reply_order: Option<Vec<String>>,
    #[serde(default, deserialize_with = "present")]
    workspace: Option<Option<String>>,
}

fn present<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

async fn update(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    payload: Result<Json<SettingsBody>, JsonRejection>,
) -> Response {
    if id.contains("..") || id.contains('/') || id.contains('\\') {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "invalid room id".into(),
        );
    }
    let Ok(Json(body)) = payload else {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_json",
            "invalid request body".into(),
        );
    };
    if let Some(Some(ws)) = &body.workspace {
        if ws.contains("..") {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "workspace path must not contain '..'".into(),
            );
        }
    }
    if let Some(order) = &body.reply_order {
        if order
            .iter()
            .any(|name| name.contains("..") || name.contains('/') || name.contains('\\'))
        {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "invalid agent in reply order".into(),
            );
        }
    }
    let Some(kind) = kind_of(&id) else {
        return not_configurable(&id);
    };
    let current = match describe(&state, &id, kind) {
        Ok(value) => value,
        Err(response) => return response,
    };
    // Reject a control that does not apply before changing anything.
    for (key, present) in [
        ("mode", body.mode.is_some()),
        ("reply_order", body.reply_order.is_some()),
        ("workspace", body.workspace.is_some()),
    ] {
        if present {
            if let Some(why) = current["unavailable"][key].as_str() {
                return error(StatusCode::BAD_REQUEST, "not_applicable", why.to_owned());
            }
        }
    }
    let workspace = match &body.workspace {
        Some(Some(path)) if !path.trim().is_empty() => match state.core.validate_workspace(path) {
            Ok(path) => Some(Some(path)),
            Err(e) => return error(StatusCode::BAD_REQUEST, "invalid_request", e.to_string()),
        },
        Some(_) if kind == Kind::Solo => {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "a direct message's workspace cannot be cleared".into(),
            )
        }
        Some(_) => Some(None),
        None => None,
    };
    if let Some(order) = &body.reply_order {
        // Fail on a bad order before any other change lands.
        let members: Vec<String> = current["members"]
            .as_array()
            .map(|m| {
                m.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        if let Some(unknown) = order.iter().find(|name| !members.contains(name)) {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                format!("'{unknown}' is not a participant of this room"),
            );
        }
        let mut seen = std::collections::HashSet::new();
        if let Some(duplicate) = order.iter().find(|name| !seen.insert(*name)) {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                format!("'{duplicate}' appears twice in the reply order"),
            );
        }
    }
    let patch = RoomSettingsPatch {
        nickname: body.nickname,
        pinned: body.pinned,
        muted: body.muted,
    };
    // The nickname is the only stored value that can still fail; check it before applying anything.
    if let Some(nickname) = &patch.nickname {
        if nickname.trim().chars().count() > 60 || nickname.chars().any(char::is_control) {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "nickname must be at most 60 characters with no control characters".into(),
            );
        }
    }
    let applied = match kind {
        Kind::Group => {
            let name = id
                .strip_prefix("group-")
                .expect("group room prefix")
                .to_owned();
            let group_change = if body.mode.is_some() || body.reply_order.is_some() {
                state.core.mutate_groups(GroupCommand::Update {
                    name: name.clone(),
                    members: None,
                    mode: body.mode,
                    member_roles: None,
                    reply_order: body.reply_order.clone(),
                })
            } else {
                Ok(())
            };
            group_change.and_then(|()| match &workspace {
                Some(Some(path)) => state
                    .core
                    .shared_workspaces()
                    .set_group(&name, path)
                    .map(|_| ()),
                Some(None) => state.core.shared_workspaces().clear_group(&name),
                None => Ok(()),
            })
        }
        Kind::Solo => match &workspace {
            Some(Some(path)) => state
                .core
                .shared_workspaces()
                .set_persona(id.strip_prefix("solo-").expect("solo room prefix"), path)
                .map(|_| ()),
            _ => Ok(()),
        },
        Kind::Main => match body.reply_order {
            Some(order) => state.core.set_main_reply_order(order),
            None => Ok(()),
        },
    };
    if let Err(e) = applied {
        return error(StatusCode::BAD_REQUEST, "invalid_request", e.to_string());
    }
    if let Err(e) = state.core.execution().update_room_settings(&id, &patch) {
        return error(StatusCode::BAD_REQUEST, "invalid_request", e.to_string());
    }
    state
        .core
        .events()
        .publish(crate::events::DomainEventKind::ConfigChanged {
            scope: "rooms".into(),
        });
    show(State(state), Path(id)).await
}
