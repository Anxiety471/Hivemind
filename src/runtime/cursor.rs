//! Cursor CLI harness via `agent acp` (ACP over stdio).
//!
//! See <https://cursor.com/docs/cli/acp>. Hivemind runs unattended: tool
//! permissions use `allow-once`, and blocking Cursor extension methods are
//! answered automatically.

use anyhow::{bail, Result};
use serde_json::{json, Value};

use crate::config::AgentConfig;

use super::acp::{
    cursor_extension_reply, cursor_initialize_params, AcpSession, ChildSpec, ConfigOption,
    PermissionPolicy,
};

pub async fn start_filtered(
    binary: &str,
    agent: &AgentConfig,
    private_env: &[String],
) -> Result<AcpSession> {
    if agent.fast.is_some() {
        bail!(
            "Cursor runtime does not support the OMP-specific 'fast' setting for agent '{}'",
            agent.name
        );
    }
    let mut config_options = Vec::new();
    if let Some(model) = agent
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        config_options.push(ConfigOption {
            id: "model",
            value: model.to_owned(),
        });
    }
    AcpSession::start(
        agent,
        ChildSpec {
            label: "Cursor",
            binary,
            args: &["acp"],
            session_new: session_new_params(agent),
            config_options,
            extra_env: vec![],
            env_remove: &[],
            initialize_params: cursor_initialize_params(),
            post_initialize: vec![],
            session_mode: Some(session_mode(agent)),
            permission_policy: PermissionPolicy::CursorCli,
            extension_reply: Some(cursor_extension_reply),
        },
        private_env,
    )
    .await
}

fn session_mode(agent: &AgentConfig) -> &'static str {
    let write = agent.tool_access.map(|access| access.write).unwrap_or(true);
    let exec = agent.tool_access.map(|access| access.exec).unwrap_or(true);
    if write && exec {
        "agent"
    } else if write {
        "plan"
    } else {
        "ask"
    }
}

fn session_new_params(agent: &AgentConfig) -> Value {
    let mut params = json!({
        "cwd": agent.workspace,
        "mcpServers": []
    });
    let prompt = agent.system_prompt.trim();
    if !prompt.is_empty() {
        params["_meta"] = json!({"systemPrompt": prompt});
    }
    params
}
