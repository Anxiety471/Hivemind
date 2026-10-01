//! Persist before acknowledging. A single server worker claims jobs atomically;
//! crashes interrupt running jobs and never implicitly replay side effects.
use super::{
    error::ApiError,
    routes::{ApiState, TurnTargetBody},
};
use crate::core::HivemindCore;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::json;
use std::{sync::Arc, time::Duration};

pub(super) fn routes() -> Router<ApiState> {
    Router::new()
        .route("/api/v1/turns/{id}", get(show))
        .route("/api/v1/turns/{id}/cancel", post(cancel))
        .route("/api/v1/turns/{id}/retry", post(retry))
        .route("/api/v1/usage", get(usage))
        .route("/api/v1/tasks/{id}/checks", get(checks))
        .route("/api/v1/tasks/{id}/recovery", post(recovery))
}
async fn show(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    match state.core.execution().get(&id) {
        Ok(Some(job)) => Json(job).into_response(),
        Ok(None) => {
            ApiError::new(StatusCode::NOT_FOUND, "not_found", "turn not found").into_response()
        }
        Err(_) => internal(),
    }
}
async fn cancel(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    match state.core.execution().cancel(&id) {
        Ok(true) => Json(json!({"turn_id":id,"status":"cancelled"})).into_response(),
        Ok(false) => ApiError::new(
            StatusCode::CONFLICT,
            "not_cancellable",
            "turn missing or already ended",
        )
        .into_response(),
        Err(_) => internal(),
    }
}
async fn retry(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    let Ok(Some(job)) = state.core.execution().get(&id) else {
        return ApiError::new(StatusCode::NOT_FOUND, "not_found", "turn not found").into_response();
    };
    if !matches!(job.status.as_str(), "failed" | "interrupted") {
        return ApiError::new(
            StatusCode::CONFLICT,
            "not_retryable",
            "only interrupted or failed turns may be retried",
        )
        .into_response();
    }
    match state
        .core
        .execution()
        .submit(&job.room_id, &job.target, &job.message, None)
    {
        Ok(job) => (StatusCode::ACCEPTED, Json(job)).into_response(),
        Err(_) => internal(),
    }
}
async fn usage(
    State(state): State<ApiState>,
    axum::extract::RawQuery(raw): axum::extract::RawQuery,
) -> Response {
    let params = super::tasks::query(raw);
    match state
        .core
        .execution()
        .usage(params.get("scope").map(String::as_str))
    {
        Ok(value) => Json(value).into_response(),
        Err(_) => internal(),
    }
}
async fn checks(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    match state.core.execution().checks(&id) {
        Ok(value) => Json(json!({"checks":value})).into_response(),
        Err(_) => internal(),
    }
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoveryRequest {
    artifact_id: String,
    action: String,
}
async fn recovery(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<RecoveryRequest>,
) -> Response {
    let service = state.core.coordination();
    let result = service
        .store()
        .read(|db| Ok((db.task_or_err(&id)?, db.artifact(&body.artifact_id)?)));
    let Ok((task, Some(artifact))) = result else {
        return ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "task or artifact not found",
        )
        .into_response();
    };
    if artifact.task_id != task.id || artifact.kind != "recovery" {
        return ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_recovery",
            "artifact is not a recovery for this task",
        )
        .into_response();
    }
    let Some(sha) = artifact.content_hash.as_deref() else {
        return internal();
    };
    if service
        .store()
        .read(|db| db.running_attempts(Some(&task.id)))
        .map(|v| !v.is_empty())
        .unwrap_or(true)
    {
        return ApiError::new(
            StatusCode::CONFLICT,
            "attempt_running",
            "stop the attempt before recovering",
        )
        .into_response();
    }
    match body.action.as_str() {
        "resume" => {
            if !matches!(
                task.status,
                crate::coordination::model::TaskStatus::Blocked
                    | crate::coordination::model::TaskStatus::NeedsInput
            ) {
                return ApiError::new(
                    StatusCode::CONFLICT,
                    "not_resumable",
                    "resume requires a blocked task; restore terminal failures to a checkout",
                )
                .into_response();
            }
            if service
                .record_artifact(
                    &id,
                    None,
                    "recovery_selected",
                    &artifact.id,
                    Some(sha),
                    "Operator selected recovery for the next attempt",
                )
                .is_err()
            {
                return internal();
            }
            match service.resume(&task.root_id, true, 0, 0, "user") {
                Ok(detail) => Json(json!({"task":detail,"recovery":artifact.id})).into_response(),
                Err(_) => ApiError::new(
                    StatusCode::CONFLICT,
                    "resume_failed",
                    "root task cannot be resumed",
                )
                .into_response(),
            }
        }
        "restore" => {
            let destination = state.core.data_dir().join("recovered").join(&artifact.id);
            // The directory name comes from a host-generated artifact ID, never a request path.
            if std::fs::create_dir_all(destination.parent().unwrap()).is_err() {
                return internal();
            }
            match crate::coordination::workspace::checkout_detached(&task.workspace,&destination,sha) {
                Ok(tree) => Json(json!({"artifact_id":artifact.id,"commit_sha":sha,"workspace":tree.cwd})).into_response(),
                Err(_) => ApiError::new(StatusCode::CONFLICT,"restore_failed","recovery checkout could not be created; an existing checkout is never overwritten").into_response(),
            }
        }
        "discard" => {
            match service.record_artifact(
                &id,
                None,
                "recovery_discarded",
                &artifact.id,
                Some(sha),
                "Operator discarded recovery; retained commit for audit",
            ) {
                Ok(_) => Json(json!({"artifact_id":artifact.id,"discarded":true})).into_response(),
                Err(_) => internal(),
            }
        }
        _ => ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_action",
            "action must be resume, restore, or discard",
        )
        .into_response(),
    }
}

fn internal() -> Response {
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal_error",
        "execution store unavailable",
    )
    .into_response()
}

pub(super) async fn run(core: Arc<HivemindCore>) {
    if let Err(error) = core.execution().recover_jobs() {
        eprintln!("execution recovery failed: {error}");
        return;
    }
    while !core.is_shutting_down() {
        let job = match core.execution().claim() {
            Ok(Some(job)) => job,
            Ok(None) => {
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
            Err(error) => {
                eprintln!("execution claim failed: {error}");
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
        };
        let target = serde_json::from_value::<TurnTargetBody>(job.target.clone())
            .map(TurnTargetBody::target);
        let Ok(target) = target else {
            let _ =
                core.execution()
                    .finish(&job.turn_id, "failed", json!({"error":"invalid target"}));
            continue;
        };
        {
            let outcome = core.send_job_turn(&target, &job.message, &job.turn_id);
            tokio::pin!(outcome);
            loop {
                tokio::select! {
                    result = &mut outcome => {
                        let (status,body) = match result {
                            Ok(turn) => {
                                let failed = turn.replies.iter().any(|r| r.result.is_err());
                                let replies: Vec<_> = turn.replies.into_iter().map(|r|json!({"persona_id":r.name,"ok":r.result.is_ok(),"content":r.result.unwrap_or_else(|_|"agent reply failed".into())})).collect();
                                (if failed {"failed"} else {"completed"},json!({"turn_id":turn.turn_id,"room_id":turn.room_id,"replies":replies}))
                            }
                            Err(_) => ("failed",json!({"error":"turn could not be completed"})),
                        };
                        let status = if core.is_shutting_down() { "interrupted" } else { status };
                        if let Err(error) = core.execution().finish(&job.turn_id,status,body) { eprintln!("execution finish failed: {error}"); }
                        break;
                    }
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {
                        if core.is_shutting_down() || core.execution().get(&job.turn_id).ok().flatten().is_some_and(|j|j.status == "cancelled") {
                            // Drop the prompt future before rotating; its session may still be busy.
                            break;
                        }
                    }
                }
            }
        }
        if let Ok(resolved) = core.resolve_target(&target) {
            if core.is_shutting_down()
                || core
                    .execution()
                    .get(&job.turn_id)
                    .ok()
                    .flatten()
                    .is_some_and(|j| j.status == "cancelled")
            {
                for member in resolved.participants {
                    core.rotate_instance(
                        &crate::identity::AgentInstanceId::new(&job.room_id, &member.agent.name),
                        "job_cancelled",
                    )
                    .await;
                }
            }
        }
    }
    let _ = core.execution().recover_jobs();
}
