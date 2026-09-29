use std::{collections::HashSet, fs, path::Path};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HivemindConfig {
    #[serde(default)]
    pub runtime: RuntimeConfig,
    #[serde(default)]
    pub conversation: ConversationConfig,
    #[serde(default, rename = "personas", alias = "agents")]
    pub agents: Vec<AgentConfig>,
    #[serde(default)]
    pub groups: Vec<GroupConfig>,
    #[serde(default)]
    pub context: ContextConfig,
    #[serde(default)]
    pub memory: MemoryConfig,
}

/// Deterministic, model-independent memory behavior.
///
/// The only supported mode today is `deterministic`: storage, retrieval, and
/// scope policy never require a model or provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryConfig {
    #[serde(default = "default_memory_mode")]
    pub mode: String,
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self {
            mode: default_memory_mode(),
        }
    }
}

fn default_memory_mode() -> String {
    "deterministic".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ConversationConfig {
    #[serde(default)]
    pub reply_order: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GroupConfig {
    #[serde(rename = "id", alias = "name")]
    pub name: String,
    #[serde(default)]
    pub members: Vec<String>,
    #[serde(default)]
    pub mode: ConversationMode,
    #[serde(default)]
    pub member_roles: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub reply_order: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ConversationMode {
    #[default]
    Broadcast,
    Discussion,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextConfig {
    #[serde(default = "default_recent_turns")]
    pub recent_turns: usize,
    #[serde(default = "default_summary_max_tokens")]
    pub summary_max_tokens: usize,
    #[serde(default = "default_context_target_tokens")]
    pub context_target_tokens: usize,
    /// Live runtime context size (runtime-reported or estimated at 4 bytes/token)
    /// at which an agent-instance runtime is rotated before its next turn.
    #[serde(default = "default_runtime_rotate_tokens")]
    pub runtime_rotate_tokens: usize,
    #[serde(default = "default_summary_refresh_turns")]
    pub summary_refresh_turns: usize,
}

impl Default for ContextConfig {
    fn default() -> Self {
        Self {
            recent_turns: default_recent_turns(),
            summary_max_tokens: default_summary_max_tokens(),
            context_target_tokens: default_context_target_tokens(),
            runtime_rotate_tokens: default_runtime_rotate_tokens(),
            summary_refresh_turns: default_summary_refresh_turns(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeConfig {
    #[serde(default = "default_omp_binary")]
    pub omp_binary: String,
    #[serde(default = "default_pi_binary")]
    pub pi_binary: String,
    /// Maximum seconds a runtime prompt may take; 0 disables the timeout.
    #[serde(default = "default_runtime_prompt_timeout_secs")]
    pub prompt_timeout_secs: u64,
    /// Seconds an agent-instance runtime may sit unused before it is stopped;
    /// 0 keeps sessions until shutdown.
    #[serde(default = "default_idle_timeout_secs")]
    pub idle_timeout_secs: u64,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            omp_binary: default_omp_binary(),
            pi_binary: default_pi_binary(),
            prompt_timeout_secs: default_runtime_prompt_timeout_secs(),
            idle_timeout_secs: default_idle_timeout_secs(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    #[serde(rename = "id", alias = "name")]
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
    #[serde(default)]
    pub role: Option<String>,
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
        if self.memory.mode != "deterministic" {
            bail!(
                "memory.mode must be \"deterministic\" (the only supported mode); got {:?}",
                self.memory.mode
            );
        }
        if self.context.recent_turns == 0
            || self.context.summary_max_tokens == 0
            || self.context.context_target_tokens == 0
            || self.context.summary_refresh_turns == 0
        {
            bail!("context.recent_turns, summary_max_tokens, context_target_tokens, and summary_refresh_turns must be positive");
        }
        if self.context.summary_max_tokens > self.context.context_target_tokens {
            bail!("context.summary_max_tokens must not exceed context.context_target_tokens");
        }
        if self.context.runtime_rotate_tokens <= self.context.context_target_tokens {
            bail!("context.runtime_rotate_tokens must exceed context.context_target_tokens");
        }
        if self.agents.is_empty() {
            bail!("config contains no personas; add at least one [[personas]] entry (legacy [[agents]] entries with name are also accepted) or create a starter config with 'hivemind init'");
        }

        let mut persona_ids = HashSet::with_capacity(self.agents.len());
        for persona in &self.agents {
            if persona.name.trim().is_empty() {
                bail!("[[personas]].id must not be empty; assign each persona a non-empty id (`[[agents]].name` remains a legacy alias)");
            }
            if !persona_ids.insert(persona.name.as_str()) {
                bail!("duplicate persona id '{}'; rename one of the [[personas]] entries so every id is unique (`[[agents]].name` is the legacy alias)", persona.name);
            }
        }
        let mut group_names = HashSet::with_capacity(self.groups.len());
        for group in &self.groups {
            if group.name.trim().is_empty() || group.name == "main" {
                bail!("invalid or reserved group name '{}'", group.name);
            }
            if !group_names.insert(group.name.as_str()) {
                bail!("duplicate group name '{}'", group.name);
            }
            let mut members = HashSet::with_capacity(group.members.len());
            for member in &group.members {
                if !persona_ids.contains(member.as_str()) {
                    bail!("unknown persona id '{member}' in group '{}'; use a configured [[personas]].id (`[[agents]].name` is the legacy alias)", group.name);
                }
                if !members.insert(member.as_str()) {
                    bail!("duplicate persona id '{member}' in group '{}'", group.name);
                }
            }
            for name in group.member_roles.keys() {
                if !members.contains(name.as_str()) {
                    bail!(
                        "group '{}' defines a role for non-member '{name}'",
                        group.name
                    );
                }
            }
            for name in &group.reply_order {
                if !members.contains(name.as_str()) {
                    bail!(
                        "group '{}' reply_order references non-member '{name}'",
                        group.name
                    );
                }
            }
            let mut group_reply_names = HashSet::with_capacity(group.reply_order.len());
            for name in &group.reply_order {
                if !group_reply_names.insert(name.as_str()) {
                    bail!(
                        "group '{}' reply_order contains duplicate persona id '{name}'",
                        group.name
                    );
                }
            }
        }

        let mut reply_names = HashSet::with_capacity(self.conversation.reply_order.len());
        for name in &self.conversation.reply_order {
            if !reply_names.insert(name.as_str()) {
                bail!("conversation.reply_order contains duplicate persona id '{name}'; use unique configured persona IDs");
            }
            if !persona_ids.contains(name.as_str()) {
                bail!("conversation.reply_order references unknown persona id '{name}'; use configured [[personas]].id values (`[[agents]].name` is the legacy alias)");
            }
        }

        Ok(())
    }

    /// Agents in configured reply order, with unspecified agents appended in
    /// their declaration order.
    pub fn ordered_agents(&self) -> Vec<&AgentConfig> {
        let mut ordered = Vec::with_capacity(self.agents.len());
        for name in &self.conversation.reply_order {
            if let Some(agent) = self.agents.iter().find(|agent| agent.name == *name) {
                ordered.push(agent);
            }
        }
        for agent in &self.agents {
            if !self.conversation.reply_order.contains(&agent.name) {
                ordered.push(agent);
            }
        }
        ordered
    }
    /// Resolve a group's effective member order from its overrides and the
    /// global reply order, retaining only configured group members.
    pub fn ordered_group_members<'a>(&'a self, group: &GroupConfig) -> Vec<&'a AgentConfig> {
        let mut ordered = Vec::with_capacity(group.members.len());
        for name in &group.reply_order {
            if group.members.contains(name) {
                if let Some(agent) = self.agents.iter().find(|agent| agent.name == *name) {
                    ordered.push(agent);
                }
            }
        }
        ordered.extend(self.ordered_agents().into_iter().filter(|agent| {
            group.members.contains(&agent.name) && !group.reply_order.contains(&agent.name)
        }));
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
            "# Configure model and reasoning per agent with model = \"provider/model-id\" and reasoning = \"high\".\n# Provider credentials are managed by Pi/OMP and are never stored here.\n{raw}"
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
            context: ContextConfig::default(),
            memory: MemoryConfig::default(),
            groups: Vec::new(),
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
                    role: Some("Software Engineer".into()),
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
                    role: Some("Reviewer".into()),
                },
            ],
        }
    }
}

fn default_recent_turns() -> usize {
    6
}
fn default_summary_max_tokens() -> usize {
    2000
}
fn default_context_target_tokens() -> usize {
    12000
}
fn default_runtime_rotate_tokens() -> usize {
    24000
}
fn default_summary_refresh_turns() -> usize {
    4
}

fn default_omp_binary() -> String {
    "omp".into()
}
fn default_pi_binary() -> String {
    "pi".into()
}
fn default_runtime_prompt_timeout_secs() -> u64 {
    300
}
fn default_idle_timeout_secs() -> u64 {
    120
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
        assert_eq!(legacy.runtime.prompt_timeout_secs, 300);
        assert_eq!(legacy.agents[0].runtime, "omp");

        let configured: HivemindConfig = toml::from_str(
            r#"
                [runtime]
                pi_binary = "/custom/pi"
                prompt_timeout_secs = 0
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
        assert_eq!(configured.runtime.prompt_timeout_secs, 0);
        assert_eq!(configured.agents[0].runtime, "pi");
        assert_eq!(configured.agents[1].runtime, "omp");
    }

    #[test]
    fn default_poc_contains_two_pi_agents() {
        let config = HivemindConfig::default_poc();

        assert_eq!(config.agents.len(), 2);
        assert!(config.agents.iter().all(|agent| agent.runtime == "pi"));
        assert_eq!(config.conversation.reply_order, ["Maomao", "Albedo"]);
        assert_eq!(config.runtime.pi_binary, "pi");
        assert_eq!(config.runtime.prompt_timeout_secs, 300);
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
    fn memory_mode_defaults_to_deterministic_and_rejects_unknown_modes() {
        let config: HivemindConfig = toml::from_str("[[agents]]\nname = \"A\"\n").unwrap();
        assert_eq!(config.memory.mode, "deterministic");

        let explicit: HivemindConfig =
            toml::from_str("[memory]\nmode = \"deterministic\"\n[[agents]]\nname = \"A\"\n")
                .unwrap();
        assert_eq!(explicit.memory.mode, "deterministic");

        let unsupported = load_toml("[memory]\nmode = \"hybrid\"\n[[agents]]\nname = \"A\"\n")
            .unwrap_err()
            .to_string();
        assert!(unsupported.contains("memory.mode must be"));

        assert_eq!(HivemindConfig::default_poc().memory.mode, "deterministic");
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
    fn reply_order_defaults_to_declaration_order_and_partial_order_appends_omissions() {
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
                .map(|a| a.name.as_str())
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
        assert_eq!(
            partial
                .ordered_agents()
                .iter()
                .map(|a| a.name.as_str())
                .collect::<Vec<_>>(),
            ["Third", "First", "Second"]
        );
    }

    #[test]
    fn persona_room_and_context_configuration_validate() {
        let config = load_toml(
            r#"
            [[personas]]
            id = "maomao"
            role = "Engineer"
            [[personas]]
            id = "albedo"
            [[groups]]
            id = "development"
            mode = "discussion"
            members = ["maomao", "albedo"]
            reply_order = ["albedo", "maomao"]
            [groups.member_roles]
            albedo = "Lead Reviewer"
            [context]
            recent_turns = 3
            summary_max_tokens = 100
            context_target_tokens = 1000
            runtime_rotate_tokens = 2000
            summary_refresh_turns = 4
        "#,
        )
        .unwrap();
        assert_eq!(config.agents[0].name, "maomao");
        assert_eq!(config.groups[0].mode, ConversationMode::Discussion);
        assert_eq!(config.groups[0].member_roles["albedo"], "Lead Reviewer");

        let invalid = load_toml("[[personas]]\nid = \"a\"\n[context]\ncontext_target_tokens = 0\n")
            .unwrap_err()
            .to_string();
        assert!(invalid.contains("must be positive"));
        let bad_role = load_toml("[[personas]]\nid = \"a\"\n[[groups]]\nid = \"g\"\nmembers = [\"a\"]\n[groups.member_roles]\nb = \"Reviewer\"\n").unwrap_err().to_string();
        assert_eq!(
            config.groups[0]
                .reply_order
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["albedo", "maomao"]
        );
        let bad_order = load_toml(
            "[[personas]]\nid = \"a\"\n[[personas]]\nid = \"b\"\n[[groups]]\nid = \"g\"\nmembers = [\"a\"]\nreply_order = [\"b\"]\n",
        )
        .unwrap_err()
        .to_string();
        assert!(bad_order.contains("non-member"));
        assert!(bad_role.contains("non-member"));
    }

    fn load_toml(raw: &str) -> Result<HivemindConfig> {
        let path = std::env::temp_dir().join(format!(
            "hivemind-config-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(&path, raw)?;
        let result = HivemindConfig::load(&path);
        let _ = fs::remove_file(path);
        result
    }

    #[test]
    fn load_rejects_configurations_without_personas() {
        let error = load_toml("personas = []\n").unwrap_err().to_string();
        assert!(error.contains("config contains no personas"));
        assert!(error.contains("[[personas]]"));
    }

    #[test]
    fn load_errors_include_persona_id_and_legacy_alias_guidance() {
        for (reply_order, expected) in [
            ("[\"A\", \"A\"]", "use unique configured persona IDs"),
            ("[\"Missing\"]", "use configured [[personas]].id values"),
        ] {
            let raw =
                format!("[conversation]\nreply_order = {reply_order}\n[[agents]]\nname = \"A\"\n");
            let error = load_toml(&raw).unwrap_err().to_string();
            assert!(error.contains(expected), "unexpected error: {error}");
        }

        let duplicate = load_toml("[[agents]]\nname = \"A\"\n[[agents]]\nname = \"A\"\n")
            .unwrap_err()
            .to_string();
        assert!(duplicate.contains("rename one of the [[personas]] entries"));
        assert!(duplicate.contains("legacy alias"));

        let empty = load_toml("[[personas]]\nid = \"  \"\n")
            .unwrap_err()
            .to_string();
        assert!(empty.contains("[[personas]].id"));
        assert!(empty.contains("legacy alias"));
    }

    #[test]
    fn missing_config_suggests_init() {
        let path = std::env::temp_dir().join(format!(
            "hivemind-missing-config-{}.toml",
            std::process::id()
        ));
        let error = HivemindConfig::load(&path).unwrap_err().to_string();
        assert!(error.contains("hivemind --config <path> init"));
        assert!(error.contains("cargo run -- --config <path> init"));
        assert!(error.contains("cargo run -- init"));
    }
    #[test]
    fn init_generates_valid_config_and_preserves_existing_file() {
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
        let config = HivemindConfig::load(&path).unwrap();
        assert_eq!(config.agents.len(), 2);
        assert!(config.agents.iter().all(|agent| agent.runtime == "pi"));

        fs::write(&path, "user config").unwrap();
        assert!(HivemindConfig::write_default(&path, false).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "user config");
        HivemindConfig::write_default(&path, true).unwrap();
        assert_eq!(HivemindConfig::load(&path).unwrap().agents.len(), 2);
        let _ = fs::remove_file(path);
    }
}
