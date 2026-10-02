//! Skills and tool catalogue, so a client can show what an agent can be asked to use.
use std::collections::BTreeMap;

use axum::{
    extract::{Path, RawQuery, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::json;

use super::{error::ApiError, routes::ApiState, tasks::query};
use crate::conversation::linter::KNOWN_TOOLS;

pub(super) fn routes() -> Router<ApiState> {
    Router::new()
        .route("/api/v1/skills", get(list))
        .route("/api/v1/skills/{name}", get(show))
        .route("/api/v1/tools", get(tools))
}

async fn list(State(state): State<ApiState>) -> Response {
    let catalog = state.core.skills();
    Json(json!({"dirs": catalog.dirs(), "skills": catalog.list()})).into_response()
}

async fn show(
    State(state): State<ApiState>,
    Path(name): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let params = query(raw);
    match state
        .core
        .skills()
        .read(&name, params.get("path").map(String::as_str))
    {
        Ok(document) => Json(json!({"skill": document})).into_response(),
        Err(_) => ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "skill or file was not found",
        )
        .into_response(),
    }
}

/// Tool names agents can call through the `hivemind-tool` fence, grouped by namespace.
/// Which of them one persona is offered still depends on its room, roles and task.
async fn tools() -> Response {
    let mut groups: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for tool in KNOWN_TOOLS {
        let namespace = tool.split('.').next().unwrap_or(tool);
        groups.entry(namespace).or_default().push(tool);
    }
    Json(json!({"tools": KNOWN_TOOLS, "namespaces": groups})).into_response()
}
