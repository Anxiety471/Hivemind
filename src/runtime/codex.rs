//! Codex harness via `@agentclientprotocol/codex-acp` (ACP over stdio).

use anyhow::Result;
use serde_json::json;

use crate::config::AgentConfig;

use super::acp::{AcpSession, ChildSpec, ConfigOption};

pub async fn start_filtered(
    binary: &str,
    codex_binary: Option<&str>,
    agent: &AgentConfig,
    private_env: &[String],
) -> Result<AcpSession> {
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
    if let Some(reasoning) = agent
        .reasoning
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        config_options.push(ConfigOption {
            id: "reasoning_effort",
            value: reasoning.to_owned(),
        });
    }
    if let Some(fast) = agent.fast {
        config_options.push(ConfigOption {
            id: "fast-mode",
            value: json!(fast).to_string(),
        });
    }
    let mut extra_env = vec![
        ("NO_BROWSER".into(), "1".into()),
        (
            "INITIAL_AGENT_MODE".into(),
            initial_agent_mode(agent).into(),
        ),
    ];
    if let Some(path) = codex_binary.filter(|value| !value.is_empty()) {
        extra_env.push(("CODEX_PATH".into(), path.to_owned()));
    }
    let codex_config = codex_config(agent);
    if !codex_config.is_null() {
        extra_env.push(("CODEX_CONFIG".into(), codex_config.to_string()));
    }
    AcpSession::start(
        agent,
        ChildSpec {
            label: "Codex",
            binary,
            args: &[],
            session_new: json!({"cwd": agent.workspace, "mcpServers": []}),
            config_options,
            extra_env,
            env_remove: &[],
            initialize_params: super::acp::default_initialize_params(),
            post_initialize: vec![],
            session_mode: None,
            permission_policy: super::acp::PermissionPolicy::Adapter,
            extension_reply: None,
        },
        private_env,
    )
    .await
}

fn codex_config(agent: &AgentConfig) -> serde_json::Value {
    let prompt = agent.system_prompt.trim();
    if prompt.is_empty() {
        return json!(null);
    }
    json!({
        "developer_instructions": prompt
    })
}

fn initial_agent_mode(agent: &AgentConfig) -> &'static str {
    let write = agent.tool_access.map(|access| access.write).unwrap_or(true);
    let exec = agent.tool_access.map(|access| access.exec).unwrap_or(true);
    if write && exec {
        "agent-full-access"
    } else if write {
        "workspace-write"
    } else {
        "read-only"
    }
}
