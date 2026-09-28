# GOAL — 2026-09-28 — Deterministic Seven-Layer Memory System

## Objective

Build Hivemind's long-term memory as a **deterministic core system that works without any LLM curator**.

An LLM may be added later as an optional enrichment/classification layer, but memory must continue working when:

- no model is configured,
- the configured model is unavailable,
- a free model disappears,
- the provider is offline,
- the user has no remaining provider quota.

The architectural rule is:

```text
Memory must not depend on an LLM to exist.
```

Agents must also explicitly know that Hivemind provides memory tools they can use to:

- search previous memories,
- write private notes,
- write group-shared memory when permitted,
- propose persona memory,
- propose global Hivemind memory,
- inspect relevant stored context.

The runtime may forget.

Hivemind memory must remain available.

---

# Seven-layer memory model

Use this hierarchy:

```text
L1  Harness Working Context
L2  Recent Conversation
L3  Group Shared Memory
L4  Agent Private Memory
L5  Persona Memory
L6  Hivemind Global Memory
L7  Canonical Archive
```

Retrieval/search is **not another layer**.

Retrieval is a mechanism that searches the appropriate layers and injects a small relevant result set into the agent's current context.

---

# L1 — Harness Working Context

L1 is already owned by the active runtime/harness.

Examples:

- Pi session context,
- OMP session context,
- active tool calls,
- current inference state.

Hivemind must not duplicate this layer.

Important rule:

```text
L1 is disposable and non-authoritative.
```

If Pi/OMP is killed and restarted, Hivemind must be able to reconstruct useful context from L2-L7.

---

# L2 — Recent Conversation

L2 contains a bounded raw window of the current conversation.

Scope:

```text
conversation / room
```

Examples:

```text
group:development
solo:maomao
group:security
```

Suggested configuration:

```toml
[memory.recent]
turns = 6
```

Behavior:

- append completed room turns to canonical storage,
- expose only the most recent configured number of turns as L2,
- do not delete older turns when they fall out of L2,
- older turns remain available from L7.

L2 is deterministic.

No model is required.

---

# L3 — Group Shared Memory

L3 contains durable information that all members of one group are allowed to know.

Scope:

```text
group
```

Examples:

```text
Goal:
Build the Hivemind frontend and backend.

Assignments:
Maomao -> Backend
Marin -> Frontend
Albedo -> Architecture review

Decisions:
- Rust backend
- TypeScript frontend
- WebSocket for realtime transport

Open questions:
- Authentication design
```

L3 must support structured categories such as:

- goals,
- decisions,
- assignments,
- blockers,
- open questions,
- completed items,
- durable group notes.

A group cannot read another group's L3 unless an explicit future permission model allows it.

---

# L4 — Agent Private Memory

L4 belongs to one room-specific agent instance.

Scope:

```text
agent_instance
```

Example:

```text
development/Maomao

- I own the backend API.
- Marin is waiting for the auth contract.
- I need to revisit WebSocket authentication.
- I think the current router boundary needs cleanup.
```

Properties:

- only that agent instance reads it automatically,
- other group members do not receive it,
- another instance of the same persona in another room gets a separate L4,
- private notes must never be silently promoted to wider scopes.

Example:

```text
development/Maomao -> private memory A
security/Maomao    -> private memory B
```

---

# L5 — Persona Memory

L5 belongs to the reusable persona across multiple instances.

Scope:

```text
persona
```

Example:

```text
Persona: Maomao

- Backend-focused engineer.
- Familiar with Hivemind architecture.
- Strong preference for simple service boundaries.
- Knows Rust API conventions used by this project.
```

L5 is broader than L4.

Therefore promotion into L5 must be stricter.

Private room information must not automatically become persona-wide knowledge.

Think:

```text
L4 = what this particular instance experienced
L5 = what this persona may generally retain across instances
```

---

# L6 — Hivemind Global Memory

L6 contains durable knowledge that every authorized Hivemind agent may know regardless of room/persona.

Scope:

```text
hivemind
```

Examples:

```text
Project:
- Name: Hivemind
- Core backend: Rust
- Future frontend: TypeScript

Architecture:
- Hivemind owns canonical context.
- Pi and OMP runtimes are disposable.
- HTTP API routes are versioned under /api/v1.
- Group discussions use deterministic speaker ordering.
```

L6 is **not** a dumping ground.

Only project-wide/system-wide durable facts belong here.

Bad L6 examples:

- temporary task assignments,
- one agent's opinion,
- private solo conversation details,
- unconfirmed speculation,
- secrets from one room.

Because L6 affects every future agent, writes to it require the strictest policy checks.

---

# L7 — Canonical Archive

L7 is the durable source of truth.

Everything important is preserved here.

At minimum store:

- rooms,
- turns,
- messages,
- participants,
- memory records,
- memory revisions,
- group state,
- persona memory,
- global memory,
- runtime epochs,
- provenance.

SQLite is preferred initially.

Suggested conceptual tables:

```text
rooms
turns
messages
memories
memory_revisions
group_state
runtime_epochs
```

The exact schema may differ.

Use SQLite FTS5 for initial text search.

Do not require a vector database for this milestone.

---

# Memory scopes

Layers describe how memory is used.

Scopes describe ownership and access.

Support explicit scopes such as:

```text
conversation
group
agent_instance
persona
hivemind
archive
```

Every memory record must have a scope.

Do not infer access merely from where a row happens to be stored.

---

# Provenance

Every promoted memory must preserve where it came from.

Conceptually:

```text
memory_id
layer
scope_type
scope_id
kind
content
source_room_id
source_turn_id
source_message_id
source_actor
created_at
updated_at
status
importance
```

A memory without provenance should be treated as weaker than one tied to canonical evidence.

Do not lose the original source event when memory is promoted or summarized.

---

# Supersession and stale memory

Durable facts change.

Support memory lifecycle states:

```text
active
superseded
archived
```

And where useful:

```text
supersedes_memory_id
```

Example:

```text
Frontend = React
      ↓ superseded
Frontend = Vue
```

Search/retrieval should prefer active memories unless historical results are explicitly requested.

Do not silently delete superseded memories from L7.

---

# Deterministic memory core

The system must work in:

```toml
[memory]
mode = "deterministic"
```

This is the default.

In deterministic mode:

- every canonical message/turn goes to L7,
- the recent window is maintained as L2,
- explicit structured events update L3/L4/L5/L6,
- agents may explicitly use memory tools,
- SQLite FTS5 powers search,
- no LLM is required.

---

# Deterministic placement

Many events already have obvious destinations.

Examples:

| Event | Placement |
| --- | --- |
| room message | L7 + eligible for L2 |
| `task.assigned` | L3 + relevant L4 |
| `group.decision` | L3 |
| private agent note | L4 |
| persona preference/knowledge update | L5 |
| project-wide architectural fact | L6 |
| everything else | L7 only |

Do not invoke an LLM for events whose ownership is structurally obvious.

---

# Structured memory events

Introduce explicit Hivemind memory/domain events.

Examples:

```text
memory.group.add
memory.private.add
memory.persona.propose
memory.global.propose
memory.update
memory.archive
memory.search
```

Structured system events may also map directly into memory:

```text
task.assigned
decision.recorded
blocker.added
task.completed
```

The exact event names may differ.

The important point is that deterministic application events can update memory without transcript interpretation.

---

# Agent memory tools

Agents must know that Hivemind gives them memory capabilities.

Expose a small Hivemind-owned tool interface.

Minimum tool set:

```text
memory.search
memory.private.add
memory.private.update
memory.group.add
memory.group.update
memory.persona.propose
memory.global.propose
memory.archive
```

Optional read helpers:

```text
memory.current_group
memory.current_private
memory.current_persona
memory.current_global
```

Keep the tool surface small.

Do not expose raw SQL.

---

# Agent tool awareness

This is a required part of the milestone.

When Hivemind creates/recreates an agent instance, the generated agent context/tool manifest must explicitly tell the agent:

1. memory tools exist,
2. what each tool is for,
3. which scopes it can access,
4. that searching memory is preferred over pretending to remember,
5. that private/group/persona/global writes have different visibility,
6. that broader memories require stricter validation.

Conceptual injected guidance:

```text
Hivemind Memory Tools

You have access to persistent Hivemind memory.

Use memory.search when relevant information may exist outside your current context.

You may write private notes using memory.private.add.

You may add group-shared information using memory.group.add when the information
belongs to the current group's shared work.

Persona-wide and Hivemind-global memory are broader scopes. Use
memory.persona.propose or memory.global.propose rather than assuming the write
will be accepted.

Do not claim to remember information that is not in current context or returned
by a memory search.
```

This guidance must be generated by Hivemind.

Do not hardcode it independently inside each persona.

---

# Runtime tool bridge

Memory tools belong to Hivemind, not Pi/OMP.

Architecturally:

```text
Agent
  |
Hivemind Tool Bridge
  |
Memory Service
  |
Storage
```

Runtime adapters should only provide the mechanism required to expose/call tools.

Do not implement separate memory logic inside the Pi adapter and OMP adapter.

If one runtime lacks native structured tool calling, use the smallest compatible bridge/protocol while preserving the same Hivemind memory API.

---

# Tool authorization

An agent must not be allowed to write arbitrary scopes.

Examples:

## `memory.private.add`

May write only to the caller's current agent-instance scope.

## `memory.group.add`

May write only to the current group unless explicit authorization exists.

## `memory.persona.propose`

May propose a persona-wide memory for the caller's persona.

Hivemind validates before committing.

## `memory.global.propose`

May propose a global memory.

The agent does not directly force the write.

Hivemind policy decides whether the proposal is accepted.

## `memory.search`

Search only authorized scopes.

An agent in one group must not automatically search another group's private history.

---

# Search

Search must work without an LLM.

Use SQLite FTS5 initially.

Conceptual tool call:

```json
{
  "query": "websocket authentication",
  "scopes": [
    "current_group",
    "current_instance",
    "persona",
    "global",
    "archive"
  ],
  "limit": 8
}
```

Hivemind must enforce which requested scopes are actually accessible.

Results should include provenance.

Example:

```json
{
  "results": [
    {
      "layer": "group",
      "content": "Authentication strategy is still undecided.",
      "room": "development",
      "turn_id": "turn-42"
    }
  ]
}
```

---

# Deterministic ranking

Initial retrieval ranking may use simple factors:

```text
text relevance
+ importance
+ recency
+ scope priority
+ active/superseded status
```

Keep ranking deterministic and testable.

Do not make successful memory search depend on a generative model.

---

# Context integration

Memory retrieval feeds the Context Builder.

An agent invocation may receive:

```text
L2 recent conversation
+
L3 current group memory
+
L4 relevant private memory
+
L5 relevant persona memory
+
L6 relevant global memory
+
selected L7 search evidence
```

Do not inject all stored memory.

Use bounded retrieval.

The context budget from the shared-context milestone remains authoritative.

---

# Explicit memory writes

Agents and future users should be able to create deterministic memories explicitly.

Conceptual agent operations:

```text
memory.private.add("Revisit websocket authentication")
memory.group.add("Maomao owns backend API")
memory.persona.propose("Prefers small service boundaries")
memory.global.propose("Hivemind runtimes are disposable")
```

The first two may be accepted directly when policy allows.

The latter two should pass stricter validation because their scope is broader.

---

# Optional hybrid mode

Support a future/optional mode:

```toml
[memory]
mode = "hybrid"

[memory.curator]
enabled = true
provider = "..."
model = "..."
```

The curator may:

- inspect completed turns,
- propose durable memories,
- suggest memory kind/scope,
- suggest importance,
- suggest supersession.

The curator must **not** own storage.

Pipeline:

```text
Turn/Event
   |
L7 canonical write
   |
deterministic rules
   |
ambiguous candidate?
   |
optional curator
   |
MemoryProposal
   |
Policy Engine
   |
validated memory write
```

If the curator fails, deterministic memory continues operating.

---

# No-model fallback

If no curator/model is available:

```text
L7 continues
L2 continues
explicit L3-L6 writes continue
memory.search continues
agent memory tools continue
```

Only automatic interpretation/promotion of ambiguous transcript content is skipped.

Nothing must be lost.

A future maintenance command may process unclassified historical turns later.

Conceptually:

```text
hivemind memory process-pending
```

This command is optional for this milestone.

---

# Memory policy engine

Create a deterministic policy layer between tool/model proposals and storage.

Conceptually:

```text
MemoryRequest
     |
Policy Engine
     |
     +-- validate caller
     +-- validate scope
     +-- validate target exists
     +-- validate provenance
     +-- reject forbidden escalation
     +-- resolve/update existing memory
     |
Memory Store
```

Broader scopes must be harder to write than narrow scopes.

Suggested principle:

```text
private < group < persona < global
```

Do not base acceptance solely on an LLM-provided confidence number.

---

# Global-memory safeguards

L6 affects the whole hive.

A global memory should normally require at least one of:

- explicit user instruction,
- established Hivemind configuration,
- structured project event,
- an accepted architectural decision,
- another deterministic trusted source.

An agent's unsupported opinion must not automatically become global truth.

---

# Human/user memory commands

Where useful, expose shell commands later through the command system.

Possible shape:

```bash
hivemind memory search "websocket auth"

hivemind memory group development add "JWT selected"
hivemind memory agent Maomao add "Revisit websocket auth"
hivemind memory persona maomao add "Backend specialist"
hivemind memory global add "Core backend is Rust"
```

Do not block the core memory milestone on polishing every CLI command.

The service/tool API comes first.

---

# Storage strategy

Prefer SQLite.

Reasons:

- local,
- zero external service,
- transactional,
- durable,
- FTS5,
- easy room/persona scoping,
- appropriate for the current single-node Hivemind design.

Do not add a vector database in this milestone.

Keep storage behind an abstraction so another backend can be added later.

---

# Suggested modules

A reasonable layout:

```text
src/
  memory/
    mod.rs
    model.rs
    service.rs
    policy.rs
    search.rs
    tools.rs
    context.rs
    store/
      mod.rs
      sqlite.rs
```

Exact names are flexible.

Keep memory logic independent from transport and runtime-specific code.

---

# Concurrent development rule

Other plans are executing concurrently.

Before changing shared files such as:

- `src/main.rs`,
- `src/config.rs`,
- conversation coordinator,
- runtime manager,
- API state,
- tool registration,

re-read the current repository state.

Prefer additive modules and narrow integration points.

Do not overwrite behavior introduced by the shared-context, command, setup, reply-order, or API/WebSocket goals.

---

# Failure behavior

## Storage unavailable

Fail memory writes clearly.

Do not pretend a durable write succeeded.

## Search failure

Agent execution may continue without retrieved memory where safe, but the agent must not be told that memory was found.

## Invalid scope

Reject the operation.

## Unauthorized broader write

Reject or convert it into an allowed proposal path.

## Curator unavailable

Ignore curator enrichment and continue deterministic operation.

## Corrupt/invalid curator output

Reject it before storage.

---

# Tests

Add deterministic tests for:

- L2 recent-window behavior,
- group memory isolation,
- agent-instance private memory isolation,
- persona memory shared across instances,
- global memory visible across authorized agents,
- L7 canonical persistence,
- provenance,
- supersession,
- FTS5 search,
- scope filtering,
- deterministic ranking,
- private memory writes,
- group memory writes,
- persona proposal validation,
- global proposal validation,
- denied cross-group search,
- denied cross-agent private-memory access,
- tool manifest/agent awareness injection,
- fresh runtime receiving memory-tool guidance,
- no-model mode,
- curator failure fallback,
- memory store restart/persistence.

Core tests must not require provider calls.

---

# Acceptance criteria

The goal is complete when:

1. Hivemind implements the seven memory layers with L1 treated as runtime-owned.
2. L2 recent conversation is bounded and deterministic.
3. L3 group memory is isolated per group.
4. L4 private memory is isolated per agent instance.
5. L5 persona memory can be shared across instances of the same persona.
6. L6 global memory is available system-wide subject to policy.
7. L7 stores canonical durable history.
8. SQLite-backed persistence exists.
9. FTS5 memory search works without an LLM.
10. Every promoted memory retains provenance.
11. Superseded memories remain historically available.
12. Agents can call Hivemind memory tools.
13. Agents are explicitly informed that memory tools exist and when to use them.
14. Memory tools are exposed through one Hivemind tool bridge rather than runtime-specific memory implementations.
15. Tool access is scope-authorized.
16. Agents cannot silently read another group's/private agent's memory.
17. Broader persona/global writes are policy-controlled.
18. Deterministic mode works with no model configured.
19. Optional curator failure cannot break memory.
20. Context building injects only bounded relevant memories.
21. Existing Pi/OMP adapters remain disposable.
22. Existing conversation/group work integrates without duplicating memory ownership.
23. `cargo test` passes.
24. `cargo clippy --all-targets --all-features -- -D warnings` passes.

---

# Non-goals

Do not expand this milestone into:

- mandatory LLM memory classification,
- vector databases,
- embeddings,
- semantic RAG,
- cloud memory services,
- cross-user permissions,
- remote memory synchronization,
- autonomous persona rewriting,
- arbitrary raw SQL tools,
- dumping full archive history into prompts.

Those may be layered on later.

---

## Definition of done

Hivemind memory should work like:

```text
                   Hivemind Memory
                         |
     +---------+---------+---------+---------+
     |         |         |         |         |
    L2        L3        L4        L5        L6
 recent     group     private   persona    global
     \         \         |         /         /
      \         \        |        /         /
       +----------+-------+-------+----------+
                          |
                     Memory Search
                          |
                     Context Builder
                          |
                        Agent
                          |
                 Hivemind Memory Tools
                          |
                        L7
                 Canonical Archive
```

The model may help curate memory.

The model must never be required for Hivemind to remember.
