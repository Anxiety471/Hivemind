use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HivemindConfig {
    #[serde(default)]
    pub execution: crate::execution::ExecutionConfig,
    #[serde(default)]
    pub server: crate::api::ServerConfig,
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
    #[serde(default)]
    pub coordination: CoordinationConfig,
    /// Custom roles: named bundles of permissions (see `access::PERMISSIONS`).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub roles: BTreeMap<String, RoleConfig>,
    /// Limits where agents may point a workspace; a user-written path is never checked.
    #[serde(default, skip_serializing_if = "WorkspacesConfig::is_default")]
    pub workspaces: WorkspacesConfig,
}

/// A custom role. Built-in role names are reserved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct RoleConfig {
    #[serde(default)]
    pub permissions: Vec<String>,
}

/// Agent-driven workspace changes (`workspace.set`, `workspace.list`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct WorkspacesConfig {
    /// Absolute directories agents may choose from. Empty means any existing directory.
    #[serde(default)]
    pub roots: Vec<String>,
    /// Workspaces the user added in the UI. Unlike `roots` they never restrict
    /// anything; they are the directories offered when picking a workspace.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub known: Vec<String>,
}

impl WorkspacesConfig {
    fn is_default(&self) -> bool {
        self.roots.is_empty() && self.known.is_empty()
    }
}

impl CoordinationConfig {
    fn validate(&self, agents: &[AgentConfig]) -> Result<()> {
        if let Some(planner) = &self.planner {
            if !agents.iter().any(|agent| agent.name == *planner) {
                bail!("coordination.planner references unknown persona id '{planner}'");
            }
        }
        if self.max_dispatches == 0
            || self.max_tool_actions == 0
            || self.max_messages == 0
            || self.max_plan_tasks == 0
            || self.max_plan_depth == 0
            || self.max_elapsed_secs == 0
            || self.max_attempts_per_task == 0
            || self.max_concurrent == 0
            || self.lease_secs == 0
            || self.max_message_depth == 0
        {
            bail!("coordination limits must be positive");
        }
        Ok(())
    }
}

/// Autonomous task coordination. Off by default: existing configurations
/// keep their exact behavior until `enabled = true`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoordinationConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Persona that plans natural-language tasks. When absent, the coordinator
    /// is the best-ranked persona holding the `coordinate` permission.
    #[serde(default)]
    pub planner: Option<String>,
    /// Dispatches (attempts) charged to one root task and all descendants.
    #[serde(default = "default_max_dispatches")]
    pub max_dispatches: u32,
    /// Coordination tool calls charged to one root task.
    #[serde(default = "default_max_tool_actions")]
    pub max_tool_actions: u32,
    /// Messages charged to one root task.
    #[serde(default = "default_max_messages")]
    pub max_messages: u32,
    #[serde(default = "default_max_plan_tasks")]
    pub max_plan_tasks: usize,
    /// Longest parent chain and dependency chain a task graph may have.
    #[serde(default = "default_max_plan_depth")]
    pub max_plan_depth: usize,
    /// Wall-clock seconds a root task may keep working before it is blocked.
    #[serde(default = "default_max_elapsed_secs")]
    pub max_elapsed_secs: u64,
    /// Attempts allowed for one task, including repair attempts after review rejection.
    #[serde(default = "default_max_attempts_per_task")]
    pub max_attempts_per_task: u32,
    /// Attempts running at once across all roots.
    #[serde(default = "default_max_concurrent")]
    pub max_concurrent: usize,
    /// Seconds an attempt lease stays valid without a heartbeat.
    #[serde(default = "default_lease_secs")]
    pub lease_secs: u64,
    /// Longest causation chain whose messages may still wake a recipient.
    #[serde(default = "default_max_message_depth")]
    pub max_message_depth: u32,
}

impl Default for CoordinationConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            planner: None,
            max_dispatches: default_max_dispatches(),
            max_tool_actions: default_max_tool_actions(),
            max_messages: default_max_messages(),
            max_plan_tasks: default_max_plan_tasks(),
            max_plan_depth: default_max_plan_depth(),
            max_elapsed_secs: default_max_elapsed_secs(),
            max_attempts_per_task: default_max_attempts_per_task(),
            max_concurrent: default_max_concurrent(),
            lease_secs: default_lease_secs(),
            max_message_depth: default_max_message_depth(),
        }
    }
}

fn default_max_dispatches() -> u32 {
    64
}
fn default_max_tool_actions() -> u32 {
    400
}
fn default_max_messages() -> u32 {
    200
}
fn default_max_plan_tasks() -> usize {
    32
}
fn default_max_plan_depth() -> usize {
    6
}
fn default_max_elapsed_secs() -> u64 {
    3600
}
fn default_max_attempts_per_task() -> u32 {
    3
}
fn default_max_concurrent() -> usize {
    4
}
fn default_lease_secs() -> u64 {
    300
}
fn default_max_message_depth() -> u32 {
    8
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationConfig {
    #[serde(default)]
    pub reply_order: Vec<String>,
    /// Follow-up replies a Discussion turn may add beyond each member's first:
    /// @mentions of members who have already replied, and unprompted open-floor
    /// replies. 0 disables.
    #[serde(default = "default_mention_limit")]
    pub mention_limit: usize,
}

impl Default for ConversationConfig {
    fn default() -> Self {
        Self {
            reply_order: Vec::new(),
            mention_limit: default_mention_limit(),
        }
    }
}

pub const MAX_MENTION_LIMIT: usize = 16;

fn default_mention_limit() -> usize {
    4
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
    /// Shared working directory for every member when the group works together.
    /// Absent means the group has no shared workspace; members keep their own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ConversationMode {
    Broadcast,
    #[default]
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
    #[serde(skip)]
    pub private_env: Vec<String>,
    /// Hivemind-owned directory for harness config that replaces the user's own
    /// (OpenCode config dir, OMP settings overlay); set by the core to
    /// `.hivemind/harness`, absolute.
    #[serde(skip)]
    pub harness_dir: Option<PathBuf>,
    #[serde(default = "default_omp_binary")]
    pub omp_binary: String,
    #[serde(default = "default_pi_binary")]
    pub pi_binary: String,
    #[serde(default = "default_opencode_binary")]
    pub opencode_binary: String,
    /// Maximum seconds a runtime prompt may stay inactive without progress; 0
    /// disables the timeout. Progress (streaming tokens, tool events, reasoning)
    /// resets this inactivity window.
    #[serde(default = "default_runtime_prompt_timeout_secs")]
    pub prompt_timeout_secs: u64,
    /// Seconds an agent-instance runtime may sit unused before it is stopped;
    /// 0 keeps sessions until shutdown.
    #[serde(default = "default_idle_timeout_secs")]
    pub idle_timeout_secs: u64,
    /// Extra attempts on the same model after a failed prompt (not after a
    /// timeout) before moving to the persona's `fallback_models`.
    #[serde(default = "default_prompt_retries")]
    pub prompt_retries: u32,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            private_env: Vec::new(),
            harness_dir: None,
            omp_binary: default_omp_binary(),
            pi_binary: default_pi_binary(),
            opencode_binary: default_opencode_binary(),
            prompt_timeout_secs: default_runtime_prompt_timeout_secs(),
            idle_timeout_secs: default_idle_timeout_secs(),
            prompt_retries: default_prompt_retries(),
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
    /// Models tried in order, one attempt each, once `model` has failed.
    /// A fallback that answers stays the live session's model until it rotates.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fallback_models: Vec<String>,
    #[serde(default, alias = "thinking")]
    pub reasoning: Option<String>,
    #[serde(default)]
    pub fast: Option<bool>,
    #[serde(default)]
    pub role: Option<String>,
    /// Skill tags used to select this persona for work. Purely descriptive
    /// text elsewhere; only these tags participate in matching.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,
    /// Direct permission grants (`access::PERMISSIONS`), added to those of `roles`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub permissions: Vec<String>,
    /// Roles granting permissions. Declaring any makes gated memory tools deny-by-default.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub roles: Vec<String>,
    /// Runtime tool restriction resolved from `roles` at startup (`access::tool_access`); never configured directly.
    #[serde(skip)]
    pub tool_access: Option<ToolAccess>,
}

/// Which of a runtime's own workspace tools a restricted persona keeps.
/// Reading and searching are always available.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolAccess {
    /// File-editing tools (`edit`, `write`, notebooks).
    pub write: bool,
    /// Shell and code-execution tools (`bash`, `python`); these can write files too.
    pub exec: bool,
}
impl HivemindConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = fs::read_to_string(path).with_context(|| {
            format!(
                "failed to read config {}; create it at this path with 'hivemind --config <path> init' or 'cargo run -- --config <path> init' (for the default path, use 'hivemind init' or 'cargo run -- init')",
                path.display()
            )
        })?;

        let mut config: Self = toml::from_str(&raw)
            .with_context(|| format!("failed to parse config {}", path.display()))?;

        config.validate()?;
        for agent in &mut config.agents {
            agent.workspace = absolute_workspace(&agent.workspace);
        }
        for group in &mut config.groups {
            group.workspace = group.workspace.take().map(|w| absolute_workspace(&w));
        }
        for root in &mut config.workspaces.roots {
            *root = absolute_workspace(root);
        }
        for known in &mut config.workspaces.known {
            *known = absolute_workspace(known);
        }

        Ok(config)
    }

    /// Rejects a context budget too small to hold the fixed pack overhead.
    pub fn validate_context_floor(&self) -> Result<()> {
        if self.context.context_target_tokens < MIN_CONTEXT_TARGET_TOKENS {
            bail!(
                "context.context_target_tokens ({}) is below the minimum of {MIN_CONTEXT_TARGET_TOKENS}",
                self.context.context_target_tokens
            );
        }
        Ok(())
    }

    pub fn validate(&self) -> Result<()> {
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
        self.validate_context_floor()?;
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
        for persona in &self.agents {
            if persona
                .capabilities
                .iter()
                .any(|tag| tag.trim().is_empty() || tag.len() > 64)
            {
                bail!(
                    "persona '{}' has an empty or overlong capability tag",
                    persona.name
                );
            }
            if persona
                .fallback_models
                .iter()
                .any(|model| model.trim().is_empty() || model.len() > 256)
            {
                bail!(
                    "persona '{}' has an empty or overlong fallback model",
                    persona.name
                );
            }
        }
        crate::access::validate(self)?;
        self.coordination.validate(&self.agents)?;
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

        if self.conversation.mention_limit > MAX_MENTION_LIMIT {
            bail!("conversation.mention_limit must be at most {MAX_MENTION_LIMIT}");
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
            "# Configure model and reasoning per agent with model = \"provider/model-id\" and reasoning = \"high\" (reasoning is not supported by the opencode runtime).\n# Provider credentials are managed by Pi/OMP/OpenCode and are never stored here.\n{raw}"
        );
        fs::write(path, raw)
            .with_context(|| format!("failed to write config {}", path.display()))?;

        Ok(())
    }

    pub fn default_poc() -> Self {
        Self {
            execution: Default::default(),
            server: Default::default(),
            runtime: RuntimeConfig::default(),
            conversation: ConversationConfig {
                reply_order: vec!["Engineer".into(), "Reviewer".into()],
                ..ConversationConfig::default()
            },
            context: ContextConfig::default(),
            memory: MemoryConfig::default(),
            coordination: CoordinationConfig::default(),
            roles: BTreeMap::new(),
            workspaces: WorkspacesConfig::default(),
            groups: Vec::new(),
            agents: vec![
                AgentConfig {
                    name: "Engineer".into(),
                    runtime: "pi".into(),
                    system_prompt: concat!(
                        "You are the Engineer, a software engineering agent inside Hivemind. ",
                        "Reply naturally and concisely to the user. ",
                        "You are one member of a multi-agent hive."
                    )
                    .into(),
                    workspace: ".".into(),
                    model: None,
                    reasoning: None,
                    fast: None,
                    fallback_models: Vec::new(),
                    role: Some("Software Engineer".into()),
                    capabilities: Vec::new(),
                    permissions: Vec::new(),
                    roles: Vec::new(),
                    tool_access: None,
                },
                AgentConfig {
                    name: "Reviewer".into(),
                    runtime: "pi".into(),
                    system_prompt: concat!(
                        "You are the Reviewer, a careful reviewer and systems-thinking agent inside Hivemind. ",
                        "Reply naturally and concisely to the user. ",
                        "You are one member of a multi-agent hive."
                    )
                    .into(),
                    workspace: ".".into(),
                    model: None,
                    reasoning: None,
                    fast: None,
                    fallback_models: Vec::new(),
                    role: Some("Reviewer".into()),
                    capabilities: Vec::new(),
                    permissions: Vec::new(),
                    roles: Vec::new(),
                    tool_access: None,
                },
            ],
        }
    }
}

/// Smallest `context_target_tokens` that holds the fixed context-pack overhead
/// (identity, memory-tool manifest, state, current turn) before any history.
pub const MIN_CONTEXT_TARGET_TOKENS: usize = 1000;

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
    150_000
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
fn default_opencode_binary() -> String {
    "opencode".into()
}
fn default_runtime_prompt_timeout_secs() -> u64 {
    300
}
fn default_idle_timeout_secs() -> u64 {
    120
}
fn default_prompt_retries() -> u32 {
    1
}

fn default_runtime() -> String {
    "omp".into()
}

/// Resolves a workspace against the current directory without touching the filesystem, so a
/// missing directory still fails per agent at session start rather than at load. Runtimes and
/// git are handed this path in places where a relative one would resolve differently.
pub fn absolute_workspace(workspace: &str) -> String {
    std::path::absolute(workspace)
        .map_or_else(|_| workspace.to_owned(), |p| p.display().to_string())
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
        assert_eq!(legacy.runtime.opencode_binary, "opencode");
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
        assert_eq!(config.conversation.reply_order, ["Engineer", "Reviewer"]);
        assert_eq!(config.runtime.pi_binary, "pi");
        assert_eq!(config.runtime.prompt_timeout_secs, 300);
    }

    #[test]
    fn default_poc_round_trips_through_toml() {
        let config = HivemindConfig::default_poc();
        let serialized = toml::to_string(&config).unwrap();
        let decoded: HivemindConfig = toml::from_str(&serialized).unwrap();

        assert_eq!(decoded.agents.len(), 2);
        assert_eq!(decoded.agents[0].name, "Engineer");
        assert_eq!(decoded.agents[1].name, "Reviewer");
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
            name = "Engineer"
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
            id = "engineer"
            role = "Engineer"
            [[personas]]
            id = "reviewer"
            [[groups]]
            id = "development"
            mode = "discussion"
            members = ["engineer", "reviewer"]
            reply_order = ["reviewer", "engineer"]
            [groups.member_roles]
            reviewer = "Lead Reviewer"
            [context]
            recent_turns = 3
            summary_max_tokens = 100
            context_target_tokens = 1000
            runtime_rotate_tokens = 2000
            summary_refresh_turns = 4
        "#,
        )
        .unwrap();
        assert_eq!(config.agents[0].name, "engineer");
        assert_eq!(config.groups[0].mode, ConversationMode::Discussion);
        assert_eq!(config.groups[0].member_roles["reviewer"], "Lead Reviewer");

        let invalid = load_toml("[[personas]]\nid = \"a\"\n[context]\ncontext_target_tokens = 0\n")
            .unwrap_err()
            .to_string();
        assert!(invalid.contains("must be positive"));
        let below_floor = load_toml(&format!(
            "[[personas]]\nid = \"a\"\n[context]\ncontext_target_tokens = {}\nruntime_rotate_tokens = 5000\nsummary_max_tokens = 10\n",
            MIN_CONTEXT_TARGET_TOKENS - 1
        ))
        .unwrap_err()
        .to_string();
        assert!(below_floor.contains("minimum of 1000"));
        let bad_role = load_toml("[[personas]]\nid = \"a\"\n[[groups]]\nid = \"g\"\nmembers = [\"a\"]\n[groups.member_roles]\nb = \"Reviewer\"\n").unwrap_err().to_string();
        assert_eq!(
            config.groups[0]
                .reply_order
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["reviewer", "engineer"]
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
    fn load_resolves_relative_workspaces_and_tolerates_missing_ones() {
        let config = load_toml("[[agents]]\nname = \"A\"\nworkspace = \"sub/dir\"\n[[agents]]\nname = \"B\"\nworkspace = \"/abs/ws\"\n").unwrap();
        let expected = std::env::current_dir().unwrap().join("sub/dir");
        assert_eq!(std::path::Path::new(&config.agents[0].workspace), expected);
        assert_eq!(config.agents[1].workspace, "/abs/ws");
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

    #[test]
    fn example_team_loads_and_roles_restrict_tools_as_documented() {
        let config = load_toml(include_str!("../examples/team.toml")).unwrap();
        let access = |name: &str| {
            crate::access::tool_access(
                config.agents.iter().find(|a| a.name == name).unwrap(),
                &config.roles,
            )
        };
        let tools = |write, exec| Some(ToolAccess { write, exec });
        assert_eq!(config.agents.len(), 6);
        assert_eq!(
            (access("Leader"), access("Researcher"), access("Auditor")),
            (
                tools(false, false),
                tools(false, false),
                tools(false, false)
            )
        );
        assert_eq!(
            (access("Implementor"), access("Tester"), access("Writer")),
            (None, tools(false, true), tools(true, false))
        );
    }
}
