//! Saved web UI rice for this hive: `GET`/`PUT`/`DELETE /api/v1/ui/rice`.
use axum::{
    extract::{rejection::JsonRejection, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};

use super::{error::ApiError, routes::ApiState};
use crate::ui_rice::UiRiceFile;

pub(super) fn routes() -> Router<ApiState> {
    Router::new().route("/api/v1/ui/rice", get(show).put(update).delete(clear))
}

async fn show(State(state): State<ApiState>) -> Response {
    match state.core.ui_rice().load() {
        Ok(saved) => Json(json!({ "saved": saved })).into_response(),
        Err(_) => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "saved rice could not be read",
        )
        .into_response(),
    }
}

async fn update(
    State(state): State<ApiState>,
    payload: Result<Json<Value>, JsonRejection>,
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
    let doc = match UiRiceFile::parse(&body) {
        Ok(doc) => doc,
        Err(message) => {
            return ApiError::owned(StatusCode::BAD_REQUEST, "invalid_request", message)
                .into_response()
        }
    };
    if state.core.ui_rice().save(&doc).is_err() {
        return ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "saved rice could not be written",
        )
        .into_response();
    }
    publish(&state);
    Json(json!({ "saved": doc })).into_response()
}

async fn clear(State(state): State<ApiState>) -> Response {
    if state.core.ui_rice().clear().is_err() {
        return ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "saved rice could not be removed",
        )
        .into_response();
    }
    publish(&state);
    StatusCode::NO_CONTENT.into_response()
}

fn publish(state: &ApiState) {
    state
        .core
        .events()
        .publish(crate::events::DomainEventKind::ConfigChanged { scope: "ui".into() });
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

    fn app() -> axum::Router {
        let directory = std::env::temp_dir().join(format!(
            "hivemind-ui-rice-api-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let core = Arc::new(
            HivemindCore::new(
                HivemindConfig::default_poc(),
                directory.join("hivemind.toml"),
            )
            .unwrap(),
        );
        router(core, watch::channel(false).1)
    }

    async fn call(app: axum::Router, method: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri("/api/v1/ui/rice");
        let request = if let Some(body) = body {
            builder = builder.header(CONTENT_TYPE, "application/json");
            builder.body(Body::from(body.to_string())).unwrap()
        } else {
            builder.body(Body::empty()).unwrap()
        };
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, value)
    }

    #[tokio::test]
    async fn rice_is_empty_until_saved_and_delete_clears_it() {
        let app = app();
        let (status, body) = call(app.clone(), "GET", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "saved": null }));

        let (status, body) = call(
            app.clone(),
            "PUT",
            Some(json!({"selected_id": "matrix", "custom": []})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["saved"]["selected_id"], "matrix");

        let (status, body) = call(app.clone(), "GET", None).await;
        assert_eq!(body["saved"]["selected_id"], "matrix");
        assert_eq!(status, StatusCode::OK);

        let (status, _) = call(app.clone(), "PUT", Some(json!({"selected_id": "nope"}))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let (status, _) = call(app.clone(), "DELETE", None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (_, body) = call(app, "GET", None).await;
        assert_eq!(body, json!({ "saved": null }));
    }
}
