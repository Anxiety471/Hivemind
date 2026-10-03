//! Operator settings from `hivemind.toml`: `GET`/`PUT /api/v1/config`.
use axum::{
    extract::{rejection::JsonRejection, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};

use super::{error::ApiError, routes::ApiState};
use crate::operator::{OperatorBody, OperatorView};

pub(super) fn routes() -> Router<ApiState> {
    Router::new().route("/api/v1/config", get(show).put(update))
}

async fn show(State(state): State<ApiState>) -> Response {
    Json(OperatorView::from_config(
        &state.core.config(),
        state.core.coordination_booted(),
    ))
    .into_response()
}

async fn update(
    State(state): State<ApiState>,
    payload: Result<Json<OperatorBody>, JsonRejection>,
) -> Response {
    let Json(body) = match payload {
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
    match state.core.apply_operator(body) {
        Ok(view) => Json(view).into_response(),
        Err(error) => {
            let message = error.to_string();
            if error.chain().any(|cause| cause.is::<std::io::Error>()) {
                eprintln!("operator config update failed: {error:#}");
                return ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "configuration could not be saved",
                )
                .into_response();
            }
            ApiError::owned(StatusCode::BAD_REQUEST, "invalid_request", message).into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::{api::routes::router, config::HivemindConfig, core::HivemindCore};
    use axum::{
        body::Body,
        http::{header::CONTENT_TYPE, Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use std::sync::Arc;
    use tokio::sync::watch;
    use tower::ServiceExt;

    fn app() -> (axum::Router, std::path::PathBuf) {
        let directory = std::env::temp_dir().join(format!(
            "hivemind-operator-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("hivemind.toml");
        HivemindConfig::write_default(&path, false).unwrap();
        let config = HivemindConfig::load(&path).unwrap();
        let core = Arc::new(HivemindCore::new(config, &path).unwrap());
        (router(core, watch::channel(false).1), path)
    }

    async fn call(app: axum::Router, method: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri("/api/v1/config");
        let request = if let Some(body) = body {
            builder = builder.header(CONTENT_TYPE, "application/json");
            builder.body(Body::from(body.to_string())).unwrap()
        } else {
            builder.body(Body::empty()).unwrap()
        };
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value = serde_json::from_slice(&bytes).unwrap();
        (status, value)
    }

    #[tokio::test]
    async fn budgets_and_project_folders_round_trip_without_erasing_comments() {
        let (app, path) = app();
        let (status, body) = call(app.clone(), "GET", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["context"]["context_target_tokens"], 12000);
        assert_eq!(body["execution"]["task_token_limit"], 0);
        assert_eq!(body["restart"], json!([]));

        let mut next = body.clone();
        next["context"]["context_target_tokens"] = json!(16000);
        next["context"]["runtime_rotate_tokens"] = json!(200000);
        next["execution"]["task_token_limit"] = json!(50000);
        next["execution"]["project_token_limit"] = json!(250000);
        next.as_object_mut().unwrap().remove("restart");
        let folder = path.parent().unwrap().join("project");
        std::fs::create_dir(&folder).unwrap();
        next["workspace_roots"] = json!([folder.display().to_string()]);
        next["skills"] = json!(["~/agents/skills"]);

        let (status, saved) = call(app.clone(), "PUT", Some(next)).await;
        assert_eq!(status, StatusCode::OK, "{saved}");
        assert_eq!(saved["context"]["context_target_tokens"], 16000);
        assert_eq!(saved["execution"]["project_token_limit"], 250000);
        assert_eq!(saved["workspace_roots"][0], folder.display().to_string());
        assert_eq!(saved["skills"][0], "~/agents/skills");

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("Provider credentials"), "{raw}");
        assert!(raw.contains("context_target_tokens = 16000"), "{raw}");
        assert!(raw.contains("task_token_limit = 50000"), "{raw}");

        let (status, _) = call(
            app,
            "PUT",
            Some(json!({
                "context": {"context_target_tokens": 10},
                "execution": {},
                "coordination": {},
                "runtime": {
                    "omp_binary": "omp",
                    "pi_binary": "pi",
                    "opencode_binary": "opencode",
                    "prompt_timeout_secs": 300,
                    "idle_timeout_secs": 120,
                    "prompt_retries": 1
                },
                "skills": [],
                "workspace_roots": []
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("context_target_tokens = 16000"), "{raw}");
    }
}
