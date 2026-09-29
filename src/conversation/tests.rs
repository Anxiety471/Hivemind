use super::*;
use crate::memory::{MemoryStatus, MemoryStore, Scope};
use parking_lot::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Fake {
    prompts: Mutex<Vec<(AgentInstanceId, String)>>,
    running: AtomicUsize,
    max_running: AtomicUsize,
    fail: Option<String>,
    barrier: Option<Arc<tokio::sync::Barrier>>,
    reply: Mutex<Option<String>>,
}
#[async_trait]
impl AgentInvoker for Fake {
    async fn cursor(&self, _agent_instance_id: &AgentInstanceId) -> Option<SessionCursor> {
        None
    }

    async fn invoke(&self, request: InvokeRequest<'_>) -> Result<InvokeReply> {
        let agent = request.agent;
        let now = self.running.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_running.fetch_max(now, Ordering::SeqCst);
        self.prompts
            .lock()
            .push((request.agent_instance_id.clone(), request.full.to_owned()));
        let synchronized = if let Some(barrier) = &self.barrier {
            tokio::time::timeout(std::time::Duration::from_secs(2), barrier.wait())
                .await
                .is_ok()
        } else {
            tokio::task::yield_now().await;
            true
        };
        self.running.fetch_sub(1, Ordering::SeqCst);
        if !synchronized {
            anyhow::bail!("different room invocations did not meet at the barrier");
        }
        if self.fail.as_deref() == Some(&agent.name) {
            anyhow::bail!("fixture failure");
        }
        let text = self
            .reply
            .lock()
            .clone()
            .unwrap_or_else(|| format!("{} answered", agent.name));
        Ok(InvokeReply {
            text,
            epoch_id: "fake".into(),
        })
    }
}
fn member(name: &str) -> Participant {
    Participant {
        agent: AgentConfig {
            name: name.into(),
            runtime: "pi".into(),
            system_prompt: String::new(),
            workspace: ".".into(),
            model: None,
            reasoning: None,
            fast: None,
            role: None,
        },
        role: Some(format!("{name} role")),
    }
}
fn fixture() -> (PathBuf, ConversationCoordinator) {
    let path = std::env::temp_dir().join(format!("hivemind-context-test-{}", stable_id()));
    let coord = ConversationCoordinator::new(
        &path,
        ContextConfig {
            recent_turns: 1,
            summary_max_tokens: 100,
            context_target_tokens: 1000,
            runtime_rotate_tokens: 24000,
            summary_refresh_turns: 2,
        },
        in_memory_memory(),
    );
    (path, coord)
}

fn in_memory_memory() -> Arc<MemoryService> {
    Arc::new(MemoryService::new(MemoryStore::in_memory().unwrap()))
}
fn fake(fail: Option<&str>) -> Arc<Fake> {
    fake_with(fail, None)
}
fn fake_with(fail: Option<&str>, barrier: Option<Arc<tokio::sync::Barrier>>) -> Arc<Fake> {
    Arc::new(Fake {
        prompts: Mutex::new(Vec::new()),
        running: AtomicUsize::new(0),
        max_running: AtomicUsize::new(0),
        fail: fail.map(str::to_owned),
        reply: Mutex::new(None),
        barrier,
    })
}

struct DelayedEventsInvoker;

#[async_trait]
impl AgentInvoker for DelayedEventsInvoker {
    async fn cursor(&self, _agent_instance_id: &AgentInstanceId) -> Option<SessionCursor> {
        None
    }

    async fn invoke(&self, request: InvokeRequest<'_>) -> Result<InvokeReply> {
        let agent = request.agent;
        let delay = if agent.name == "Slow" { 60 } else { 5 };
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        if agent.name == "Fails" {
            anyhow::bail!("sensitive provider detail");
        }
        Ok(InvokeReply {
            text: format!("{} reply", agent.name),
            epoch_id: "fake".into(),
        })
    }
}
struct SameRoomOverlapProbe {
    active: AtomicUsize,
    max_active: AtomicUsize,
    started: tokio::sync::Notify,
}

#[async_trait]
impl AgentInvoker for SameRoomOverlapProbe {
    async fn cursor(&self, _agent_instance_id: &AgentInstanceId) -> Option<SessionCursor> {
        None
    }

    async fn invoke(&self, _request: InvokeRequest<'_>) -> Result<InvokeReply> {
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_active.fetch_max(active, Ordering::SeqCst);
        self.started.notify_one();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        self.active.fetch_sub(1, Ordering::SeqCst);
        Ok(InvokeReply {
            text: "serialized reply".into(),
            epoch_id: "fake".into(),
        })
    }
}

#[tokio::test]
async fn broadcast_events_track_completion_order_and_safe_attributed_failures() {
    let path = std::env::temp_dir().join(format!("hivemind-event-turn-{}", stable_id()));
    let events = crate::events::EventBus::new();
    let mut receiver = events.subscribe();
    let coordinator = ConversationCoordinator::new_with_events(
        &path,
        ContextConfig::default(),
        in_memory_memory(),
        Some(events),
    );
    let members = [member("Slow"), member("Fast")];
    let replies = coordinator
        .turn(TurnRequest {
            room: "event-room",
            room_name: "Event room",
            group_id: "group-1",
            mode: ConversationMode::Broadcast,
            members: &members,
            input: "question",
            invoker: Arc::new(DelayedEventsInvoker),
        })
        .await
        .unwrap();

    assert_eq!(
        replies
            .iter()
            .map(|reply| reply.name.as_str())
            .collect::<Vec<_>>(),
        ["Slow", "Fast"]
    );
    let mut seen = Vec::new();
    while let Ok(event) = receiver.try_recv() {
        seen.push(event.payload);
    }
    let (turn_id, room_id) = seen
        .iter()
        .find_map(|event| match event {
            crate::events::DomainEventKind::TurnStarted { turn_id, room_id } => {
                Some((turn_id.clone(), room_id.clone()))
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(room_id, "event-room");
    let completed_order = seen
        .iter()
        .filter_map(|event| match event {
            crate::events::DomainEventKind::AgentReplyCompleted {
                turn_id: observed_turn,
                room_id: observed_room,
                agent_id,
                agent_instance_id,
            } => {
                assert_eq!(observed_turn, &turn_id);
                assert_eq!(observed_room, "event-room");
                assert_eq!(
                    agent_instance_id,
                    &AgentInstanceId::new("event-room", agent_id)
                );
                Some(agent_id.as_str())
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(completed_order, ["Fast", "Slow"]);
    let saved = coordinator.room_history("event-room").unwrap();
    assert!(saved.completed_turns.contains(&turn_id));
    assert!(matches!(
        seen.last(),
        Some(crate::events::DomainEventKind::TurnCompleted { turn_id: completed, .. })
            if completed == &turn_id
    ));

    let failing_path = path.with_extension("failure");
    let failing_events = crate::events::EventBus::new();
    let mut failure_receiver = failing_events.subscribe();
    let failing = ConversationCoordinator::new_with_events(
        &failing_path,
        ContextConfig::default(),
        in_memory_memory(),
        Some(failing_events),
    );
    let failed_members = [member("Fails")];
    let failed = failing
        .turn(TurnRequest {
            room: "failure-room",
            room_name: "Failure room",
            group_id: "",
            mode: ConversationMode::Discussion,
            members: &failed_members,
            input: "question",
            invoker: Arc::new(DelayedEventsInvoker),
        })
        .await
        .unwrap();
    assert!(failed[0]
        .result
        .as_ref()
        .unwrap_err()
        .contains("sensitive provider detail"));
    let failed_event = loop {
        match failure_receiver.try_recv() {
            Ok(crate::events::DomainEvent {
                payload:
                    crate::events::DomainEventKind::AgentReplyFailed {
                        turn_id,
                        room_id,
                        agent_id,
                        agent_instance_id,
                        error_code,
                        message,
                    },
                ..
            }) => {
                break (
                    turn_id,
                    room_id,
                    agent_id,
                    agent_instance_id,
                    error_code,
                    message,
                )
            }
            Ok(_) => continue,
            Err(error) => panic!("missing reply failure event: {error}"),
        }
    };
    assert_eq!(failed_event.1, "failure-room");
    assert_eq!(failed_event.2, "Fails");
    assert_eq!(
        failed_event.3,
        AgentInstanceId::new("failure-room", "Fails")
    );
    assert_eq!(failed_event.4, "agent_reply_failed");
    assert_eq!(failed_event.5, "agent failed to produce a reply");
    assert!(!failed_event.5.contains("sensitive"));
    let failed_history = failing.room_history("failure-room").unwrap();
    assert!(failed_history.completed_turns.contains(&failed_event.0));
    let _ = fs::remove_dir_all(path);
    let _ = fs::remove_dir_all(failing_path);
}
#[tokio::test]
async fn advisory_room_lock_releases_when_owner_drops() {
    let path = std::env::temp_dir().join(format!("hivemind-lock-{}", stable_id()));
    let first = acquire_file_lock(&path, "room").await.unwrap();
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(30),
        acquire_file_lock(&path, "room")
    )
    .await
    .is_err());
    drop(first);
    let second = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        acquire_file_lock(&path, "room"),
    )
    .await
    .unwrap()
    .unwrap();
    drop(second);
    let _ = fs::remove_dir_all(path);
}

#[tokio::test]
async fn broadcast_concurrent_failure_and_canonical_history_persist() {
    let (path, coord) = fixture();
    let f = fake(Some("B"));
    let members = vec![member("A"), member("B")];
    let replies = coord
        .turn(TurnRequest {
            room: "room",
            room_name: "Team",
            group_id: "",
            mode: ConversationMode::Broadcast,
            members: &members,
            input: "question",
            invoker: f.clone(),
        })
        .await
        .unwrap();
    assert!(f.max_running.load(Ordering::SeqCst) > 1);
    assert!(replies[1].result.is_err());
    let history = ConversationCoordinator::new(&path, ContextConfig::default(), coord.memory())
        .room_history("room")
        .unwrap();
    assert_eq!(history.events.len(), 3);
    let failed = history
        .events
        .iter()
        .find(|event| event.speaker == "B")
        .unwrap();
    assert!(failed.error);
    assert_eq!(history.room_id, "room");
    let first = history
        .events
        .iter()
        .find(|event| event.speaker == "A")
        .unwrap();
    assert_eq!(
        first.agent_instance_id.as_ref(),
        Some(&AgentInstanceId::new("room", "A"))
    );
    let _ = fs::remove_dir_all(path);
}
#[cfg(unix)]
#[tokio::test]
async fn broadcast_context_sections_match_across_personas() {
    let (path, coordinator) = fixture();
    let fake = fake(None);
    let seed_members = [member("A"), member("B")];
    coordinator
        .turn(TurnRequest {
            room: "shared-room",
            room_name: "Shared room",
            group_id: "shared-group",
            mode: ConversationMode::Discussion,
            members: &seed_members,
            input: "Goal: shared target\nseed turn one",
            invoker: fake.clone(),
        })
        .await
        .unwrap();
    coordinator
        .turn(TurnRequest {
            room: "shared-room",
            room_name: "Shared room",
            group_id: "shared-group",
            mode: ConversationMode::Discussion,
            members: &seed_members,
            input: "seed turn two",
            invoker: fake.clone(),
        })
        .await
        .unwrap();

    let mut reviewer = member("A");
    reviewer.role = Some("Reviewer".into());
    let mut builder = member("B");
    builder.role = Some("Builder".into());
    let broadcast_members = [reviewer, builder];
    coordinator
        .turn(TurnRequest {
            room: "shared-room",
            room_name: "Shared room",
            group_id: "shared-group",
            mode: ConversationMode::Broadcast,
            members: &broadcast_members,
            input: "one common question",
            invoker: fake.clone(),
        })
        .await
        .unwrap();

    let prompts = fake.prompts.lock();
    let prompt_a = prompts
        .iter()
        .rev()
        .find(|(instance, _)| instance == &AgentInstanceId::new("shared-room", "A"))
        .unwrap()
        .1
        .as_str();
    let prompt_b = prompts
        .iter()
        .rev()
        .find(|(instance, _)| instance == &AgentInstanceId::new("shared-room", "B"))
        .unwrap()
        .1
        .as_str();
    fn before<'a>(prompt: &'a str, section: &str, next: &str) -> &'a str {
        prompt
            .split_once(section)
            .unwrap()
            .1
            .split_once(next)
            .unwrap()
            .0
    }
    assert_eq!(
        before(prompt_a, "Participants:\n", "\n\nYou are"),
        before(prompt_b, "Participants:\n", "\n\nYou are")
    );
    assert_eq!(
        before(
            prompt_a,
            "Shared room state:\n",
            "\nOlder conversation summary:"
        ),
        before(
            prompt_b,
            "Shared room state:\n",
            "\nOlder conversation summary:"
        )
    );
    assert_eq!(
        before(
            prompt_a,
            "Older conversation summary:\n",
            "\nRecent conversation:"
        ),
        before(
            prompt_b,
            "Older conversation summary:\n",
            "\nRecent conversation:"
        )
    );
    assert_eq!(
        before(
            prompt_a,
            "Recent conversation:\n",
            "\nCurrent user message:"
        ),
        before(
            prompt_b,
            "Recent conversation:\n",
            "\nCurrent user message:"
        )
    );
    assert_eq!(
        prompt_a
            .split_once("Current user message:\n")
            .unwrap()
            .1
            .trim_end(),
        prompt_b
            .split_once("Current user message:\n")
            .unwrap()
            .1
            .trim_end()
    );
    drop(prompts);
    let _ = fs::remove_dir_all(path);
}

#[tokio::test]
async fn discussion_failure_is_recorded_and_next_speaker_gets_compact_marker() {
    let (path, coordinator) = fixture();
    let fake = fake(Some("B"));
    let members = [member("A"), member("B"), member("C")];
    let replies = coordinator
        .turn(TurnRequest {
            room: "failure-room",
            room_name: "Failure room",
            group_id: "failure-group",
            mode: ConversationMode::Discussion,
            members: &members,
            input: "discuss the failure",
            invoker: fake.clone(),
        })
        .await
        .unwrap();
    assert!(replies[1].result.is_err());
    let history = coordinator.room_history("failure-room").unwrap();
    let failed = history
        .events
        .iter()
        .find(|event| event.speaker == "B")
        .unwrap();
    assert!(failed.error);
    assert!(failed.content.contains("fixture failure"));

    let prompts = fake.prompts.lock();
    let prompt_c = prompts
        .iter()
        .find(|(instance, _)| instance == &AgentInstanceId::new("failure-room", "C"))
        .unwrap()
        .1
        .as_str();
    assert!(prompt_c.contains("B failed to produce a response for this turn."));
    assert!(!prompt_c.contains("fixture failure"));
    let _ = fs::remove_dir_all(path);
}

#[tokio::test]
async fn concurrent_rooms_keep_history_and_runtime_instances_isolated() {
    let (path, coord) = fixture();
    let coord = Arc::new(coord);
    let f = fake_with(None, Some(Arc::new(tokio::sync::Barrier::new(2))));
    let members = vec![member("A")];
    let first_coord = coord.clone();
    let first_members = members.clone();
    let first_invoker = f.clone();
    let one = tokio::spawn(async move {
        first_coord
            .turn(TurnRequest {
                room: "room/a",
                room_name: "Team A",
                group_id: "",
                mode: ConversationMode::Discussion,
                members: &first_members,
                input: "message alpha",
                invoker: first_invoker,
            })
            .await
    });
    let second_coord = coord.clone();
    let second_invoker = f.clone();
    let two = tokio::spawn(async move {
        second_coord
            .turn(TurnRequest {
                room: "room_a",
                room_name: "Team B",
                group_id: "",
                mode: ConversationMode::Discussion,
                members: &members,
                input: "message beta",
                invoker: second_invoker,
            })
            .await
    });
    one.await.unwrap().unwrap();
    two.await.unwrap().unwrap();
    assert!(
        f.max_running.load(Ordering::SeqCst) > 1,
        "different rooms should progress concurrently"
    );
    let prompts = f.prompts.lock();
    let alpha = prompts
        .iter()
        .find(|(instance, _)| instance == &AgentInstanceId::new("room/a", "A"))
        .unwrap();
    let beta = prompts
        .iter()
        .find(|(instance, _)| instance == &AgentInstanceId::new("room_a", "A"))
        .unwrap();
    assert!(alpha.1.contains("message alpha") && !alpha.1.contains("message beta"));
    assert!(beta.1.contains("message beta") && !beta.1.contains("message alpha"));
    drop(prompts);
    assert_eq!(
        coord.room_history("room/a").unwrap().events[0].content,
        "message alpha"
    );
    assert_eq!(
        coord.room_history("room_a").unwrap().events[0].content,
        "message beta"
    );
    let _ = fs::remove_dir_all(path);
}
#[tokio::test]
async fn same_room_turns_serialize_invocation_and_persist_in_order() {
    let (path, coordinator) = fixture();
    let coordinator = Arc::new(coordinator);
    let probe = Arc::new(SameRoomOverlapProbe {
        active: AtomicUsize::new(0),
        max_active: AtomicUsize::new(0),
        started: tokio::sync::Notify::new(),
    });
    let members = vec![member("A")];
    let first_coordinator = coordinator.clone();
    let first_members = members.clone();
    let first_probe = probe.clone();
    let first = tokio::spawn(async move {
        first_coordinator
            .turn(TurnRequest {
                room: "same-room",
                room_name: "Same room",
                group_id: "",
                mode: ConversationMode::Discussion,
                members: &first_members,
                input: "first turn",
                invoker: first_probe,
            })
            .await
    });
    probe.started.notified().await;

    let second_coordinator = coordinator.clone();
    let second_probe = probe.clone();
    let second = tokio::spawn(async move {
        second_coordinator
            .turn(TurnRequest {
                room: "same-room",
                room_name: "Same room",
                group_id: "",
                mode: ConversationMode::Discussion,
                members: &members,
                input: "second turn",
                invoker: second_probe,
            })
            .await
    });

    first.await.unwrap().unwrap();
    second.await.unwrap().unwrap();
    assert_eq!(probe.max_active.load(Ordering::SeqCst), 1);
    let history = coordinator.room_history("same-room").unwrap();
    let user_turns: Vec<_> = history
        .events
        .iter()
        .filter(|event| event.speaker == "user")
        .map(|event| event.content.as_str())
        .collect();
    assert_eq!(user_turns, ["first turn", "second turn"]);
    let _ = fs::remove_dir_all(path);
}

#[tokio::test]
async fn discussion_context_is_ordered_and_rooms_are_isolated() {
    let (path, coord) = fixture();
    let f = fake(None);
    let members = vec![member("A"), member("B")];
    coord
        .turn(TurnRequest {
            room: "room/a",
            room_name: "Team",
            group_id: "",
            mode: ConversationMode::Discussion,
            members: &members,
            input: "question",
            invoker: f.clone(),
        })
        .await
        .unwrap();
    {
        let prompts = f.prompts.lock();
        assert!(prompts[0].1.contains("A role") && prompts[0].1.contains("B role"));
        assert!(!prompts[0].1.contains("A answered"));
        assert!(prompts[1].1.contains("A: A answered"));
    }
    coord
        .turn(TurnRequest {
            room: "room_a",
            room_name: "Other",
            group_id: "",
            mode: ConversationMode::Discussion,
            members: &[member("A")],
            input: "second room",
            invoker: f.clone(),
        })
        .await
        .unwrap();
    let isolated = coord.room_history("room_a").unwrap();
    assert_eq!(isolated.events[0].content, "second room");
    let store = JsonFileStore::new(&path);
    assert_ne!(store.room_path("room/a"), store.room_path("room_a"));
    let _ = fs::remove_dir_all(path);
}
#[tokio::test]
async fn interrupted_canonical_turns_are_summarized_before_they_age_out() {
    let (path, coord) = fixture();
    JsonFileStore::new(&path)
        .save_room(
            "room",
            &RoomHistory {
                room_id: "room".into(),
                events: vec![
                    MessageEvent {
                        id: "orphan-user".into(),
                        turn_id: "interrupted".into(),
                        speaker: "user".into(),
                        agent_instance_id: None,
                        legacy_agent_instance_id: None,
                        content: "interrupted user input".into(),
                        error: false,
                    },
                    MessageEvent {
                        id: "orphan-reply".into(),
                        turn_id: "interrupted".into(),
                        speaker: "A".into(),
                        agent_instance_id: Some(AgentInstanceId::new("room", "A")),
                        legacy_agent_instance_id: None,
                        content: "interrupted assistant response".into(),
                        error: false,
                    },
                ],
                ..RoomHistory::default()
            },
        )
        .unwrap();
    let f = fake(None);
    let member = [member("A")];
    coord
        .turn(TurnRequest {
            room: "room",
            room_name: "Team",
            group_id: "",
            mode: ConversationMode::Discussion,
            members: &member,
            input: "first recovered turn",
            invoker: f.clone(),
        })
        .await
        .unwrap();
    let history = coord.room_history("room").unwrap();
    assert!(history.summary.contains("interrupted user input"));
    assert!(history.summary.contains("interrupted assistant response"));
    assert!(!history.completed_turns.contains(&"interrupted".to_owned()));

    coord
        .turn(TurnRequest {
            room: "room",
            room_name: "Team",
            group_id: "",
            mode: ConversationMode::Discussion,
            members: &member,
            input: "second recovered turn",
            invoker: f.clone(),
        })
        .await
        .unwrap();
    let pack = f.prompts.lock().last().unwrap().1.clone();
    assert!(pack.contains("Older conversation summary:"));
    assert!(pack.contains("interrupted assistant response"));
    let _ = fs::remove_dir_all(path);
}

#[tokio::test]
async fn state_summary_budget_and_utf8_boundaries_are_preserved() {
    let (path, coord) = fixture();
    let f = fake(None);
    let member = [member("A")];
    coord
        .turn(TurnRequest {
            room: "room",
            room_name: "Team",
            group_id: "",
            mode: ConversationMode::Discussion,
            members: &member,
            input: "Goal: Ship safely\nolder one",
            invoker: f.clone(),
        })
        .await
        .unwrap();
    assert_eq!(
        coord.room_history("room").unwrap().state.goal.as_deref(),
        Some("Ship safely")
    );
    coord
        .turn(TurnRequest {
            room: "room",
            room_name: "Team",
            group_id: "",
            mode: ConversationMode::Discussion,
            members: &member,
            input: "older two",
            invoker: f.clone(),
        })
        .await
        .unwrap();
    coord
        .turn(TurnRequest {
            room: "room",
            room_name: "Team",
            group_id: "",
            mode: ConversationMode::Discussion,
            members: &member,
            input: "current three",
            invoker: f.clone(),
        })
        .await
        .unwrap();
    let last = f.prompts.lock().last().unwrap().1.clone();
    assert!(last.contains("Older conversation summary:") && last.contains("older one"));
    assert!(last.contains("Current user message:\ncurrent three"));
    assert_eq!(utf8_suffix("🌿abcdef", 5), "bcdef");
    coord
        .turn(TurnRequest {
            room: "room",
            room_name: "Team",
            group_id: "",
            mode: ConversationMode::Discussion,
            members: &member,
            input: "current four",
            invoker: f.clone(),
        })
        .await
        .unwrap();
    let fourth = f.prompts.lock().last().unwrap().1.clone();
    assert!(fourth.contains("older two"));
    assert!(fourth.contains("current three"));
    assert_eq!(utf8_suffix("🌿abcdef", 5), "bcdef");

    let limits = ContextConfig {
        context_target_tokens: 1000,
        ..ContextConfig::default()
    };
    let bounded = ConversationCoordinator::new(&path, limits, coord.memory());
    let oversized = bounded
        .turn(TurnRequest {
            room: "other",
            room_name: "Team",
            group_id: "",
            mode: ConversationMode::Discussion,
            members: &member,
            input: &"x".repeat(5000),
            invoker: f,
        })
        .await
        .unwrap();
    assert!(oversized[0]
        .result
        .as_ref()
        .unwrap_err()
        .contains("exceed configured"));
    assert_eq!(
        bounded.room_history("other").unwrap().events[0].speaker,
        "user"
    );
    let _ = fs::remove_dir_all(path);
}
#[tokio::test]
async fn explicit_state_updates_are_persisted_and_recalled_in_the_next_pack() {
    let (path, coord) = fixture();
    let f = fake(None);
    *f.reply.lock() = Some("Decision: model-generated should be ignored".into());
    let member = [member("A")];
    coord
        .turn(TurnRequest {
            room: "state-room",
            room_name: "Team",
            group_id: "",
            mode: ConversationMode::Discussion,
            members: &member,
            input: "Decision: use typed updates\nAssign: A = implement parser",
            invoker: f.clone(),
        })
        .await
        .unwrap();
    coord
        .turn(TurnRequest {
            room: "state-room",
            room_name: "Team",
            group_id: "",
            mode: ConversationMode::Discussion,
            members: &member,
            input: "continue",
            invoker: f.clone(),
        })
        .await
        .unwrap();

    let history = coord.room_history("state-room").unwrap();
    assert_eq!(history.state.decisions, ["use typed updates"]);
    assert_eq!(
        history.state.assignments.get("A").map(String::as_str),
        Some("implement parser")
    );
    let next_pack = f.prompts.lock().last().unwrap().1.clone();
    assert!(next_pack.contains(r#""decisions":["use typed updates"]"#));
    assert!(next_pack.contains(r#""assignments":{"A":"implement parser"}"#));
    let _ = fs::remove_dir_all(path);
}
#[tokio::test]
async fn invalid_state_update_keeps_prior_state_and_finalizes_turn() {
    let (path, coord) = fixture();
    let goal = "x".repeat(1900);
    let member = [member("A")];
    let first = coord
        .turn(TurnRequest {
            room: "state-room",
            room_name: "Team",
            group_id: "",
            mode: ConversationMode::Discussion,
            members: &member,
            input: &format!("Goal: {goal}"),
            invoker: fake(None),
        })
        .await
        .unwrap();
    assert_eq!(first[0].result.as_deref(), Ok("A answered"));
    let previous_state = coord.room_history("state-room").unwrap().state;
    assert_eq!(previous_state.goal.as_deref(), Some(goal.as_str()));

    let replies = coord
        .turn(TurnRequest {
            room: "state-room",
            room_name: "Team",
            group_id: "",
            mode: ConversationMode::Discussion,
            members: &member,
            input: "Decision: this would exceed the serialized state budget",
            invoker: fake(None),
        })
        .await
        .unwrap();
    assert_eq!(replies[0].result.as_deref(), Ok("A answered"));

    let history = coord.room_history("state-room").unwrap();
    assert_eq!(history.state, previous_state);
    assert_eq!(history.completed_turns.len(), 2);
    assert_eq!(history.events.len(), 4);
    assert_eq!(history.events[2].speaker, "user");
    assert_eq!(history.events[3].speaker, "A");
    assert_eq!(history.events[3].content, "A answered");
    assert_eq!(history.maintenance_errors.len(), 1);
    assert!(history.maintenance_errors[0]
        .contains("serialized room state exceeds context budget limit of 2000 bytes"));
    let _ = fs::remove_dir_all(path);
}
#[test]
fn context_budget_trims_old_history_but_keeps_current_input() {
    let path = std::env::temp_dir().join(format!("hivemind-budget-{}", stable_id()));
    let limits = ContextConfig {
        context_target_tokens: 600,
        ..ContextConfig::default()
    };
    let coordinator = ConversationCoordinator::with_store(
        Arc::new(JsonFileStore::new(&path)),
        limits,
        in_memory_memory(),
    );
    let member = member("A");
    let history = RoomHistory {
        summary: "old-summary ".repeat(400),
        events: vec![MessageEvent {
            id: "old".into(),
            turn_id: "old-turn".into(),
            speaker: "user".into(),
            agent_instance_id: None,
            legacy_agent_instance_id: None,
            content: "old-message ".repeat(400),
            error: false,
        }],
        ..RoomHistory::default()
    };
    let caller = invocation_caller("room", "", "A", "current-turn", "message-1");
    let request = PackRequest {
        history: &history,
        room_name: "Team",
        members: std::slice::from_ref(&member),
        current: &member,
        input: "retain this current request",
        prior: &[],
        active_turn: "current-turn",
        caller: &caller,
    };
    let state_json = coordinator.state_json(&history, &caller).unwrap();
    let pack = coordinator.context_pack(&request, &state_json).unwrap();
    assert!(pack.len() <= 600 * 4, "manifest must fit the same budget");
    assert!(pack.contains("retain this current request"));
    assert!(pack.contains("Participants:"));
    assert!(pack.contains(ROOM_MEMORY_TOOL_MANIFEST));
    let _ = fs::remove_dir_all(path);
}

#[test]
fn turn_delta_lists_unseen_peers_and_changed_state_and_rejects_gaps() {
    let path = std::env::temp_dir().join(format!("hivemind-delta-{}", stable_id()));
    let limits = ContextConfig {
        context_target_tokens: 600,
        ..ContextConfig::default()
    };
    let coordinator = ConversationCoordinator::with_store(
        Arc::new(JsonFileStore::new(&path)),
        limits,
        in_memory_memory(),
    );
    let members = [member("A"), member("B")];
    let event = |turn_id: &str, speaker: &str, content: &str| MessageEvent {
        id: stable_id(),
        turn_id: turn_id.into(),
        speaker: speaker.into(),
        agent_instance_id: None,
        legacy_agent_instance_id: None,
        content: content.into(),
        error: false,
    };
    let history = RoomHistory {
        events: vec![
            event("t1", "user", "earlier question"),
            event("t1", "A", "earlier answer"),
            event("t1", "B", "peer answer"),
        ],
        ..RoomHistory::default()
    };
    let caller = invocation_caller("room", "", "A", "t2", "message-1");
    let request = PackRequest {
        history: &history,
        room_name: "Team",
        members: &members,
        current: &members[0],
        input: "next question",
        prior: &[],
        active_turn: "t2",
        caller: &caller,
    };
    let state_json = coordinator.state_json(&history, &caller).unwrap();
    let cursor = TurnView {
        turn_id: "t1".into(),
        speakers: vec!["user".into(), "A".into()],
        state_json: "{\"stale\":true}".into(),
    };
    let delta = coordinator
        .turn_delta(&request, &cursor, &state_json)
        .unwrap();
    assert!(
        delta.contains("Room update since your last reply:\nB: peer answer\n"),
        "{delta}"
    );
    assert!(!delta.contains("A: earlier answer"), "{delta}");
    assert!(
        delta.contains(&format!("\nShared room state:\n{state_json}\n")),
        "{delta}"
    );
    assert!(
        delta.contains("\nCurrent user message:\nnext question\n"),
        "{delta}"
    );
    assert!(delta.contains(SESSION_TOOL_REMINDER), "{delta}");

    let unchanged = TurnView {
        state_json: state_json.clone(),
        ..cursor.clone()
    };
    let delta = coordinator
        .turn_delta(&request, &unchanged, &state_json)
        .unwrap();
    assert!(!delta.contains("Shared room state:"), "{delta}");

    let gap = TurnView {
        turn_id: "missing-turn".into(),
        ..cursor.clone()
    };
    assert!(coordinator
        .turn_delta(&request, &gap, &state_json)
        .is_none());

    let oversized = RoomHistory {
        events: vec![
            event("t1", "user", "earlier question"),
            event("t1", "B", &"x".repeat(4000)),
        ],
        ..RoomHistory::default()
    };
    let request = PackRequest {
        history: &oversized,
        ..request
    };
    assert!(coordinator
        .turn_delta(&request, &cursor, &state_json)
        .is_none());
    let _ = fs::remove_dir_all(path);
}

// ---- Hivemind memory tool bridge ----

/// Invoker with a scripted reply sequence; falls back to plain text.
struct Scripted {
    prompts: Mutex<Vec<String>>,
    replies: Mutex<std::collections::VecDeque<String>>,
}
#[async_trait]
impl AgentInvoker for Scripted {
    async fn cursor(&self, _agent_instance_id: &AgentInstanceId) -> Option<SessionCursor> {
        None
    }

    async fn invoke(&self, request: InvokeRequest<'_>) -> Result<InvokeReply> {
        self.prompts.lock().push(request.full.to_owned());
        tokio::task::yield_now().await;
        let text = match self.replies.lock().pop_front() {
            Some(reply) => reply,
            None => "plain final answer".into(),
        };
        Ok(InvokeReply {
            text,
            epoch_id: "fake".into(),
        })
    }
}
fn scripted(replies: &[&str]) -> Arc<Scripted> {
    Arc::new(Scripted {
        prompts: Mutex::new(Vec::new()),
        replies: Mutex::new(
            replies
                .iter()
                .map(|reply| (*reply).to_owned())
                .collect::<std::collections::VecDeque<_>>(),
        ),
    })
}
fn tool_block(name: &str, args: serde_json::Value) -> String {
    format!("Looking things up.\n```hivemind-tool\n{{\"name\":\"{name}\",\"args\":{args}}}\n```\n")
}
fn tool_call(name: &str, args: serde_json::Value) -> MemoryToolCall {
    MemoryToolCall {
        name: name.to_owned(),
        args,
    }
}

#[tokio::test]
async fn tool_loop_executes_actions_reprompts_and_returns_final_text() {
    let (path, coord) = fixture();
    let add = tool_block(
        "memory.private.add",
        serde_json::json!({
            "content": "websocket auth uses JWT",
            "room_id": "spoofed-room",
            "instance": "spoofed-instance",
            "persona": "spoofed-persona"
        }),
    );
    let search = tool_block(
        "memory.search",
        serde_json::json!({"query": "websocket JWT", "scopes": ["private"]}),
    );
    let f = scripted(&[&add, &search]);
    let members = [member("A")];
    let replies = coord
        .turn(TurnRequest {
            room: "tool-room",
            room_name: "Team",
            group_id: "",
            mode: ConversationMode::Discussion,
            members: &members,
            input: "check memory",
            invoker: f.clone(),
        })
        .await
        .unwrap();
    assert_eq!(replies[0].result.as_deref(), Ok("plain final answer"));
    assert_eq!(f.prompts.lock().len(), 3, "two actions then final text");
    {
        let prompts = f.prompts.lock();
        assert!(prompts[0].contains("Hivemind memory tools"));
        assert!(prompts[1].contains("Memory tool exchange this turn"));
        assert!(prompts[1].contains("stored private memory"));
        assert!(prompts[2].contains("1 memory results:"));
        assert!(prompts[2].contains("[private] websocket auth uses JWT"));
    }
    // Spoofed owner fields in args were ignored: the record is bound to
    // the invocation instance Hivemind created.
    let caller = Caller::agent(
        "tool-room",
        "",
        AgentInstanceId::new("tool-room", "A"),
        "A",
        "A",
    );
    let instance = AgentInstanceId::new("tool-room", "A");
    let found = coord
        .memory()
        .store()
        .records_in_scope(&caller, &Scope::AgentInstance(instance.clone()))
        .unwrap();
    assert_eq!(found.len(), 1);
    assert!(found[0].content.contains("websocket auth uses JWT"));
    let other = Caller::agent(
        "tool-room",
        "",
        AgentInstanceId::new("tool-room", "B"),
        "B",
        "B",
    );
    assert!(coord
        .memory()
        .store()
        .records_in_scope(&other, &Scope::AgentInstance(instance))
        .is_err());
    let _ = fs::remove_dir_all(path);
}

#[cfg(unix)]
#[tokio::test]
async fn tool_loop_enforces_action_cap_before_plain_text() {
    let (path, coord) = fixture();
    let block = tool_block(
        "memory.private.add",
        serde_json::json!({"content": "bounded note"}),
    );
    let f = scripted(&[&block, &block, &block, &block, &block]);
    let members = [member("A")];
    let replies = coord
        .turn(TurnRequest {
            room: "cap-room",
            room_name: "Team",
            group_id: "",
            mode: ConversationMode::Discussion,
            members: &members,
            input: "keep calling",
            invoker: f.clone(),
        })
        .await
        .unwrap();
    let error = replies[0].result.as_ref().unwrap_err();
    assert!(error.contains("memory tool action limit (4)"), "{error}");
    assert_eq!(f.prompts.lock().len(), 5, "four actions then the cap");
    let _ = fs::remove_dir_all(path);
}

#[tokio::test]
async fn malformed_tool_blocks_are_fed_back_not_guessed() {
    let (path, coord) = fixture();
    let broken = "```hivemind-tool\n{\"name\":\n```";
    let f = scripted(&[broken]);
    let members = [member("A")];
    let replies = coord
        .turn(TurnRequest {
            room: "malformed-room",
            room_name: "Team",
            group_id: "",
            mode: ConversationMode::Discussion,
            members: &members,
            input: "go",
            invoker: f.clone(),
        })
        .await
        .unwrap();
    // The parse failure is feedback, so the loop re-prompts; the scripted
    // invoker then falls back to plain text.
    assert_eq!(replies[0].result.as_deref(), Ok("plain final answer"));
    assert_eq!(f.prompts.lock().len(), 2);
    assert!(f.prompts.lock()[1].contains("error: hivemind-tool block is not valid JSON"));
    let _ = fs::remove_dir_all(path);
}

#[test]
fn tool_execution_denies_cross_scope_reads_and_unauthorized_group_writes() {
    let memory = MemoryService::new(MemoryStore::in_memory().unwrap());
    let alice = invocation_caller("room-1", "grp-1", "room-1/Alice", "turn-1", "msg-1");
    let bob = invocation_caller("room-2", "grp-2", "room-2/Bob", "turn-1", "msg-1");

    execute_memory_tool(
        &memory,
        &alice,
        &tool_call(
            "memory.private.add",
            serde_json::json!({"content": "alice private note"}),
        ),
    )
    .unwrap();
    let denied = execute_memory_tool(
        &memory,
        &bob,
        &tool_call(
            "memory.search",
            serde_json::json!({"query": "alice private", "scopes": ["private"]}),
        ),
    )
    .unwrap();
    assert_eq!(denied, "no memory results matched");

    execute_memory_tool(
        &memory,
        &alice,
        &tool_call(
            "memory.group.add",
            serde_json::json!({"content": "grp-1 shared decision"}),
        ),
    )
    .unwrap();
    let cross_group = execute_memory_tool(
        &memory,
        &bob,
        &tool_call(
            "memory.search",
            serde_json::json!({"query": "shared decision", "scopes": ["group"]}),
        ),
    )
    .unwrap();
    assert_eq!(cross_group, "no memory results matched");

    // A route with no configured group has no group scope at all.
    let solo = invocation_caller("solo-room", "", "solo-room/S", "turn-1", "msg-1");
    let group_error = execute_memory_tool(
        &memory,
        &solo,
        &tool_call(
            "memory.group.add",
            serde_json::json!({"content": "no group here"}),
        ),
    )
    .unwrap_err()
    .to_string();
    assert!(group_error.contains("group"), "{group_error}");
    // ...but private writes still work for that caller.
    execute_memory_tool(
        &memory,
        &solo,
        &tool_call(
            "memory.private.add",
            serde_json::json!({"content": "solo private note"}),
        ),
    )
    .unwrap();
}

#[test]
fn proposals_are_policy_gated_and_archive_respects_trust() {
    let memory = MemoryService::new(MemoryStore::in_memory().unwrap());
    let caller = invocation_caller("room-1", "grp-1", "room-1/A", "turn-1", "msg-1");

    let persona = execute_memory_tool(
        &memory,
        &caller,
        &tool_call(
            "memory.persona.propose",
            serde_json::json!({"content": "Engineer prefers small service boundaries"}),
        ),
    )
    .unwrap();
    assert!(persona.starts_with("accepted persona memory"), "{persona}");

    let global_error = execute_memory_tool(
        &memory,
        &caller,
        &tool_call(
            "memory.global.propose",
            serde_json::json!({"content": "Hivemind architecture is final"}),
        ),
    )
    .unwrap_err()
    .to_string();
    assert!(
        global_error.contains("deterministic source"),
        "{global_error}"
    );

    let private = execute_memory_tool(
        &memory,
        &caller,
        &tool_call(
            "memory.private.add",
            serde_json::json!({"content": "archivable note"}),
        ),
    )
    .unwrap();
    let private_id = private
        .split_whitespace()
        .last()
        .expect("result names the id")
        .to_owned();
    execute_memory_tool(
        &memory,
        &caller,
        &tool_call("memory.archive", serde_json::json!({"id": private_id})),
    )
    .unwrap();

    let persona_id = persona
        .split_whitespace()
        .nth(3)
        .expect("result names the id")
        .to_owned();
    let archive_error = execute_memory_tool(
        &memory,
        &caller,
        &tool_call("memory.archive", serde_json::json!({"id": persona_id})),
    )
    .unwrap_err()
    .to_string();
    assert!(archive_error.contains("trusted caller"), "{archive_error}");
}

#[test]
fn unknown_tool_and_unknown_scope_are_rejected() {
    let memory = MemoryService::new(MemoryStore::in_memory().unwrap());
    let caller = invocation_caller("room-1", "grp-1", "room-1/A", "turn-1", "msg-1");
    let unknown = execute_memory_tool(
        &memory,
        &caller,
        &tool_call("memory.drop_everything", serde_json::json!({})),
    )
    .unwrap_err()
    .to_string();
    assert!(unknown.contains("unknown memory tool"));
    let bad_scope = execute_memory_tool(
        &memory,
        &caller,
        &tool_call(
            "memory.search",
            serde_json::json!({"query": "x", "scopes": ["other-group-id"]}),
        ),
    )
    .unwrap_err()
    .to_string();
    assert!(bad_scope.contains("unknown search scope"));
}

#[tokio::test]
async fn context_pack_injects_authorized_hits_and_never_echoes_current_input() {
    let (path, coord) = fixture();
    let seeder = invocation_caller("seed-room", "grp", "S", "seed-turn", "seed-msg");
    coord
        .memory()
        .add_group(
            &seeder,
            MemoryWrite {
                id: None,
                kind: "note".into(),
                content: "Authentication strategy is undecided".into(),
                provenance: Provenance::default(),
                importance: 40,
                supersedes_memory_id: None,
            },
        )
        .unwrap();
    let f = fake(None);
    let members = [member("A")];

    coord
        .turn(TurnRequest {
            room: "grp-room",
            room_name: "Team",
            group_id: "grp",
            mode: ConversationMode::Discussion,
            members: &members,
            input: "authentication strategy?",
            invoker: f.clone(),
        })
        .await
        .unwrap();
    coord
        .turn(TurnRequest {
            room: "fresh-room",
            room_name: "Team",
            group_id: "",
            mode: ConversationMode::Discussion,
            members: &members,
            input: "unique xylophone question",
            invoker: f.clone(),
        })
        .await
        .unwrap();
    coord
        .turn(TurnRequest {
            room: "other-room",
            room_name: "Team",
            group_id: "grp-2",
            mode: ConversationMode::Discussion,
            members: &members,
            input: "authentication strategy",
            invoker: f.clone(),
        })
        .await
        .unwrap();
    {
        let prompts = f.prompts.lock();
        assert!(prompts[0].1.contains("Relevant Hivemind memory:"));
        assert!(prompts[0]
            .1
            .contains("[group] Authentication strategy is undecided"));
        assert!(prompts[0]
            .1
            .contains("(source: room seed-room, turn seed-turn, message seed-msg, actor S)"));
        assert!(prompts[0].1.contains(GROUP_MEMORY_TOOL_MANIFEST));
        // Current-turn input is never echoed back as a memory hit.
        assert!(!prompts[1].1.contains("Relevant Hivemind memory:"));
        // Groupless rooms never advertise group tools.
        assert!(prompts[1].1.contains(ROOM_MEMORY_TOOL_MANIFEST));
        assert!(!prompts[1].1.contains("memory.group."));
        // Another group never sees grp's shared memory.
        assert!(!prompts[2].1.contains("Relevant Hivemind memory:"));
        assert!(prompts[2].1.contains(GROUP_MEMORY_TOOL_MANIFEST));
    }
    let _ = fs::remove_dir_all(path);
}

#[tokio::test]
async fn fresh_agents_all_receive_the_same_hivemind_generated_manifest() {
    let (path, coord) = fixture();
    let f = fake(None);
    let members = [member("A"), member("B")];
    coord
        .turn(TurnRequest {
            room: "guidance-room",
            room_name: "Team",
            group_id: "",
            mode: ConversationMode::Broadcast,
            members: &members,
            input: "hello",
            invoker: f.clone(),
        })
        .await
        .unwrap();
    {
        let prompts = f.prompts.lock();
        assert!(prompts
            .iter()
            .any(|(instance, _)| instance == &AgentInstanceId::new("guidance-room", "A")));
        assert!(prompts
            .iter()
            .any(|(instance, _)| instance == &AgentInstanceId::new("guidance-room", "B")));
        for (_, prompt) in prompts.iter() {
            assert!(prompt.contains(ROOM_MEMORY_TOOL_MANIFEST));
            assert!(prompt.contains("memory.persona.propose"));
        }
        // Both manifests are Hivemind-generated constants, not persona prose.
        assert!(!ROOM_MEMORY_TOOL_MANIFEST.contains("You are "));
        assert!(!GROUP_MEMORY_TOOL_MANIFEST.contains("You are "));
    }
    let _ = fs::remove_dir_all(path);
}

#[tokio::test]
async fn legacy_json_history_migrates_once_into_sqlite_and_json_is_removed() {
    let (path, coord) = fixture();
    let json_path = JsonFileStore::new(&path).room_path("legacy-room");
    JsonFileStore::new(&path)
        .save_room(
            "legacy-room",
            &RoomHistory {
                room_id: "legacy-room".into(),
                events: vec![
                    MessageEvent {
                        id: "old-user".into(),
                        turn_id: "old-turn".into(),
                        speaker: "user".into(),
                        agent_instance_id: None,
                        legacy_agent_instance_id: None,
                        content: "legacy question".into(),
                        error: false,
                    },
                    MessageEvent {
                        id: "old-reply".into(),
                        turn_id: "old-turn".into(),
                        speaker: "A".into(),
                        agent_instance_id: Some(AgentInstanceId::new("legacy-room", "A")),
                        legacy_agent_instance_id: None,
                        content: "legacy answer".into(),
                        error: true,
                    },
                ],
                summary: "legacy summary".into(),
                completed_turns: vec!["old-turn".into()],
                ..RoomHistory::default()
            },
        )
        .unwrap();
    let canonical_json: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&json_path).unwrap()).unwrap();
    assert_eq!(
        canonical_json["events"][1]["agent_instance_identity_version"],
        1
    );
    let canonical = JsonFileStore::new(&path).load_room("legacy-room").unwrap();
    assert_eq!(
        canonical.events[1].agent_instance_id,
        Some(AgentInstanceId::new("legacy-room", "A"))
    );
    fs::write(
        &json_path,
        serde_json::json!({
            "room_id": "legacy-room",
            "events": [
                {
                    "id": "old-user",
                    "turn_id": "old-turn",
                    "speaker": "user",
                    "agent_instance_id": null,
                    "content": "legacy question",
                    "error": false
                },
                {
                    "id": "old-reply",
                    "turn_id": "old-turn",
                    "speaker": "A",
                    "agent_instance_id": "ai1:10:other-room1:x",
                    "content": "legacy answer",
                    "error": true
                }
            ],
            "summary": "legacy summary",
            "completed_turns": ["old-turn"]
        })
        .to_string(),
    )
    .unwrap();
    assert_eq!(
        AgentInstanceId::decode("ai1:10:other-room1:x"),
        Some(AgentInstanceId::new("other-room", "x"))
    );
    let loaded = JsonFileStore::new(&path).load_room("legacy-room").unwrap();
    assert_eq!(
        loaded.events[1].legacy_agent_instance_id.as_deref(),
        Some("ai1:10:other-room1:x")
    );
    assert_eq!(
        loaded.events[1].agent_instance_id,
        Some(AgentInstanceId::new("legacy-room", "A"))
    );
    let loaded_json = serde_json::to_value(&loaded).unwrap();
    assert!(loaded_json["events"][1]
        .get("agent_instance_identity_version")
        .is_none());
    assert!(json_path.exists());

    let history = coord.room_history("legacy-room").unwrap();
    assert_eq!(history.events.len(), 2);
    assert_eq!(history.events[0].content, "legacy question");
    assert!(history.events[1].error);
    assert_eq!(
        history.events[1].agent_instance_id,
        Some(AgentInstanceId::new("legacy-room", "A"))
    );
    assert_eq!(
        history.events[1].legacy_agent_instance_id.as_deref(),
        Some("ai1:10:other-room1:x")
    );
    assert_eq!(
        history.completed_turns,
        [legacy_turn_id("legacy-room", "old-turn")]
    );
    assert_eq!(history.summary, "legacy summary");
    assert!(!json_path.exists(), "migrated JSON must be removed");

    // The migrated history survives in SQLite after the JSON is gone.
    let again = coord.room_history("legacy-room").unwrap();
    assert_eq!(again.events.len(), 2);
    assert_eq!(
        again.events[1].legacy_agent_instance_id.as_deref(),
        Some("ai1:10:other-room1:x")
    );
    assert_eq!(
        again.events[1].agent_instance_id,
        Some(AgentInstanceId::new("legacy-room", "A"))
    );
    let _ = fs::remove_dir_all(path);
}

#[tokio::test]
async fn partial_legacy_import_resumes_without_loss_or_duplicates() {
    let (path, coord) = fixture();
    let room = "legacy-resume";
    let json_store = JsonFileStore::new(&path);
    json_store
        .save_room(
            room,
            &RoomHistory {
                room_id: room.into(),
                events: vec![
                    MessageEvent {
                        id: "e1".into(),
                        turn_id: "t1".into(),
                        speaker: "user".into(),
                        agent_instance_id: None,
                        legacy_agent_instance_id: None,
                        content: "first question".into(),
                        error: false,
                    },
                    MessageEvent {
                        id: "e2".into(),
                        turn_id: "t1".into(),
                        speaker: "A".into(),
                        agent_instance_id: Some(AgentInstanceId::new(room, "A")),
                        legacy_agent_instance_id: None,
                        content: "first answer".into(),
                        error: false,
                    },
                    MessageEvent {
                        id: "e3".into(),
                        turn_id: "t2".into(),
                        speaker: "user".into(),
                        agent_instance_id: None,
                        legacy_agent_instance_id: None,
                        content: "second question".into(),
                        error: false,
                    },
                    MessageEvent {
                        id: "e4".into(),
                        turn_id: "t2".into(),
                        speaker: "A".into(),
                        agent_instance_id: Some(AgentInstanceId::new(room, "A")),
                        legacy_agent_instance_id: None,
                        content: "second answer".into(),
                        error: true,
                    },
                ],
                completed_turns: vec!["t1".into(), "t2".into()],
                summary: "resumed summary".into(),
                ..RoomHistory::default()
            },
        )
        .unwrap();
    let json_path = json_store.room_path(room);
    assert!(json_path.exists());

    // Simulate a crashed first attempt: only the first legacy turn was
    // written, using exactly the stable ids import_legacy computes. The
    // archive is now non-empty, so inferring completion from any single
    // message would skip the import and delete the unimported turns.
    let partial_messages: Vec<ArchivedMessage> = [
        (0usize, "e1", "user", "first question"),
        (1, "e2", "A", "first answer"),
    ]
    .into_iter()
    .map(|(index, id, speaker, content)| ArchivedMessage {
        id: legacy_message_id(room, index, id),
        room_id: room.into(),
        turn_id: legacy_turn_id(room, "t1"),
        speaker: speaker.into(),
        content: content.into(),
        created_at: 0,
    })
    .collect();
    coord
        .memory()
        .append_archive_turn(
            &Caller::trusted_user("test"),
            ArchivedTurn {
                id: legacy_turn_id(room, "t1"),
                room_id: room.into(),
                started_at: 1,
                completed_at: Some(2),
                metadata: serde_json::Value::Null,
                participants: vec![ArchiveParticipant {
                    participant_id: "A".into(),
                    role: None,
                }],
                messages: partial_messages,
            },
        )
        .unwrap();
    assert!(
        !coord
            .memory()
            .recent_messages(&Caller::trusted_user("test"), room, 10)
            .unwrap()
            .is_empty(),
        "preexisting partial archive must exist"
    );

    let history = coord.room_history(room).unwrap();
    assert_eq!(
        history.events.len(),
        4,
        "every legacy turn must survive a resumed import"
    );
    assert_eq!(history.events[0].content, "first question");
    assert_eq!(history.events[1].content, "first answer");
    assert_eq!(history.events[2].content, "second question");
    assert_eq!(history.events[3].content, "second answer");
    assert!(history.events[3].error);
    let mut ids: Vec<String> = history.events.iter().map(|e| e.id.clone()).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 4, "resumed import must not duplicate ids");
    assert_eq!(
        history.completed_turns,
        [legacy_turn_id(room, "t1"), legacy_turn_id(room, "t2")]
    );
    assert_eq!(history.summary, "resumed summary");
    assert!(!json_path.exists(), "file removed only after full success");

    // Idempotent after removal: a reload still returns the full history.
    assert_eq!(coord.room_history(room).unwrap().events.len(), 4);
    let _ = fs::remove_dir_all(path);
}

#[tokio::test]
async fn group_state_persists_across_coordinator_and_store_restarts() {
    let root = std::env::temp_dir().join(format!("hivemind-group-state-{}", stable_id()));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("memory.sqlite3");
    let context = root.join("context");
    let limits = ContextConfig {
        recent_turns: 2,
        summary_max_tokens: 100,
        context_target_tokens: 1000,
        runtime_rotate_tokens: 24000,
        summary_refresh_turns: 2,
    };
    let caller = || {
        Caller::agent(
            "gs-room",
            "gs-group",
            AgentInstanceId::new("gs-room", "A"),
            "A",
            "A",
        )
    };
    {
        let memory = Arc::new(MemoryService::open(&database).unwrap());
        let coord = ConversationCoordinator::new(&context, limits.clone(), memory);
        let members = [member("A")];
        coord
            .turn(TurnRequest {
                room: "gs-room",
                room_name: "Team",
                group_id: "gs-group",
                mode: ConversationMode::Discussion,
                members: &members,
                input: "Decision: use JWT tokens",
                invoker: fake(None),
            })
            .await
            .unwrap();
        let stored = coord
            .memory()
            .group_state(&caller())
            .unwrap()
            .expect("accepted group directive must persist as canonical group state");
        assert!(stored.state.to_string().contains("use JWT tokens"));
    }

    // Fresh coordinator + fresh store connection: group state survives.
    let memory = Arc::new(MemoryService::open(&database).unwrap());
    let coord = ConversationCoordinator::new(&context, limits, memory);
    let stored = coord
        .memory()
        .group_state(&caller())
        .unwrap()
        .expect("group state must survive a store restart");
    assert!(stored.state.to_string().contains("use JWT tokens"));
    let members = [member("A")];
    let f = fake(None);
    coord
        .turn(TurnRequest {
            room: "gs-room",
            room_name: "Team",
            group_id: "gs-group",
            mode: ConversationMode::Discussion,
            members: &members,
            input: "anything",
            invoker: f.clone(),
        })
        .await
        .unwrap();
    let prompts = f.prompts.lock();
    assert!(
        prompts[0].1.contains("Shared room state:"),
        "restarted group caller must load canonical group state into context"
    );
    assert!(prompts[0].1.contains("use JWT tokens"));
    drop(prompts);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn assignment_directive_becomes_a_private_note_for_the_assignee_only() {
    let (path, coord) = fixture();
    let members = [member("A"), member("B")];
    coord
        .turn(TurnRequest {
            room: "assign-room",
            room_name: "Team",
            group_id: "assign-group",
            mode: ConversationMode::Discussion,
            members: &members,
            input: "Assign: B = write docs",
            invoker: fake(None),
        })
        .await
        .unwrap();

    let assignee = Caller::agent(
        "assign-room",
        "assign-group",
        AgentInstanceId::new("assign-room", "B"),
        "B",
        "B",
    );
    let notes = coord
        .memory()
        .store()
        .records_in_scope(
            &assignee,
            &Scope::AgentInstance(AgentInstanceId::new("assign-room", "B")),
        )
        .unwrap();
    assert!(
        notes
            .iter()
            .any(|record| record.kind == "assignment"
                && record.content.contains("Assigned: write docs")),
        "assignee must hold the private L4 assignment note, got {:?}",
        notes
            .iter()
            .map(|r| (&r.kind, &r.content))
            .collect::<Vec<_>>()
    );

    let other = Caller::agent(
        "assign-room",
        "assign-group",
        AgentInstanceId::new("assign-room", "A"),
        "A",
        "A",
    );
    let others_notes = coord
        .memory()
        .store()
        .records_in_scope(
            &other,
            &Scope::AgentInstance(AgentInstanceId::new("assign-room", "A")),
        )
        .unwrap();
    assert!(
        others_notes.is_empty(),
        "assignment must stay private to the assignee: {:?}",
        others_notes
            .iter()
            .map(|r| (&r.kind, &r.content))
            .collect::<Vec<_>>()
    );

    // The group's shared state still records the assignment mapping and
    // attributes the directive's author (the user), not a persona.
    let group = coord
        .memory()
        .group_state(&other)
        .unwrap()
        .expect("group state recorded");
    assert!(group.state.to_string().contains("write docs"));
    assert_eq!(group.updated_by, "user");

    // Reassigning updates the one active note instead of accumulating.
    coord
        .turn(TurnRequest {
            room: "assign-room",
            room_name: "Team",
            group_id: "assign-group",
            mode: ConversationMode::Discussion,
            members: &members,
            input: "Assign: B = write release notes",
            invoker: fake(None),
        })
        .await
        .unwrap();
    let after = coord
        .memory()
        .store()
        .records_in_scope(
            &assignee,
            &Scope::AgentInstance(AgentInstanceId::new("assign-room", "B")),
        )
        .unwrap();
    let active: Vec<_> = after
        .iter()
        .filter(|record| record.kind == "assignment" && record.status == MemoryStatus::Active)
        .collect();
    assert_eq!(active.len(), 1, "exactly one active assignment note");
    assert!(active[0].content.contains("Assigned: write release notes"));
    assert_eq!(active[0].provenance.source_actor.as_deref(), Some("user"));
    assert_eq!(
        active[0].provenance.source_kind.as_deref(),
        Some("structured_project_event")
    );

    // The old assignment text must not remain searchable as active. Query
    // its distinctive term only: partial matches now retrieve on any token.
    let stale = coord
        .memory()
        .search(
            &assignee,
            &SearchRequest {
                query: "docs".into(),
                scopes: vec![SearchScope::Instance],
                limit: 8,
                include_historical: false,
            },
        )
        .unwrap();
    assert!(
        stale.is_empty(),
        "old assignment text must not be active: {:?}",
        stale.iter().map(|r| &r.record.content).collect::<Vec<_>>()
    );
    assert!(
        after
            .iter()
            .all(|record| !record.content.contains("write docs")),
        "old assignment text must not remain stored: {:?}",
        after.iter().map(|r| &r.content).collect::<Vec<_>>()
    );
    let fresh = coord
        .memory()
        .search(
            &assignee,
            &SearchRequest {
                query: "release notes".into(),
                scopes: vec![SearchScope::Instance],
                limit: 8,
                include_historical: false,
            },
        )
        .unwrap();
    assert_eq!(fresh.len(), 1, "current assignment text is searchable");
    let _ = fs::remove_dir_all(path);
}

#[tokio::test]
async fn global_proposal_requires_exact_user_directive_binding() {
    let (path, coord) = fixture();
    let coord = Arc::new(coord);
    let members = [member("A")];
    let exact = "Hivemind runtimes are disposable";
    let turn = |input: &str, invoker: Arc<Scripted>| {
        let members = members.clone();
        let input = input.to_owned();
        let coord = coord.clone();
        async move {
            coord
                .turn(TurnRequest {
                    room: "glob-room",
                    room_name: "Team",
                    group_id: "g-g",
                    mode: ConversationMode::Discussion,
                    members: &members,
                    input: &input,
                    invoker,
                })
                .await
        }
    };

    // Valid: the model proposes exactly the user-authorized content.
    let propose = tool_block(
        "memory.global.propose",
        serde_json::json!({ "content": exact }),
    );
    let f = scripted(&[&propose]);
    turn("Global: Hivemind runtimes are disposable", f.clone())
        .await
        .unwrap();
    {
        let prompts = f.prompts.lock();
        assert!(
            prompts[1].contains("accepted global memory"),
            "exact user-authorized proposal must be accepted: {}",
            prompts[1]
        );
    }
    let reader = Caller::agent(
        "glob-room",
        "g-g",
        AgentInstanceId::new("glob-room", "A"),
        "A",
        "A",
    );
    let globals = coord
        .memory()
        .store()
        .records_in_scope(&reader, &Scope::Hivemind)
        .unwrap();
    assert!(globals.iter().any(|record| record.content.trim() == exact));

    // Mismatched: the directive binds only its exact text.
    let wrong = tool_block(
        "memory.global.propose",
        serde_json::json!({ "content": "Hivemind architecture is final" }),
    );
    let f2 = scripted(&[&wrong]);
    turn("Global: something else entirely", f2.clone())
        .await
        .unwrap();
    {
        let prompts = f2.prompts.lock();
        assert!(
            prompts[1].contains("error:"),
            "mismatched content must be rejected: {}",
            prompts[1]
        );
    }
    let globals = coord
        .memory()
        .store()
        .records_in_scope(&reader, &Scope::Hivemind)
        .unwrap();
    assert_eq!(globals.len(), 1, "mismatch must not create a record");
    assert!(!globals
        .iter()
        .any(|record| record.content.contains("architecture is final")));

    // Unbound: no directive at all can never authorize a global write.
    let f3 = scripted(&[&wrong]);
    turn("plain turn without any directive", f3.clone())
        .await
        .unwrap();
    {
        let prompts = f3.prompts.lock();
        assert!(
            prompts[1].contains("error:"),
            "unbound proposal must be rejected: {}",
            prompts[1]
        );
    }
    let globals = coord
        .memory()
        .store()
        .records_in_scope(&reader, &Scope::Hivemind)
        .unwrap();
    assert_eq!(
        globals.len(),
        1,
        "unbound proposal must not create a record"
    );
    let _ = fs::remove_dir_all(path);
}

#[tokio::test]
async fn room_history_round_trips_through_the_sqlite_file_on_disk() {
    let root = std::env::temp_dir().join(format!("hivemind-sqlite-{}", stable_id()));
    fs::create_dir_all(&root).unwrap();
    let database = root.join("memory.sqlite3");
    let context = root.join("context");
    let limits = ContextConfig {
        recent_turns: 2,
        summary_max_tokens: 100,
        context_target_tokens: 1000,
        runtime_rotate_tokens: 24000,
        summary_refresh_turns: 2,
    };
    {
        let memory = Arc::new(MemoryService::open(&database).unwrap());
        let coord = ConversationCoordinator::new(&context, limits.clone(), memory);
        let f = fake(None);
        let members = [member("A")];
        coord
            .turn(TurnRequest {
                room: "persist-room",
                room_name: "Team",
                group_id: "",
                mode: ConversationMode::Discussion,
                members: &members,
                input: "remember me",
                invoker: f,
            })
            .await
            .unwrap();
    }
    // Fresh connection, fresh coordinator: only SQLite remains.
    let reopened = Arc::new(MemoryService::open(&database).unwrap());
    let coord = ConversationCoordinator::new(&context, limits, reopened);
    let history = coord.room_history("persist-room").unwrap();
    assert_eq!(history.events.len(), 2);
    assert_eq!(history.events[0].content, "remember me");
    assert_eq!(history.events[1].content, "A answered");
    assert_eq!(history.completed_turns.len(), 1);
    let _ = fs::remove_dir_all(root);
}
