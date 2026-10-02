//! Create, replace, and delete agents (personas) at runtime.
//!
//! Every change is validated as a whole configuration, written to the config file, and
//! only then published to the running server (see `HivemindCore::create_agent`).
use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{error::ApiError, routes::ApiState};
use crate::config::AgentConfig;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AgentBody {
    id: Option<String>,
    runtime: Option<String>,
    #[serde(default)]
    system_prompt: String,
    workspace: Option<String>,
    model: Option<String>,
    #[serde(default)]
    fallback_models: Vec<String>,
    reasoning: Option<String>,
    fast: Option<bool>,
    role: Option<String>,
    #[serde(default)]
    capabilities: Vec<String>,
    #[serde(default)]
    permissions: Vec<String>,
    #[serde(default)]
    roles: Vec<String>,
}

/// The editable definition of an agent as the UI shows and re-submits it.
pub(super) fn config_view(agent: &AgentConfig) -> Value {
    json!({
        "runtime": agent.runtime,
        "system_prompt": agent.system_prompt,
        "workspace": agent.workspace,
        "model": agent.model,
        "fallback_models": agent.fallback_models,
        "reasoning": agent.reasoning,
        "fast": agent.fast,
        "role": agent.role,
        "capabilities": agent.capabilities,
        "permissions": agent.permissions,
        "roles": agent.roles,
    })
}

fn blank_to_none(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

fn failure(error: anyhow::Error) -> Response {
    let message = error.to_string();
    let internal = error.chain().any(|cause| {
        cause.is::<std::io::Error>()
            || cause.is::<toml::ser::Error>()
            || cause.is::<toml_edit::TomlError>()
    });
    if internal {
        eprintln!("agent change failed: {error:#}");
        return ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "request could not be completed",
        )
        .into_response();
    }
    let status = if message.starts_with("unknown agent") {
        StatusCode::NOT_FOUND
    } else if message.contains("already exists")
        || message.contains("still a member")
        || message.contains("coordination planner")
        || message.contains("last agent")
    {
        StatusCode::CONFLICT
    } else {
        StatusCode::BAD_REQUEST
    };
    ApiError::owned(status, "invalid_request", message).into_response()
}

fn bad_json() -> Response {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "invalid_json",
        "invalid request body",
    )
    .into_response()
}

#[allow(clippy::result_large_err)]
fn build(state: &ApiState, id: String, body: AgentBody) -> Result<AgentConfig, Response> {
    let workspace = match blank_to_none(body.workspace) {
        Some(path) => state
            .core
            .validate_workspace(&path)
            .map_err(|error| failure(anyhow::anyhow!("workspace: {error}")))?,
        None => crate::config::absolute_workspace("."),
    };
    Ok(AgentConfig {
        name: id,
        runtime: blank_to_none(body.runtime).unwrap_or_else(|| "omp".into()),
        system_prompt: body.system_prompt,
        workspace,
        model: blank_to_none(body.model),
        fallback_models: body.fallback_models,
        reasoning: blank_to_none(body.reasoning),
        fast: body.fast,
        role: blank_to_none(body.role),
        capabilities: body.capabilities,
        permissions: body.permissions,
        roles: body.roles,
        tool_access: None,
    })
}

pub(super) async fn create(
    State(state): State<ApiState>,
    payload: Result<Json<AgentBody>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload else {
        return bad_json();
    };
    let Some(id) = body.id.clone().map(|id| id.trim().to_owned()) else {
        return ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "agent id is required",
        )
        .into_response();
    };
    let agent = match build(&state, id.clone(), body) {
        Ok(agent) => agent,
        Err(response) => return response,
    };
    match state.core.create_agent(agent) {
        Ok(()) => match state.core.agents().get(&id) {
            Some(agent) => (
                StatusCode::CREATED,
                Json(json!({"id": id, "config": config_view(&agent)})),
            )
                .into_response(),
            None => failure(anyhow::anyhow!("unknown agent '{id}'")),
        },
        Err(error) => failure(error),
    }
}

pub(super) async fn update(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    payload: Result<Json<AgentBody>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = payload else {
        return bad_json();
    };
    if body.id.as_deref().is_some_and(|body_id| body_id != id) {
        return ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "an agent's id cannot be changed",
        )
        .into_response();
    }
    if state.core.agents().get(&id).is_none() {
        return failure(anyhow::anyhow!("unknown agent '{id}'"));
    }
    let agent = match build(&state, id.clone(), body) {
        Ok(agent) => agent,
        Err(response) => return response,
    };
    if let Err(error) = state.core.update_agent(agent) {
        return failure(error);
    }
    // Sessions hold the old prompt, model and runtime; drop them without holding up this reply.
    let core = state.core.clone();
    let persona = id.clone();
    tokio::spawn(async move { core.rotate_persona(&persona, "agent_updated").await });
    match state.core.agents().get(&id) {
        Some(agent) => Json(json!({"id": id, "config": config_view(&agent)})).into_response(),
        None => failure(anyhow::anyhow!("unknown agent '{id}'")),
    }
}

pub(super) async fn remove(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    if let Err(error) = state.core.delete_agent(&id) {
        return failure(error);
    }
    let core = state.core.clone();
    tokio::spawn(async move { core.rotate_persona(&id, "agent_deleted").await });
    StatusCode::NO_CONTENT.into_response()
}
