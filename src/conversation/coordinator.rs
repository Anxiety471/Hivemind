use super::*;

pub struct TurnRequest<'a> {
    pub room: &'a str,
    pub room_name: &'a str,
    pub group_id: &'a str,
    pub mode: ConversationMode,
    pub members: &'a [Participant],
    pub input: &'a str,
    pub invoker: Arc<dyn AgentInvoker>,
}

/// A room's own cap on follow-up replies in a Discussion turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FollowUpLimit {
    Limited(usize),
    /// No budget: follow-ups continue until everyone passes, up to a safety ceiling.
    Unlimited,
}

/// Safety ceiling for [`FollowUpLimit::Unlimited`], so two agents tagging each
/// other can never hold a room forever.
pub const UNLIMITED_FOLLOW_UP_CEILING: usize = 200;

impl FollowUpLimit {
    fn budget(self) -> usize {
        match self {
            Self::Limited(n) => n,
            Self::Unlimited => UNLIMITED_FOLLOW_UP_CEILING,
        }
    }
}

/// Looks up the room's own follow-up limit, if one was set.
pub type FollowUpResolver = Arc<dyn Fn(&str) -> Option<FollowUpLimit> + Send + Sync>;

/// Owns durable room history and all turn/context orchestration; runtime sessions are disposable.
pub struct ConversationCoordinator {
    store: Arc<dyn ContextStore>,
    memory: Arc<MemoryService>,
    limits: std::sync::RwLock<ContextConfig>,
    events: Option<crate::events::EventBus>,
    lock_dir: std::sync::OnceLock<PathBuf>,
    tools: std::sync::OnceLock<Arc<dyn ToolHost>>,
    access: std::sync::OnceLock<Arc<crate::access::AccessPolicy>>,
    mention_limit: std::sync::OnceLock<usize>,
    follow_up_override: std::sync::OnceLock<FollowUpResolver>,
}

pub(super) struct PackRequest<'a> {
    pub(super) history: &'a RoomHistory,
    pub(super) room_name: &'a str,
    pub(super) members: &'a [Participant],
    pub(super) current: &'a Participant,
    pub(super) input: &'a str,
    pub(super) prior: &'a [(String, Result<String, String>)],
    pub(super) active_turn: &'a str,
    pub(super) caller: &'a Caller,
    /// Pre-rendered "Relevant Hivemind memory" block, retrieved once per member.
    pub(super) retrieval: &'a str,
    /// Open-floor follow-up: the member may answer exactly `PASS` to stay silent.
    pub(super) optional: bool,
    /// Remaining follow-up replies allowed for this turn.
    pub(super) remaining_budget: Option<usize>,
}

/// Prompts prepared for one member's invocation this turn.
pub(super) struct MemberPrompt {
    /// Self-contained Context Pack used whenever the runtime (re)hydrates.
    pack: String,
    /// `(epoch_id, text)` continuation for the live session, when buildable.
    delta: Option<(String, String)>,
    /// Room view the session holds after it replies.
    view: TurnView,
}

/// Delta sections cannot restate the manifest; they point back at it.
pub(super) const SESSION_TOOL_REMINDER: &str =
    "\nHivemind memory tools remain available exactly as described at the start of this session.\n";

/// Earlier same-turn replies (Discussion mode) plus, for an open-floor
/// follow-up, the permission to PASS. Rendered identically for full packs and
/// deltas.
pub(super) fn same_turn_replies(
    prior: &[(String, Result<String, String>)],
    optional: bool,
    remaining_budget: Option<usize>,
) -> String {
    let peers = prior
        .iter()
        .map(|(name, result)| match result {
            Ok(reply) => format!("{name}: {reply}\n"),
            Err(_) => format!("{name} failed to produce a response for this turn.\n"),
        })
        .collect::<String>();
    let mut out = if peers.is_empty() {
        String::new()
    } else {
        format!("\nEarlier replies in this turn:\n{peers}")
    };
    if optional {
        out.push_str(&format!("\nYou already replied in this turn; the floor is open for a follow-up. Reply again only if you have something worth adding — a rebuttal, correction, or answer to a point raised since your last reply. Otherwise reply with exactly {PASS} and nothing else.\n"));
    }
    if let Some(remaining) = remaining_budget {
        if remaining == 0 {
            out.push_str("\nNote: No follow-up replies remain for this turn. Please finish what you are doing and conclude without expecting further replies from other members.\n");
        } else if remaining <= 2 {
            let s = if remaining == 1 {
                "reply remains"
            } else {
                "replies remain"
            };
            out.push_str(&format!("\nNote: Only {remaining} follow-up {s} for this turn. Please finish what you are doing and conclude the discussion.\n"));
        }
    }
    out
}

/// What an open-floor member answers to stay silent; never recorded.
const PASS: &str = "PASS";

/// Whether an open-floor reply declined to speak.
fn is_pass(text: &str) -> bool {
    let text = text
        .trim()
        .trim_matches(|c: char| c == '*' || c == '`' || c == '.');
    text.is_empty() || text.eq_ignore_ascii_case(PASS)
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '-'
}

/// Whether `rest` (the text after an `@`) starts with `name`, ending at a word boundary.
fn name_follows(rest: &str, name: &str) -> bool {
    rest.get(..name.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(name))
        && !rest[name.len()..].chars().next().is_some_and(is_word)
}

/// Indices of members `@Name`d in `text`, in order of first mention.
pub(super) fn mentioned_members(text: &str, members: &[Participant]) -> Vec<usize> {
    let mut found = Vec::new();
    for (at, _) in text.match_indices('@') {
        if text[..at].chars().next_back().is_some_and(is_word) {
            continue;
        }
        let rest = &text[at + 1..];
        let best = members
            .iter()
            .enumerate()
            .filter(|(_, m)| name_follows(rest, &m.agent.name))
            .max_by_key(|(_, m)| m.agent.name.len());
        if let Some((index, _)) = best {
            if !found.contains(&index) {
                found.push(index);
            }
        }
    }
    found
}

impl ConversationCoordinator {
    /// SQLite (L7 archive) is the single source of truth for room history;
    /// `memory` is the one service opened at process startup.
    pub fn new(
        directory: impl Into<PathBuf>,
        limits: ContextConfig,
        memory: Arc<MemoryService>,
    ) -> Self {
        Self::new_with_events(directory, limits, memory, None)
    }
    pub fn new_with_events(
        directory: impl Into<PathBuf>,
        limits: ContextConfig,
        memory: Arc<MemoryService>,
        events: Option<crate::events::EventBus>,
    ) -> Self {
        Self {
            store: Arc::new(SqliteContextStore::new(directory, memory.clone())),
            memory,
            limits: std::sync::RwLock::new(limits),
            events,
            lock_dir: std::sync::OnceLock::new(),
            tools: std::sync::OnceLock::new(),
            access: std::sync::OnceLock::new(),
            mention_limit: std::sync::OnceLock::new(),
            follow_up_override: std::sync::OnceLock::new(),
        }
    }
    #[cfg(test)]
    pub fn with_store(
        store: Arc<dyn ContextStore>,
        limits: ContextConfig,
        memory: Arc<MemoryService>,
    ) -> Self {
        Self {
            store,
            memory,
            limits: std::sync::RwLock::new(limits),
            events: None,
            lock_dir: std::sync::OnceLock::new(),
            tools: std::sync::OnceLock::new(),
            access: std::sync::OnceLock::new(),
            mention_limit: std::sync::OnceLock::new(),
            follow_up_override: std::sync::OnceLock::new(),
        }
    }
    /// Install the extra tool surface offered beside memory tools. Set once at startup.
    pub fn set_tools(&self, host: Arc<dyn ToolHost>) {
        let _ = self.tools.set(host);
    }
    /// Install the persona access policy that gates memory writes. Set once at startup.
    pub fn set_access(&self, policy: Arc<crate::access::AccessPolicy>) {
        let _ = self.access.set(policy);
    }
    /// Per-room overrides of the follow-up budget. Set once at startup.
    pub fn set_follow_up_resolver(&self, resolver: FollowUpResolver) {
        let _ = self.follow_up_override.set(resolver);
    }

    /// Context budgets for the next turn. A turn already being built keeps the limits it started with.
    pub fn set_limits(&self, limits: ContextConfig) {
        *self.limits.write().expect("context limits lock poisoned") = limits;
    }
    /// Extra mention-triggered replies a Discussion turn may add. Set once at startup.
    pub fn set_mention_limit(&self, limit: usize) {
        let _ = self.mention_limit.set(limit);
    }

    /// Effective follow-up budget for a room: per-room override if set, else global mention limit.
    pub fn follow_up_budget(&self, room: &str) -> usize {
        self.follow_up_override
            .get()
            .and_then(|resolve| resolve(room))
            .map(FollowUpLimit::budget)
            .unwrap_or_else(|| self.mention_limit.get().copied().unwrap_or(0))
    }
    /// The shared memory service this coordinator executes tool calls against.
    #[cfg(test)]
    pub fn memory(&self) -> Arc<MemoryService> {
        self.memory.clone()
    }
    pub fn room_history(&self, room: &str) -> Result<RoomHistory> {
        self.store.load_room(room)
    }

    /// Load a room for one turn; pair with `store.release` after the last save.
    fn checkout(&self, room: &str) -> Result<RoomHistory> {
        self.store.checkout(room)
    }

    pub async fn turn(&self, request: TurnRequest<'_>) -> Result<Vec<TurnReply>> {
        self.turn_with_outcome(request)
            .await
            .map(|outcome| outcome.replies)
    }

    pub async fn turn_with_outcome(&self, request: TurnRequest<'_>) -> Result<TurnExecution> {
        self.turn_with_id(request, None).await
    }

    pub(crate) async fn turn_with_id(
        &self,
        request: TurnRequest<'_>,
        id: Option<&str>,
    ) -> Result<TurnExecution> {
        let room_id = request.room.to_owned();
        self.turn_internal(request, id)
            .await
            .map(|(turn_id, replies)| TurnExecution {
                turn_id,
                room_id,
                replies,
            })
    }

    async fn turn_internal(
        &self,
        request: TurnRequest<'_>,
        id: Option<&str>,
    ) -> Result<(String, Vec<TurnReply>)> {
        let TurnRequest {
            room,
            room_name,
            group_id,
            mode,
            members,
            input,
            invoker,
        } = request;
        let room_lock = room_mutex(self.lock_directory()?, room).await?;
        let _in_process = room_lock.lock().await;
        let _file_lock = acquire_file_lock(self.store.directory(), room).await?;
        let mut history = self.checkout(room)?;
        if self.refresh_summary(&mut history) {
            self.store.save_changes(
                room,
                &history,
                &Changes {
                    turn: None,
                    snapshot: true,
                },
            )?;
        }
        let mut saved = history.events.len();
        let turn_id = id.map(str::to_owned).unwrap_or_else(stable_id);
        if let Some(events) = &self.events {
            events.publish(crate::events::DomainEventKind::TurnStarted {
                turn_id: turn_id.clone(),
                room_id: room.to_owned(),
            });
        }
        let user_message_id = stable_id();
        history.events.push(MessageEvent {
            id: user_message_id.clone(),
            turn_id: turn_id.clone(),
            speaker: "user".into(),
            agent_instance_id: None,
            legacy_agent_instance_id: None,
            content: input.into(),
            error: false,
        });
        self.save_turn(&history, room, &turn_id, &mut saved, false, false)?;
        // Explicit structured directive from the raw user input only; may
        // authorize exactly one exact-content global proposal this turn.
        let host = self.tools.get().cloned();
        let access = self.access.get().cloned();
        let agent_input = host
            .as_ref()
            .is_some_and(|host| host.agent_originated(room));
        let authorized_global = if agent_input {
            None
        } else {
            authorized_global_directive(input)
        };
        // Archive hits depend only on the room and the input, so one search
        // serves every member of this turn.
        let shared_archive = members
            .first()
            .map(|member| {
                self.archive_retrieval(
                    &invocation_caller(
                        room,
                        group_id,
                        &member.agent.name,
                        &turn_id,
                        &user_message_id,
                    ),
                    input,
                )
            })
            .unwrap_or_default();
        let mut replies = Vec::with_capacity(members.len());
        match mode {
            ConversationMode::Broadcast => {
                let mut jobs = JoinSet::new();
                let mut task_names = HashMap::new();
                for member in members {
                    let caller = invocation_caller(
                        room,
                        group_id,
                        &member.agent.name,
                        &turn_id,
                        &user_message_id,
                    );
                    let instance_id = AgentInstanceId::new(room, &member.agent.name);
                    let cursor = invoker.cursor(&instance_id).await;
                    let retrieval =
                        self.memory_retrieval(&caller, input, &turn_id, &shared_archive);
                    let prompt = self.member_prompt(
                        &PackRequest {
                            history: &history,
                            room_name,
                            members,
                            current: member,
                            input,
                            prior: &[],
                            active_turn: &turn_id,
                            caller: &caller,
                            retrieval: &retrieval,
                            optional: false,
                            remaining_budget: None,
                        },
                        cursor,
                    );
                    let (name, prompt) = match prompt {
                        Ok(prompt) => (member.agent.name.clone(), prompt),
                        Err(error) => {
                            let name = member.agent.name.clone();
                            if let Some(events) = &self.events {
                                events.publish(crate::events::DomainEventKind::AgentReplyStarted {
                                    turn_id: turn_id.clone(),
                                    room_id: room.to_owned(),
                                    agent_id: name.clone(),
                                    agent_instance_id: instance_id.clone(),
                                });
                                events.publish(crate::events::DomainEventKind::AgentReplyFailed {
                                    turn_id: turn_id.clone(),
                                    room_id: room.to_owned(),
                                    agent_id: name.clone(),
                                    agent_instance_id: instance_id,
                                    error_code: "context_build_failed".into(),
                                    message: "agent context could not be built".into(),
                                });
                            }
                            replies.push(TurnReply {
                                name,
                                result: Err(format!("context pack: {error:#}")),
                            });
                            continue;
                        }
                    };
                    if let Some(events) = &self.events {
                        events.publish(crate::events::DomainEventKind::AgentReplyStarted {
                            turn_id: turn_id.clone(),
                            room_id: room.to_owned(),
                            agent_id: name.clone(),
                            agent_instance_id: AgentInstanceId::new(room, &name),
                        });
                    }
                    let invoker = invoker.clone();
                    let agent = member.agent.clone();
                    let room = room.to_owned();
                    let memory = self.memory.clone();
                    let authorized_global = authorized_global.clone();
                    let host = host.clone();
                    let access = access.clone();
                    let task_name = name.clone();
                    let handle = jobs.spawn(async move {
                        let MemberPrompt { pack, delta, view } = prompt;
                        let instance_id = AgentInstanceId::new(&room, &agent.name);
                        let result = invoke_with_memory(
                            &*invoker,
                            &instance_id,
                            &agent,
                            &pack,
                            delta
                                .as_ref()
                                .map(|(epoch_id, text)| PromptDelta { epoch_id, text }),
                            &view,
                            &caller,
                            &memory,
                            authorized_global.as_deref(),
                            host.as_deref(),
                            access.as_deref(),
                        )
                        .await
                        .map_err(|e| format!("{e:#}"));
                        (name, result)
                    });
                    task_names.insert(handle.id(), task_name);
                }
                let mut by_name = HashMap::new();
                while let Some(joined) = jobs.join_next_with_id().await {
                    let (name, result) = match joined {
                        Ok((id, (name, result))) => {
                            task_names.remove(&id);
                            (name, result)
                        }
                        Err(error) => {
                            let name = task_names
                                .remove(&error.id())
                                .unwrap_or_else(|| "unknown agent".into());
                            (name, Err(format!("agent task failed: {error}")))
                        }
                    };
                    if let Some(events) = &self.events {
                        let instance_id = AgentInstanceId::new(room, &name);
                        let event = if result.is_ok() {
                            crate::events::DomainEventKind::AgentReplyCompleted {
                                turn_id: turn_id.clone(),
                                room_id: room.to_owned(),
                                agent_id: name.clone(),
                                agent_instance_id: instance_id,
                            }
                        } else {
                            crate::events::DomainEventKind::AgentReplyFailed {
                                turn_id: turn_id.clone(),
                                room_id: room.to_owned(),
                                agent_id: name.clone(),
                                agent_instance_id: instance_id,
                                error_code: "agent_reply_failed".into(),
                                message: "agent failed to produce a reply".into(),
                            }
                        };
                        events.publish(event);
                    }
                    append_reply(&mut history, room, &turn_id, &name, &result);
                    self.save_turn(&history, room, &turn_id, &mut saved, false, false)?;
                    by_name.insert(name, result);
                }
                for member in members {
                    let name = member.agent.name.clone();
                    let result = by_name
                        .remove(&name)
                        .unwrap_or_else(|| Err("agent task did not return".into()));
                    replies.push(TurnReply { name, result });
                }
            }
            ConversationMode::Discussion => {
                let mut prior = Vec::new();
                // Every member replies once, in order. An @mention in a reply gives that
                // member a further reply unless one is already pending. Once the queue is
                // empty the floor opens: the others, in order after the last speaker, may
                // follow up or answer PASS, until all of them pass in a row. Mention and
                // floor replies share one budget so the exchange always ends.
                let mut queue: std::collections::VecDeque<usize> = (0..members.len()).collect();
                let mut extra = self.follow_up_budget(room);
                let mut initial_pending = members.len();
                let mut last_speaker = None;
                let mut passes = 0;
                loop {
                    let (index, floor) = if let Some(index) = queue.pop_front() {
                        (index, false)
                    } else if let (Some(last), true) =
                        (last_speaker, extra > 0 && passes + 1 < members.len())
                    {
                        ((last + 1 + passes) % members.len(), true)
                    } else {
                        break;
                    };
                    initial_pending = initial_pending.saturating_sub(1);
                    let remaining_budget =
                        Some(extra + queue.len().saturating_sub(initial_pending));
                    let member = &members[index];
                    let caller = invocation_caller(
                        room,
                        group_id,
                        &member.agent.name,
                        &turn_id,
                        &user_message_id,
                    );
                    let name = member.agent.name.clone();
                    let instance_id = AgentInstanceId::new(room, &name);
                    if let Some(events) = &self.events {
                        events.publish(crate::events::DomainEventKind::AgentReplyStarted {
                            turn_id: turn_id.clone(),
                            room_id: room.to_owned(),
                            agent_id: name.clone(),
                            agent_instance_id: instance_id.clone(),
                        });
                    }
                    let cursor = invoker.cursor(&instance_id).await;
                    let retrieval =
                        self.memory_retrieval(&caller, input, &turn_id, &shared_archive);
                    let result = match self.member_prompt(
                        &PackRequest {
                            history: &history,
                            room_name,
                            members,
                            current: member,
                            input,
                            prior: &prior,
                            active_turn: &turn_id,
                            caller: &caller,
                            retrieval: &retrieval,
                            optional: floor,
                            remaining_budget,
                        },
                        cursor,
                    ) {
                        Ok(MemberPrompt { pack, delta, view }) => invoke_with_memory(
                            &*invoker,
                            &instance_id,
                            &member.agent,
                            &pack,
                            delta
                                .as_ref()
                                .map(|(epoch_id, text)| PromptDelta { epoch_id, text }),
                            &view,
                            &caller,
                            &self.memory,
                            authorized_global.as_deref(),
                            host.as_deref(),
                            access.as_deref(),
                        )
                        .await
                        .map_err(|e| format!("{e:#}")),
                        Err(error) => Err(format!("context pack: {error:#}")),
                    };
                    if let Some(events) = &self.events {
                        let event = if result.is_ok() {
                            crate::events::DomainEventKind::AgentReplyCompleted {
                                turn_id: turn_id.clone(),
                                room_id: room.to_owned(),
                                agent_id: name.clone(),
                                agent_instance_id: instance_id.clone(),
                            }
                        } else {
                            crate::events::DomainEventKind::AgentReplyFailed {
                                turn_id: turn_id.clone(),
                                room_id: room.to_owned(),
                                agent_id: name.clone(),
                                agent_instance_id: instance_id.clone(),
                                error_code: "agent_reply_failed".into(),
                                message: "agent failed to produce a reply".into(),
                            }
                        };
                        events.publish(event);
                    }
                    // A declined (or failed) floor reply is dropped: nobody asked for it.
                    if floor && result.as_ref().map_or(true, |text| is_pass(text)) {
                        passes += 1;
                        continue;
                    }
                    if floor {
                        extra -= 1;
                    }
                    passes = 0;
                    last_speaker = Some(index);
                    append_reply(&mut history, room, &turn_id, &name, &result);
                    self.save_turn(&history, room, &turn_id, &mut saved, false, false)?;
                    prior.push((name.clone(), result.clone()));
                    if let Ok(text) = &result {
                        replies.push(TurnReply {
                            name: name.clone(),
                            result: result.clone(),
                        });
                        for target in mentioned_members(text, members) {
                            if target == index || queue.contains(&target) {
                                continue;
                            }
                            if extra > 0 {
                                queue.push_back(target);
                                extra -= 1;
                            }
                        }
                        continue;
                    }
                    replies.push(TurnReply { name, result });
                }
            }
        }
        for reply in &replies {
            if !history
                .events
                .iter()
                .rev()
                .take_while(|event| event.turn_id == turn_id)
                .any(|event| event.speaker == reply.name)
            {
                append_reply(&mut history, room, &turn_id, &reply.name, &reply.result);
            }
        }
        history.completed_turns.push(turn_id.clone());
        let mut next_state = history.state.clone();
        let state_update =
            apply_explicit_state_updates(&mut next_state, if agent_input { "" } else { input })
                .and_then(|()| {
                    validate_state(
                        &next_state,
                        self.limits
                            .read()
                            .expect("context limits lock poisoned")
                            .context_target_tokens
                            .saturating_mul(2),
                    )
                });
        if let Err(error) = state_update {
            record_maintenance_error(
                &mut history,
                format!("state update rejected for turn {turn_id}: {error:#}"),
            );
        } else {
            if !group_id.is_empty() {
                // Explicit assignments are user directives: a host caller
                // with structured-project-event provenance, actor "user",
                // bound to the assignee's instance. Solo/main rooms stay
                // room-scoped and never write these notes.
                for (persona, task) in next_state.assignments.iter() {
                    if history.state.assignments.get(persona) == Some(task)
                        || !members.iter().any(|member| member.agent.name == *persona)
                    {
                        continue;
                    }
                    let assignee =
                        user_directive_caller(room, group_id, persona, &turn_id, &user_message_id);
                    let note = MemoryWrite {
                        id: None,
                        kind: "assignment".into(),
                        content: format!("Assigned: {task}"),
                        provenance: Provenance::default(),
                        importance: 60,
                        supersedes_memory_id: None,
                    };
                    if let Err(error) = replace_active_assignment(&self.memory, &assignee, note) {
                        record_maintenance_error(
                            &mut history,
                            format!("assignment note for '{persona}' rejected: {error:#}"),
                        );
                    }
                }
                // Group rooms persist accepted directives as canonical group
                // state, attributed to the directive's author: the user.
                let group_caller =
                    user_directive_caller(room, group_id, "", &turn_id, &user_message_id);
                if let Err(error) = self
                    .memory
                    .set_group_state(&group_caller, serde_json::to_value(&next_state)?)
                {
                    record_maintenance_error(
                        &mut history,
                        format!("group state update rejected: {error:#}"),
                    );
                }
            }
            history.state = next_state;
        }
        self.refresh_summary(&mut history);
        self.save_turn(&history, room, &turn_id, &mut saved, true, true)?;
        self.store.release(room, history);
        if let Some(events) = &self.events {
            events.publish(crate::events::DomainEventKind::TurnCompleted {
                turn_id: turn_id.clone(),
                room_id: room.to_owned(),
                reply_count: replies.len(),
            });
        }
        Ok((turn_id, replies))
    }

    /// Serialized shared state shown to `caller`: canonical group state for
    /// group callers, the room-scoped conversation snapshot otherwise.
    pub(super) fn state_json(&self, history: &RoomHistory, caller: &Caller) -> Result<String> {
        let state_value = if caller.group_id.is_empty() {
            serde_json::to_value(&history.state)?
        } else {
            match self.memory.group_state(caller) {
                Ok(Some(record)) => record.state,
                _ => serde_json::to_value(&history.state)?,
            }
        };
        Ok(serde_json::to_string(&state_value)?)
    }

    /// Full pack, optional epoch-bound delta, and the room view the member's
    /// session holds once it replies.
    fn member_prompt(
        &self,
        request: &PackRequest<'_>,
        cursor: Option<SessionCursor>,
    ) -> Result<MemberPrompt> {
        let state_json = self.state_json(request.history, request.caller)?;
        let pack = self.context_pack(request, &state_json)?;
        let delta = cursor.and_then(|cursor| {
            self.turn_delta(request, &cursor.view, &state_json)
                .map(|text| (cursor.epoch_id, text))
        });
        let mut speakers = Vec::with_capacity(request.prior.len() + 2);
        speakers.push("user".to_owned());
        speakers.extend(request.prior.iter().map(|(name, _)| name.clone()));
        speakers.push(request.current.agent.name.clone());
        Ok(MemberPrompt {
            pack,
            delta,
            view: TurnView {
                turn_id: request.active_turn.to_owned(),
                speakers,
                state_json,
            },
        })
    }

    /// Room delta for a live session whose view is `cursor`, or `None` when
    /// the session cannot be continued (its view fell out of history, or the
    /// delta would exceed the context budget) and must rehydrate.
    pub(super) fn turn_delta(
        &self,
        request: &PackRequest<'_>,
        cursor: &TurnView,
        state_json: &str,
    ) -> Option<String> {
        let PackRequest {
            history,
            input,
            prior,
            active_turn,
            retrieval,
            optional,
            remaining_budget,
            ..
        } = *request;
        let last = history
            .events
            .iter()
            .rposition(|event| event.turn_id == cursor.turn_id)?;
        let start = history.events[..last]
            .iter()
            .rposition(|event| event.turn_id != cursor.turn_id)
            .map_or(0, |index| index + 1);
        let lines = history.events[start..]
            .iter()
            .filter(|event| event.turn_id != active_turn)
            .filter({
                // Each earlier occurrence in the view hides one event, so a
                // speaker who replied in several rounds is not over-matched.
                let mut seen = cursor.speakers.clone();
                move |event| {
                    if event.turn_id != cursor.turn_id {
                        return true;
                    }
                    match seen.iter().position(|s| *s == event.speaker) {
                        Some(index) => {
                            seen.swap_remove(index);
                            false
                        }
                        None => true,
                    }
                }
            })
            .map(|event| format!("{}: {}", event.speaker, event.content))
            .collect::<Vec<_>>()
            .join("\n");
        let mut delta = String::new();
        if !lines.is_empty() {
            delta.push_str(&format!("Room update since your last reply:\n{lines}\n"));
        }
        if state_json != cursor.state_json {
            delta.push_str(&format!("\nShared room state:\n{state_json}\n"));
        }
        delta.push_str(retrieval);
        delta.push_str(SESSION_TOOL_REMINDER);
        if let Some(reminder) = self
            .tools
            .get()
            .and_then(|host| host.reminder(&request.caller.room_id, &request.caller.persona_id))
        {
            delta.push_str(&reminder);
        }
        delta.push_str(&format!("\nCurrent user message:\n{input}\n"));
        delta.push_str(&same_turn_replies(prior, optional, remaining_budget));
        (delta.len()
            <= self
                .limits
                .read()
                .expect("context limits lock poisoned")
                .context_target_tokens
                .saturating_mul(4))
        .then_some(delta)
    }

    pub(super) fn context_pack(
        &self,
        request: &PackRequest<'_>,
        state_json: &str,
    ) -> Result<String> {
        let PackRequest {
            history,
            room_name,
            members,
            current,
            input,
            prior,
            active_turn,
            caller,
            retrieval,
            optional,
            remaining_budget,
        } = *request;
        let roster = members
            .iter()
            .map(|p| {
                format!(
                    "- {} — {}",
                    p.agent.name,
                    p.role
                        .as_deref()
                        .or(p.agent.role.as_deref())
                        .unwrap_or("participant")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let mention_hint = if members.len() > 1 {
            "This is a group conversation with the other participants listed above, and every participant replies to each user message. Speak as yourself and from your role: build on, question, or correct what teammates said. When you challenge a teammate or ask them something, write @Name so they get to answer; after everyone has replied, others may also follow up on their own.\n"
        } else {
            ""
        };
        let identity = format!("You are participating in {room_name}.\n\nParticipants:\n{roster}\n\nYou are {}. Your room role is {}.\n{mention_hint}", current.agent.name, current.role.as_deref().or(current.agent.role.as_deref()).unwrap_or("participant"));
        let extra = self
            .tools
            .get()
            .and_then(|host| host.manifest(&caller.room_id, &caller.persona_id))
            .unwrap_or_default();
        let manifest = format!("\n{}{extra}", memory_tool_manifest(caller));
        let state = format!("\nShared room state:\n{state_json}\n");
        let summary = if history.summary.is_empty() {
            String::new()
        } else {
            format!("\nOlder conversation summary:\n{}\n", history.summary)
        };
        let recent = recent_events(
            &history.events,
            self.limits
                .read()
                .expect("context limits lock poisoned")
                .recent_turns,
            active_turn,
        );
        let recent = if recent.is_empty() {
            String::new()
        } else {
            format!("\nRecent conversation:\n{recent}\n")
        };
        // Bounded retrieval over the caller's authorized scopes only; current-turn
        // messages are excluded so the input is never echoed back as a "memory".
        let hits = retrieval;
        let current = format!("\nCurrent user message:\n{input}\n");
        let same_turn = same_turn_replies(prior, optional, remaining_budget);
        let mandatory_len =
            identity.len() + manifest.len() + state.len() + current.len() + same_turn.len();
        // Established byte budget: four times the configured token target,
        // enforced before any optional section is assembled.
        let budget = self
            .limits
            .read()
            .expect("context limits lock poisoned")
            .context_target_tokens
            .saturating_mul(4);
        if mandatory_len > budget {
            bail!("current turn and participant/state context ({mandatory_len} bytes) exceed configured context_target_tokens ({} tokens = {budget} bytes)", self.limits.read().expect("context limits lock poisoned").context_target_tokens);
        }
        let available = budget - mandatory_len;
        let mut optional = format!("{summary}{recent}{hits}");
        if optional.len() > available {
            let keep_recent = recent.len().min(available);
            let keep_summary = available.saturating_sub(keep_recent);
            optional = format!(
                "{}{}",
                utf8_suffix(&summary, keep_summary),
                utf8_suffix(&recent, keep_recent)
            );
        }
        Ok(format!(
            "{identity}{manifest}{state}{optional}{current}{same_turn}"
        ))
    }

    /// Archive hits for this turn's input. Identical for every member (same
    /// room, same query, current turn excluded), so it is searched once per
    /// turn and shared. One extra row covers the active turn's own message.
    fn archive_retrieval(&self, caller: &Caller, input: &str) -> Vec<SearchResult> {
        let query = input.trim();
        if query.is_empty() {
            return Vec::new();
        }
        self.memory
            .search(
                caller,
                &SearchRequest {
                    query: query.to_owned(),
                    scopes: vec![SearchScope::Archive],
                    limit: 9,
                    include_historical: false,
                },
            )
            .unwrap_or_default()
    }

    /// Deterministic, bounded retrieval of authorized group/private/persona/
    /// global results for this agent's own identity merged with the turn's
    /// shared current-room archive hits. Search failure or no results inject
    /// nothing (the agent is never told memory was found when it was not).
    fn memory_retrieval(
        &self,
        caller: &Caller,
        input: &str,
        active_turn: &str,
        shared_archive: &[SearchResult],
    ) -> String {
        let query = input.trim().to_owned();
        if query.is_empty() {
            return String::new();
        }
        let scopes = default_search_scopes(caller)
            .into_iter()
            .filter(|scope| *scope != SearchScope::Archive)
            .collect();
        let mut results = self
            .memory
            .search(
                caller,
                &SearchRequest {
                    query,
                    scopes,
                    limit: 8,
                    include_historical: false,
                },
            )
            .unwrap_or_default();
        results.extend(shared_archive.iter().cloned());
        results.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.record.id.cmp(&b.record.id))
        });
        let lines: Vec<String> = results
            .iter()
            .filter(|result| {
                result.record.provenance.source_turn_id.as_deref() != Some(active_turn)
            })
            .take(8)
            .map(|result| memory_result_line(&result.record))
            .collect();
        if lines.is_empty() {
            return String::new();
        }
        format!("\nRelevant Hivemind memory:\n{}\n", lines.join("\n"))
    }

    fn refresh_summary(&self, history: &mut RoomHistory) -> bool {
        let mut turn_count = 0usize;
        let mut last: Option<&str> = None;
        for event in &history.events {
            if last != Some(event.turn_id.as_str()) {
                turn_count += 1;
                last = Some(event.turn_id.as_str());
            }
        }
        let archive_count = turn_count.saturating_sub(
            self.limits
                .read()
                .expect("context limits lock poisoned")
                .recent_turns,
        );
        if archive_count == 0 {
            return false;
        }
        let completed = history.completed_turns.len();
        let cadence_due = completed > 0
            && completed.is_multiple_of(
                self.limits
                    .read()
                    .expect("context limits lock poisoned")
                    .summary_refresh_turns,
            );
        let raw_window_would_evict_unrepresented_turn =
            archive_count > history.summarized_turn_count;
        if !cadence_due && !raw_window_would_evict_unrepresented_turn {
            return false;
        }
        // Events of one turn are contiguous, so the archived prefix ends where
        // turn number `archive_count` begins.
        let mut cut = history.events.len();
        let mut seen = 0;
        let mut last: Option<&str> = None;
        for (index, event) in history.events.iter().enumerate() {
            if last != Some(event.turn_id.as_str()) {
                if seen == archive_count {
                    cut = index;
                    break;
                }
                seen += 1;
                last = Some(event.turn_id.as_str());
            }
        }
        // The summary is the last `cap` bytes of the archived narrative, so
        // walk the archived events newest-first and stop once that much text
        // is collected instead of formatting the whole history.
        let cap = self
            .limits
            .read()
            .expect("context limits lock poisoned")
            .summary_max_tokens
            .saturating_mul(4);
        let mut lines = Vec::new();
        let mut collected = 0usize;
        for event in history.events[..cut].iter().rev() {
            let line = format!("{}: {}", event.speaker, event.content);
            collected += line.len() + 1;
            lines.push(line);
            if collected > cap {
                break;
            }
        }
        lines.reverse();
        history.summary = utf8_suffix(&lines.join("\n"), cap);
        history.summarized_turn_count = archive_count;
        true
    }

    /// Persist what changed in the active turn: events from `*saved` on, its
    /// completion, and optionally the state snapshot.
    fn save_turn(
        &self,
        history: &RoomHistory,
        room: &str,
        turn_id: &str,
        saved: &mut usize,
        completed: bool,
        snapshot: bool,
    ) -> Result<()> {
        self.store.save_changes(
            room,
            history,
            &Changes {
                turn: Some(TurnChange {
                    turn_id,
                    events_from: *saved,
                    completed,
                }),
                snapshot,
            },
        )?;
        *saved = history.events.len();
        Ok(())
    }

    /// Canonical context directory, created and resolved once per coordinator.
    fn lock_directory(&self) -> Result<&Path> {
        if let Some(directory) = self.lock_dir.get() {
            return Ok(directory);
        }
        let directory = canonical_store_dir(self.store.directory())?;
        Ok(self.lock_dir.get_or_init(|| directory))
    }
}
