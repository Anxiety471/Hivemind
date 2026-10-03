//! A room's chat schedules: the wakeups an agent scheduled for itself, listed
//! and cancellable by the user.
//!
//! Only chat rooms have schedules, because only there does `wakeup.schedule`
//! store them; task-room wakeups ride the coordination queue and are bound to
//! a live attempt, so the same "not configurable" answer as room settings is
//! returned for any id that is not the main conversation, a direct message, or
//! a group chat.
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get},
    Json, Router,
};
use serde_json::json;

use super::{error::ApiError, routes::ApiState};
use crate::{execution::ChatScheduleRow, wakeup::chat_target};

pub(super) fn routes() -> Router<ApiState> {
    Router::new()
        .route("/api/v1/rooms/{id}/schedules", get(show))
        .route("/api/v1/rooms/{id}/schedules/{sid}", delete(cancel))
}

fn error(status: StatusCode, code: &'static str, message: String) -> Response {
    ApiError::owned(status, code, message).into_response()
}

fn internal() -> Response {
    error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal_error",
        "execution store unavailable".into(),
    )
}

/// Rejects an id that is not a chat room: task rooms keep their wakeups on the
/// coordination queue, and threads have no wakeup target at all.
fn no_schedules(id: &str) -> Response {
    error(
        StatusCode::NOT_FOUND,
        "not_found",
        format!("room '{id}' has no schedules; only the main conversation, direct messages and group chats do"),
    )
}

/// A schedule as the API shows it: the clean body the agent wrote, plus how
/// often and how much it has fired.
fn schedule_json(row: &ChatScheduleRow) -> serde_json::Value {
    json!({
        "id": row.id,
        "label": row.label,
        "message": row.message,
        "due_at": row.due_at,
        "repeat_seconds": row.repeat_seconds,
        "repeat_count": row.repeat_count,
        "fires": row.fires,
        "state": row.state,
        "created_at": row.created_at,
    })
}

/// `GET /api/v1/rooms/{id}/schedules`: every schedule of the room, newest
/// first and in any state, so the user can see what is pending and what ran.
async fn show(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    if chat_target(&id).is_none() {
        return no_schedules(&id);
    }
    match state.core.execution().chat_wakeups_for(&id) {
        Ok(rows) => Json(json!({
            "room_id": id,
            "schedules": rows.iter().map(schedule_json).collect::<Vec<_>>(),
        }))
        .into_response(),
        Err(_) => internal(),
    }
}

/// `DELETE /api/v1/rooms/{id}/schedules/{sid}`: stops one schedule belonging
/// to the room. Unknown or foreign ids are 404, a schedule that already ended
/// is 409, and a stopped one is returned in state `cancelled`.
async fn cancel(
    State(state): State<ApiState>,
    Path((id, sid)): Path<(String, String)>,
) -> Response {
    if chat_target(&id).is_none() {
        return no_schedules(&id);
    }
    let found = match state.core.execution().chat_wakeups_for(&id) {
        Ok(rows) => rows,
        Err(_) => return internal(),
    };
    let Some(row) = found.iter().find(|row| row.id == sid).cloned() else {
        return error(
            StatusCode::NOT_FOUND,
            "not_found",
            format!("schedule '{sid}' was not found in room '{id}'"),
        );
    };
    match state.core.execution().cancel_chat_wakeup(&sid) {
        Ok(true) => {
            let mut row = row;
            row.state = "cancelled".into();
            Json(json!({"schedule": schedule_json(&row)})).into_response()
        }
        // Only a queued or dispatched schedule is live; a completed or already
        // cancelled one has nothing left to stop.
        Ok(false) => error(
            StatusCode::CONFLICT,
            "not_cancellable",
            format!("schedule '{sid}' already ended in state '{}'", row.state),
        ),
        Err(_) => internal(),
    }
}
