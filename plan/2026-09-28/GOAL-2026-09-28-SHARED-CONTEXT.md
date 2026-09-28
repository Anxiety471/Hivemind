# GOAL — 2026-09-28 — Shared Turn Context and Group Awareness

## Objective

Make Hivemind own conversation context so agents can participate in real group chats without relying on ever-growing Pi/OMP session history.

The system must support:

- multiple independent group chats,
- variable/config-driven group awareness,
- reusable personas,
- fresh runtime instances per room/persona instance,
- shared same-turn context,
- bounded model context,
- long-running conversations without uncontrolled context growth.

The core architectural rule is:

```text
Hivemind owns memory and conversation state.
Pi / OMP sessions are disposable execution caches.
```

Do not make runtime session history the source of truth.

---

# Problem

The current multi-agent flow can route one user turn to multiple agents, but each agent effectively behaves as if it is alone.

Example:

```text
User: who should do frontend or backend?

Maomao: I can help with both...
Albedo: I can help with both...
```

The agents do not know:

- who else is in the room,
- what role each participant has,
- who speaks before/after them,
- what another agent already said in the same turn.

A naive fix would be to keep one giant persistent runtime session and continuously append the entire group transcript.

Do not do that.

That approach creates context rot, escalating token usage, stale instructions, and increasingly noisy model state.

---

# Core architecture

Separate these concepts:

```text
Persona
   |
   +--> Agent Instance (room A) --> Pi/OMP process
   |
   +--> Agent Instance (room B) --> Pi/OMP process
   |
   +--> Agent Instance (solo)   --> Pi/OMP process
```

A persona is configuration.

An agent instance is a runtime-bound participant inside one conversation.

A group chat is a Hivemind-owned conversation room.

A Pi/OMP process is disposable compute attached to an agent instance.

---

# Persona model

Create a reusable persona definition.

Conceptually:

```toml
[[personas]]
id = "maomao"
name = "Maomao"
role = "Backend Engineer"
runtime = "pi"
model = "provider/model"
reasoning = "high"
system_prompt = """
You are Maomao, a backend-focused software engineer.
"""
```

A persona may participate in multiple rooms.

Each participation creates a separate agent instance and therefore a fresh runtime/session.

Example:

```text
development room
  -> maomao persona
  -> AgentInstance development/maomao
  -> Pi process #41

architecture room
  -> maomao persona
  -> AgentInstance architecture/maomao
  -> Pi process #57
```

The two instances must not share runtime context.

---

# Group configuration

Groups must be variable/config-driven.

Example:

```toml
[[groups]]
id = "development"
name = "Development Team"
mode = "discussion"

[[groups.members]]
persona = "maomao"
role = "Backend Engineer"

[[groups.members]]
persona = "marin"
role = "Frontend Engineer"

[[groups.members]]
persona = "albedo"
role = "Architecture Reviewer"
```

Another room may reuse the same personas with different membership or roles:

```toml
[[groups]]
id = "review"
name = "Review Board"
mode = "broadcast"

[[groups.members]]
persona = "albedo"
role = "Lead Reviewer"

[[groups.members]]
persona = "maomao"
role = "Implementation Reviewer"
```

Do not hardcode group awareness into persona system prompts.

Hivemind must build room awareness dynamically from configuration.

---

# Conversation modes

Support at least two group execution modes.

## Broadcast mode

All participating agents receive the same turn context and may execute concurrently.

```text
User
 ├─ Agent A
 ├─ Agent B
 └─ Agent C
```

Agents know who else is in the room, but they do not see other agents' replies from the same turn.

Use this for:

- independent opinions,
- reviews,
- brainstorming,
- parallel analysis.

Broadcast mode should preserve async execution.

## Discussion mode

Agents speak in deterministic reply order.

Each later speaker receives the replies already produced earlier in the same turn.

```text
User
  ↓
Agent A
  ↓
Agent B sees A
  ↓
Agent C sees A + B
```

Use this for actual collaboration.

Discussion mode is intentionally sequential within one turn because a later agent cannot see an earlier agent's answer before that answer exists.

Do not fake concurrency here.

---

# Room-owned canonical history

Every room must have a canonical event/message history owned by Hivemind.

Conceptually:

```text
Room: development

Turn 1
  user: ...
  maomao: ...
  marin: ...
  albedo: ...

Turn 2
  user: ...
  maomao: ...
  marin: ...
  albedo: ...
```

The runtime session history is not authoritative.

If Pi/OMP crashes or is rotated, Hivemind must still retain the room conversation.

Use stable identifiers for:

- room,
- turn,
- message/event,
- persona,
- agent instance.

---

# Context store

Introduce a Hivemind-owned context store abstraction.

Conceptually:

```rust
trait ContextStore {
    async fn append_event(...);
    async fn recent_turns(...);
    async fn load_room_state(...);
    async fn save_room_state(...);
    async fn load_summary(...);
    async fn save_summary(...);
}
```

The exact API may differ.

For the first implementation, use a durable local store if practical.

SQLite is preferred because Hivemind will need:

- multiple rooms,
- ordered turns/messages,
- state snapshots,
- summaries,
- future retrieval/search.

If SQLite would create excessive conflict with concurrently changing code, isolate the storage boundary first and provide a minimal local implementation, but do not couple the context builder directly to runtime memory.

---

# Shared structured room state

Maintain compact structured state for each room.

This is separate from the raw transcript.

Example:

```json
{
  "goal": "Build frontend and backend for the dashboard",
  "decisions": [
    "Backend exposes REST API",
    "Frontend uses React",
    "Authentication uses JWT"
  ],
  "assignments": {
    "Maomao": "Backend API",
    "Marin": "Frontend UI",
    "Albedo": "Architecture review"
  },
  "open_questions": [
    "WebSocket event schema is undecided"
  ],
  "completed": [
    "Database schema approved"
  ]
}
```

This shared blackboard exists so agents do not need to infer current project state from hundreds of old messages.

The schema may evolve, but keep it explicit and serializable.

At minimum support:

- current goal,
- decisions,
- assignments,
- open questions,
- completed items.

Do not trust arbitrary runtime session memory to preserve these facts.

---

# Rolling summary

Each room should maintain a compact rolling summary of older discussion.

Example:

```text
The group chose Rust for the Hivemind core and TypeScript for the future UI.
Pi is the lightweight runtime while OMP remains supported.
Maomao owns backend API work and Marin owns frontend work.
Albedo reviews architectural boundaries.
```

The rolling summary is conversational compression.

It must not replace structured room state.

Use:

```text
structured state -> facts / decisions / assignments
rolling summary  -> compressed narrative context
```

Avoid endless summary-of-summary degradation.

When refreshing the summary, prefer summarizing from canonical source turns plus the previous stable state rather than recursively compressing text forever.

---

# Recent raw turn window

Keep a configurable number of recent turns verbatim.

Example:

```toml
[context]
recent_turns = 6
```

Recent raw messages preserve nuance that a summary loses.

The context builder should include these recent turns before reaching into older history.

Do not feed the entire canonical transcript by default.

---

# Current turn context

The current turn must remain raw and unsummarized.

In discussion mode:

```text
User:
Build the login system.

Maomao:
I'll implement the auth endpoints.

Marin:
I'll build the login UI against those endpoints.
```

When Albedo is next, Hivemind must include both earlier same-turn responses.

The current turn transcript grows only until the turn finishes.

Afterward it becomes part of canonical room history.

---

# Context Pack

Before invoking any agent instance, Hivemind builds a bounded Context Pack.

Conceptually:

```text
1. Persona identity
2. Group awareness
3. Shared structured room state
4. Rolling summary
5. Recent raw turns
6. Current user message
7. Earlier same-turn replies, when discussion mode
8. Current speaker identity/role
```

Example group-awareness block:

```text
You are participating in the Development Team.

Participants:
- Maomao — Backend Engineer
- Marin — Frontend Engineer
- Albedo — Architecture Reviewer

You are Marin.
Your room role is Frontend Engineer.

The user is speaking to the group.
You are not the only agent present.
```

This block must be generated dynamically from current room configuration.

---

# Context budget

Context construction must be bounded.

Add configurable limits.

Example:

```toml
[context]
recent_turns = 6
summary_max_tokens = 2000
context_target_tokens = 12000
runtime_rotate_tokens = 24000
```

Exact defaults may be adjusted after implementation.

The important behavior is:

- do not blindly append all history,
- reserve room for the current user turn and model response,
- trim/compress old context before hitting provider limits,
- keep current-turn content higher priority than old narrative history.

If exact provider token counting is unavailable, use a deterministic approximation initially and isolate the budgeting logic so provider-aware counting can replace it later.

---

# Runtime instance lifecycle

Agent identity must survive runtime replacement.

Conceptually:

```text
AgentInstance development/maomao
      |
      +-- Runtime Epoch 1 -> Pi process #41
      |
      +-- Runtime Epoch 2 -> Pi process #72
```

When the runtime context approaches the configured rotation threshold:

1. persist canonical turn history,
2. refresh room state,
3. refresh rolling summary if required,
4. cleanly stop the old Pi/OMP process,
5. create a fresh runtime process,
6. rebuild the Context Pack,
7. continue with the same Hivemind agent instance identity.

The user should not experience the runtime replacement as a new persona.

Do not silently rotate in the middle of an active model response.

---

# Fresh runtime per room/persona instance

A persona used in multiple rooms must spawn independent runtimes.

Example:

```text
persona: Maomao

development
  -> fresh Pi process

review
  -> fresh Pi process

solo
  -> fresh Pi process
```

No runtime session may be shared across rooms.

This is necessary for context isolation.

A future optimization may suspend/restart inactive instances using Hivemind context rehydration.

Correct isolation comes before process reuse.

---

# Shared-turn coordinator

Introduce a room/turn coordinator above AgentManager.

Conceptually:

```text
ConversationCoordinator
    |
    +-- resolve room
    +-- resolve participants
    +-- create turn ID
    +-- build base shared context
    +-- dispatch broadcast OR discussion flow
    +-- append canonical events
    +-- update room state/summary
    +-- complete turn
```

Runtime adapters must not implement room logic.

---

# Broadcast turn algorithm

Conceptually:

```text
create turn
   |
build shared base Context Pack
   |
spawn prompts concurrently
   |
collect responses
   |
present in deterministic reply order
   |
append responses to canonical turn
   |
update room memory
```

Every participant receives:

- persona,
- group awareness,
- shared room state,
- summary,
- recent turns,
- current user message.

They do not receive same-turn peer replies.

---

# Discussion turn algorithm

Conceptually:

```text
create turn
   |
for speaker in reply_order:
    build Context Pack
      + current user turn
      + replies already produced this turn

    invoke speaker
    append response to current turn
   |
complete canonical turn
   |
update room memory
```

Later speakers must see earlier speakers' current-turn replies.

Do not dispatch all speakers concurrently in discussion mode.

---

# Updating shared state

Do not let every agent independently rewrite room state.

Use one controlled Hivemind memory-update step after a turn.

Possible initial strategy:

1. deterministic extraction where fields are explicit,
2. one configured summarizer/memory-maintainer persona/model when interpretation is needed,
3. validate the resulting structured state before replacing the prior snapshot.

Keep memory maintenance separate from normal agent personas where practical.

Do not expose arbitrary model-generated state directly as trusted application configuration.

---

# Summary refresh policy

Do not regenerate the rolling summary after every message unless necessary.

Use a policy such as:

- refresh after N completed turns,
- or refresh when recent raw context crosses a threshold,
- or refresh before runtime rotation.

The policy must be configurable/testable.

Summary generation failures must not destroy canonical history.

---

# Retrieval boundary

Design storage so older history can later be searched and selectively reintroduced.

Future behavior:

```text
User asks about an old decision
      |
retrieve relevant archived turns
      |
inject selected evidence into Context Pack
```

Do not require semantic/vector retrieval for this milestone unless it is trivial to add cleanly.

The current goal is bounded shared context, not a full RAG system.

---

# Multiple group chats

Hivemind must support multiple rooms simultaneously.

Each room owns:

- configuration,
- members,
- mode,
- canonical history,
- shared state,
- rolling summary,
- recent-turn window,
- independent agent instances.

Example:

```text
development
  Maomao -> Pi #41
  Marin  -> Pi #42

review
  Maomao -> Pi #57
  Albedo -> OMP #58
```

The Maomao instances are separate despite sharing one persona definition.

---

# Solo conversations

Treat solo chats as one-member conversation rooms internally where practical.

This gives solo chats the same:

- canonical history,
- summary,
- recent-window logic,
- runtime rotation,
- persistence model.

Avoid building an entirely separate memory architecture for solo mode.

---

# Configuration validation

At startup/config load validate:

- unique persona IDs,
- valid group IDs,
- every group member references a known persona,
- no duplicate member instance unless explicitly supported,
- valid room mode: `broadcast` or `discussion`,
- reply order only references actual room participants,
- context limits are positive and internally sensible.

Fail clearly before runtime startup when possible.

---

# Failure handling

## Agent failure in broadcast mode

Record an agent-attributed failure in the current turn.

Other agents may still complete.

Do not reorder replies because one failed early.

## Agent failure in discussion mode

Record the failure in the failed speaker's slot.

Later speakers may continue and should receive a compact marker such as:

```text
Maomao failed to produce a response for this turn.
```

Do not invent a fake reply.

## Memory update failure

Canonical turn history must remain intact.

Keep the previous valid room state/summary and report/log the failed maintenance step.

Memory compaction failure must never erase source history.

## Runtime crash

A runtime crash may be restarted only if Hivemind clearly knows whether the active turn can be safely retried.

Do not pretend lost in-process context survived.

For later turns, a fresh runtime may be rehydrated from Hivemind-owned Context Packs.

---

# API/WebSocket compatibility

The concurrently developed API/WebSocket layer should eventually expose room and turn events from this architecture.

Design internal events so future transport events can represent:

```text
conversation.turn.started
agent.reply.started
agent.reply.completed
agent.error
conversation.turn.completed
room.state.updated
runtime.rotated
```

Do not make this goal depend on the API milestone finishing first.

Do not place WebSocket-specific types inside the conversation core.

---

# Concurrent-development rule

Several plans are currently being implemented in parallel.

Before modifying shared files such as:

- `src/main.rs`,
- `src/config.rs`,
- runtime manager code,
- group/command models,
- API shared state,

re-read the current repository state.

Prefer additive modules and narrow integration commits.

Do not overwrite another goal's newly added behavior.

---

# Suggested module boundaries

A reasonable structure is:

```text
src/
  persona/
  conversation/
    mod.rs
    room.rs
    turn.rs
    coordinator.rs
    context_builder.rs
    memory.rs
    store.rs
  runtime/
    ...
```

If SQLite is used:

```text
src/
  storage/
    sqlite.rs
```

Exact names are flexible.

Keep conversation logic independent from Pi/OMP protocol details.

---

# Acceptance criteria

The goal is complete when:

1. Persona definitions are separate from runtime agent instances.
2. The same persona can participate in multiple rooms using independent runtime processes.
3. Hivemind supports multiple group chats at the same time.
4. Group awareness is generated dynamically from config/room state.
5. Agents know the names/roles of other participants.
6. Broadcast mode keeps independent agents concurrent.
7. Discussion mode is sequential in deterministic reply order.
8. Later discussion speakers receive earlier same-turn replies.
9. Every room has canonical Hivemind-owned turn/message history.
10. Runtime session memory is not the canonical conversation store.
11. Every room maintains structured shared state.
12. Every room maintains a bounded rolling summary.
13. Every invocation includes only a bounded recent raw-turn window.
14. Current-turn messages are never prematurely summarized.
15. A Context Pack is generated for each agent invocation.
16. Context Pack construction obeys configurable context limits.
17. Runtime processes can be replaced without changing persona/agent-instance identity.
18. Runtime rotation rehydrates the agent from Hivemind-owned context.
19. No runtime process is shared across separate rooms.
20. Solo conversations can use the same room/context architecture.
21. Memory-maintenance failure cannot delete canonical history.
22. Group/room configuration is validated before use.
23. Existing Pi and OMP adapters remain behind runtime boundaries.
24. Existing command/API work is integrated without duplicating room logic.
25. `cargo test` passes.
26. `cargo clippy --all-targets --all-features -- -D warnings` passes.

---

# Tests to add

Add deterministic tests for:

- persona -> multiple independent agent instances,
- separate runtime instances for the same persona in two rooms,
- group-awareness rendering,
- room-role overrides,
- broadcast context equality across participants,
- broadcast concurrency,
- discussion sequential ordering,
- same-turn response injection,
- canonical history persistence,
- recent-turn truncation,
- rolling-summary inclusion,
- structured room-state inclusion,
- context-budget trimming priorities,
- runtime rotation and rehydration,
- room isolation,
- solo-room behavior,
- agent failure in broadcast mode,
- agent failure in discussion mode,
- summary/state update failure preserving canonical history,
- invalid persona/group references,
- mixed Pi/OMP room membership.

Use fake runtimes and deterministic fixtures.

Do not require paid provider calls for core tests.

---

# Non-goals

Do not expand this milestone into:

- vector databases,
- semantic embeddings,
- full RAG,
- autonomous agent spawning,
- automatic team formation,
- agent voting/debate frameworks,
- remote distributed workers,
- multi-user permissions,
- provider billing/token accounting,
- frontend UI,
- Internet-facing authentication.

Those can build on top of this context architecture later.

---

## Definition of done

The architecture should behave like:

```text
                       Hivemind
                          |
                +---------+---------+
                |                   |
             Personas          Conversation Rooms
                                    |
                 +------------------+------------------+
                 |                  |                  |
             Canonical          Shared State      Rolling Summary
              History               |                  |
                 +------------------+------------------+
                                    |
                              Context Builder
                                    |
                        +-----------+-----------+
                        |                       |
                   recent turns            current turn
                        |                       |
                        +-----------+-----------+
                                    |
                              Context Pack
                                    |
                              Agent Instance
                                    |
                           disposable Pi / OMP
```

The runtime may forget.

Hivemind must not.
