//! Read-only room endpoints: which rooms exist, their state, and paged message history.
use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::{
    extract::{Path, RawQuery, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
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
        .route("/api/v1/rooms/{id}/exposure", get(exposure))
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

#[derive(Serialize)]
pub struct RoomExposureResponse {
    pub room_id: String,
    pub room_kind: String,
    pub room_name: String,
    pub agents: Vec<AgentExposure>,
    pub skills: Vec<crate::skills::Skill>,
}

#[derive(Serialize)]
pub struct AgentExposure {
    pub persona_id: String,
    pub runtime: String,
    pub model: Option<String>,
    pub reasoning: Option<String>,
    pub fast: Option<bool>,
    pub role: Option<String>,
    pub workspace: AgentWorkspaceExposure,
    pub authorization: AgentAuthorizationExposure,
    pub tools: AgentToolsExposure,
}

#[derive(Serialize)]
pub struct AgentWorkspaceExposure {
    pub effective: String,
    pub is_shared: bool,
    pub source: &'static str,
}

#[derive(Serialize)]
pub struct AgentAuthorizationExposure {
    pub restricted: bool,
    pub roles: Vec<String>,
    pub permissions: Vec<String>,
    pub capabilities: Vec<String>,
    pub sandbox: AgentSandboxExposure,
}

#[derive(Serialize)]
pub struct AgentSandboxExposure {
    pub file_editing: bool,
    pub shell_execution: bool,
    pub web_access: bool,
}

#[derive(Serialize)]
pub struct AgentToolsExposure {
    pub runtime: Vec<RuntimeToolExposure>,
    pub host: Vec<HostToolExposure>,
}

#[derive(Serialize)]
pub struct RuntimeToolExposure {
    pub name: &'static str,
    pub category: &'static str,
    pub allowed: bool,
    pub description: &'static str,
    pub reason: Option<&'static str>,
}

#[derive(Serialize)]
pub struct HostToolExposure {
    pub name: &'static str,
    pub category: &'static str,
    pub available: bool,
    pub allowed: bool,
    pub permission: Option<&'static str>,
    pub description: &'static str,
}

async fn exposure(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    // Thread resolution: check state.core.memory().thread(&caller(), &id). If found, resolve via state.core.resolve_target(&ConversationTarget::Thread { thread_id: id }).
    if let Ok(Some(thread)) = state.core.memory().thread(&caller(), &id) {
        let (room_name, group_id, participants) =
            match state.core.resolve_target(&ConversationTarget::Thread {
                thread_id: id.clone(),
            }) {
                Ok(resolved) => (resolved.room_name, resolved.group_id, resolved.participants),
                Err(_) => (thread.name, String::new(), Vec::new()),
            };
        return build_exposure_response(&state, id, "thread", room_name, group_id, participants);
    }

    // Task room resolution: if crate::coordination::model::task_of_room(&id) returns Some(task_id), find task detail from state.core.coordination().detail(task_id) if coordination is enabled; collect coordinator, owner, reviewer personas from state.core.agents().
    if let Some(task_id) = crate::coordination::model::task_of_room(&id) {
        if state.core.coordination().enabled() {
            if let Ok(detail) = state.core.coordination().detail(task_id) {
                let mut participants = Vec::new();
                let mut seen = std::collections::HashSet::new();
                let candidates = [
                    (detail.task.coordinator.as_str(), "coordinator"),
                    (detail.task.owner.as_deref().unwrap_or(""), "owner"),
                    (detail.task.reviewer.as_deref().unwrap_or(""), "reviewer"),
                ];
                for (name, role) in candidates {
                    if !name.is_empty() && seen.insert(name) {
                        if let Some(agent) = state.core.agents().get(name) {
                            let mut a = (*agent).clone();
                            if !detail.task.workspace.is_empty() {
                                a.workspace = detail.task.workspace.clone();
                            }
                            participants.push(crate::conversation::Participant {
                                agent: Arc::new(a),
                                role: Some(role.to_string()),
                            });
                        }
                    }
                }
                return build_exposure_response(
                    &state,
                    id,
                    "task",
                    detail.task.objective,
                    String::new(),
                    participants,
                );
            }
        }
    }

    // Configured rooms (main, solo-*, group-*): match from configured(&state).
    let configured_rooms = configured(&state);
    if let Some((kind, resolved)) = configured_rooms.into_iter().find(|(_, r)| r.room_id == id) {
        return build_exposure_response(
            &state,
            id,
            kind,
            resolved.room_name,
            resolved.group_id,
            resolved.participants,
        );
    }

    // Summary check: if not in configured rooms, check room_summaries(&caller()). If missing, return 404 ApiError::new(StatusCode::NOT_FOUND, "not_found", "room was not found"). If found in summary, kind is "archived", participants is empty.
    let summaries = match state.core.memory().room_summaries(&caller()) {
        Ok(rows) => rows,
        Err(_) => return internal(),
    };
    if let Some((_, name, ..)) = summaries.into_iter().find(|(room, ..)| *room == id) {
        return build_exposure_response(&state, id, "archived", name, String::new(), Vec::new());
    }

    ApiError::new(StatusCode::NOT_FOUND, "not_found", "room was not found").into_response()
}

fn build_exposure_response(
    state: &ApiState,
    room_id: String,
    kind: &str,
    room_name: String,
    group_id: String,
    participants: Vec<crate::conversation::Participant>,
) -> Response {
    let skills = state.core.skills().list();
    let has_skills = !skills.is_empty();

    let is_group = kind == "group" || !group_id.is_empty();
    let is_solo = kind == "solo";
    let is_chat = kind == "main" || kind == "solo" || kind == "group" || kind == "thread";
    let is_task = kind == "task";

    let mut agents = Vec::new();
    for p in &participants {
        let agent_cfg = state
            .core
            .agents()
            .get(&p.agent.name)
            .map(|a| (*a).clone())
            .unwrap_or_else(|| (*p.agent).clone());

        let grants = crate::access::resolve(&agent_cfg, &state.core.config().roles);
        let tool_access = crate::access::tool_access(&agent_cfg, &state.core.config().roles);

        let file_editing = tool_access.map(|ta| ta.write).unwrap_or(true);
        let shell_execution = tool_access.map(|ta| ta.exec).unwrap_or(true);
        let web_access = agent_cfg.web;

        let effective = p.agent.workspace.clone();
        let is_shared = if !group_id.is_empty() {
            state.core.shared_workspaces().group(&group_id).as_deref() == Some(&effective)
        } else {
            false
        };
        let source = if is_shared { "group" } else { "persona" };

        let runtime_tools = vec![
            RuntimeToolExposure {
                name: "read",
                category: "fs_read",
                allowed: true,
                description: "Read and inspect workspace files",
                reason: None,
            },
            RuntimeToolExposure {
                name: "grep",
                category: "fs_read",
                allowed: true,
                description: "Search workspace file contents",
                reason: None,
            },
            RuntimeToolExposure {
                name: "glob",
                category: "fs_read",
                allowed: true,
                description: "Find files by pattern",
                reason: None,
            },
            RuntimeToolExposure {
                name: "edit",
                category: "fs_write",
                allowed: file_editing,
                description: "Edit existing files",
                reason: if file_editing {
                    None
                } else {
                    Some("Lacks 'workspace.write' permission")
                },
            },
            RuntimeToolExposure {
                name: "write",
                category: "fs_write",
                allowed: file_editing,
                description: "Create or overwrite files",
                reason: if file_editing {
                    None
                } else {
                    Some("Lacks 'workspace.write' permission")
                },
            },
            RuntimeToolExposure {
                name: "bash",
                category: "execution",
                allowed: shell_execution,
                description: "Execute shell commands",
                reason: if shell_execution {
                    None
                } else {
                    Some("Lacks 'workspace.exec' permission")
                },
            },
            RuntimeToolExposure {
                name: "python",
                category: "execution",
                allowed: shell_execution,
                description: "Run Python scripts",
                reason: if shell_execution {
                    None
                } else {
                    Some("Lacks 'workspace.exec' permission")
                },
            },
            RuntimeToolExposure {
                name: "web_search",
                category: "web",
                allowed: web_access,
                description: "Web search and page retrieval",
                reason: if web_access {
                    None
                } else {
                    Some("Web access disabled")
                },
            },
        ];

        let (
            workspace_set_available,
            workspace_set_allowed,
            workspace_set_perm,
            workspace_set_desc,
        ) = if is_solo {
            (
                true,
                !grants.restricted || grants.has("workspace.write"),
                Some("workspace.write"),
                "Change own workspace",
            )
        } else if is_group {
            (
                true,
                !grants.restricted || grants.has("group.manage"),
                Some("group.manage"),
                "Change group shared workspace",
            )
        } else {
            (false, false, None, "Not offered in this room type")
        };

        let (
            workspace_clear_available,
            workspace_clear_allowed,
            workspace_clear_perm,
            workspace_clear_desc,
        ) = if is_group {
            (
                true,
                !grants.restricted || grants.has("group.manage"),
                Some("group.manage"),
                "Clear group shared workspace",
            )
        } else {
            (false, false, None, "Not offered in this room type")
        };

        let host_tools = vec![
            HostToolExposure {
                name: "memory.search",
                category: "memory",
                available: true,
                allowed: true,
                permission: None,
                description: "Search across memory scopes",
            },
            HostToolExposure {
                name: "memory.private.*",
                category: "memory",
                available: true,
                allowed: !grants.restricted || grants.has("memory.private.write"),
                permission: Some("memory.private.write"),
                description: "Add, update, or upsert private memory records",
            },
            HostToolExposure {
                name: "memory.group.*",
                category: "memory",
                available: is_group,
                allowed: is_group && (!grants.restricted || grants.has("memory.group.write")),
                permission: Some("memory.group.write"),
                description: "Add, update, or upsert group memory records",
            },
            HostToolExposure {
                name: "memory.persona.*",
                category: "memory",
                available: true,
                allowed: !grants.restricted || grants.has("memory.persona.write"),
                permission: Some("memory.persona.write"),
                description: "Propose updates to persona memory",
            },
            HostToolExposure {
                name: "memory.global.*",
                category: "memory",
                available: true,
                allowed: !grants.restricted || grants.has("memory.global.write"),
                permission: Some("memory.global.write"),
                description:
                    "Propose updates to global memory (requires operator Global: directive)",
            },
            HostToolExposure {
                name: "memory.archive.*",
                category: "memory",
                available: true,
                allowed: !grants.restricted || grants.has("memory.archive"),
                permission: Some("memory.archive"),
                description: "Archive superseded memory records",
            },
            HostToolExposure {
                name: "workspace.get / list",
                category: "workspace",
                available: is_solo || is_group,
                allowed: is_solo || is_group,
                permission: None,
                description: "Inspect active workspace and allowed root directories",
            },
            HostToolExposure {
                name: "workspace.set",
                category: "workspace",
                available: workspace_set_available,
                allowed: workspace_set_allowed,
                permission: workspace_set_perm,
                description: workspace_set_desc,
            },
            HostToolExposure {
                name: "workspace.clear",
                category: "workspace",
                available: workspace_clear_available,
                allowed: workspace_clear_allowed,
                permission: workspace_clear_perm,
                description: workspace_clear_desc,
            },
            HostToolExposure {
                name: "skills.list / read",
                category: "skills",
                available: has_skills,
                allowed: has_skills,
                permission: None,
                description: "Inspect and read instructions for configured skills",
            },
            HostToolExposure {
                name: "wakeup.schedule",
                category: "wakeup",
                available: is_chat || is_task,
                allowed: is_chat || is_task,
                permission: None,
                description: "Schedule a future wakeup message",
            },
            HostToolExposure {
                name: "artifacts.get",
                category: "artifacts",
                available: true,
                allowed: true,
                permission: None,
                description: "Inspect saved artifact metadata",
            },
            HostToolExposure {
                name: "library.create / add_file",
                category: "artifacts",
                available: true,
                allowed: !grants.restricted || grants.has("artifacts.write"),
                permission: Some("artifacts.write"),
                description: "Save deliverables to the Hivemind Artifact Library",
            },
            HostToolExposure {
                name: "library.publish",
                category: "artifacts",
                available: true,
                allowed: !grants.restricted || grants.has("artifacts.publish"),
                permission: Some("artifacts.publish"),
                description: "Publish an artifact to obtain a user-accessible URL",
            },
            HostToolExposure {
                name: "tasks.* / messages.*",
                category: "coordination",
                available: is_task,
                allowed: is_task,
                permission: Some("coordinate / delegate"),
                description: "Autonomous task graph, peer messaging, and review tools",
            },
        ];

        agents.push(AgentExposure {
            persona_id: p.agent.name.clone(),
            runtime: agent_cfg.runtime.clone(),
            model: agent_cfg.model.clone(),
            reasoning: agent_cfg.reasoning.clone(),
            fast: agent_cfg.fast,
            role: p.role.clone().or_else(|| agent_cfg.role.clone()),
            workspace: AgentWorkspaceExposure {
                effective,
                is_shared,
                source,
            },
            authorization: AgentAuthorizationExposure {
                restricted: grants.restricted,
                roles: grants.roles,
                permissions: grants.permissions,
                capabilities: agent_cfg.capabilities,
                sandbox: AgentSandboxExposure {
                    file_editing,
                    shell_execution,
                    web_access,
                },
            },
            tools: AgentToolsExposure {
                runtime: runtime_tools,
                host: host_tools,
            },
        });
    }

    Json(RoomExposureResponse {
        room_id,
        room_kind: kind.to_string(),
        room_name,
        agents,
        skills,
    })
    .into_response()
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
