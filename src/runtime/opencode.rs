//! OpenCode adapter over the Agent Client Protocol (ACP).
//!
//! Transport is `opencode acp` over stdio with Hivemind-owned `OPENCODE_CONFIG_DIR` isolation.

use std::path::Path;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use crate::config::AgentConfig;

use super::acp::{AcpSession, ChildSpec, ConfigOption};

/// No-op plugin kept in Hivemind's OpenCode config dir.
pub(super) const KEEP_PROVIDERS_PLUGIN: &str = "// Written by Hivemind. OpenCode drops its built-in `opencode` provider when no plugin loads; this no-op keeps it.\nexport const Hivemind = async () => ({});\n";

pub async fn start_filtered(
    binary: &str,
    config_dir: &Path,
    agent: &AgentConfig,
    private_env: &[String],
) -> Result<AcpSession> {
    if agent.fast.is_some() {
        bail!(
            "OpenCode runtime does not support the OMP-specific 'fast' setting for agent '{}'",
            agent.name
        );
    }
    if agent
        .reasoning
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        bail!(
            "OpenCode runtime does not support the 'reasoning' setting for agent '{}'; remove it or choose another runtime",
            agent.name
        );
    }
    let model = match agent
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(model) if model.split_once('/').is_some_and(|(p, m)| !p.is_empty() && !m.is_empty()) => {
            Some(model.to_owned())
        }
        Some(model) => bail!(
            "OpenCode model '{model}' for agent '{}' must be 'provider/model-id', for example 'opencode/big-pickle'",
            agent.name
        ),
        None => None,
    };
    super::write_owned_file(
        &config_dir.join("plugins").join("hivemind.js"),
        KEEP_PROVIDERS_PLUGIN,
    )
    .context("preparing Hivemind's OpenCode config directory")?;
    let mut config = json!({"permission": permission(agent)});
    if !agent.system_prompt.trim().is_empty() {
        config["agent"] = json!({"build": {"prompt": agent.system_prompt}});
    }
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
            label: "OpenCode",
            binary,
            args: &["acp"],
            session_new: json!({"cwd": agent.workspace, "mcpServers": []}),
            config_options,
            extra_env: vec![
                ("OPENCODE_CONFIG_CONTENT".into(), config.to_string()),
                ("OPENCODE_CONFIG_DIR".into(), config_dir.display().to_string()),
                ("OPENCODE_DISABLE_PROJECT_CONFIG".into(), "1".into()),
            ],
            env_remove: &["OPENCODE_CONFIG"],
        },
        private_env,
    )
    .await
}

/// OpenCode permission config: everything allowed unless the persona's roles withhold editing or shell.
pub fn permission(agent: &AgentConfig) -> Value {
    if agent.tool_access.is_none() && agent.web {
        return json!("allow");
    }
    let mut rules = json!({"*": "allow"});
    if let Some(access) = agent.tool_access {
        if !access.write {
            rules["edit"] = json!("deny");
        }
        if !access.exec {
            rules["bash"] = json!("deny");
        }
    }
    if !agent.web {
        rules["webfetch"] = json!("deny");
        rules["websearch"] = json!("deny");
    }
    rules
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn web_off_denies_web_tools_even_for_an_unrestricted_persona() {
        let mut agent = crate::config::HivemindConfig::default_poc().agents[0].clone();
        assert_eq!(permission(&agent), json!("allow"));
        agent.web = false;
        assert_eq!(
            permission(&agent),
            json!({"*": "allow", "webfetch": "deny", "websearch": "deny"})
        );
    }
}
