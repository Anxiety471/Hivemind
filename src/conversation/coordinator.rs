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

/// Owns durable room history and all turn/context orchestration; runtime sessions are disposable.
pub struct ConversationCoordinator {
    store: Arc<dyn ContextStore>,
    memory: Arc<MemoryService>,
    limits: ContextConfig,
    events: Option<crate::events::EventBus>,
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

/// Earlier same-turn replies (Discussion mode), rendered identically for
/// full packs and deltas.
pub(super) fn same_turn_replies(prior: &[(String, Result<String, String>)]) -> String {
    let peers = prior
        .iter()
        .map(|(name, result)| match result {
            Ok(reply) => format!("{name}: {reply}\n"),
            Err(_) => format!("{name} failed to produce a response for this turn.\n"),
        })
        .collect::<String>();
    if peers.is_empty() {
        String::new()
    } else {
        format!("\nEarlier replies in this turn:\n{peers}")
    }
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
            limits,
            events,
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
            limits,
            events: None,
        }
    }
    /// The shared memory service this coordinator executes tool calls against.
    #[cfg(test)]
    pub fn memory(&self) -> Arc<MemoryService> {
        self.memory.clone()
    }
    pub fn room_history(&self, room: &str) -> Result<RoomHistory> {
        self.store.load_room(room)
    }

    fn save(&self, history: &RoomHistory, room: &str) -> Result<()> {
        self.store.save_room(room, history)
    }

    pub async fn turn(&self, request: TurnRequest<'_>) -> Result<Vec<TurnReply>> {
        self.turn_with_outcome(request)
            .await
            .map(|outcome| outcome.replies)
    }

    pub async fn turn_with_outcome(&self, request: TurnRequest<'_>) -> Result<TurnExecution> {
        let room_id = request.room.to_owned();
        self.turn_internal(request)
            .await
            .map(|(turn_id, replies)| TurnExecution {
                turn_id,
                room_id,
                replies,
            })
    }

    async fn turn_internal(&self, request: TurnRequest<'_>) -> Result<(String, Vec<TurnReply>)> {
        let TurnRequest {
            room,
            room_name,
            group_id,
            mode,
            members,
            input,
            invoker,
        } = request;
        let room_lock = room_mutex(self.store.directory(), room).await?;
        let _in_process = room_lock.lock().await;
        let _file_lock = acquire_file_lock(self.store.directory(), room).await?;
        let mut history = self.room_history(room)?;
        if self.refresh_summary(&mut history) {
            self.save(&history, room)?;
        }
        let turn_id = stable_id();
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
        self.save(&history, room)?;
        // Explicit structured directive from the raw user input only; may
        // authorize exactly one exact-content global proposal this turn.
        let authorized_global = authorized_global_directive(input);
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
                    self.save(&history, room)?;
                    by_name.insert(name, result);
                }
                for member in members {
                    let name = member.agent.name.clone();
                    let result = by_name
                        .remove(&name)
                        .or_else(|| {
                            replies
                                .iter()
                                .find(|reply: &&TurnReply| reply.name == name)
                                .map(|reply| reply.result.clone())
                        })
                        .unwrap_or_else(|| Err("agent task did not return".into()));
                    if !replies.iter().any(|reply| reply.name == name) {
                        replies.push(TurnReply { name, result });
                    }
                }
                replies.sort_by_key(|reply| {
                    members
                        .iter()
                        .position(|member| member.agent.name == reply.name)
                        .unwrap_or(usize::MAX)
                });
            }
            ConversationMode::Discussion => {
                let mut prior = Vec::new();
                for member in members {
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
                    append_reply(&mut history, room, &turn_id, &name, &result);
                    self.save(&history, room)?;
                    prior.push((name.clone(), result.clone()));
                    replies.push(TurnReply { name, result });
                }
            }
        }
        for reply in &replies {
            if !history
                .events
                .iter()
                .any(|event| event.turn_id == turn_id && event.speaker == reply.name)
            {
                append_reply(&mut history, room, &turn_id, &reply.name, &reply.result);
            }
        }
        history.completed_turns.push(turn_id.clone());
        let mut next_state = history.state.clone();
        let state_update = apply_explicit_state_updates(&mut next_state, input).and_then(|()| {
            validate_state(
                &next_state,
                self.limits.context_target_tokens.saturating_mul(2),
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
        self.save(&history, room)?;
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
            caller,
            ..
        } = *request;
        let start = history
            .events
            .iter()
            .position(|event| event.turn_id == cursor.turn_id)?;
        let lines = history.events[start..]
            .iter()
            .filter(|event| event.turn_id != active_turn)
            .filter(|event| {
                event.turn_id != cursor.turn_id || !cursor.speakers.contains(&event.speaker)
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
        delta.push_str(&self.memory_retrieval(caller, input, active_turn));
        delta.push_str(SESSION_TOOL_REMINDER);
        delta.push_str(&format!("\nCurrent user message:\n{input}\n"));
        delta.push_str(&same_turn_replies(prior));
        (delta.len() <= self.limits.context_target_tokens.saturating_mul(4)).then_some(delta)
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
        let identity = format!("You are participating in {room_name}.\n\nParticipants:\n{roster}\n\nYou are {}. Your room role is {}.\n", current.agent.name, current.role.as_deref().or(current.agent.role.as_deref()).unwrap_or("participant"));
        let manifest = format!("\n{}", memory_tool_manifest(caller));
        let state = format!("\nShared room state:\n{state_json}\n");
        let summary = if history.summary.is_empty() {
            String::new()
        } else {
            format!("\nOlder conversation summary:\n{}\n", history.summary)
        };
        let recent = recent_events(&history.events, self.limits.recent_turns, active_turn);
        let recent = if recent.is_empty() {
            String::new()
        } else {
            format!("\nRecent conversation:\n{recent}\n")
        };
        // Bounded retrieval over the caller's authorized scopes only; current-turn
        // messages are excluded so the input is never echoed back as a "memory".
        let hits = self.memory_retrieval(caller, input, active_turn);
        let current = format!("\nCurrent user message:\n{input}\n");
        let same_turn = same_turn_replies(prior);
        let mandatory_len =
            identity.len() + manifest.len() + state.len() + current.len() + same_turn.len();
        // Established byte budget: four times the configured token target,
        // enforced before any optional section is assembled.
        let budget = self.limits.context_target_tokens.saturating_mul(4);
        if mandatory_len > budget {
            bail!("current turn and participant/state context ({mandatory_len} bytes) exceed configured context_target_tokens ({} tokens = {budget} bytes)", self.limits.context_target_tokens);
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

    /// Deterministic, bounded retrieval of authorized group/private/persona/
    /// global/current-room archive results for this agent's own identity.
    /// Search failure or no results inject nothing (the agent is never told
    /// memory was found when it was not).
    fn memory_retrieval(&self, caller: &Caller, input: &str, active_turn: &str) -> String {
        let query = input.trim().to_owned();
        if query.is_empty() {
            return String::new();
        }
        let results = match self.memory.search(
            caller,
            &SearchRequest {
                query,
                scopes: default_search_scopes(caller),
                limit: 8,
                include_historical: false,
            },
        ) {
            Ok(results) => results,
            Err(_) => return String::new(),
        };
        let mut lines = Vec::new();
        for result in results
            .iter()
            .filter(|result| {
                result.record.provenance.source_turn_id.as_deref() != Some(active_turn)
            })
            .take(8)
        {
            lines.push(format!(
                "- [{}] {}{}",
                layer_label(result.record.layer),
                utf8_suffix(&result.record.content, 300),
                source_suffix(&result.record.provenance)
            ));
        }
        if lines.is_empty() {
            return String::new();
        }
        format!("\nRelevant Hivemind memory:\n{}\n", lines.join("\n"))
    }

    fn refresh_summary(&self, history: &mut RoomHistory) -> bool {
        let mut turn_ids = Vec::new();
        let mut seen = HashSet::new();
        for event in &history.events {
            if seen.insert(event.turn_id.as_str()) {
                turn_ids.push(event.turn_id.as_str());
            }
        }
        let archive_count = turn_ids.len().saturating_sub(self.limits.recent_turns);
        if archive_count == 0 {
            return false;
        }
        let completed = history.completed_turns.len();
        let cadence_due =
            completed > 0 && completed.is_multiple_of(self.limits.summary_refresh_turns);
        let raw_window_would_evict_unrepresented_turn =
            archive_count > history.summarized_turn_count;
        if !cadence_due && !raw_window_would_evict_unrepresented_turn {
            return false;
        }
        let archived: HashSet<_> = turn_ids[..archive_count].iter().copied().collect();
        let narrative = history
            .events
            .iter()
            .filter(|event| archived.contains(event.turn_id.as_str()))
            .map(|event| format!("{}: {}", event.speaker, event.content))
            .collect::<Vec<_>>()
            .join("\n");
        history.summary = utf8_suffix(&narrative, self.limits.summary_max_tokens.saturating_mul(4));
        history.summarized_turn_count = archive_count;
        true
    }
}
