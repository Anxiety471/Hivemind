//! Choices the agent form offers: each runtime's models and reasoning levels, and a folder
//! browser for picking an agent workspace.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};

use axum::{
    extract::{Path as UrlPath, RawQuery, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::json;

use super::{error::ApiError, routes::ApiState, tasks::query};
use crate::runtime::catalog::{self, Catalog};

/// Listing models spawns the runtime (seconds for OpenCode); keep the answer for a while.
const TTL: Duration = Duration::from_secs(300);
const MAX_ENTRIES: usize = 2000;

pub(super) fn routes() -> Router<ApiState> {
    Router::new()
        .route("/api/v1/runtimes/{runtime}/models", get(models))
        .route("/api/v1/fs/dirs", get(dirs))
        .route("/api/v1/fs/pick", post(pick))
}

type Slot = Arc<tokio::sync::Mutex<Option<(Instant, Catalog)>>>;

fn slot(runtime: &str) -> Slot {
    static SLOTS: LazyLock<Mutex<HashMap<String, Slot>>> = LazyLock::new(Default::default);
    SLOTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .entry(runtime.to_owned())
        .or_default()
        .clone()
}

/// `?refresh=true` bypasses the cache (after the user signs in to another provider).
async fn models(
    State(state): State<ApiState>,
    UrlPath(runtime): UrlPath<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    if !catalog::is_runtime(&runtime) {
        return ApiError::new(StatusCode::NOT_FOUND, "not_found", "unknown runtime").into_response();
    }
    let refresh = query(raw).get("refresh").map(String::as_str) == Some("true");
    let slot = slot(&runtime);
    // One caller lists; concurrent callers for the same runtime wait for its result.
    let mut cached = slot.lock().await;
    if let Some((at, catalog)) = cached.as_ref() {
        if !refresh && at.elapsed() < TTL {
            return Json(catalog).into_response();
        }
    }
    let config = state.core.config();
    let harness = config.runtime.harness_dir.clone().unwrap_or_else(|| std::env::temp_dir().join("hivemind-harness"));
    match catalog::list(&config.runtime, &runtime, &harness).await {
        Ok(catalog) => {
            *cached = Some((Instant::now(), catalog.clone()));
            Json(catalog).into_response()
        }
        Err(error) => {
            ApiError::owned(StatusCode::BAD_GATEWAY, "runtime_unavailable", format!("{error:#}")).into_response()
        }
    }
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).filter(|p| p.is_absolute())
}

/// Subfolders of `path` for the workspace picker. When `[workspaces] roots` is set the
/// browser stays inside them, as workspace changes do.
async fn dirs(State(state): State<ApiState>, RawQuery(raw): RawQuery) -> Response {
    let params = query(raw);
    let hidden = params.get("hidden").map(String::as_str) == Some("true");
    let requested = params.get("path").map(|p| p.trim().to_owned()).filter(|p| !p.is_empty());
    let roots: Vec<PathBuf> = state
        .core
        .shared_workspaces()
        .roots()
        .iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .collect();
    let result = tokio::task::spawn_blocking(move || browse(requested, hidden, &roots)).await;
    match result {
        Ok(Ok(mut listing)) => {
            listing["native_picker"] = json!(native_picker_available(&state));
            Json(listing).into_response()
        }
        Ok(Err((status, code, message))) => ApiError::owned(status, code, message).into_response(),
        Err(_) => ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", "request could not be completed")
            .into_response(),
    }
}

/// A folder dialog the host desktop offers: program and arguments, starting at `start`.
fn native_dialog(start: &Path) -> Option<(&'static str, Vec<String>)> {
    let on_path = |name: &str| std::env::var_os("PATH").is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join(name).is_file()));
    let start = start.display().to_string();
    if cfg!(target_os = "macos") {
        let script = "POSIX path of (choose folder with prompt \"Choose the agent workspace\")".to_owned();
        return on_path("osascript").then(|| ("osascript", vec!["-e".to_owned(), script]));
    }
    let has_display = std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some();
    if !cfg!(target_os = "linux") || !has_display {
        return None;
    }
    let kde = std::env::var("XDG_CURRENT_DESKTOP").is_ok_and(|d| d.to_uppercase().contains("KDE"));
    let order = if kde { ["kdialog", "zenity"] } else { ["zenity", "kdialog"] };
    let program = order.into_iter().find(|name| on_path(name))?;
    Some(match program {
        "kdialog" => ("kdialog", vec!["--getexistingdirectory".to_owned(), start]),
        _ => (
            "zenity",
            vec!["--file-selection".to_owned(), "--directory".to_owned(), "--title=Choose the agent workspace".to_owned(), format!("--filename={start}/")],
        ),
    })
}

/// The dialog opens on the machine Hivemind runs on, so it is only offered to a server
/// that listens on loopback, where that machine is the user's own.
fn native_picker_available(state: &ApiState) -> bool {
    state.core.config().server.bind.is_loopback() && native_dialog(Path::new("/")).is_some()
}

/// Open the desktop's own folder dialog and return the chosen path (`null` when cancelled).
async fn pick(State(state): State<ApiState>, RawQuery(raw): RawQuery) -> Response {
    if !native_picker_available(&state) {
        return ApiError::new(StatusCode::NOT_IMPLEMENTED, "not_available", "this server cannot open a folder dialog").into_response();
    }
    let start = query(raw)
        .get("path")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_dir())
        .or_else(home)
        .unwrap_or_else(|| PathBuf::from("/"));
    let Some((program, args)) = native_dialog(&start) else {
        return ApiError::new(StatusCode::NOT_IMPLEMENTED, "not_available", "this server cannot open a folder dialog").into_response();
    };
    let run = tokio::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let output = match tokio::time::timeout(Duration::from_secs(900), run).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return ApiError::owned(StatusCode::BAD_GATEWAY, "dialog_failed", format!("could not open {program}: {error}")).into_response()
        }
        Err(_) => return ApiError::new(StatusCode::GATEWAY_TIMEOUT, "dialog_timeout", "the folder dialog was left open too long").into_response(),
    };
    // Every dialog exits 1 when the user cancels.
    if output.status.code() == Some(1) {
        return Json(json!({"path": null})).into_response();
    }
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return ApiError::owned(StatusCode::BAD_GATEWAY, "dialog_failed", format!("{program} failed: {}", detail.trim())).into_response();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let chosen = text.trim().trim_end_matches('/');
    let chosen = if chosen.is_empty() { "/" } else { chosen };
    match state.core.validate_workspace(chosen) {
        Ok(path) => Json(json!({"path": path})).into_response(),
        Err(error) => ApiError::owned(StatusCode::BAD_REQUEST, "invalid_request", error.to_string()).into_response(),
    }
}

type Failure = (StatusCode, &'static str, String);

fn browse(requested: Option<String>, hidden: bool, roots: &[PathBuf]) -> Result<serde_json::Value, Failure> {
    let start = match requested {
        Some(path) => PathBuf::from(path),
        None => roots.first().cloned().or_else(home).unwrap_or_else(|| PathBuf::from("/")),
    };
    if !start.is_absolute() {
        return Err((StatusCode::BAD_REQUEST, "invalid_request", "the folder path must be absolute".into()));
    }
    let real = std::fs::canonicalize(&start).map_err(|_| {
        (StatusCode::NOT_FOUND, "not_found", format!("'{}' does not exist or is not a folder", start.display()))
    })?;
    let inside = |path: &Path| roots.is_empty() || roots.iter().any(|root| path.starts_with(root));
    if !inside(&real) {
        return Err((StatusCode::FORBIDDEN, "forbidden", "that folder is outside the allowed workspace roots".into()));
    }
    let read = std::fs::read_dir(&real)
        .map_err(|_| (StatusCode::FORBIDDEN, "forbidden", format!("'{}' cannot be read", real.display())))?;
    let mut entries: Vec<(String, String)> = read
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if (!hidden && name.starts_with('.')) || !entry.path().is_dir() {
                return None;
            }
            Some((name, entry.path().to_string_lossy().into_owned()))
        })
        .collect();
    entries.sort_by_cached_key(|(name, _)| name.to_lowercase());
    let truncated = entries.len() > MAX_ENTRIES;
    entries.truncate(MAX_ENTRIES);
    let parent = real.parent().filter(|parent| inside(parent)).map(|p| p.to_string_lossy().into_owned());
    Ok(json!({
        "path": real,
        "parent": parent,
        "home": home().filter(|home| inside(home)),
        "roots": roots,
        "truncated": truncated,
        "entries": entries.into_iter().map(|(name, path)| json!({"name": name, "path": path})).collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hivemind-browse-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for sub in ["alpha", "Beta", ".hidden", "alpha/inner"] {
            std::fs::create_dir_all(dir.join(sub)).unwrap();
        }
        std::fs::write(dir.join("file.txt"), "x").unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    fn names(listing: &serde_json::Value) -> Vec<&str> {
        listing["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect()
    }

    #[test]
    fn lists_only_folders_sorted_and_hides_dotfolders() {
        let dir = tree("lists");
        let listing = browse(Some(dir.display().to_string()), false, &[]).unwrap();
        assert_eq!(names(&listing), ["alpha", "Beta"]);
        let all = browse(Some(dir.display().to_string()), true, &[]).unwrap();
        assert_eq!(names(&all), [".hidden", "alpha", "Beta"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn roots_confine_the_browser() {
        let dir = tree("roots");
        let roots = [dir.join("alpha")];
        let inside = browse(None, false, &roots).unwrap();
        assert_eq!(names(&inside), ["inner"]);
        assert!(inside["parent"].is_null(), "cannot climb out of the root");
        let outside = browse(Some(dir.display().to_string()), false, &roots).unwrap_err();
        assert_eq!(outside.0, StatusCode::FORBIDDEN);
        let relative = browse(Some("relative".into()), false, &[]).unwrap_err();
        assert_eq!(relative.0, StatusCode::BAD_REQUEST);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
