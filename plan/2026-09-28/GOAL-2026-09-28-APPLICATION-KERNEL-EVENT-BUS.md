# GOAL — 2026-09-28 — Application Kernel and Event Bus

## Objective

Introduce one authoritative **Hivemind application kernel** so the CLI, HTTP API, WebSocket layer, memory system, conversation system, and future frontend all operate through the same core services instead of gradually becoming separate implementations of "what Hivemind is."

Also introduce a typed internal **Event Bus** for live domain events.

The architectural rule is:

```text
Interfaces do not own Hivemind behavior.
HivemindCore owns application behavior.
```

Target:

```text
                   Interfaces
          CLI        HTTP        WebSocket
           \          |          /
            \         |         /
             +------------------+
             |   HivemindCore   |
             +--------+---------+
                      |
       +--------------+---------------+
       |              |               |
 Conversation       Memory           Tools
       |              |               |
       +--------------+---------------+
                      |
                  EventBus
                      |
                RuntimeManager
                  /       \
                Pi         OMP
```

This is an architectural consolidation milestone.

Do not use it to invent autonomous orchestration behavior.

---

# Current repository state

At the time this goal was written, the repository already has:

- Pi and OMP runtime adapters,
- `AgentManager`,
- deterministic reply ordering,
- `hivemind init`,
- `hivemind doctor`,
- interactive CLI chat,
- loopback HTTP API,
- WebSocket transport,
- API routes under `/api/v1`,
- a dedicated `hivemind-server` binary.

However, application ownership is still split.

The CLI currently creates and owns `AgentManager` directly.

The API currently owns cloned `HivemindConfig` state and exposes transport endpoints independently.

`src/lib.rs` currently exports only API/config modules.

That is acceptable for the proof of concept, but it becomes dangerous once shared-context, groups, memory, tools, tasks, and streaming begin landing.

Before implementing this goal, **re-read the current tree** because several other plans are executing concurrently.

If another task has already introduced a core/service boundary, extend it rather than creating a competing one.

---

# What HivemindCore is

Create one application-level object representing a running Hivemind process.

Conceptually:

```rust
pub struct HivemindCore {
    config: Arc<HivemindConfig>,
    events: EventBus,

    // progressively integrated services
    agents: AgentRegistry,
    conversations: ConversationService,
    memory: MemoryService,
    tools: ToolRegistry,
    runtimes: RuntimeManager,
}
```

The exact fields must match whichever concurrently implemented services actually exist.

Do not create fake placeholder subsystems merely to satisfy this diagram.

The important properties are:

- interfaces depend on the core,
- core services are shared,
- runtime-specific details stay below the core,
- core state is not duplicated independently in CLI/API/WebSocket code.

---

# Core ownership boundary

The application kernel should own or coordinate:

- loaded/validated application configuration,
- agent/persona registry,
- room/conversation service,
- runtime manager,
- memory service when available,
- tool registry when available,
- event bus,
- application shutdown.

It should **not** own:

- terminal rendering,
- HTTP request parsing,
- WebSocket frame parsing,
- Axum-specific response types,
- Clap-specific argument types,
- Pi JSON-RPC wire details,
- OMP RPC wire details.

Keep transport and runtime protocol concerns at the edges.

---

# Do not turn HivemindCore into a god object

The kernel coordinates services.

It must not become one 4,000-line struct with methods for every feature.

Prefer:

```text
HivemindCore
   |
   +-- agents()
   +-- conversations()
   +-- memory()
   +-- tools()
   +-- events()
   +-- runtimes()
```

or equivalent service access/application methods.

Application behavior should live in domain/service modules.

The core is the composition root and lifecycle owner.

---

# Suggested module layout

A reasonable target:

```text
src/
  lib.rs

  core/
    mod.rs
    builder.rs
    lifecycle.rs

  events/
    mod.rs
    event.rs
    bus.rs

  conversation/
    ...

  memory/
    ...

  tools/
    ...

  runtime/
    ...
```

Exact filenames are flexible.

Do not move every file purely for aesthetic reasons.

Prefer incremental extraction.

---

# Library boundary

Move reusable application modules behind the library crate.

The binaries should become thin entry points.

Conceptually:

```rust
use hivemind::{
    core::HivemindCore,
    config::HivemindConfig,
};
```

The CLI binary should not maintain a second private copy of runtime/config modules using local `mod` declarations once the library exposes the authoritative modules.

Likewise, the API binary should use the same core.

---

# Core construction

Provide a clear construction path.

Conceptually:

```rust
let config = HivemindConfig::load(path)?;
let core = HivemindCore::new(config).await?;
```

or:

```rust
let core = HivemindCore::builder(config)
    .build()
    .await?;
```

Do not require provider/model calls just to construct the core.

This is important because commands such as:

```text
hivemind doctor
hivemind agents
GET /api/v1/health
GET /api/v1/info
```

must remain cheap and available without starting every model runtime.

Runtime startup should be explicit or lazy behind the runtime service.

---

# Runtime lifecycle

The current CLI eagerly starts one worker/session per configured agent.

The new kernel must preserve correct cleanup while allowing future room-specific instances and lazy server behavior.

The kernel/runtime service should support operations conceptually like:

```text
ensure_agent_instance(...)
prompt_agent(...)
prompt_agents(...)
shutdown_instance(...)
shutdown_all(...)
```

Do not force the API health endpoint to spawn Pi/OMP.

Do not create duplicate runtime processes because two internal services independently decided to "own" the same agent instance.

Runtime identity should eventually follow the shared-context architecture:

```text
persona + room/instance identity -> runtime instance
```

If the shared-context goal has not landed yet, preserve current agent semantics while designing the boundary so room-specific instances can replace them later.

---

# One authoritative registry/state

Agent metadata must have one source inside the core.

The CLI, API, and WebSocket layers should query the same registry/service.

Example:

```text
CLI /agents
GET /api/v1/agents
future frontend agent list
```

must not each independently re-derive agent state from raw config.

Static configuration may still be stored in `HivemindConfig`, but effective runtime/application state should be resolved through core services.

---

# Event Bus

Introduce an internal typed event bus.

Purpose:

- decouple producers from observers,
- allow CLI/WebSocket/logging/memory to observe the same domain events,
- provide one live event vocabulary,
- prevent WebSocket-specific event types from leaking into application logic.

The event bus is **not** the source of truth.

It is a live notification mechanism.

Canonical state/history belongs in the relevant durable service, especially the memory/archive system.

---

# Event envelope

Use a transport-independent envelope.

Conceptually:

```rust
pub struct DomainEvent {
    pub event_id: EventId,
    pub sequence: u64,
    pub occurred_at: SystemTime,
    pub payload: DomainEventKind,
}
```

Possible metadata:

- event ID,
- monotonic process-local sequence,
- timestamp,
- room ID,
- turn ID,
- agent-instance ID,
- correlation/request ID.

Do not require every event to populate irrelevant metadata.

---

# Typed event vocabulary

Start small.

Implement only events backed by current behavior.

Initial useful events:

```text
core.started
core.shutting_down

conversation.turn.started
conversation.turn.completed

agent.reply.started
agent.reply.completed
agent.reply.failed

runtime.started
runtime.stopped
runtime.failed
```

As concurrently developed systems land, extend with:

```text
room.created
room.updated
room.deleted

memory.updated
memory.search.completed

tool.call.started
tool.call.completed
tool.call.failed
```

Do not create fifty speculative event variants before the corresponding features exist.

---

# Strong typing internally

Internally prefer Rust enums/structs.

Conceptually:

```rust
pub enum DomainEventKind {
    CoreStarted,

    TurnStarted {
        room_id: RoomId,
        turn_id: TurnId,
    },

    AgentReplyStarted {
        room_id: RoomId,
        turn_id: TurnId,
        agent_instance_id: AgentInstanceId,
    },

    AgentReplyCompleted {
        room_id: RoomId,
        turn_id: TurnId,
        agent_instance_id: AgentInstanceId,
    },

    AgentReplyFailed {
        room_id: RoomId,
        turn_id: TurnId,
        agent_instance_id: AgentInstanceId,
        error: PublicError,
    },
}
```

Transport layers can serialize these events later.

Do not make the core publish arbitrary JSON blobs.

---

# Bounded event delivery

Use bounded live delivery.

A Tokio broadcast/channel-based implementation is acceptable.

Requirements:

- publishers must not block forever because one observer is slow,
- subscribers must be independently consumable,
- lag must be detectable,
- the bus must not grow an unbounded in-memory queue.

If `tokio::sync::broadcast` is used, explicitly handle `Lagged` errors in consumers.

A lagging UI/WebSocket subscriber may miss ephemeral events and then refresh authoritative state.

Do not pretend an ephemeral broadcast bus is a durable log.

---

# Event ordering

Within one Hivemind process, emitted events should carry a monotonic sequence number.

This helps:

- terminal rendering,
- WebSocket clients,
- debugging,
- tests.

For one turn, expected ordering might be:

```text
101 conversation.turn.started
102 agent.reply.started     Maomao
103 agent.reply.completed   Maomao
104 agent.reply.started     Albedo
105 agent.reply.completed   Albedo
106 conversation.turn.completed
```

Broadcast mode may interleave agent completion events according to actual completion time.

Presentation ordering and event occurrence ordering are separate concepts.

Do not rewrite real completion order merely to make event sequence resemble configured reply order.

---

# Event bus vs deterministic reply order

Keep these responsibilities separate.

The deterministic reply-order system answers:

```text
In what order should responses be presented?
```

The event bus answers:

```text
What happened, and when?
```

Example:

```text
Albedo finishes first
Maomao finishes second
```

The event bus may emit:

```text
agent.reply.completed Albedo
agent.reply.completed Maomao
```

while the CLI may still render:

```text
Maomao>
...

Albedo>
...
```

according to configured presentation order.

Do not conflate these.

---

# Event publication rules

Publish events at domain boundaries, not random print statements.

Bad:

```rust
println!("agent started");
event_bus.publish(...);
```

Better:

```text
ConversationService
    -> starts turn
    -> publishes TurnStarted

RuntimeManager
    -> starts runtime
    -> publishes RuntimeStarted

ConversationService
    -> records reply
    -> publishes AgentReplyCompleted
```

Then interfaces decide how to display/serialize them.

---

# CLI integration

Refactor the CLI so it consumes `HivemindCore`.

Current conceptual flow:

```text
main.rs
  -> load config
  -> AgentManager::start
  -> prompt_all
```

Target:

```text
main.rs
  -> load/build HivemindCore
  -> call core/application services
  -> render results/events
```

Keep terminal-specific concerns in CLI code:

- prompt display,
- command parsing,
- colors later,
- printing replies,
- Ctrl-C interaction.

Do not move terminal rendering into the core.

---

# API integration

Change API state from:

```text
ApiState {
    config,
    shutdown,
}
```

toward:

```text
ApiState {
    core: Arc<HivemindCore>,
    shutdown,
}
```

or equivalent.

HTTP handlers should ask core services for state.

Example:

```text
GET /api/v1/agents
   -> core.agents().list()
```

Do not keep a parallel agent-state implementation inside Axum handlers.

The health/info endpoints should remain cheap and must not start model runtimes.

---

# WebSocket integration

The existing WebSocket transport currently proves connectivity with system ready/ping/pong behavior.

Keep that protocol working.

Then allow WebSocket sessions to subscribe to Hivemind domain events.

Conceptually:

```text
EventBus
   |
subscriber
   |
WebSocket adapter
   |
serialize DomainEvent
   |
client
```

The WebSocket layer maps internal events to versioned external messages.

Do not expose internal Rust enum serialization as a permanent public protocol accidentally.

Use an explicit mapping layer.

---

# External WebSocket event names

A future public mapping may use:

```text
conversation.turn.started
agent.reply.started
agent.reply.completed
agent.reply.failed
conversation.turn.completed
runtime.started
runtime.stopped
```

The API/WebSocket protocol version remains independent from Rust enum layout.

Changing an internal field must not silently break clients.

---

# Event replay is not part of EventBus

New WebSocket clients may connect after events already happened.

The event bus itself does not need durable replay in this milestone.

If a client needs current state:

```text
1. fetch/query authoritative state
2. subscribe to live events
```

Future canonical archive/memory APIs may provide historical event retrieval.

Do not mutate the event bus into Kafka because we emitted six agent events.

---

# Memory-system integration

The deterministic memory plan is executing concurrently.

The kernel should provide memory as a service when available.

The event bus can notify memory observers, but **critical canonical writes must not depend solely on an ephemeral event subscriber**.

For example:

```text
ConversationService
   -> commit completed turn to canonical storage
   -> publish turn.completed
```

is safer than:

```text
publish turn.completed
   -> hope memory subscriber receives it
   -> maybe persist
```

If event-driven persistence is used, it must include reliable acknowledgement/retry semantics.

For this milestone, prefer direct authoritative service calls plus event publication.

---

# Tool-system integration

The memory plan requires agents to know about Hivemind-owned tools.

The application kernel should become the composition point for the future tool registry.

Conceptually:

```text
HivemindCore
   |
ToolRegistry
   |
   +-- memory.search
   +-- memory.private.add
   +-- future task.*
```

Runtime adapters should receive a tool bridge/manifest from the core rather than inventing their own application tools.

Do not fully implement every memory tool in this milestone if that plan is still running.

Provide the boundary needed for it to plug in cleanly.

---

# Conversation integration

When the shared-context/conversation coordinator lands, it should become the application-level path for turns.

Target:

```text
interface
   |
HivemindCore
   |
ConversationService
   |
Context Builder
   |
RuntimeManager
```

Do not let the CLI keep using `AgentManager::prompt_all` directly while the API uses a separate conversation coordinator.

There must eventually be one turn execution path.

During migration, adapters/compatibility wrappers are acceptable.

---

# Core lifecycle

Provide explicit lifecycle behavior.

Conceptually:

```text
construct
   |
start required services
   |
run
   |
shutdown requested
   |
stop accepting new work
   |
finish/cancel active turns according to policy
   |
shutdown runtime instances
   |
flush durable services
   |
publish final lifecycle events where practical
   |
exit
```

Shutdown must be idempotent where practical.

No orphan Pi/OMP children.

---

# Ctrl-C ownership

Avoid every subsystem installing its own Ctrl-C handler.

The outer executable/process should generally own OS signal handling and call:

```text
core.shutdown()
```

The core coordinates internal shutdown.

The API server may retain graceful Axum shutdown plumbing, but it should delegate application shutdown to the same core lifecycle.

---

# Error model

Introduce or preserve application-level errors that interfaces can map appropriately.

Example:

```text
CoreError::AgentNotFound
CoreError::RoomNotFound
CoreError::RuntimeUnavailable
CoreError::TurnInProgress
CoreError::ShuttingDown
```

Exact enum structure is flexible.

CLI maps them to terminal errors/exit codes.

HTTP maps them to status/JSON.

WebSocket maps them to protocol errors.

Do not make domain services return Axum response types.

---

# Observability

The event bus should make debugging easier.

At minimum, provide enough metadata to trace:

```text
request/correlation
   -> room
   -> turn
   -> agent instance
   -> runtime
```

Do not log secrets, raw credentials, or private memory indiscriminately.

Event payloads should be safe by design where possible.

---

# Concurrency model

HivemindCore must be safely shareable across async interfaces.

Likely shape:

```rust
Arc<HivemindCore>
```

Avoid one giant global mutex.

Prefer subsystem-local synchronization.

A slow memory search should not lock the entire hive.

A WebSocket subscriber should not block agent execution.

Room/turn serialization should happen at the appropriate conversation scope, not process-wide unless genuinely required.

---

# Multiple simultaneous interfaces

The same core should be capable of serving multiple interface consumers within one process.

Example:

```text
             one HivemindCore
             /      |       \
          CLI     HTTP      WS
```

The current project may still ship separate CLI/server binaries.

That is fine.

The requirement is architectural reuse, not forcing every interface into one process immediately.

---

# Backward compatibility

Preserve existing behavior while migrating:

- `cargo run` still starts CLI chat,
- `hivemind doctor` still works,
- deterministic reply ordering still works,
- `cargo run --bin hivemind-server` still serves the local API,
- health/info/agents endpoints continue working,
- WebSocket ready/ping/pong behavior remains valid,
- Pi and OMP adapters continue functioning.

Do not make architectural cleanup break the proof of concept.

---

# Suggested implementation phases

## Phase 1 — Core composition root

- expose runtime/config modules through library crate,
- create `HivemindCore`,
- move shared construction/lifecycle ownership into it,
- keep existing behavior through compatibility methods.

## Phase 2 — Event bus

- add typed event model,
- bounded bus,
- monotonic sequence IDs,
- subscriptions,
- core/runtime lifecycle events,
- turn/reply events where current turn execution allows.

## Phase 3 — CLI migration

- CLI builds/uses core,
- remove direct runtime ownership from CLI,
- retain terminal behavior.

## Phase 4 — API migration

- API state holds `Arc<HivemindCore>`,
- handlers query core services,
- health stays runtime-free.

## Phase 5 — WebSocket event bridge

- subscribe to EventBus,
- map internal domain events to public protocol events,
- preserve ping/pong,
- handle lag/disconnect cleanly.

Do not require all phases to be one giant commit.

---

# Tests

Core tests must not require paid provider calls.

Add fake runtime/service implementations where needed.

At minimum test:

- one core instance exposes one authoritative agent registry,
- core construction does not start providers unnecessarily,
- CLI-equivalent and API-equivalent agent listing use the same source,
- event subscribers receive published events,
- event sequence numbers are monotonic,
- multiple subscribers receive the same live event,
- lagging subscriber behavior is explicit,
- dropping one subscriber does not affect others,
- runtime start/stop events are attributed correctly,
- turn started/completed ordering,
- reply failure event attribution,
- deterministic presentation order remains independent from completion event order,
- shutdown stops all owned runtimes,
- shutdown is safe when called during/after partial startup,
- API health does not require agent runtime startup,
- WebSocket ready/ping/pong remains functional,
- WebSocket event mapping does not expose internal-only fields,
- existing CLI/API tests continue passing.

---

# Acceptance criteria

The goal is complete when:

1. A reusable `HivemindCore` (or equivalently named application kernel) exists.
2. The core is the composition/lifecycle root for shared Hivemind services.
3. CLI code no longer owns a parallel application model.
4. API state uses the core rather than cloned configuration as its effective application state.
5. Core construction does not make provider/model calls merely to exist.
6. Runtime startup is controlled through one core/runtime service boundary.
7. Pi/OMP implementation details remain below the runtime abstraction.
8. A typed internal Event Bus exists.
9. Event delivery is bounded.
10. Events have monotonic process-local sequence IDs.
11. Multiple subscribers can observe the same live events independently.
12. Lagging subscribers are handled explicitly.
13. EventBus is documented as ephemeral, not canonical storage.
14. Core lifecycle events are published.
15. Turn/reply events are published where conversation execution exists.
16. Deterministic reply presentation remains separate from event occurrence order.
17. CLI behavior remains compatible.
18. HTTP health/info/agents remain compatible.
19. WebSocket ready/ping/pong remains compatible.
20. WebSocket can bridge selected Hivemind domain events.
21. Core shutdown cleans up runtime children.
22. The architecture allows the shared-context and memory systems to plug into the same core.
23. `cargo test` passes.
24. `cargo clippy --all-targets --all-features -- -D warnings` passes.

---

# Non-goals

Do not expand this milestone into:

- autonomous agent delegation,
- task planning,
- voting/debate,
- full memory implementation,
- vector search,
- frontend implementation,
- remote distributed workers,
- durable event streaming infrastructure,
- Kafka/NATS/Redis,
- Internet-facing authentication,
- replacing the current WebSocket protocol wholesale,
- arbitrary plugin execution.

Those build on top of the kernel.

---

## Definition of done

Before:

```text
CLI -> AgentManager

API -> Config clone

WebSocket -> API-local behavior
```

After:

```text
             CLI
              \
               \
HTTP --------> HivemindCore <-------- WebSocket
                    |
        +-----------+-----------+
        |           |           |
 Conversation    Memory       Tools
        |           |           |
        +-----------+-----------+
                    |
                 EventBus
                    |
              RuntimeManager
               /         \
             Pi           OMP
```

Hivemind should have one brain.

Interfaces are just different mouths.
