//! Issue backlog: list and dismiss proposals, read or change the council
//! cadence, and start one discussion now. Starting a round does not implement
//! anything it files.
use axum::{
    extract::{rejection::JsonRejection, Path, RawQuery, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;

use super::{error::ApiError, routes::ApiState, tasks::query};
use crate::{
    config::{IssuesConfig, IssuesMode},
    issues::{resolve_members, run_discussion, IssueError, IssueKind, IssueStatus, Trigger},
};

pub(super) fn routes() -> Router<ApiState> {
    Router::new()
        .route("/api/v1/issues", get(list))
        .route(
            "/api/v1/issues/settings",
            get(settings).patch(update_settings),
        )
        .route("/api/v1/issues/rounds", get(rounds).post(start))
        .route("/api/v1/issues/{id}", get(show))
        .route("/api/v1/issues/{id}/dismiss", post(dismiss))
}

fn issue_error(error: IssueError) -> Response {
    let (status, code) = match &error {
        IssueError::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
        IssueError::Invalid(_) => (StatusCode::BAD_REQUEST, "invalid_request"),
        IssueError::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
        IssueError::Disabled => (StatusCode::CONFLICT, "issues_disabled"),
        IssueError::Internal(detail) => {
            eprintln!("issues internal error: {detail}");
            return ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "request could not be completed",
            )
            .into_response();
        }
    };
    ApiError::owned(status, code, error.to_string()).into_response()
}

fn settings_body(state: &ApiState) -> Result<serde_json::Value, IssueError> {
    let config = state.core.config();
    let issues = state.core.issues().config();
    let running = state.core.issues().running()?.is_some();
    let now = state.core.issues().now();
    let (anchor, next_eligible_at) = if issues.enabled {
        let anchor = state.core.issues().anchor(now)?;
        let next = (!running).then_some(anchor.saturating_add(issues.interval_secs as i64));
        (Some(anchor), next)
    } else {
        (None, None)
    };
    Ok(json!({
        "enabled": issues.enabled,
        "mode": issues.mode.as_str(),
        "interval_secs": issues.interval_secs,
        "idle_secs": issues.idle_secs,
        "max_issues_per_round": issues.max_issues_per_round,
        "members": issues.members,
        "group": issues.group,
        "workspace": issues.workspace,
        "prompt": issues.prompt,
        "default_prompt": crate::issues::DEFAULT_GOAL,
        "personas": config.agents.iter().map(|agent| &agent.name).collect::<Vec<_>>(),
        "groups": config.groups.iter().map(|group| &group.name).collect::<Vec<_>>(),
        "running": running,
        "anchor": anchor,
        "next_eligible_at": next_eligible_at,
    }))
}

async fn list(State(state): State<ApiState>, RawQuery(raw): RawQuery) -> Response {
    let params = query(raw);
    let status = match params.get("status").map(String::as_str) {
        None => Some(IssueStatus::Open),
        Some("all") => None,
        Some(value) => match IssueStatus::parse(value) {
            Some(status) => Some(status),
            None => {
                return ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "status must be open, dismissed, or all",
                )
                .into_response()
            }
        },
    };
    let kind = match params.get("kind").map(String::as_str) {
        None => None,
        Some(value) => match IssueKind::parse(value) {
            Some(kind) => Some(kind),
            None => {
                return ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "kind must be feature, improvement, or bug",
                )
                .into_response()
            }
        },
    };
    match state.core.issues().list(status, kind) {
        Ok(issues) => Json(json!({"issues": issues})).into_response(),
        Err(error) => issue_error(error),
    }
}

async fn show(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    match state.core.issues().get(&id) {
        Ok(issue) => Json(json!({"issue": issue})).into_response(),
        Err(error) => issue_error(error),
    }
}

#[derive(Deserialize, Default)]
struct DismissBody {
    #[serde(default)]
    reason: Option<String>,
}

async fn dismiss(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    body: Result<Json<DismissBody>, JsonRejection>,
) -> Response {
    let reason = match body {
        Ok(Json(body)) => body.reason,
        Err(_) => {
            return ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_json",
                "invalid request body",
            )
            .into_response()
        }
    };
    match state.core.issues().dismiss(&id, reason) {
        Ok(issue) => Json(json!({"issue": issue})).into_response(),
        Err(error) => issue_error(error),
    }
}

async fn rounds(State(state): State<ApiState>) -> Response {
    match state.core.issues().rounds(50) {
        Ok(rounds) => Json(json!({"rounds": rounds})).into_response(),
        Err(error) => issue_error(error),
    }
}

async fn settings(State(state): State<ApiState>) -> Response {
    match settings_body(&state) {
        Ok(body) => Json(body).into_response(),
        Err(error) => issue_error(error),
    }
}

#[derive(Deserialize)]
struct SettingsBody {
    enabled: bool,
    mode: String,
    interval_secs: u64,
    idle_secs: u64,
    max_issues_per_round: u32,
    #[serde(default)]
    members: Vec<String>,
    #[serde(default)]
    group: Option<String>,
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    prompt: Option<String>,
}

fn blank(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_owned();
        (!value.is_empty()).then_some(value)
    })
}

async fn update_settings(
    State(state): State<ApiState>,
    body: Result<Json<SettingsBody>, JsonRejection>,
) -> Response {
    let Json(body) = match body {
        Ok(body) => body,
        Err(_) => {
            return ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_json",
                "invalid request body",
            )
            .into_response()
        }
    };
    let Some(mode) = IssuesMode::parse(&body.mode) else {
        return ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "mode must be automatic or scheduled",
        )
        .into_response();
    };
    let next = IssuesConfig {
        enabled: body.enabled,
        mode,
        members: body.members,
        group: blank(body.group),
        interval_secs: body.interval_secs,
        idle_secs: body.idle_secs,
        max_issues_per_round: body.max_issues_per_round,
        workspace: blank(body.workspace),
        prompt: blank(body.prompt),
    };
    if let Err(error) = state.core.update_issue_settings(next) {
        return ApiError::owned(StatusCode::BAD_REQUEST, "invalid_request", error.to_string())
            .into_response();
    }
    settings(State(state)).await
}

async fn start(State(state): State<ApiState>) -> Response {
    let members = match resolve_members(&state.core.config()) {
        Ok(members) => members,
        Err(error) => return issue_error(error),
    };
    let round = match state.core.issues().begin_round(Trigger::Manual, &members) {
        Ok(round) => round,
        Err(error) => return issue_error(error),
    };
    let core = state.core.clone();
    let id = round.id.clone();
    tokio::spawn(async move {
        if let Err(error) = run_discussion(&core, &id, None).await {
            eprintln!("issues: council {id} failed: {error:#}");
        }
    });
    (StatusCode::ACCEPTED, Json(json!({"round": round}))).into_response()
}
