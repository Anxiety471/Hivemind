use std::{collections::HashSet, fs, path::Path};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HivemindConfig {
    #[serde(default)]
    pub runtime: RuntimeConfig,
    #[serde(default)]
    pub conversation: ConversationConfig,
    #[serde(default)]
    pub agents: Vec<AgentConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ConversationConfig {
    #[serde(default)]
    pub reply_order: Vec<String>,
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
        let raw = fs::read_to_string(path).with_context(|| {
            format!(
                "failed to read config {}; create it at this path with 'hivemind --config <path> init' or 'cargo run -- --config <path> init' (for the default path, use 'hivemind init' or 'cargo run -- init')",
                path.display()
            )
        })?;

        let config: Self = toml::from_str(&raw)
            .with_context(|| format!("failed to parse config {}", path.display()))?;

        config.validate()?;

        Ok(config)
    }

    fn validate(&self) -> Result<()> {
        if self.agents.is_empty() {
            bail!("config contains no agents; add at least one [[agents]] entry or create a starter config with 'hivemind init'");
        }

        let mut agent_names = HashSet::with_capacity(self.agents.len());
        for agent in &self.agents {
            if agent.name.trim().is_empty() {
                bail!("[[agents]].name must not be empty; assign each agent a non-empty name");
            }
            if !agent_names.insert(agent.name.as_str()) {
                bail!("duplicate agent name '{}'; rename one of the [[agents]] entries so every agent name is unique", agent.name);
            }
        }

        let mut reply_names = HashSet::with_capacity(self.conversation.reply_order.len());
        for name in &self.conversation.reply_order {
            if !reply_names.insert(name.as_str()) {
                bail!("conversation.reply_order contains duplicate agent '{name}'; use unique configured agent names");
            }
            if !agent_names.contains(name.as_str()) {
                bail!("conversation.reply_order references unknown agent '{name}'; use unique configured agent names that match [[agents]].name");
            }
        }

        Ok(())
    }

    /// Explicitly ordered agents come first; omitted agents retain declaration order.
    pub fn ordered_agents(&self) -> Vec<&AgentConfig> {
        let mut ordered = Vec::with_capacity(self.agents.len());
        let mut included = HashSet::with_capacity(self.conversation.reply_order.len());

        for name in &self.conversation.reply_order {
            if let Some(agent) = self.agents.iter().find(|agent| agent.name == *name) {
                included.insert(agent.name.as_str());
                ordered.push(agent);
            }
        }
        for agent in &self.agents {
            if !included.contains(agent.name.as_str()) {
                ordered.push(agent);
            }
        }
        ordered
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
        let raw = format!(
            "# Configure model per agent with model = \"provider/model-id\".\n# Configure reasoning with reasoning = \"high\" (or another runtime-supported level).\n# Provider credentials are managed by Pi/OMP and are never stored here.\n{raw}"
        );
        fs::write(path, raw)
            .with_context(|| format!("failed to write config {}", path.display()))?;

        Ok(())
    }

    pub fn default_poc() -> Self {
        Self {
            runtime: RuntimeConfig::default(),
            conversation: ConversationConfig {
                reply_order: vec!["Maomao".into(), "Albedo".into()],
            },
            agents: vec![
                AgentConfig {
                    name: "Maomao".into(),
                    runtime: "pi".into(),
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
                    runtime: "pi".into(),
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
    fn default_poc_contains_two_pi_agents_and_reply_order() {
        let config = HivemindConfig::default_poc();

        assert_eq!(config.agents.len(), 2);
        assert!(config.agents.iter().all(|agent| agent.runtime == "pi"));
        assert_eq!(config.conversation.reply_order, ["Maomao", "Albedo"]);
        assert_eq!(config.runtime.omp_binary, "omp");
        assert_eq!(config.runtime.pi_binary, "pi");
    }
    #[test]
    fn init_refuses_to_overwrite_without_force_and_force_replaces_config() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "hivemind-init-{}-{}.toml",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));

        HivemindConfig::write_default(&path, false).unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("model = \"provider/model-id\""));
        assert!(raw.contains("reasoning = \"high\""));
        assert!(!raw.contains("api_key"));
        assert_eq!(HivemindConfig::load(&path).unwrap().agents.len(), 2);

        fs::write(&path, "user config").unwrap();
        assert!(HivemindConfig::write_default(&path, false).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "user config");
        HivemindConfig::write_default(&path, true).unwrap();
        assert_eq!(HivemindConfig::load(&path).unwrap().agents.len(), 2);
        let _ = fs::remove_file(path);
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
    #[test]
    fn reply_order_defaults_to_declaration_order_and_appends_unlisted_agents() {
        let declaration: HivemindConfig = toml::from_str(
            r#"
                [[agents]]
                name = "First"
                [[agents]]
                name = "Second"
                [[agents]]
                name = "Third"
            "#,
        )
        .unwrap();
        assert_eq!(
            declaration
                .ordered_agents()
                .iter()
                .map(|agent| agent.name.as_str())
                .collect::<Vec<_>>(),
            ["First", "Second", "Third"]
        );

        let partial: HivemindConfig = toml::from_str(
            r#"
                [conversation]
                reply_order = ["Third", "First"]
                [[agents]]
                name = "First"
                [[agents]]
                name = "Second"
                [[agents]]
                name = "Third"
            "#,
        )
        .unwrap();
        partial.validate().unwrap();
        assert_eq!(
            partial
                .ordered_agents()
                .iter()
                .map(|agent| agent.name.as_str())
                .collect::<Vec<_>>(),
            ["Third", "First", "Second"]
        );
    }

    fn load_toml(raw: &str) -> anyhow::Result<HivemindConfig> {
        use std::sync::atomic::{AtomicUsize, Ordering};

        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "hivemind-reply-order-{}-{}.toml",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&path, raw)?;
        let result = HivemindConfig::load(&path);
        let _ = std::fs::remove_file(path);
        result
    }

    #[test]
    fn load_rejects_duplicate_and_unknown_reply_order_names() {
        for (raw, expected) in [
            (
                r#"
                    [conversation]
                    reply_order = ["A", "A"]
                    [[agents]]
                    name = "A"
                "#,
                "contains duplicate agent",
            ),
            (
                r#"
                    [conversation]
                    reply_order = ["Missing"]
                    [[agents]]
                    name = "A"
                "#,
                "references unknown agent",
            ),
        ] {
            let error = load_toml(raw).unwrap_err().to_string();
            assert!(
                error.contains(expected),
                "unexpected validation error: {error}"
            );
        }
    }
}
