mod registry;
pub use registry::AgentRegistry;

use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, RwLock,
    },
};

use anyhow::{Context, Result};

use crate::{
    shared_workspace::{SharedWorkspaces, ToolHosts, WorkspaceTools},
    config::{ConversationMode, HivemindConfig},
    coordination::{policy::Roster, store::CoordinationStore, CoordinationService, CoordinationTools},
    conversation::{
        AgentInvoker, ConversationCoordinator, Participant, RuntimeInvoker, TurnExecution,
        TurnReply, TurnRequest,
    },
    events::{DomainEventKind, EventBus},
    memory::MemoryService,
    runtime::RuntimePool,
};

/// Process-level owner of configuration, memory, conversations, events, and API state.
pub struct HivemindCore {
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
    shutting_down: AtomicBool,
    shutdown_lock: tokio::sync::Mutex<()>,
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
fn with_workspace(agent: Arc<crate::config::AgentConfig>, workspace: &str) -> Arc<crate::config::AgentConfig> {
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
        let context_dir = data_dir.join("context");
        let config = Arc::new(config);
        let agents = AgentRegistry {
            agents: Arc::new(
                config
                    .ordered_agents()
                    .into_iter()
                    .map(|agent| Arc::new(agent.clone()))
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
        let runtime = Arc::new(RuntimePool::new(
            config.runtime.clone(),
            config.context.runtime_rotate_tokens,
            memory.clone(),
            events.clone(),
        ));
        let audit = Arc::new(
            crate::access::Audit::open(data_dir.join("access.sqlite3"))
                .context("opening access audit log")?,
        );
        let access = Arc::new(crate::access::AccessPolicy::from_config(&config, audit.clone()));
        conversation.set_access(access.clone());
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
        let workspaces = Arc::new(SharedWorkspaces::new(&config_path, &config));
        let mut hosts: Vec<Arc<dyn crate::conversation::ToolHost>> = vec![Arc::new(WorkspaceTools::new(workspaces.clone()))];
        if config.coordination.enabled {
            hosts.push(Arc::new(CoordinationTools::new(coordination.clone(), audit.clone())));
        }
        conversation.set_tools(Arc::new(ToolHosts(hosts)));
        events.publish(DomainEventKind::CoreStarted);
        Ok(Self {
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
            shutting_down: AtomicBool::new(false),
            shutdown_lock: tokio::sync::Mutex::new(()),
        })
    }

    pub fn agents(&self) -> AgentRegistry {
        self.agents
            .read()
            .expect("core agent registry lock poisoned")
            .clone()
    }

    /// Update only persisted group definitions; runtime and context services
    /// are intentionally not reconstructed by this operation.
    pub fn reload_groups(&self, groups: Vec<crate::config::GroupConfig>) {
        let mut config = self
            .config
            .read()
            .expect("core config lock poisoned")
            .as_ref()
            .clone();
        config.groups = groups;
        self.workspaces.replace_groups(&config.groups);
        *self.config.write().expect("core config lock poisoned") = Arc::new(config);
    }

    pub fn config(&self) -> HivemindConfig {
        self.config
            .read()
            .expect("core config lock poisoned")
            .as_ref()
            .clone()
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
    pub async fn rotate_instance(&self, instance: &crate::identity::AgentInstanceId, reason: &'static str) {
        self.runtime.rotate_instance(instance, reason).await;
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
                    .map(|agent| Participant { agent: self.own_workspace(agent), role: None })
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
                    participants: vec![Participant {
                        agent,
                        role: None,
                    }],
                }
            }
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
                            Some(Participant { role: group.member_roles.get(&agent.name).cloned(), agent })
                        })
                        .collect(),
                }
            }
        })
    }

    /// The persona with its current own workspace, which an agent may have changed at runtime.
    fn own_workspace(&self, agent: Arc<crate::config::AgentConfig>) -> Arc<crate::config::AgentConfig> {
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
        let binary = directory.0.join("fake-pi");
        let lifecycle = directory.0.join("lifecycle.log");
        let prompts = directory.0.join("prompts.log");
        let script = r#"#!/bin/sh
case "$*" in
  *"You are the Engineer"*) agent=Engineer ;;
  *) agent=Unknown ;;
esac
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
      case "$request" in
        *'Current user message:\ncrash-now'*) exit 3 ;;
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
            2
        );
        let messages = prompt_messages(&prompts);
        assert!(messages[1].contains("Participants:"), "{}", messages[1]);
        let mut failure_codes = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let DomainEventKind::RuntimeFailed { error_code, .. } = event.payload.clone() {
                failure_codes.push(error_code);
            }
        }
        assert_eq!(failure_codes, ["runtime_failure"]);
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
