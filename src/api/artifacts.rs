use super::{error::ApiError, routes::ApiState};
use crate::artifacts::{LibraryArtifact, NewArtifact, MAX_ARTIFACT_BYTES};
use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit, Path, Query, State},
    http::{header, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::json;

pub(super) fn routes() -> Router<ApiState> {
    Router::new()
        .route("/api/v1/library", get(list).post(create))
        .route("/api/v1/library/{id}", get(show).delete(remove))
        .route("/api/v1/library/{id}/content", get(content))
        .route(
            "/api/v1/library/{id}/publish",
            post(publish).delete(unpublish),
        )
        .layer(DefaultBodyLimit::max(12 * 1024 * 1024))
        .route("/artifacts/{token}", get(shared))
}

/// Public capability URLs authorize only the GET/HEAD of one published object.
pub(super) fn is_shared_read(method: &Method, path: &str) -> bool {
    matches!(*method, Method::GET | Method::HEAD)
        && path
            .strip_prefix("/artifacts/")
            .is_some_and(crate::artifacts::is_share_token)
}

fn missing() -> Response {
    ApiError::new(StatusCode::NOT_FOUND, "not_found", "artifact not found").into_response()
}
fn failure(error: anyhow::Error) -> Response {
    if error
        .chain()
        .any(|cause| cause.is::<rusqlite::Error>() || cause.is::<std::io::Error>())
    {
        eprintln!("artifact request failed: {error:#}");
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "artifact request could not be completed",
        )
        .into_response()
    } else {
        ApiError::owned(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            error.to_string(),
        )
        .into_response()
    }
}

#[derive(Deserialize)]
pub(super) struct Search {
    #[serde(default)]
    query: String,
    #[serde(default = "default_limit")]
    limit: usize,
    #[serde(default)]
    offset: usize,
}
fn default_limit() -> usize {
    50
}
async fn list(State(state): State<ApiState>, Query(search): Query<Search>) -> Response {
    match state
        .core
        .artifacts()
        .list(&search.query, search.limit, search.offset)
    {
        Ok(artifacts) => Json(json!({"artifacts": artifacts})).into_response(),
        Err(e) => failure(e),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Create {
    title: String,
    filename: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    room_id: String,
    content: Option<String>,
    content_base64: Option<String>,
}
async fn create(
    State(state): State<ApiState>,
    body: Result<Json<Create>, JsonRejection>,
) -> Response {
    let Json(body) = match body {
        Ok(body) => body,
        Err(error) if error.status() == StatusCode::PAYLOAD_TOO_LARGE => {
            return ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "too_large",
                "artifact request exceeds the upload limit",
            )
            .into_response();
        }
        Err(_) => {
            return ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_json",
                "invalid artifact request body",
            )
            .into_response()
        }
    };
    if body.room_id.len() > 200 || body.room_id.chars().any(char::is_control) {
        return failure(anyhow::anyhow!("invalid room ID"));
    }
    let content = match (body.content, body.content_base64) {
        (Some(text), None) => text.into_bytes(),
        (None, Some(encoded)) => match STANDARD.decode(encoded) {
            Ok(bytes) => bytes,
            Err(_) => return failure(anyhow::anyhow!("invalid base64 content")),
        },
        _ => {
            return failure(anyhow::anyhow!(
                "provide exactly one of content or content_base64"
            ))
        }
    };
    if content.len() > MAX_ARTIFACT_BYTES {
        return ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "too_large",
            "artifact exceeds the 8 MiB limit",
        )
        .into_response();
    }
    match state.core.artifacts().create(NewArtifact {
        title: &body.title,
        filename: &body.filename,
        description: &body.description,
        media_type: crate::artifacts::media_type(&body.filename),
        content: &content,
        room: &body.room_id,
        persona: "operator",
    }) {
        Ok(artifact) => (StatusCode::CREATED, Json(json!({"artifact": artifact}))).into_response(),
        Err(e) => failure(e),
    }
}
async fn show(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    match state.core.artifacts().get(&id) {
        Ok(Some(artifact)) => Json(json!({"artifact": artifact})).into_response(),
        Ok(None) => missing(),
        Err(e) => failure(e),
    }
}
async fn content(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    match (
        state.core.artifacts().get(&id),
        state.core.artifacts().content(&id),
    ) {
        (Ok(Some(artifact)), Ok(Some(bytes))) => bytes_response(artifact, bytes),
        (Err(e), _) | (_, Err(e)) => failure(e),
        _ => missing(),
    }
}
async fn publish(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    match state.core.artifacts().publish(&id) {
        Ok(Some(artifact)) => Json(json!({"artifact": artifact})).into_response(),
        Ok(None) => missing(),
        Err(e) => failure(e),
    }
}
async fn unpublish(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    match state.core.artifacts().unpublish(&id) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => missing(),
        Err(e) => failure(e),
    }
}
async fn remove(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    match state.core.artifacts().delete(&id) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => missing(),
        Err(e) => failure(e),
    }
}
#[derive(Deserialize)]
pub(super) struct SharedParams {
    /// `?raw=1` returns the stored bytes instead of a rendered document.
    #[serde(default)]
    raw: Option<String>,
}
async fn shared(
    State(state): State<ApiState>,
    Path(token): Path<String>,
    Query(params): Query<SharedParams>,
) -> Response {
    match state.core.artifacts().shared_content(&token) {
        Ok(Some((artifact, bytes))) => shared_response(artifact, bytes, params.raw.is_some()),
        Ok(None) => missing(),
        Err(e) => failure(e),
    }
}
fn bytes_response(artifact: LibraryArtifact, bytes: Vec<u8>) -> Response {
    respond(artifact, bytes, None, ARTIFACT_CSP)
}

/// Published Markdown and images open as documents styled like the Library
/// preview; `?raw=1` and every other type stream the stored bytes.
fn shared_response(artifact: LibraryArtifact, bytes: Vec<u8>, raw: bool) -> Response {
    if raw {
        return respond(artifact, bytes, None, ARTIFACT_CSP);
    }
    match artifact.media_type.as_str() {
        "text/markdown" => match std::str::from_utf8(&bytes) {
            Ok(markdown) => {
                let page = super::document::markdown_document(&artifact.title, markdown);
                respond(
                    artifact,
                    page.into_bytes(),
                    Some("text/html; charset=utf-8"),
                    ARTIFACT_CSP,
                )
            }
            Err(_) => respond(artifact, bytes, None, ARTIFACT_CSP),
        },
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/svg+xml" => {
            let page = super::document::image_document(&artifact.title);
            respond(
                artifact,
                page.into_bytes(),
                Some("text/html; charset=utf-8"),
                IMAGE_PAGE_CSP,
            )
        }
        _ => respond(artifact, bytes, None, ARTIFACT_CSP),
    }
}

/// Applies to every response derived from artifact content: an opaque origin with
/// no scripts, forms or network access.
const ARTIFACT_CSP: &str = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/// The image page carries no artifact markup, so it is not sandboxed and can load
/// the same-origin raw image it wraps.
const IMAGE_PAGE_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

fn respond(
    artifact: LibraryArtifact,
    bytes: Vec<u8>,
    content_type: Option<&str>,
    csp: &'static str,
) -> Response {
    let mut response = bytes.into_response();
    let headers = response.headers_mut();
    let inline = matches!(
        artifact.media_type.as_str(),
        "text/plain"
            | "text/markdown"
            | "text/html"
            | "application/json"
            | "application/xml"
            | "text/xml"
            | "image/svg+xml"
            | "image/png"
            | "image/jpeg"
            | "image/gif"
            | "image/webp"
    );
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(content_type.unwrap_or(&artifact.media_type))
            .expect("validated media type"),
    );
    let filename: String = artifact
        .filename
        .bytes()
        .map(|b| format!("%{b:02X}"))
        .collect();
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!(
            "{}; filename*=UTF-8''{filename}",
            if inline { "inline" } else { "attachment" }
        ))
        .expect("encoded filename"),
    );
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    // Content derived from artifacts gets an opaque origin and cannot run scripts,
    // submit forms, navigate the parent, or read the operator's API.
    headers.insert("content-security-policy", HeaderValue::from_static(csp));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    response
}
