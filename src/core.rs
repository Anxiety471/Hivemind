mod registry;
pub use registry::AgentRegistry;

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, RwLock,
    },
};

use anyhow::{Context, Result};

use crate::{
    config::{ConversationMode, HivemindConfig},
    conversation::{
        AgentInvoker, ConversationCoordinator, Participant, RuntimeInvoker, TurnExecution,
        TurnReply, TurnRequest,
    },
    coordination::{
        policy::Roster, store::CoordinationStore, CoordinationService, CoordinationTools,
    },
    events::{DomainEventKind, EventBus},
    memory::MemoryService,
    runtime::RuntimePool,
    shared_workspace::{SharedWorkspaces, ToolHosts, WorkspaceTools},
};

/// Process-level owner of configuration, memory, conversations, events, and API state.
pub struct HivemindCore {
    artifacts: Arc<crate::artifacts::ArtifactLibrary>,
    execution: Arc<crate::execution::ExecutionStore>,
    config: RwLock<Arc<HivemindConfig>>,
    agents: RwLock<AgentRegistry>,
    memory: Arc<MemoryService>,
    conversation: ConversationCoordinator,
    events: EventBus,
    runtime: Arc<RuntimePool>,
    config_path: PathBuf,
    data_dir: PathBuf,
    coordination: Arc<CoordinationService>,
    access: Arc<crate::access::AccessPolicy>,
    workspaces: Arc<SharedWorkspaces>,
    skills: Arc<crate::skills::SkillCatalog>,
    setup_required: AtomicBool,
    setup_lock: std::sync::Mutex<()>,
    shutting_down: AtomicBool,
    shutdown_lock: tokio::sync::Mutex<()>,
    group_edit_lock: Arc<std::sync::Mutex<()>>,
}

pub struct CoreTurnRequest<'a> {
    pub room: &'a str,
    pub room_name: &'a str,
    pub group_id: &'a str,
    pub mode: ConversationMode,
    pub members: &'a [Participant],
    pub input: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreError {
    ShuttingDown,
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ShuttingDown => f.write_str("Hivemind core is shutting down"),
        }
    }
}

impl std::error::Error for CoreError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConversationTarget {
    Main,
    Solo { persona_id: String },
    Group { group_id: String },
    Thread { thread_id: String },
}

/// The conversation target that owns a parent room id (`main`, `solo-<id>`, `group-<id>`).
pub fn parent_target(room_id: &str) -> Option<ConversationTarget> {
    if room_id == "main" {
        Some(ConversationTarget::Main)
    } else if let Some(id) = room_id.strip_prefix("solo-") {
        Some(ConversationTarget::Solo {
            persona_id: id.into(),
        })
    } else {
        room_id
            .strip_prefix("group-")
            .map(|id| ConversationTarget::Group {
                group_id: id.into(),
            })
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedConversationTarget {
    pub room_id: String,
    pub room_name: String,
    pub group_id: String,
    pub mode: ConversationMode,
    pub participants: Vec<Participant>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetResolutionError {
    Invalid(String),
    NotFound(String),
}

impl std::fmt::Display for TargetResolutionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) | Self::NotFound(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for TargetResolutionError {}

/// `agent` moved to `workspace`; the shared handle is reused when it already is there.
fn with_workspace(
    agent: Arc<crate::config::AgentConfig>,
    workspace: &str,
) -> Arc<crate::config::AgentConfig> {
    if agent.workspace == workspace {
        return agent;
    }
    let mut moved = (*agent).clone();
    moved.workspace = workspace.to_owned();
    Arc::new(moved)
}

impl HivemindCore {
    pub fn new(config: HivemindConfig, config_path: impl AsRef<Path>) -> Result<Self> {
        let config_path = config_path.as_ref().to_owned();
        let setup_required = config.agents.is_empty() && !config_path.exists();
        let data_dir = config_path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."))
            .join(".hivemind");
        std::fs::create_dir_all(&data_dir)
            .with_context(|| format!("creating Hivemind data directory {}", data_dir.display()))?;
        let memory_path = data_dir.join("memory.sqlite3");
        let memory = Arc::new(
            MemoryService::open(&memory_path)
                .with_context(|| format!("opening memory store at {}", memory_path.display()))?,
        );
        let artifacts = Arc::new(crate::artifacts::ArtifactLibrary::open(
            data_dir.join("artifacts.sqlite3"),
            config.server.public_base_url.as_deref(),
        )?);
        let context_dir = data_dir.join("context");
        let config = Arc::new(config);
        let agents = AgentRegistry {
            agents: Arc::new(
                config
                    .ordered_agents()
                    .into_iter()
                    .map(|agent| {
                        Arc::new(crate::config::AgentConfig {
                            tool_access: crate::access::tool_access(agent, &config.roles),
                            ..agent.clone()
                        })
                    })
                    .collect(),
            ),
        };
        let events = EventBus::new();
        let conversation = ConversationCoordinator::new_with_events(
            context_dir,
            config.context.clone(),
            memory.clone(),
            Some(events.clone()),
        );
        let execution = Arc::new(crate::execution::ExecutionStore::open(
            data_dir.join("execution.sqlite3"),
            config.execution.clone(),
        )?);
        execution.protect_env(config.server.token_env.as_deref());
        let mut runtime_config = config.runtime.clone();
        runtime_config
            .private_env
            .extend(config.server.token_env.iter().cloned());
        runtime_config.harness_dir = Some(
            std::path::absolute(data_dir.join("harness"))
                .context("resolving Hivemind harness directory")?,
        );
        let runtime = Arc::new(RuntimePool::new(
            runtime_config,
            config.context.runtime_rotate_tokens,
            memory.clone(),
            events.clone(),
        ));
        let audit = Arc::new(
            crate::access::Audit::open(data_dir.join("access.sqlite3"))
                .context("opening access audit log")?,
        );
        let access = Arc::new(crate::access::AccessPolicy::from_config(
            &config,
            audit.clone(),
        ));
        conversation.set_access(access.clone());
        conversation.set_mention_limit(config.conversation.mention_limit);
        let coordination_store = if config.coordination.enabled {
            CoordinationStore::open(data_dir.join("coordination.sqlite3"))
        } else {
            CoordinationStore::in_memory()
        }
        .map_err(|error| anyhow::anyhow!("opening coordination store: {error}"))?;
        let coordination = Arc::new(CoordinationService::new(
            coordination_store,
            config.coordination.clone(),
            Roster::from_config(&config),
            events.clone(),
        ));
        {
            let execution = execution.clone();
            let memory = memory.clone();
            conversation.set_follow_up_resolver(Arc::new(move |room| {
                let limit = execution
                    .room_settings(room)
                    .ok()
                    .and_then(|s| s.follow_up_limit)
                    .or_else(|| {
                        if room.starts_with("thread-") {
                            let caller = crate::memory::Caller::trusted_user("core");
                            let thread = memory.thread(&caller, room).ok()??;
                            execution
                                .room_settings(&thread.parent_room_id)
                                .ok()
                                .and_then(|s| s.follow_up_limit)
                        } else {
                            None
                        }
                    })?;
                match limit {
                    n if n < 0 => Some(crate::conversation::FollowUpLimit::Unlimited),
                    n => Some(crate::conversation::FollowUpLimit::Limited(n as usize)),
                }
            }));
        }
        runtime.set_execution(execution.clone());
        coordination.set_execution(execution.clone());
        {
            let pool = Arc::downgrade(&runtime);
            coordination.set_steerer(Arc::new(
                move |instance: &crate::identity::AgentInstanceId, text: &str| {
                    pool.upgrade()
                        .is_some_and(|pool| pool.steer(instance, text))
                },
            ));
        }
        {
            let coord = Arc::downgrade(&coordination);
            runtime.set_hold_check(Arc::new(
                move |instance: &crate::identity::AgentInstanceId| {
                    coord
                        .upgrade()
                        .is_some_and(|c| c.has_open_question(instance))
                },
            ));
        }
        let workspaces = Arc::new(SharedWorkspaces::new(&config_path, &config));
        let group_edit_lock = workspaces.edit_lock.clone();
        let mut hosts: Vec<Arc<dyn crate::conversation::ToolHost>> = vec![Arc::new(
            WorkspaceTools::new(workspaces.clone(), access.clone()),
        )];
        let skills = Arc::new(crate::skills::SkillCatalog::new(&config.skills.dirs));
        hosts.push(Arc::new(crate::skills::SkillTools::new(skills.clone())));
        hosts.push(Arc::new(
            crate::artifacts::ArtifactTools::new(
                artifacts.clone(),
                workspaces.clone(),
                access.clone(),
            )
            .with_coordination(coordination.clone()),
        ));
        if config.coordination.enabled {
            // Registered before `CoordinationTools` so it wins the shared
            // `wakeup.schedule` name and the coordination host handles the rest.
            hosts.push(Arc::new(crate::wakeup::ChatWakeupTools::new(
                coordination.clone(),
                execution.clone(),
            )));
            hosts.push(Arc::new(CoordinationTools::new(
                coordination.clone(),
                audit.clone(),
            )));
        }
        conversation.set_tools(Arc::new(ToolHosts(hosts)));
        events.publish(DomainEventKind::CoreStarted);
        Ok(Self {
            artifacts,
            execution,
            config: RwLock::new(config),
            agents: RwLock::new(agents),
            memory,
            conversation,
            events,
            runtime,
            config_path,
            data_dir,
            coordination,
            access,
            workspaces,
            skills,
            setup_required: AtomicBool::new(setup_required),
            setup_lock: std::sync::Mutex::new(()),
            shutting_down: AtomicBool::new(false),
            shutdown_lock: tokio::sync::Mutex::new(()),
            group_edit_lock,
        })
    }

    pub fn artifacts(&self) -> &Arc<crate::artifacts::ArtifactLibrary> {
        &self.artifacts
    }

    pub fn execution(&self) -> &Arc<crate::execution::ExecutionStore> {
        &self.execution
    }

    pub async fn send_job_turn(
        &self,
        target: &ConversationTarget,
        message: &str,
        turn_id: &str,
        origin: &str,
    ) -> Result<TurnExecution> {
        anyhow::ensure!(!self.is_shutting_down(), "core is shutting down");
        let resolved = self.resolve_target(target)?;
        let invoker = Arc::new(RuntimeInvoker::new(
            self.runtime.clone(),
            &resolved.room_id,
            &resolved.group_id,
        ));
        self.conversation
            .turn_with_id(
                TurnRequest {
                    room: &resolved.room_id,
                    room_name: &resolved.room_name,
                    group_id: &resolved.group_id,
                    mode: resolved.mode,
                    members: &resolved.participants,
                    input: message,
                    invoker,
                },
                Some(turn_id),
                origin,
            )
            .await
    }

    pub fn agents(&self) -> AgentRegistry {
        let registry = self
            .agents
            .read()
            .expect("core agent registry lock poisoned")
            .clone();
        AgentRegistry {
            agents: Arc::new(
                registry
                    .list()
                    .into_iter()
                    .map(|agent| match self.workspaces.persona(&agent.name) {
                        Some(workspace) => with_workspace(agent, &workspace),
                        None => agent,
                    })
                    .collect(),
            ),
        }
    }

    /// Update only persisted group definitions; runtime and context services
    /// are intentionally not reconstructed by this operation.
    pub fn reload_groups(&self, groups: Vec<crate::config::GroupConfig>) {
        let mut config = self.config();
        config.groups = groups;
        self.workspaces.replace_groups(&config.groups);
        *self.config.write().expect("core config lock poisoned") = Arc::new(config);
    }

    /// Apply a group change: persist it to the config file, then publish it to the live core.
    /// Serialized so concurrent edits cannot lose each other's writes.
    pub fn mutate_groups(&self, command: crate::commands::GroupCommand) -> Result<()> {
        let _guard = self
            .group_edit_lock
            .lock()
            .expect("group edit lock poisoned");
        let mut config = self.config();
        crate::commands::mutate_group(&mut config, &self.config_path, command)?;
        self.reload_groups(config.groups);
        Ok(())
    }

    pub fn config(&self) -> HivemindConfig {
        let mut config = self
            .config
            .read()
            .expect("core config lock poisoned")
            .as_ref()
            .clone();
        // Workspace tools and settings share the authoritative workspace store.
        // Merge its current values before exposing or persisting a config snapshot.
        let (groups, personas) = self.workspaces.snapshot();
        for agent in &mut config.agents {
            if let Some((_, workspace)) = personas.iter().find(|(id, _)| id == &agent.name) {
                agent.workspace = workspace.clone();
            }
        }
        for group in &mut config.groups {
            if let Some((_, workspace)) = groups.iter().find(|(id, _)| id == &group.name) {
                group.workspace = workspace.clone();
            }
        }
        config.workspaces.known = self.workspaces.known();
        config
    }

    /// Add an agent: validate the resulting configuration, persist it, then expose it.
    pub fn create_agent(&self, agent: crate::config::AgentConfig) -> Result<()> {
        self.edit_agents(|config| {
            anyhow::ensure!(
                !config.agents.iter().any(|a| a.name == agent.name),
                "agent '{}' already exists",
                agent.name
            );
            config.agents.push(agent.clone());
            Ok(())
        })?;
        self.events.publish(DomainEventKind::ConfigChanged {
            scope: "agents".into(),
        });
        Ok(())
    }

    /// Replace one agent's definition (its id never changes: rooms and memory are keyed by it).
    pub fn update_agent(&self, agent: crate::config::AgentConfig) -> Result<()> {
        self.edit_agents(|config| {
            let slot = config
                .agents
                .iter_mut()
                .find(|a| a.name == agent.name)
                .with_context(|| format!("unknown agent '{}'", agent.name))?;
            *slot = agent.clone();
            Ok(())
        })?;
        self.events.publish(DomainEventKind::ConfigChanged {
            scope: "agents".into(),
        });
        Ok(())
    }

    /// Remove an agent. Refused while a group or the task planner still depends on it,
    /// and for the last remaining agent.
    pub fn delete_agent(&self, name: &str) -> Result<()> {
        self.edit_agents(|config| {
            anyhow::ensure!(
                config.agents.iter().any(|a| a.name == name),
                "unknown agent '{name}'"
            );
            anyhow::ensure!(
                config.agents.len() > 1,
                "agent '{name}' is the last agent and cannot be deleted"
            );
            let groups: Vec<&str> = config
                .groups
                .iter()
                .filter(|g| g.members.iter().any(|m| m == name))
                .map(|g| g.name.as_str())
                .collect();
            anyhow::ensure!(
                groups.is_empty(),
                "agent '{name}' is still a member of group {}; remove it from the group first",
                groups.join(", ")
            );
            anyhow::ensure!(
                config.coordination.planner.as_deref() != Some(name),
                "agent '{name}' is the coordination planner; choose another planner first"
            );
            config.agents.retain(|a| a.name != name);
            config.conversation.reply_order.retain(|a| a != name);
            Ok(())
        })?;
        self.events.publish(DomainEventKind::ConfigChanged {
            scope: "agents".into(),
        });
        Ok(())
    }

    /// Set the order agents answer in the main conversation (`[conversation] reply_order`).
    pub fn set_main_reply_order(&self, order: Vec<String>) -> Result<()> {
        let _guard = self
            .group_edit_lock
            .lock()
            .expect("config edit lock poisoned");
        let mut staged = self.config();
        let mut seen = std::collections::HashSet::new();
        for name in &order {
            anyhow::ensure!(
                staged.agents.iter().any(|a| a.name == *name),
                "unknown agent '{name}' in reply order"
            );
            anyhow::ensure!(seen.insert(name), "duplicate agent '{name}' in reply order");
        }
        staged.conversation.reply_order = order.clone();
        staged.validate()?;
        crate::shared_workspace::edit_config(&self.config_path, |document| {
            let table = document
                .entry("conversation")
                .or_insert_with(toml_edit::table)
                .as_table_mut()
                .context("[conversation] is not a table")?;
            table["reply_order"] = toml_edit::value(order.iter().collect::<toml_edit::Array>());
            Ok(())
        })?;
        self.activate_agents(staged);
        self.events.publish(DomainEventKind::ConfigChanged {
            scope: "rooms".into(),
        });
        Ok(())
    }

    /// Stop every live session of `persona` so the next prompt starts from its current definition.
    pub async fn rotate_persona(&self, persona: &str, reason: &'static str) {
        self.runtime.rotate_persona(persona, reason).await;
    }

    /// Check a workspace path the way the workspace settings do.
    pub fn validate_workspace(&self, path: &str) -> Result<String> {
        self.workspaces.check(path)
    }

    /// Stage `change` on a copy of the configuration, validate it, persist the persona
    /// list, and only then publish it to every live service. A failure at any step leaves
    /// both the file and the running server untouched.
    fn edit_agents(&self, change: impl FnOnce(&mut HivemindConfig) -> Result<()>) -> Result<()> {
        let _guard = self
            .group_edit_lock
            .lock()
            .expect("config edit lock poisoned");
        anyhow::ensure!(
            !self.setup_required(),
            "finish the first-run setup before managing agents"
        );
        let mut staged = self.config();
        let reply_order_before = staged.conversation.reply_order.clone();
        change(&mut staged)?;
        for agent in &mut staged.agents {
            agent.name = agent.name.trim().to_owned();
            anyhow::ensure!(
                !agent.name.is_empty()
                    && agent.name.len() <= 64
                    && agent
                        .name
                        .chars()
                        .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ' ')),
                "agent id must be 1-64 letters, digits, spaces, '-', '_' or '.'"
            );
            anyhow::ensure!(
                !agent.name.eq_ignore_ascii_case("main"),
                "agent id 'main' is reserved"
            );
            anyhow::ensure!(
                matches!(agent.runtime.as_str(), "pi" | "omp" | "opencode"),
                "runtime must be one of pi, omp, opencode"
            );
        }
        staged.validate()?;
        crate::shared_workspace::edit_config(&self.config_path, |document| {
            let key = if document
                .get("personas")
                .is_some_and(toml_edit::Item::is_array_of_tables)
                || !document
                    .get("agents")
                    .is_some_and(toml_edit::Item::is_array_of_tables)
            {
                "personas"
            } else {
                "agents"
            };
            #[derive(serde::Serialize)]
            struct Doc<'a> {
                personas: &'a [crate::config::AgentConfig],
            }
            let rendered = toml::to_string(&Doc {
                personas: &staged.agents,
            })?
            .parse::<toml_edit::DocumentMut>()?;
            let other = if key == "personas" {
                "agents"
            } else {
                "personas"
            };
            document.remove(other);
            document[key] = rendered["personas"].clone();
            if staged.conversation.reply_order != reply_order_before {
                let table = document
                    .entry("conversation")
                    .or_insert_with(toml_edit::table)
                    .as_table_mut()
                    .context("[conversation] is not a table")?;
                table["reply_order"] = toml_edit::value(
                    staged
                        .conversation
                        .reply_order
                        .iter()
                        .collect::<toml_edit::Array>(),
                );
            }
            Ok(())
        })?;
        self.activate_agents(staged);
        Ok(())
    }

    fn activate_agents(&self, config: HivemindConfig) {
        let registry = AgentRegistry {
            agents: Arc::new(
                config
                    .ordered_agents()
                    .into_iter()
                    .map(|agent| {
                        Arc::new(crate::config::AgentConfig {
                            tool_access: crate::access::tool_access(agent, &config.roles),
                            ..agent.clone()
                        })
                    })
                    .collect(),
            ),
        };
        self.workspaces.replace_personas(&config.agents);
        self.access.replace_from_config(&config);
        self.coordination.set_roster(Roster::from_config(&config));
        *self
            .agents
            .write()
            .expect("core agent registry lock poisoned") = registry;
        *self.config.write().expect("core config lock poisoned") = Arc::new(config);
    }

    /// Whether this server still needs its initial persona configuration.
    pub fn setup_required(&self) -> bool {
        self.setup_required.load(Ordering::Acquire)
    }

    /// Persist and activate the initial configuration submitted by the Web UI.
    /// This is deliberately one-shot: normal configuration changes remain explicit file edits.
    pub fn complete_initial_setup(&self, mut config: HivemindConfig) -> Result<()> {
        let _guard = self.setup_lock.lock().expect("setup lock poisoned");
        anyhow::ensure!(self.setup_required(), "Hivemind is already configured");
        config.validate()?;
        for persona in &mut config.agents {
            persona.workspace = crate::config::absolute_workspace(&persona.workspace);
        }

        let serialized = toml::to_string_pretty(&config).context("serializing initial config")?;
        let parent = self
            .config_path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        fs::create_dir_all(parent)
            .with_context(|| format!("creating config directory {}", parent.display()))?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&self.config_path)
            .with_context(|| format!("creating config {}", self.config_path.display()))?;
        if let Err(error) = file
            .write_all(serialized.as_bytes())
            .and_then(|()| file.sync_all())
        {
            drop(file);
            let _ = fs::remove_file(&self.config_path);
            return Err(error)
                .with_context(|| format!("writing config {}", self.config_path.display()));
        }

        let registry = AgentRegistry {
            agents: Arc::new(
                config
                    .ordered_agents()
                    .into_iter()
                    .map(|agent| {
                        Arc::new(crate::config::AgentConfig {
                            tool_access: crate::access::tool_access(agent, &config.roles),
                            ..agent.clone()
                        })
                    })
                    .collect(),
            ),
        };
        self.workspaces.replace_personas(&config.agents);
        self.access.replace_from_config(&config);
        *self
            .agents
            .write()
            .expect("core agent registry lock poisoned") = registry;
        *self.config.write().expect("core config lock poisoned") = Arc::new(config);
        self.setup_required.store(false, Ordering::Release);
        Ok(())
    }
    pub fn events(&self) -> &EventBus {
        &self.events
    }
    pub fn coordination(&self) -> &Arc<CoordinationService> {
        &self.coordination
    }
    pub fn access(&self) -> &Arc<crate::access::AccessPolicy> {
        &self.access
    }
    pub fn skills(&self) -> &Arc<crate::skills::SkillCatalog> {
        &self.skills
    }
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }
    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::Acquire)
    }
    /// Invoker that routes a room's turns to the core-owned runtime pool.
    pub fn runtime_invoker(&self, room: &str, group_id: &str) -> Arc<dyn AgentInvoker> {
        Arc::new(RuntimeInvoker::new(self.runtime.clone(), room, group_id))
    }
    /// Stop one instance's live session so its next prompt hydrates fresh.
    pub async fn rotate_instance(
        &self,
        instance: &crate::identity::AgentInstanceId,
        reason: &'static str,
    ) {
        self.runtime.rotate_instance(instance, reason).await;
    }
    /// Steer a message into any actively replying agents in a room.
    pub fn steer_room(&self, room_id: &str, text: &str) -> Vec<String> {
        let active = self.events.active_replies(room_id);
        let mut delivered = Vec::new();
        for persona in active {
            let instance = crate::identity::AgentInstanceId::new(room_id, &persona);
            if self.runtime.steer(&instance, text) {
                delivered.push(persona);
            }
        }
        delivered
    }
    pub fn memory(&self) -> &Arc<MemoryService> {
        &self.memory
    }
    pub fn conversation(&self) -> &ConversationCoordinator {
        &self.conversation
    }
    pub fn shared_workspaces(&self) -> &Arc<SharedWorkspaces> {
        &self.workspaces
    }
    pub fn config_path(&self) -> &Path {
        &self.config_path
    }

    pub fn resolve_target(
        &self,
        target: &ConversationTarget,
    ) -> std::result::Result<ResolvedConversationTarget, TargetResolutionError> {
        if let ConversationTarget::Thread { thread_id } = target {
            return self.resolve_thread(thread_id);
        }
        let registry = self.agents();
        let config = self.config.read().expect("core config lock poisoned");
        let config = config.as_ref();
        Ok(match target {
            ConversationTarget::Main => ResolvedConversationTarget {
                room_id: "main".into(),
                room_name: "Main conversation".into(),
                group_id: String::new(),
                mode: ConversationMode::Broadcast,
                participants: registry
                    .list()
                    .into_iter()
                    .map(|agent| Participant {
                        agent: self.own_workspace(agent),
                        role: None,
                    })
                    .collect(),
            },
            ConversationTarget::Solo { persona_id } => {
                if persona_id.trim().is_empty() {
                    return Err(TargetResolutionError::Invalid(
                        "persona id must not be empty".into(),
                    ));
                }
                let agent = registry.get(persona_id).ok_or_else(|| {
                    TargetResolutionError::NotFound(format!("unknown persona '{persona_id}'"))
                })?;
                let agent = self.own_workspace(agent);
                ResolvedConversationTarget {
                    room_id: format!("solo-{persona_id}"),
                    room_name: format!("Solo: {persona_id}"),
                    group_id: String::new(),
                    mode: ConversationMode::Discussion,
                    participants: vec![Participant { agent, role: None }],
                }
            }
            ConversationTarget::Thread { .. } => unreachable!("handled above"),
            ConversationTarget::Group { group_id } => {
                if group_id.trim().is_empty() {
                    return Err(TargetResolutionError::Invalid(
                        "group id must not be empty".into(),
                    ));
                }
                let group = config
                    .groups
                    .iter()
                    .find(|group| group.name == *group_id)
                    .ok_or_else(|| {
                        TargetResolutionError::NotFound(format!("unknown group '{group_id}'"))
                    })?;
                if group.members.is_empty() {
                    return Err(TargetResolutionError::Invalid(format!(
                        "group '{group_id}' has no members"
                    )));
                }
                let members = config.ordered_group_members(group);
                let shared = self.workspaces.group(&group.name);
                ResolvedConversationTarget {
                    room_id: format!("group-{group_id}"),
                    room_name: group.name.clone(),
                    group_id: group.name.clone(),
                    mode: group.mode,
                    participants: members
                        .into_iter()
                        .filter_map(|agent| {
                            let agent = registry.get(&agent.name)?;
                            // A shared workspace wins; otherwise the persona's own (agent-changeable) one.
                            let agent = match &shared {
                                Some(workspace) => with_workspace(agent, workspace),
                                None => self.own_workspace(agent),
                            };
                            Some(Participant {
                                role: group.member_roles.get(&agent.name).cloned(),
                                agent,
                            })
                        })
                        .collect(),
                }
            }
        })
    }

    /// A thread runs with its parent room's participants, mode and group, in its own room.
    fn resolve_thread(
        &self,
        thread_id: &str,
    ) -> std::result::Result<ResolvedConversationTarget, TargetResolutionError> {
        if thread_id.trim().is_empty() {
            return Err(TargetResolutionError::Invalid(
                "thread id must not be empty".into(),
            ));
        }
        let caller = crate::memory::Caller::trusted_user("core");
        let thread = self
            .memory()
            .thread(&caller, thread_id)
            .map_err(|_| TargetResolutionError::NotFound(format!("unknown thread '{thread_id}'")))?
            .ok_or_else(|| {
                TargetResolutionError::NotFound(format!("unknown thread '{thread_id}'"))
            })?;
        let parent = parent_target(&thread.parent_room_id).ok_or_else(|| {
            TargetResolutionError::NotFound(format!("parent room of '{thread_id}' is gone"))
        })?;
        let mut resolved = self.resolve_target(&parent)?;
        resolved.room_id = thread.id;
        resolved.room_name = thread.name;
        Ok(resolved)
    }

    /// The persona with its current own workspace, which an agent may have changed at runtime.
    fn own_workspace(
        &self,
        agent: Arc<crate::config::AgentConfig>,
    ) -> Arc<crate::config::AgentConfig> {
        match self.workspaces.persona(&agent.name) {
            Some(workspace) => with_workspace(agent, &workspace),
            None => agent,
        }
    }

    pub async fn send_turn(
        &self,
        target: &ConversationTarget,
        message: &str,
    ) -> anyhow::Result<TurnExecution> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(CoreError::ShuttingDown.into());
        }
        if message.trim().is_empty() {
            anyhow::bail!("empty message");
        }
        let resolved = self.resolve_target(target)?;
        let invoker = Arc::new(RuntimeInvoker::new(
            self.runtime.clone(),
            &resolved.room_id,
            &resolved.group_id,
        ));
        self.send_resolved_turn(&resolved, message, invoker).await
    }

    pub async fn send_resolved_turn(
        &self,
        target: &ResolvedConversationTarget,
        message: &str,
        invoker: Arc<dyn AgentInvoker>,
    ) -> anyhow::Result<TurnExecution> {
        anyhow::ensure!(!message.trim().is_empty(), "empty message");
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(CoreError::ShuttingDown.into());
        }
        self.conversation
            .turn_with_outcome(TurnRequest {
                room: &target.room_id,
                room_name: &target.room_name,
                group_id: &target.group_id,
                mode: target.mode,
                members: &target.participants,
                input: message,
                invoker,
            })
            .await
    }
    pub async fn turn(&self, request: CoreTurnRequest<'_>) -> Result<Vec<TurnReply>> {
        let invoker = Arc::new(RuntimeInvoker::new(
            self.runtime.clone(),
            request.room,
            request.group_id,
        ));
        self.turn_with_invoker(request, invoker).await
    }

    pub async fn turn_with_invoker(
        &self,
        request: CoreTurnRequest<'_>,
        invoker: Arc<dyn AgentInvoker>,
    ) -> Result<Vec<TurnReply>> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(CoreError::ShuttingDown.into());
        }
        self.conversation
            .turn(TurnRequest {
                room: request.room,
                room_name: request.room_name,
                group_id: request.group_id,
                mode: request.mode,
                members: request.members,
                input: request.input,
                invoker,
            })
            .await
    }

    /// Idempotently stop the core and every live agent-instance runtime.
    pub async fn shutdown(&self) {
        let _guard = self.shutdown_lock.lock().await;
        if self.shutting_down.swap(true, Ordering::AcqRel) {
            return;
        }
        self.events.publish(DomainEventKind::CoreShuttingDown);
        self.runtime.shutdown().await;
    }
}

#[cfg(test)]
mod tests {
    use crate::identity::AgentInstanceId;
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
    };

    use super::*;

    static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "hivemind-core-turn-{}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Fake pi that logs lifecycle lines to `lifecycle.log`, raw prompt
    /// requests to `prompts.log`, reports `stats-tokens` (default 0) as its
    /// context usage, exits on a `crash-now` prompt, and — while `tool-mode`
    /// exists — answers with a memory tool call until it sees a tool result.
    fn fake_core(directory: &TestDirectory) -> (HivemindCore, PathBuf, PathBuf) {
        fake_core_with_timeouts(directory, 300, 120)
    }
    fn fake_core_with_prompt_timeout(
        directory: &TestDirectory,
        prompt_timeout_secs: u64,
    ) -> (HivemindCore, PathBuf, PathBuf) {
        fake_core_with_timeouts(directory, prompt_timeout_secs, 0)
    }
    fn fake_core_with_timeouts(
        directory: &TestDirectory,
        prompt_timeout_secs: u64,
        idle_timeout_secs: u64,
    ) -> (HivemindCore, PathBuf, PathBuf) {
        fake_core_configured(directory, prompt_timeout_secs, idle_timeout_secs, |_| {})
    }
    fn fake_core_configured(
        directory: &TestDirectory,
        prompt_timeout_secs: u64,
        idle_timeout_secs: u64,
        configure: impl FnOnce(&mut HivemindConfig),
    ) -> (HivemindCore, PathBuf, PathBuf) {
        let binary = directory.0.join("fake-pi");
        let lifecycle = directory.0.join("lifecycle.log");
        let prompts = directory.0.join("prompts.log");
        let script = r#"#!/bin/sh
case "$*" in
  *"You are the Engineer"*) agent=Engineer ;;
  *) agent=Unknown ;;
esac
case "$*" in *bad/model*) bad=1 ;; esac
printf '%s\n' "$$" > __DIR__/runtime.pid
printf '%s started\n' "$agent" >> __DIR__/lifecycle.log
while IFS= read -r request; do
  case "$request" in
    *'"type":"new_session"'*)
      printf '%s\n' '{"type":"response","command":"new_session","success":true}'
      ;;
    *'"type":"get_session_stats"'*)
      tokens=$(cat __DIR__/stats-tokens 2>/dev/null || echo 0)
      printf '{"type":"response","command":"get_session_stats","success":true,"data":{"contextUsage":{"tokens":%s,"contextWindow":1000000,"percent":0}}}\n' "$tokens"
      ;;
    *'"type":"prompt"'*)
      printf '%s prompt\n' "$agent" >> __DIR__/lifecycle.log
      printf '%s\n' "$request" >> __DIR__/prompts.log
      if [ -n "$bad" ]; then exit 3; fi
      case "$request" in
        *'Current user message:\ncrash-now'*) exit 3 ;;
        *'Current user message:\ncrash-once'*) if [ ! -e __DIR__/crashed ]; then : > __DIR__/crashed; exit 3; fi ;;
        *'Current user message:\nhang-now'*) while IFS= read -r ignored; do :; done ;;
      esac
      if [ -e __DIR__/tool-mode ] && ! printf '%s' "$request" | grep -q 'Memory tool result:'; then
        printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"```hivemind-tool\n{\"name\":\"memory.private.add\",\"args\":{\"content\":\"session note\"}}\n```"}]}}'
      else
        printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Engineer reply"}]}}'
      fi
      printf '%s\n' '{"type":"agent_settled"}'
      ;;
  esac
done
if [ -e __DIR__/linger ]; then exec sleep 60; fi
printf '%s stopped\n' "$agent" >> __DIR__/lifecycle.log
"#
        .replace("__DIR__", &format!("'{}'", directory.0.display()));
        fs::write(&binary, script).unwrap();
        let mut permissions = fs::metadata(&binary).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&binary, permissions).unwrap();

        let mut config = HivemindConfig::default_poc();
        config.agents.retain(|agent| agent.name == "Engineer");
        config.runtime.pi_binary = binary.display().to_string();
        config.runtime.prompt_timeout_secs = prompt_timeout_secs;
        config.runtime.idle_timeout_secs = idle_timeout_secs;
        config.agents[0].workspace = directory.0.display().to_string();
        configure(&mut config);
        let core = HivemindCore::new(config, directory.0.join("hivemind.toml")).unwrap();
        (core, lifecycle, prompts)
    }

    /// The `message` of every prompt request the fake runtime received.
    fn prompt_messages(path: &Path) -> Vec<String> {
        lines(path)
            .iter()
            .map(|line| {
                let request: serde_json::Value = serde_json::from_str(line).unwrap();
                request["message"].as_str().unwrap().to_owned()
            })
            .collect()
    }

    fn engineer_caller(room: &str) -> crate::memory::Caller {
        crate::memory::Caller::agent(
            room,
            "",
            AgentInstanceId::new(room, "Engineer"),
            "Engineer",
            "Engineer",
        )
    }

    async fn solo_turn(core: &HivemindCore, room: &str, input: &str) -> Result<Vec<TurnReply>> {
        let members = [Participant {
            agent: core.agents().list()[0].clone(),
            role: None,
        }];
        core.turn(CoreTurnRequest {
            room,
            room_name: room,
            group_id: "",
            mode: ConversationMode::Broadcast,
            members: &members,
            input,
        })
        .await
    }

    fn lines(path: &Path) -> Vec<String> {
        fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    #[tokio::test]
    async fn sessions_persist_per_room_instance_and_shutdown_stops_them_idempotently() {
        let directory = TestDirectory::new();
        let (core, lifecycle, _prompts) = fake_core(&directory);
        let mut events = core.events().subscribe();
        assert!(!lifecycle.exists(), "construction must not spawn a runtime");

        for (room, input) in [
            ("room-one", "first"),
            ("room-one", "second"),
            ("room-two", "third"),
        ] {
            let replies = solo_turn(&core, room, input).await.unwrap();
            assert_eq!(replies.len(), 1);
            assert_eq!(replies[0].result.as_ref().unwrap(), "Engineer reply");
        }
        assert_eq!(
            lines(&lifecycle),
            [
                "Engineer started",
                "Engineer prompt",
                "Engineer prompt",
                "Engineer started",
                "Engineer prompt"
            ]
        );

        core.shutdown().await;
        core.shutdown().await;
        let after = lines(&lifecycle);
        assert_eq!(after.len(), 7);
        assert_eq!(after[5..], ["Engineer stopped", "Engineer stopped"]);

        let mut started = 0;
        let mut stopped = 0;
        let mut shutting_down = 0;
        while let Ok(event) = events.try_recv() {
            match event.payload.clone() {
                DomainEventKind::RuntimeStarted { agent_id, .. } => {
                    assert_eq!(agent_id, "Engineer");
                    started += 1;
                }
                DomainEventKind::RuntimeStopped { agent_id, .. } => {
                    assert_eq!(agent_id, "Engineer");
                    stopped += 1;
                }
                DomainEventKind::CoreShuttingDown => shutting_down += 1,
                _ => {}
            }
        }
        assert_eq!((started, stopped, shutting_down), (2, 2, 1));

        let error = solo_turn(&core, "room-three", "late").await.unwrap_err();
        assert!(error.to_string().contains("shutting down"), "{error:#}");
        assert_eq!(
            lines(&lifecycle).len(),
            7,
            "no runtime started after shutdown"
        );
    }

    #[tokio::test]
    async fn later_turns_send_only_the_room_delta() {
        let directory = TestDirectory::new();
        let (core, _lifecycle, prompts) = fake_core(&directory);
        solo_turn(&core, "delta-room", "first").await.unwrap();
        solo_turn(&core, "delta-room", "second").await.unwrap();
        core.shutdown().await;

        let messages = prompt_messages(&prompts);
        assert_eq!(messages.len(), 2);
        assert!(messages[0].contains("Participants:"), "{}", messages[0]);
        assert!(
            messages[1].contains("Current user message:\nsecond"),
            "{}",
            messages[1]
        );
        assert!(!messages[1].contains("Participants:"), "{}", messages[1]);
        assert!(!messages[1].contains("first"), "{}", messages[1]);
    }

    #[tokio::test]
    async fn rotation_rehydrates_a_fresh_runtime_at_the_turn_boundary() {
        let directory = TestDirectory::new();
        let (core, lifecycle, prompts) = fake_core(&directory);
        let mut events = core.events().subscribe();
        solo_turn(&core, "rotate-room", "first").await.unwrap();
        fs::write(directory.0.join("stats-tokens"), "999999").unwrap();
        solo_turn(&core, "rotate-room", "second").await.unwrap();
        assert_eq!(
            lines(&lifecycle),
            [
                "Engineer started",
                "Engineer prompt",
                "Engineer stopped",
                "Engineer started",
                "Engineer prompt"
            ]
        );
        let messages = prompt_messages(&prompts);
        assert!(
            messages[1].contains("Participants:"),
            "rotation must rehydrate a full pack"
        );
        assert!(
            messages[1].contains("first"),
            "the full pack carries earlier room history"
        );

        let mut rotated = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let DomainEventKind::RuntimeRotated {
                agent_instance_id,
                reason,
                ..
            } = event.payload.clone()
            {
                rotated.push((agent_instance_id, reason));
            }
        }
        assert_eq!(
            rotated,
            [(
                AgentInstanceId::new("rotate-room", "Engineer"),
                "context_budget".to_owned(),
            )]
        );

        let epochs = core
            .memory()
            .runtime_epochs(&engineer_caller("rotate-room"), 10)
            .unwrap();
        assert_eq!(epochs.len(), 2);
        assert_eq!(
            epochs
                .iter()
                .filter(|epoch| epoch.ended_at.is_none())
                .count(),
            1
        );
        let rotated_epoch = epochs.iter().find(|epoch| epoch.ended_at.is_some());
        assert_eq!(
            rotated_epoch.and_then(|epoch| epoch.end_reason.as_deref()),
            Some("context_budget")
        );
        assert!(crate::runtime::is_rotation("context_budget"));
        assert!(!crate::runtime::is_rotation("idle_timeout"));
        core.shutdown().await;
    }

    #[tokio::test]
    async fn failed_runtime_is_discarded_and_next_turn_rehydrates() {
        let directory = TestDirectory::new();
        let (core, lifecycle, prompts) = fake_core_with_prompt_timeout(&directory, 300);
        let mut events = core.events().subscribe();
        let replies = solo_turn(&core, "crash-room", "crash-now").await.unwrap();
        assert!(replies[0].result.is_err());
        assert_eq!(
            core.runtime.slot_count(),
            0,
            "runtime failure evicts its empty slot when idle reaping is disabled"
        );
        let replies = solo_turn(&core, "crash-room", "after the crash")
            .await
            .unwrap();
        assert_eq!(replies[0].result.as_deref(), Ok("Engineer reply"));
        core.shutdown().await;

        assert_eq!(
            lines(&lifecycle)
                .iter()
                .filter(|line| *line == "Engineer started")
                .count(),
            3
        );
        let messages = prompt_messages(&prompts);
        assert_eq!(messages.len(), 3);
        assert!(messages[2].contains("Participants:"), "{}", messages[2]);
        let mut failure_codes = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let DomainEventKind::RuntimeFailed { error_code, .. } = event.payload.clone() {
                failure_codes.push(error_code);
            }
        }
        assert_eq!(
            failure_codes,
            ["runtime_failure", "runtime_failure"],
            "the crashing turn is retried once on a fresh session"
        );
    }

    #[tokio::test]
    async fn a_single_crash_is_retried_on_a_fresh_session() {
        let directory = TestDirectory::new();
        let (core, lifecycle, prompts) = fake_core_with_prompt_timeout(&directory, 300);
        let replies = solo_turn(&core, "retry-room", "crash-once").await.unwrap();
        assert_eq!(replies[0].result.as_deref(), Ok("Engineer reply"));
        core.shutdown().await;
        assert_eq!(prompt_messages(&prompts).len(), 2);
        assert_eq!(
            lines(&lifecycle)
                .iter()
                .filter(|line| *line == "Engineer started")
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn a_failing_model_falls_back_to_the_next_configured_model() {
        let directory = TestDirectory::new();
        let (core, _lifecycle, prompts) = fake_core_configured(&directory, 300, 0, |config| {
            config.runtime.prompt_retries = 0;
            config.agents[0].model = Some("bad/model".into());
            config.agents[0].fallback_models = vec!["bad/model".into(), "good/model".into()];
        });
        let replies = solo_turn(&core, "fallback-room", "hello").await.unwrap();
        assert_eq!(replies[0].result.as_deref(), Ok("Engineer reply"));
        core.shutdown().await;
        assert_eq!(
            prompt_messages(&prompts).len(),
            3,
            "primary and first fallback fail, second fallback answers"
        );
    }

    #[tokio::test]
    async fn exhausted_models_report_the_last_failure() {
        let directory = TestDirectory::new();
        let (core, _lifecycle, prompts) = fake_core_configured(&directory, 300, 0, |config| {
            config.runtime.prompt_retries = 1;
            config.agents[0].model = Some("bad/model".into());
            config.agents[0].fallback_models = vec!["bad/model".into()];
        });
        let replies = solo_turn(&core, "exhausted-room", "hello").await.unwrap();
        assert!(replies[0].result.is_err());
        core.shutdown().await;
        assert_eq!(prompt_messages(&prompts).len(), 3);
    }

    #[tokio::test]
    async fn prompt_timeout_discards_epoch_without_retry_and_rehydrates_next_turn() {
        let directory = TestDirectory::new();
        let (core, lifecycle, prompts) = fake_core_with_prompt_timeout(&directory, 1);
        let mut events = core.events().subscribe();

        let replies = solo_turn(&core, "timeout-room", "hang-now").await.unwrap();
        assert!(replies[0]
            .result
            .as_ref()
            .unwrap_err()
            .contains("timed out"));
        assert_eq!(
            prompt_messages(&prompts).len(),
            1,
            "the uncertain turn is not retried"
        );
        assert_eq!(
            core.runtime.slot_count(),
            0,
            "prompt timeout evicts its empty slot when idle reaping is disabled"
        );
        assert_eq!(
            lines(&lifecycle),
            ["Engineer started", "Engineer prompt", "Engineer stopped"]
        );
        let epochs = core
            .memory()
            .runtime_epochs(&engineer_caller("timeout-room"), 10)
            .unwrap();
        assert_eq!(epochs.len(), 1);
        assert!(epochs[0].ended_at.is_some());
        assert_eq!(epochs[0].end_reason.as_deref(), Some("prompt_timeout"));

        let mut failed = Vec::new();
        let mut stopped = Vec::new();
        while let Ok(event) = events.try_recv() {
            match event.payload.clone() {
                DomainEventKind::RuntimeFailed { error_code, .. } => failed.push(error_code),
                DomainEventKind::RuntimeStopped { reason, .. } => stopped.push(reason),
                _ => {}
            }
        }
        assert_eq!(failed, ["prompt_timeout"]);
        assert_eq!(stopped, ["prompt_timeout"]);

        let replies = solo_turn(&core, "timeout-room", "after timeout")
            .await
            .unwrap();
        assert_eq!(replies[0].result.as_deref(), Ok("Engineer reply"));
        assert_eq!(
            lines(&lifecycle)
                .iter()
                .filter(|line| *line == "Engineer started")
                .count(),
            2,
            "the next turn starts a fresh runtime"
        );
        assert_eq!(prompt_messages(&prompts).len(), 2);
        core.shutdown().await;
    }

    #[tokio::test]
    async fn core_shutdown_cancels_a_hanging_prompt_and_waits_for_concurrent_callers() {
        let directory = TestDirectory::new();
        let (core, lifecycle, prompts) = fake_core_with_prompt_timeout(&directory, 0);
        let mut events = core.events().subscribe();
        let core = std::sync::Arc::new(core);
        let turning_core = core.clone();
        let turn =
            tokio::spawn(
                async move { solo_turn(&turning_core, "shutdown-room", "hang-now").await },
            );
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while prompt_messages(&prompts).is_empty() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("fake runtime received the hanging prompt");

        let first = core.clone();
        let second = core.clone();
        tokio::time::timeout(std::time::Duration::from_secs(5), async move {
            tokio::join!(first.shutdown(), second.shutdown());
        })
        .await
        .expect("shutdown cancels the prompt and completes within its bound");
        let replies = turn.await.unwrap().unwrap();
        assert!(replies[0].result.is_err());
        assert_eq!(prompt_messages(&prompts).len(), 1);
        assert_eq!(
            lines(&lifecycle),
            ["Engineer started", "Engineer prompt", "Engineer stopped"]
        );
        let epochs = core
            .memory()
            .runtime_epochs(&engineer_caller("shutdown-room"), 10)
            .unwrap();
        assert_eq!(epochs.len(), 1);
        assert!(epochs[0].ended_at.is_some());

        let mut shutdown_reasons = Vec::new();
        let mut shutdown_events = 0;
        while let Ok(event) = events.try_recv() {
            match event.payload.clone() {
                DomainEventKind::RuntimeStopped { reason, .. } => shutdown_reasons.push(reason),
                DomainEventKind::CoreShuttingDown => shutdown_events += 1,
                _ => {}
            }
        }
        assert_eq!(shutdown_reasons, ["core_shutdown"]);
        assert_eq!(shutdown_events, 1);
    }
    #[tokio::test]
    async fn shutdown_cancels_omp_startup_without_opening_an_epoch() {
        let directory = TestDirectory::new();
        let binary = directory.0.join("hanging-omp");
        let script = r#"#!/bin/sh
printf '%s\n' "$$" > __DIR__/child.pid
printf started > __DIR__/started
while IFS= read -r request; do :; done
"#
        .replace("__DIR__", &format!("'{}'", directory.0.display()));
        fs::write(&binary, script).unwrap();
        let mut permissions = fs::metadata(&binary).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&binary, permissions).unwrap();

        let mut config = HivemindConfig::default_poc();
        config.agents.retain(|agent| agent.name == "Engineer");
        config.agents[0].runtime = "omp".into();
        config.agents[0].workspace = directory.0.display().to_string();
        config.runtime.omp_binary = binary.display().to_string();
        config.runtime.prompt_timeout_secs = 0;
        let core = std::sync::Arc::new(
            HivemindCore::new(config, directory.0.join("hivemind.toml")).unwrap(),
        );
        let mut events = core.events().subscribe();
        let turning_core = core.clone();
        let turn =
            tokio::spawn(async move { solo_turn(&turning_core, "startup-room", "hello").await });
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !directory.0.join("started").exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("OMP child entered startup without announcing ready");

        let shutting_core = core.clone();
        tokio::time::timeout(std::time::Duration::from_secs(5), shutting_core.shutdown())
            .await
            .expect("shutdown cancels startup and reaps the child");
        assert!(turn.await.unwrap().unwrap()[0].result.is_err());
        assert!(core
            .memory()
            .runtime_epochs(&engineer_caller("startup-room"), 10)
            .unwrap()
            .is_empty());
        while let Ok(event) = events.try_recv() {
            assert!(!matches!(
                event.payload,
                DomainEventKind::RuntimeStarted { .. }
            ));
        }

        let pid = fs::read_to_string(directory.0.join("child.pid"))
            .unwrap()
            .trim()
            .to_owned();
        let command_line = PathBuf::from(format!("/proc/{pid}/cmdline"));
        if Path::new("/proc/self").exists() {
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                loop {
                    let command = fs::read(&command_line).unwrap_or_default();
                    if !String::from_utf8_lossy(&command)
                        .contains(binary.to_string_lossy().as_ref())
                    {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("canceled OMP startup process is no longer running");
        }
    }
    #[tokio::test]
    async fn core_shutdown_kills_a_child_that_ignores_stdin_close_within_the_bound() {
        let directory = TestDirectory::new();
        let (core, _lifecycle, _prompts) = fake_core(&directory);
        fs::write(directory.0.join("linger"), "").unwrap();
        solo_turn(&core, "kill-room", "first").await.unwrap();
        let pid = fs::read_to_string(directory.0.join("runtime.pid"))
            .unwrap()
            .trim()
            .to_owned();
        let command_line = PathBuf::from(format!("/proc/{pid}/cmdline"));

        let started = std::time::Instant::now();
        tokio::time::timeout(std::time::Duration::from_secs(4), core.shutdown())
            .await
            .expect("child shutdown kill fallback is bounded");
        assert!(started.elapsed() >= std::time::Duration::from_secs(1));
        let epochs = core
            .memory()
            .runtime_epochs(&engineer_caller("kill-room"), 10)
            .unwrap();
        assert_eq!(epochs.len(), 1);
        assert!(epochs[0].ended_at.is_some());

        if Path::new("/proc/self").exists() {
            let command = fs::read(&command_line).unwrap_or_default();
            assert!(!String::from_utf8_lossy(&command).contains("sleep 60"));
        }
    }
    #[tokio::test]
    async fn idle_sessions_close_and_the_next_turn_rehydrates() {
        let directory = TestDirectory::new();
        let (core, lifecycle, prompts) = fake_core(&directory);
        solo_turn(&core, "idle-room", "first").await.unwrap();
        core.runtime.close_idle(std::time::Duration::ZERO).await;
        assert_eq!(
            lines(&lifecycle),
            ["Engineer started", "Engineer prompt", "Engineer stopped"]
        );
        let epochs = core
            .memory()
            .runtime_epochs(&engineer_caller("idle-room"), 10)
            .unwrap();
        assert!(epochs.iter().all(|epoch| epoch.ended_at.is_some()));

        solo_turn(&core, "idle-room", "second").await.unwrap();
        assert_eq!(lines(&lifecycle)[3], "Engineer started");
        assert!(prompt_messages(&prompts)[1].contains("Participants:"));
        core.shutdown().await;
    }

    #[tokio::test]
    async fn tool_followups_continue_the_live_session_with_only_the_result() {
        let directory = TestDirectory::new();
        let (core, lifecycle, prompts) = fake_core(&directory);
        fs::write(directory.0.join("tool-mode"), "").unwrap();
        let replies = solo_turn(&core, "tool-room", "save a note").await.unwrap();
        assert_eq!(replies[0].result.as_deref(), Ok("Engineer reply"));
        core.shutdown().await;

        assert_eq!(
            lines(&lifecycle)
                .iter()
                .filter(|line| *line == "Engineer started")
                .count(),
            1
        );
        let messages = prompt_messages(&prompts);
        assert_eq!(messages.len(), 2);
        assert!(
            messages[1].starts_with("Memory tool result:"),
            "{}",
            messages[1]
        );
        assert!(!messages[1].contains("Participants:"), "{}", messages[1]);
    }

    #[tokio::test]
    async fn turn_events_are_ordered_and_attributed() {
        let directory = TestDirectory::new();
        let (core, _lifecycle, _prompts) = fake_core(&directory);
        let mut events = core.events().subscribe();
        solo_turn(&core, "room-events", "hello").await.unwrap();
        core.shutdown().await;

        let mut turn_ids = Vec::new();
        let mut kinds = Vec::new();
        let mut last_sequence = 0;
        while let Ok(event) = events.try_recv() {
            assert!(event.sequence > last_sequence, "sequence must increase");
            last_sequence = event.sequence;
            let (kind, room_id, turn_id) = match event.payload.clone() {
                DomainEventKind::TurnStarted { room_id, turn_id } => {
                    ("turn_started", room_id, turn_id)
                }
                DomainEventKind::AgentReplyStarted {
                    room_id,
                    turn_id,
                    agent_id,
                    ..
                } => {
                    assert_eq!(agent_id, "Engineer");
                    ("reply_started", room_id, turn_id)
                }
                DomainEventKind::AgentReplyCompleted {
                    room_id,
                    turn_id,
                    agent_id,
                    ..
                } => {
                    assert_eq!(agent_id, "Engineer");
                    ("reply_completed", room_id, turn_id)
                }
                DomainEventKind::TurnCompleted {
                    room_id,
                    turn_id,
                    reply_count,
                } => {
                    assert_eq!(reply_count, 1);
                    ("turn_completed", room_id, turn_id)
                }
                _ => continue,
            };
            assert_eq!(room_id, "room-events");
            turn_ids.push(turn_id);
            kinds.push(kind);
        }
        assert_eq!(
            kinds,
            [
                "turn_started",
                "reply_started",
                "reply_completed",
                "turn_completed"
            ]
        );
        assert!(turn_ids
            .iter()
            .all(|id| id == &turn_ids[0] && !id.is_empty()));
    }

    #[tokio::test]
    async fn one_open_epoch_per_live_session_closed_at_shutdown() {
        let directory = TestDirectory::new();
        let (core, _lifecycle, _prompts) = fake_core(&directory);
        solo_turn(&core, "epoch-room", "first").await.unwrap();
        solo_turn(&core, "epoch-room", "second").await.unwrap();

        let caller = engineer_caller("epoch-room");
        let epochs = core.memory().runtime_epochs(&caller, 10).unwrap();
        assert_eq!(epochs.len(), 1, "one epoch per live session");
        let epoch = &epochs[0];
        assert_eq!(epoch.runtime, "pi");
        assert_eq!(
            epoch.agent_instance_id,
            AgentInstanceId::new("epoch-room", "Engineer")
        );
        assert_eq!(epoch.room_id, "epoch-room");
        assert_eq!(
            epoch.metadata.get("kind").and_then(|v| v.as_str()),
            Some("session")
        );
        assert!(epoch.ended_at.is_none());

        core.shutdown().await;
        let epochs = core.memory().runtime_epochs(&caller, 10).unwrap();
        assert!(epochs[0]
            .ended_at
            .is_some_and(|ended| ended >= epochs[0].started_at));
        assert!(core
            .memory()
            .runtime_epochs(&engineer_caller("other-room"), 10)
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn broadcast_records_runtime_startup_failure_and_keeps_successful_peer() {
        let directory = TestDirectory::new();
        let (working, _lifecycle, _prompts) = fake_core(&directory);
        let mut config = working.config().clone();
        config.runtime.idle_timeout_secs = 0;
        working.shutdown().await;
        let mut broken = config.agents[0].clone();
        broken.name = "Broken".into();
        broken.workspace = directory.0.join("missing-workspace").display().to_string();
        config.agents.insert(0, broken);
        let core = HivemindCore::new(config, directory.0.join("hivemind.toml")).unwrap();
        let members = core
            .agents()
            .list()
            .into_iter()
            .map(|agent| Participant { agent, role: None })
            .collect::<Vec<_>>();
        let replies = core
            .turn(CoreTurnRequest {
                room: "startup-room",
                room_name: "Startup room",
                group_id: "",
                mode: ConversationMode::Broadcast,
                members: &members,
                input: "record the startup error",
            })
            .await
            .unwrap();
        assert_eq!(
            core.runtime.slot_count(),
            1,
            "startup failure evicts only its vacant slot when idle reaping is disabled"
        );
        core.shutdown().await;

        let by_name = |name: &str| replies.iter().find(|reply| reply.name == name).unwrap();
        assert!(by_name("Broken").result.is_err());
        assert_eq!(by_name("Engineer").result.as_deref(), Ok("Engineer reply"));
        let history = core.conversation().room_history("startup-room").unwrap();
        let failed = history
            .events
            .iter()
            .find(|event| event.speaker == "Broken")
            .unwrap();
        assert!(failed.error);
        let succeeded = history
            .events
            .iter()
            .find(|event| event.speaker == "Engineer")
            .unwrap();
        assert!(!succeeded.error);
        assert_eq!(succeeded.content, "Engineer reply");
    }

    #[tokio::test]
    async fn construction_is_provider_free_and_registry_uses_effective_order() {
        let directory = TestDirectory::new();
        let mut config = HivemindConfig::default_poc();
        config.conversation.reply_order = vec!["Reviewer".into(), "Engineer".into()];
        config.runtime.pi_binary = directory.0.join("missing-pi").display().to_string();
        config.runtime.omp_binary = directory.0.join("missing-omp").display().to_string();
        let core = HivemindCore::new(config, directory.0.join("hivemind.toml")).unwrap();
        let names = core
            .agents()
            .list()
            .into_iter()
            .map(|agent| agent.name.clone())
            .collect::<Vec<_>>();
        let expected = core
            .config()
            .ordered_agents()
            .into_iter()
            .map(|agent| agent.name.clone())
            .collect::<Vec<_>>();
        assert_eq!(names, expected);
        assert_eq!(names, ["Reviewer", "Engineer"]);
        assert!(directory.0.join(".hivemind/memory.sqlite3").exists());
        assert!(!directory.0.join("missing-pi").exists());
        assert!(!directory.0.join("missing-omp").exists());
        core.shutdown().await;
    }

    /// Two-agent fake pi (Reviewer ordered first but replies only after the test
    /// creates `release_marker`, i.e. after Engineer completed).
    fn slow_first_pair_core(directory: &TestDirectory, release_marker: &Path) -> HivemindCore {
        let binary = directory.0.join("fake-pi-pair");
        let script = r#"#!/bin/sh
MARK='__MARK__'
case "$*" in
  *"You are the Reviewer"*) agent=Reviewer; wait_mark=1 ;;
  *) agent=Engineer; wait_mark=0 ;;
esac
while IFS= read -r request; do
  case "$request" in
    *'"type":"new_session"'*)
      printf '%s\n' '{"type":"response","command":"new_session","success":true}'
      ;;
    *'"type":"prompt"'*)
      if [ "$wait_mark" = 1 ]; then
        i=0; while [ ! -e "$MARK" ] && [ $i -lt 2000 ]; do sleep 0.01; i=$((i+1)); done
      fi
      printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"%s reply"}]}}\n' "$agent"
      printf '%s\n' '{"type":"agent_settled"}'
      ;;
  esac
done
"#;
        let script = script.replace("__MARK__", &release_marker.display().to_string());
        fs::write(&binary, script).unwrap();
        let mut permissions = fs::metadata(&binary).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&binary, permissions).unwrap();
        let mut config = HivemindConfig::default_poc();
        config.conversation.reply_order = vec!["Reviewer".into(), "Engineer".into()];
        config.runtime.pi_binary = binary.display().to_string();
        for agent in &mut config.agents {
            agent.workspace = directory.0.display().to_string();
        }
        HivemindCore::new(config, directory.0.join("hivemind.toml")).unwrap()
    }

    #[tokio::test]
    async fn broadcast_presentation_follows_configured_order_despite_completion_order() {
        let directory = TestDirectory::new();
        let release_marker = directory.0.join("reviewer-release");
        let core = slow_first_pair_core(&directory, &release_marker);
        let mut events = core.events().subscribe();
        let mut watcher = core.events().subscribe();
        let members = core
            .agents()
            .list()
            .into_iter()
            .map(|agent| Participant { agent, role: None })
            .collect::<Vec<_>>();
        let turn = core.turn(CoreTurnRequest {
            room: "order-room",
            room_name: "Order room",
            group_id: "",
            mode: ConversationMode::Broadcast,
            members: &members,
            input: "both answer",
        });
        let release = async {
            loop {
                let event = watcher.recv().await.unwrap();
                if let DomainEventKind::AgentReplyCompleted { agent_id, .. } = &event.payload {
                    if agent_id == "Engineer" {
                        fs::write(&release_marker, "").unwrap();
                        break;
                    }
                }
            }
        };
        let (replies, ()) = tokio::join!(turn, release);
        let replies = replies.unwrap();
        core.shutdown().await;

        let presented = replies
            .iter()
            .map(|reply| reply.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(presented, ["Reviewer", "Engineer"]);
        assert_eq!(replies[0].result.as_deref(), Ok("Reviewer reply"));
        assert_eq!(replies[1].result.as_deref(), Ok("Engineer reply"));
        let mut completed = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let DomainEventKind::AgentReplyCompleted { agent_id, .. } = event.payload.clone() {
                completed.push(agent_id);
            }
        }
        assert_eq!(
            completed,
            ["Engineer", "Reviewer"],
            "slow first agent completes last"
        );
    }

    #[tokio::test]
    async fn shutdown_after_partial_startup_is_safe_repeatable_and_final() {
        let directory = TestDirectory::new();
        let (working, lifecycle, _prompts) = fake_core(&directory);
        let mut config = working.config().clone();
        working.shutdown().await;
        let mut broken = config.agents[0].clone();
        broken.name = "Broken".into();
        broken.workspace = directory.0.join("missing-workspace").display().to_string();
        config.agents.insert(0, broken);
        let core = HivemindCore::new(config, directory.0.join("hivemind.toml")).unwrap();
        let mut events = core.events().subscribe();
        let members = core
            .agents()
            .list()
            .into_iter()
            .map(|agent| Participant { agent, role: None })
            .collect::<Vec<_>>();
        let request = || CoreTurnRequest {
            room: "partial-room",
            room_name: "Partial room",
            group_id: "",
            mode: ConversationMode::Broadcast,
            members: &members,
            input: "partial startup",
        };
        let replies = core.turn(request()).await.unwrap();
        assert!(replies
            .iter()
            .any(|reply| reply.name == "Broken" && reply.result.is_err()));
        assert_eq!(lines(&lifecycle), ["Engineer started", "Engineer prompt"]);

        core.shutdown().await;
        core.shutdown().await;
        assert_eq!(
            lines(&lifecycle),
            ["Engineer started", "Engineer prompt", "Engineer stopped"]
        );

        let error = core.turn(request()).await.unwrap_err();
        assert!(error.to_string().contains("shutting down"), "{error:#}");
        assert_eq!(
            lines(&lifecycle).len(),
            3,
            "no runtime spawned after shutdown"
        );

        let mut started = Vec::new();
        let mut stopped = Vec::new();
        let mut shutting_down = 0;
        while let Ok(event) = events.try_recv() {
            match event.payload.clone() {
                DomainEventKind::RuntimeStarted { agent_id, .. } => started.push(agent_id),
                DomainEventKind::RuntimeStopped { agent_id, .. } => stopped.push(agent_id),
                DomainEventKind::CoreShuttingDown => shutting_down += 1,
                _ => {}
            }
        }
        assert_eq!(started, ["Engineer"]);
        assert_eq!(stopped, ["Engineer"]);
        assert_eq!(shutting_down, 1);
    }

    #[test]
    fn core_resolves_main_solo_and_group_identity_roles_mode_and_order() {
        let directory = TestDirectory::new();
        let mut config = HivemindConfig::default_poc();
        config.conversation.reply_order = vec!["Reviewer".into()];
        config.groups.push(crate::config::GroupConfig {
            name: "review".into(),
            members: vec!["Engineer".into(), "Reviewer".into()],
            mode: ConversationMode::Discussion,
            member_roles: [("Reviewer".into(), "Lead Reviewer".into())]
                .into_iter()
                .collect(),
            reply_order: vec!["Engineer".into()],
            workspace: None,
        });
        let core = HivemindCore::new(config, directory.0.join("hivemind.toml")).unwrap();

        let main = core.resolve_target(&ConversationTarget::Main).unwrap();
        assert_eq!(main.room_id, "main");
        assert_eq!(main.room_name, "Main conversation");
        assert_eq!(main.mode, ConversationMode::Broadcast);
        assert_eq!(
            main.participants
                .iter()
                .map(|member| member.agent.name.as_str())
                .collect::<Vec<_>>(),
            ["Reviewer", "Engineer"]
        );

        let solo = core
            .resolve_target(&ConversationTarget::Solo {
                persona_id: "Engineer".into(),
            })
            .unwrap();
        assert_eq!(solo.room_id, "solo-Engineer");
        assert_eq!(solo.mode, ConversationMode::Discussion);
        assert_eq!(solo.participants[0].role, None);

        let group = core
            .resolve_target(&ConversationTarget::Group {
                group_id: "review".into(),
            })
            .unwrap();
        assert_eq!(group.room_id, "group-review");
        assert_eq!(group.group_id, "review");
        assert_eq!(group.mode, ConversationMode::Discussion);
        assert_eq!(
            group
                .participants
                .iter()
                .map(|member| member.agent.name.as_str())
                .collect::<Vec<_>>(),
            ["Engineer", "Reviewer"]
        );
        assert_eq!(group.participants[0].role, None);
        assert_eq!(group.participants[1].role.as_deref(), Some("Lead Reviewer"));
        assert!(matches!(
            core.resolve_target(&ConversationTarget::Solo {
                persona_id: "missing".into()
            }),
            Err(TargetResolutionError::NotFound(_))
        ));
        assert!(matches!(
            core.resolve_target(&ConversationTarget::Group {
                group_id: String::new()
            }),
            Err(TargetResolutionError::Invalid(_))
        ));
    }
}
