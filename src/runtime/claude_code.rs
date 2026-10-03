//! Claude Code harness via `claude-code-acp` (ACP over stdio).

use anyhow::{bail, Result};
use serde_json::json;

use crate::config::AgentConfig;

use super::acp::{AcpSession, ChildSpec, ConfigOption};

pub async fn start_filtered(
    binary: &str,
    agent: &AgentConfig,
    private_env: &[String],
) -> Result<AcpSession> {
    if agent.fast.is_some() {
        bail!(
            "Claude Code runtime does not support the OMP-specific 'fast' setting for agent '{}'",
            agent.name
        );
    }
    let model = agent
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let mut config_options = Vec::new();
    if let Some(model) = model {
        config_options.push(ConfigOption {
            id: "model",
            value: model,
        });
    }
    AcpSession::start(
        agent,
        ChildSpec {
            label: "Claude Code",
            binary,
            args: &[],
            session_new: session_new_params(agent),
            config_options,
            extra_env: vec![("NO_BROWSER".into(), "1".into())],
            env_remove: &[],
        },
        private_env,
    )
    .await
}

fn session_new_params(agent: &AgentConfig) -> serde_json::Value {
    let mut meta = json!({
        "claudeCode": {
            "options": {
                "settingSources": [],
                "mcpServers": {}
            }
        }
    });
    let prompt = agent.system_prompt.trim();
    if !prompt.is_empty() {
        meta["systemPrompt"] = json!(prompt);
    }
    if let Some(reasoning) = agent
        .reasoning
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        meta["claudeCode"]["options"]["thinking"] = json!({
            "type": "enabled",
            "budget_tokens": reasoning_budget(reasoning)
        });
    }
    json!({
        "cwd": agent.workspace,
        "mcpServers": [],
        "_meta": meta
    })
}

fn reasoning_budget(level: &str) -> u64 {
    match level {
        "off" => 0,
        "minimal" | "low" => 4_096,
        "medium" => 12_000,
        "high" | "xhigh" | "max" => 24_000,
        _ => 8_192,
    }
}
