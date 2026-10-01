use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use anyhow::{Context, Result};

use crate::{
    config::{AgentConfig, ConversationMode, HivemindConfig},
    conversation::{
        AgentInvoker, ConversationCoordinator, Participant, RuntimeInvoker, TurnReply, TurnRequest,
    },
    events::{DomainEventKind, EventBus},
    memory::MemoryService,
    runtime::RuntimePool,
    tasks::{TaskOrigin, TaskService},
};

/// Process-level owner of configuration, memory, conversations, events, and API state.
pub struct HivemindCore {
    config: Arc<HivemindConfig>,
    agents: AgentRegistry,
    memory: Arc<MemoryService>,
    conversation: Arc<ConversationCoordinator>,
    events: EventBus,
    runtime: Arc<RuntimePool>,
    tasks: TaskService,
    config_path: PathBuf,
    shutting_down: AtomicBool,
}

#[derive(Clone)]
pub struct AgentRegistry {
    agents: Arc<Vec<AgentConfig>>,
}

impl AgentRegistry {
    pub fn list(&self) -> Vec<AgentConfig> {
        self.agents.as_ref().clone()
    }
    pub fn get(&self, id: &str) -> Option<AgentConfig> {
        self.agents.iter().find(|agent| agent.name == id).cloned()
    }
}

pub struct CoreTurnRequest<'a> {
    pub room: &'a str,
    pub room_name: &'a str,
    pub group_id: &'a str,
    pub mode: ConversationMode,
    pub members: &'a [Participant],
    pub input: &'a str,
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
            agents: Arc::new(config.ordered_agents().into_iter().cloned().collect()),
        };
        let events = EventBus::new();
        let conversation = Arc::new(ConversationCoordinator::new_with_events(
            context_dir,
            config.context.clone(),
            memory.clone(),
            Some(events.clone()),
        ));
        let runtime = Arc::new(RuntimePool::new(
            config.runtime.clone(),
            config.context.runtime_rotate_tokens,
            memory.clone(),
            events.clone(),
        ));
        let tasks = TaskService::new(
            config.clone(),
            conversation.clone(),
            runtime.clone(),
            events.clone(),
            data_dir.join("tasks"),
        );
        events.publish(DomainEventKind::CoreStarted);
        Ok(Self {
            config,
            agents,
            memory,
            conversation,
            events,
            runtime,
            tasks,
            config_path,
            shutting_down: AtomicBool::new(false),
        })
    }

    pub fn config(&self) -> &HivemindConfig {
        &self.config
    }
    pub fn agents(&self) -> &AgentRegistry {
        &self.agents
    }
    pub fn events(&self) -> &EventBus {
        &self.events
    }
    pub fn memory(&self) -> &Arc<MemoryService> {
        &self.memory
    }
    pub fn conversation(&self) -> &ConversationCoordinator {
        &self.conversation
    }
    /// Task threads handed off by read-only chat agents.
    pub fn tasks(&self) -> &TaskService {
        &self.tasks
    }
    pub fn config_path(&self) -> &Path {
        &self.config_path
    }

    pub async fn turn(&self, request: CoreTurnRequest<'_>) -> Result<Vec<TurnReply>> {
        let invoker = Arc::new(
            RuntimeInvoker::new(self.runtime.clone(), request.room, request.group_id).with_tools(
                self.tasks.bind(TaskOrigin {
                    room_name: request.room_name.to_owned(),
                    group_id: request.group_id.to_owned(),
                    members: request.members.to_vec(),
                }),
            ),
        );
        self.turn_with_invoker(request, invoker).await
    }

    pub async fn turn_with_invoker(
        &self,
        request: CoreTurnRequest<'_>,
        invoker: Arc<dyn AgentInvoker>,
    ) -> Result<Vec<TurnReply>> {
        anyhow::ensure!(
            !self.shutting_down.load(Ordering::Acquire),
            "Hivemind core is shutting down"
        );
        // Workers already running for this room must hear about a decision
        // or goal this turn changes, not keep working from stale instructions.
        let watched = self
            .tasks
            .has_running_in(request.room)
            .then(|| self.conversation.room_history(request.room).ok())
            .flatten()
            .map(|history| history.state);
        let started_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let room = request.room;
        let replies = self
            .conversation
            .turn(TurnRequest {
                room: request.room,
                room_name: request.room_name,
                group_id: request.group_id,
                mode: request.mode,
                members: request.members,
                input: request.input,
                invoker,
            })
            .await?;
        if let (Some(before), Ok(after)) = (watched, self.conversation.room_history(room)) {
            for change in state_changes(&before, &after.state) {
                self.tasks.announce_to_room(room, started_ms, &change).await;
            }
        }
        Ok(replies)
    }

    /// Idempotently stop the core and every live agent-instance runtime.
    pub async fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::AcqRel) {
            return;
        }
        self.events.publish(DomainEventKind::CoreShuttingDown);
        self.tasks.cancel_all();
        self.runtime.shutdown().await;
    }
}

/// Decisions and goal changes between two snapshots of a room's state,
/// worded for a worker that is already mid-task.
fn state_changes(
    before: &crate::conversation::RoomState,
    after: &crate::conversation::RoomState,
) -> Vec<String> {
    let mut changes: Vec<String> = after
        .decisions
        .iter()
        .filter(|decision| !before.decisions.contains(decision))
        .map(|decision| format!("The room recorded a new decision: {decision}"))
        .collect();
    if after.goal != before.goal {
        if let Some(goal) = &after.goal {
            changes.push(format!("The room's goal changed to: {goal}"));
        }
    }
    changes
}

#[cfg(test)]
mod tests {
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
        let binary = directory.0.join("fake-pi");
        let lifecycle = directory.0.join("lifecycle.log");
        let prompts = directory.0.join("prompts.log");
        let script = r#"#!/bin/sh
case "$*" in
  *"You are Maomao"*) agent=Maomao ;;
  *) agent=Unknown ;;
esac
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
      esac
      if [ -e __DIR__/tool-mode ] && ! printf '%s' "$request" | grep -q 'Memory tool result:'; then
        printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"```hivemind-tool\n{\"name\":\"memory.private.add\",\"args\":{\"content\":\"session note\"}}\n```"}]}}'
      else
        printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Maomao reply"}]}}'
      fi
      printf '%s\n' '{"type":"agent_settled"}'
      ;;
  esac
done
printf '%s stopped\n' "$agent" >> __DIR__/lifecycle.log
"#
        .replace("__DIR__", &format!("'{}'", directory.0.display()));
        fs::write(&binary, script).unwrap();
        let mut permissions = fs::metadata(&binary).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&binary, permissions).unwrap();

        let mut config = HivemindConfig::default_poc();
        config.agents.retain(|agent| agent.name == "Maomao");
        config.runtime.pi_binary = binary.display().to_string();
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

    fn maomao_caller(room: &str) -> crate::memory::Caller {
        crate::memory::Caller::agent(room, "", format!("{room}/Maomao"), "Maomao", "Maomao")
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
            assert_eq!(replies[0].result.as_ref().unwrap(), "Maomao reply");
        }
        assert_eq!(
            lines(&lifecycle),
            [
                "Maomao started",
                "Maomao prompt",
                "Maomao prompt",
                "Maomao started",
                "Maomao prompt"
            ]
        );

        core.shutdown().await;
        core.shutdown().await;
        let after = lines(&lifecycle);
        assert_eq!(after.len(), 7);
        assert_eq!(after[5..], ["Maomao stopped", "Maomao stopped"]);

        let mut started = 0;
        let mut stopped = 0;
        let mut shutting_down = 0;
        while let Ok(event) = events.try_recv() {
            match event.payload {
                DomainEventKind::RuntimeStarted { agent_id, .. } => {
                    assert_eq!(agent_id, "Maomao");
                    started += 1;
                }
                DomainEventKind::RuntimeStopped { agent_id, .. } => {
                    assert_eq!(agent_id, "Maomao");
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
                "Maomao started",
                "Maomao prompt",
                "Maomao stopped",
                "Maomao started",
                "Maomao prompt"
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
                instance_id,
                reason,
                ..
            } = event.payload
            {
                rotated.push((instance_id, reason));
            }
        }
        assert_eq!(
            rotated,
            [("rotate-room/Maomao".to_owned(), "context_budget".to_owned())]
        );

        let epochs = core
            .memory()
            .runtime_epochs(&maomao_caller("rotate-room"), 10)
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
        let (core, lifecycle, prompts) = fake_core(&directory);
        let mut events = core.events().subscribe();
        let replies = solo_turn(&core, "crash-room", "crash-now").await.unwrap();
        assert!(replies[0].result.is_err());
        let replies = solo_turn(&core, "crash-room", "after the crash")
            .await
            .unwrap();
        assert_eq!(replies[0].result.as_deref(), Ok("Maomao reply"));
        core.shutdown().await;

        assert_eq!(
            lines(&lifecycle)
                .iter()
                .filter(|line| *line == "Maomao started")
                .count(),
            2
        );
        let messages = prompt_messages(&prompts);
        assert!(messages[1].contains("Participants:"), "{}", messages[1]);
        let mut failure_codes = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let DomainEventKind::RuntimeFailed { error_code, .. } = event.payload {
                failure_codes.push(error_code);
            }
        }
        assert_eq!(failure_codes, ["runtime_prompt_failed"]);
    }

    #[tokio::test]
    async fn idle_sessions_close_and_the_next_turn_rehydrates() {
        let directory = TestDirectory::new();
        let (core, lifecycle, prompts) = fake_core(&directory);
        solo_turn(&core, "idle-room", "first").await.unwrap();
        core.runtime.close_idle(std::time::Duration::ZERO).await;
        assert_eq!(
            lines(&lifecycle),
            ["Maomao started", "Maomao prompt", "Maomao stopped"]
        );
        let epochs = core
            .memory()
            .runtime_epochs(&maomao_caller("idle-room"), 10)
            .unwrap();
        assert!(epochs.iter().all(|epoch| epoch.ended_at.is_some()));

        solo_turn(&core, "idle-room", "second").await.unwrap();
        assert_eq!(lines(&lifecycle)[3], "Maomao started");
        assert!(prompt_messages(&prompts)[1].contains("Participants:"));
        core.shutdown().await;
    }

    #[tokio::test]
    async fn tool_followups_continue_the_live_session_with_only_the_result() {
        let directory = TestDirectory::new();
        let (core, lifecycle, prompts) = fake_core(&directory);
        fs::write(directory.0.join("tool-mode"), "").unwrap();
        let replies = solo_turn(&core, "tool-room", "save a note").await.unwrap();
        assert_eq!(replies[0].result.as_deref(), Ok("Maomao reply"));
        core.shutdown().await;

        assert_eq!(
            lines(&lifecycle)
                .iter()
                .filter(|line| *line == "Maomao started")
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
            let (kind, room_id, turn_id) = match event.payload {
                DomainEventKind::TurnStarted { room_id, turn_id } => {
                    ("turn_started", room_id, turn_id)
                }
                DomainEventKind::AgentReplyStarted {
                    room_id,
                    turn_id,
                    agent_id,
                    ..
                } => {
                    assert_eq!(agent_id, "Maomao");
                    ("reply_started", room_id, turn_id)
                }
                DomainEventKind::AgentReplyCompleted {
                    room_id,
                    turn_id,
                    agent_id,
                    ..
                } => {
                    assert_eq!(agent_id, "Maomao");
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

        let caller = maomao_caller("epoch-room");
        let epochs = core.memory().runtime_epochs(&caller, 10).unwrap();
        assert_eq!(epochs.len(), 1, "one epoch per live session");
        let epoch = &epochs[0];
        assert_eq!(epoch.runtime, "pi");
        assert_eq!(epoch.instance_id, "epoch-room/Maomao");
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
            .runtime_epochs(&maomao_caller("other-room"), 10)
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn broadcast_records_runtime_startup_failure_and_keeps_successful_peer() {
        let directory = TestDirectory::new();
        let (working, _lifecycle, _prompts) = fake_core(&directory);
        let mut config = working.config().clone();
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
        core.shutdown().await;

        let by_name = |name: &str| replies.iter().find(|reply| reply.name == name).unwrap();
        assert!(by_name("Broken").result.is_err());
        assert_eq!(by_name("Maomao").result.as_deref(), Ok("Maomao reply"));
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
            .find(|event| event.speaker == "Maomao")
            .unwrap();
        assert!(!succeeded.error);
        assert_eq!(succeeded.content, "Maomao reply");
    }

    #[tokio::test]
    async fn construction_is_provider_free_and_registry_uses_effective_order() {
        let directory = TestDirectory::new();
        let mut config = HivemindConfig::default_poc();
        config.conversation.reply_order = vec!["Albedo".into(), "Maomao".into()];
        config.runtime.pi_binary = directory.0.join("missing-pi").display().to_string();
        config.runtime.omp_binary = directory.0.join("missing-omp").display().to_string();
        let core = HivemindCore::new(config, directory.0.join("hivemind.toml")).unwrap();
        let names = core
            .agents()
            .list()
            .into_iter()
            .map(|agent| agent.name)
            .collect::<Vec<_>>();
        let expected = core
            .config()
            .ordered_agents()
            .into_iter()
            .map(|agent| agent.name.clone())
            .collect::<Vec<_>>();
        assert_eq!(names, expected);
        assert_eq!(names, ["Albedo", "Maomao"]);
        assert!(directory.0.join(".hivemind/memory.sqlite3").exists());
        assert!(!directory.0.join("missing-pi").exists());
        assert!(!directory.0.join("missing-omp").exists());
        core.shutdown().await;
    }

    /// Two-agent fake pi (Albedo ordered first but replies only after the test
    /// creates `release_marker`, i.e. after Maomao completed).
    fn slow_first_pair_core(directory: &TestDirectory, release_marker: &Path) -> HivemindCore {
        let binary = directory.0.join("fake-pi-pair");
        let script = r#"#!/bin/sh
MARK='__MARK__'
case "$*" in
  *"You are Albedo"*) agent=Albedo; wait_mark=1 ;;
  *) agent=Maomao; wait_mark=0 ;;
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
        config.conversation.reply_order = vec!["Albedo".into(), "Maomao".into()];
        config.runtime.pi_binary = binary.display().to_string();
        for agent in &mut config.agents {
            agent.workspace = directory.0.display().to_string();
        }
        HivemindCore::new(config, directory.0.join("hivemind.toml")).unwrap()
    }

    #[tokio::test]
    async fn broadcast_presentation_follows_configured_order_despite_completion_order() {
        let directory = TestDirectory::new();
        let release_marker = directory.0.join("albedo-release");
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
                    if agent_id == "Maomao" {
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
        assert_eq!(presented, ["Albedo", "Maomao"]);
        assert_eq!(replies[0].result.as_deref(), Ok("Albedo reply"));
        assert_eq!(replies[1].result.as_deref(), Ok("Maomao reply"));
        let mut completed = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let DomainEventKind::AgentReplyCompleted { agent_id, .. } = event.payload {
                completed.push(agent_id);
            }
        }
        assert_eq!(
            completed,
            ["Maomao", "Albedo"],
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
        assert_eq!(lines(&lifecycle), ["Maomao started", "Maomao prompt"]);

        core.shutdown().await;
        core.shutdown().await;
        assert_eq!(
            lines(&lifecycle),
            ["Maomao started", "Maomao prompt", "Maomao stopped"]
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
            match event.payload {
                DomainEventKind::RuntimeStarted { agent_id, .. } => started.push(agent_id),
                DomainEventKind::RuntimeStopped { agent_id, .. } => stopped.push(agent_id),
                DomainEventKind::CoreShuttingDown => shutting_down += 1,
                _ => {}
            }
        }
        assert_eq!(started, ["Maomao"]);
        assert_eq!(stopped, ["Maomao"]);
        assert_eq!(shutting_down, 1);
    }
}
