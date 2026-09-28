use std::{fs, path::Path};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HivemindConfig {
    #[serde(default)]
    pub runtime: RuntimeConfig,
    #[serde(default)]
    pub agents: Vec<AgentConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeConfig {
    #[serde(default = "default_omp_binary")]
    pub omp_binary: String,
    #[serde(default = "default_pi_binary")]
    pub pi_binary: String,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            omp_binary: default_omp_binary(),
            pi_binary: default_pi_binary(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub name: String,
    #[serde(default = "default_runtime")]
    pub runtime: String,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default = "default_workspace")]
    pub workspace: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default, alias = "thinking")]
    pub reasoning: Option<String>,
    #[serde(default)]
    pub fast: Option<bool>,
}

impl HivemindConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = fs::read_to_string(path)
            .with_context(|| format!("failed to read config {}", path.display()))?;

        let config: Self = toml::from_str(&raw)
            .with_context(|| format!("failed to parse config {}", path.display()))?;

        if config.agents.is_empty() {
            bail!("config contains no agents");
        }

        for agent in &config.agents {
            if agent.name.trim().is_empty() {
                bail!("agent names cannot be empty");
            }
        }

        Ok(config)
    }

    pub fn write_default(path: &Path, force: bool) -> Result<()> {
        if path.exists() && !force {
            bail!(
                "{} already exists; pass --force to replace it",
                path.display()
            );
        }

        let raw = toml::to_string_pretty(&Self::default_poc())
            .context("failed to serialize default config")?;

        fs::write(path, raw)
            .with_context(|| format!("failed to write config {}", path.display()))?;

        Ok(())
    }

    pub fn default_poc() -> Self {
        Self {
            runtime: RuntimeConfig::default(),
            agents: vec![
                AgentConfig {
                    name: "Maomao".into(),
                    runtime: "omp".into(),
                    system_prompt: concat!(
                        "You are Maomao, a software engineering agent inside Hivemind. ",
                        "Reply naturally and concisely to the user. ",
                        "You are one member of a multi-agent hive."
                    )
                    .into(),
                    workspace: ".".into(),
                    model: None,
                    reasoning: None,
                    fast: None,
                },
                AgentConfig {
                    name: "Albedo".into(),
                    runtime: "omp".into(),
                    system_prompt: concat!(
                        "You are Albedo, a careful reviewer and systems-thinking agent inside Hivemind. ",
                        "Reply naturally and concisely to the user. ",
                        "You are one member of a multi-agent hive."
                    )
                    .into(),
                    workspace: ".".into(),
                    model: None,
                    reasoning: None,
                    fast: None,
                },
            ],
        }
    }
}

fn default_omp_binary() -> String {
    "omp".into()
}
fn default_pi_binary() -> String {
    "pi".into()
}

fn default_runtime() -> String {
    "omp".into()
}

fn default_workspace() -> String {
    ".".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_binaries_default_for_legacy_and_new_configs() {
        let legacy: HivemindConfig = toml::from_str(
            r#"
                [[agents]]
                name = "Old"
            "#,
        )
        .unwrap();
        assert_eq!(legacy.runtime.omp_binary, "omp");
        assert_eq!(legacy.runtime.pi_binary, "pi");
        assert_eq!(legacy.agents[0].runtime, "omp");

        let configured: HivemindConfig = toml::from_str(
            r#"
                [runtime]
                pi_binary = "/custom/pi"
                [[agents]]
                name = "Pi"
                runtime = "pi"
                [[agents]]
                name = "OMP"
            "#,
        )
        .unwrap();
        assert_eq!(configured.runtime.pi_binary, "/custom/pi");
        assert_eq!(configured.runtime.omp_binary, "omp");
        assert_eq!(configured.agents[0].runtime, "pi");
        assert_eq!(configured.agents[1].runtime, "omp");
    }

    #[test]
    fn default_poc_contains_two_omp_agents() {
        let config = HivemindConfig::default_poc();

        assert_eq!(config.agents.len(), 2);
        assert!(config.agents.iter().all(|agent| agent.runtime == "omp"));
        assert_eq!(config.runtime.omp_binary, "omp");
        assert_eq!(config.runtime.pi_binary, "pi");
    }

    #[test]
    fn default_poc_round_trips_through_toml() {
        let config = HivemindConfig::default_poc();
        let serialized = toml::to_string(&config).unwrap();
        let decoded: HivemindConfig = toml::from_str(&serialized).unwrap();

        assert_eq!(decoded.agents.len(), 2);
        assert_eq!(decoded.agents[0].name, "Maomao");
        assert_eq!(decoded.agents[1].name, "Albedo");
    }

    #[test]
    fn legacy_thinking_key_is_accepted_as_reasoning() {
        let raw = r#"
            [[agents]]
            name = "Maomao"
            thinking = "high"
            fast = true
        "#;

        let config: HivemindConfig = toml::from_str(raw).unwrap();

        assert_eq!(config.agents[0].reasoning.as_deref(), Some("high"));
        assert_eq!(config.agents[0].fast, Some(true));
    }
}
