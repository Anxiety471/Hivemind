//! One-time browser setup for a server started without `hivemind.toml`.
use super::{error::ApiError, routes::ApiState};
use crate::config::{AgentConfig, HivemindConfig};
use axum::{
    extract::{rejection::JsonRejection, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;

const MAX_SETUP_PERSONAS: usize = 32;

pub(super) fn routes() -> Router<ApiState> {
    Router::new().route("/api/v1/setup", get(status).post(complete))
}

async fn status(State(state): State<ApiState>) -> Response {
    Json(json!({"setup_required": state.core.setup_required()})).into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetupBody {
    personas: Vec<SetupPersona>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetupPersona {
    id: String,
    #[serde(default)]
    role: String,
    runtime: String,
    workspace: String,
    #[serde(default)]
    system_prompt: String,
    model: Option<String>,
    reasoning: Option<String>,
    fast: Option<bool>,
}

fn bad_request(message: impl Into<String>) -> Response {
    ApiError::owned(StatusCode::BAD_REQUEST, "invalid_setup", message.into()).into_response()
}

fn build_config(body: SetupBody) -> Result<HivemindConfig, String> {
    if body.personas.is_empty() || body.personas.len() > MAX_SETUP_PERSONAS {
        return Err("Add between 1 and 32 personas.".into());
    }

    let mut config = HivemindConfig::default();
    let mut reply_order = Vec::with_capacity(MAX_SETUP_PERSONAS);
    let mut personas = Vec::with_capacity(MAX_SETUP_PERSONAS);
    for setup in body.personas {
        let id = setup.id.trim();
        if id.is_empty() || id.len() > 64 {
            return Err("Persona IDs must contain 1 to 64 characters.".into());
        }
        if !matches!(setup.runtime.as_str(), "pi" | "omp" | "opencode") {
            return Err(format!("Persona '{id}' uses an unsupported runtime."));
        }
        let role = setup.role.trim();
        if role.len() > 120 {
            return Err(format!(
                "Role for persona '{id}' must be 120 characters or fewer."
            ));
        }
        let system_prompt = setup.system_prompt.trim();
        if system_prompt.len() > 32 * 1024 {
            return Err(format!(
                "System prompt for persona '{id}' must be 32 KiB or fewer."
            ));
        }
        if setup
            .model
            .as_deref()
            .is_some_and(|model| model.len() > 256)
        {
            return Err(format!(
                "Model for persona '{id}' must be 256 characters or fewer."
            ));
        }
        if setup
            .reasoning
            .as_deref()
            .is_some_and(|reasoning| reasoning.len() > 64)
        {
            return Err(format!(
                "Reasoning setting for persona '{id}' must be 64 characters or fewer."
            ));
        }
        let workspace = setup.workspace.trim();
        if workspace.is_empty() || workspace.len() > 1024 {
            return Err(format!(
                "Persona '{id}' needs a workspace path of 1 to 1024 characters."
            ));
        }
        let workspace = crate::config::absolute_workspace(workspace);
        if setup.fast.is_some() && setup.runtime != "omp" {
            return Err(format!(
                "Fast mode is only supported by OMP (persona '{id}')."
            ));
        }
        if (setup.reasoning.is_some() || setup.fast.is_some()) && setup.runtime == "opencode" {
            return Err(format!(
                "Reasoning and fast mode are not supported by OpenCode (persona '{id}')."
            ));
        }
        if setup.runtime == "opencode" {
            if let Some(model) = setup
                .model
                .as_deref()
                .filter(|model| !model.trim().is_empty())
            {
                let Some((provider, model_id)) = model.trim().split_once('/') else {
                    return Err(format!(
                        "OpenCode model for '{id}' must use provider/model-id format."
                    ));
                };
                if provider.is_empty() || model_id.is_empty() {
                    return Err(format!(
                        "OpenCode model for '{id}' must use provider/model-id format."
                    ));
                }
            }
        }

        reply_order.push(id.to_owned());
        personas.push(AgentConfig {
            name: id.to_owned(),
            runtime: setup.runtime,
            system_prompt: system_prompt.to_owned(),
            workspace,
            model: setup
                .model
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty()),
            reasoning: setup
                .reasoning
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty()),
            fast: setup.fast,
            fallback_models: Vec::new(),
            role: Some(role.to_owned()).filter(|value| !value.is_empty()),
            capabilities: Vec::new(),
            permissions: Vec::new(),
            roles: Vec::new(),
            tool_access: None,
            web: true,
            authorized_work: Vec::new(),
            unauthorized_work: Vec::new(),
        });
    }

    config.conversation.reply_order = reply_order;
    config.agents = personas;
    if let Err(error) = config.validate() {
        return Err(error.to_string());
    }
    Ok(config)
}

async fn complete(
    State(state): State<ApiState>,
    payload: Result<Json<SetupBody>, JsonRejection>,
) -> Response {
    if !state.core.setup_required() {
        return ApiError::new(
            StatusCode::CONFLICT,
            "already_configured",
            "Hivemind is already configured",
        )
        .into_response();
    }
    let Ok(Json(body)) = payload else {
        return ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_json",
            "invalid setup request",
        )
        .into_response();
    };
    let config = match build_config(body) {
        Ok(config) => config,
        Err(message) => return bad_request(message),
    };
    match state.core.complete_initial_setup(config) {
        Ok(()) => Json(json!({
            "saved": true,
            "setup_required": false,
            "persona_count": state.core.agents().list().len(),
        }))
        .into_response(),
        Err(error) if error.to_string().contains("already configured") => ApiError::new(
            StatusCode::CONFLICT,
            "already_configured",
            "Hivemind is already configured",
        )
        .into_response(),
        Err(error)
            if error.chain().any(|cause| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|io| io.kind() == std::io::ErrorKind::AlreadyExists)
            }) =>
        {
            ApiError::new(
                StatusCode::CONFLICT,
                "already_configured",
                "Hivemind is already configured",
            )
            .into_response()
        }
        Err(error) if error.chain().any(|cause| cause.is::<std::io::Error>()) => {
            eprintln!("initial setup persistence failed: {error:#}");
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "setup could not be saved",
            )
            .into_response()
        }
        Err(error) => bad_request(error.to_string()),
    }
}
