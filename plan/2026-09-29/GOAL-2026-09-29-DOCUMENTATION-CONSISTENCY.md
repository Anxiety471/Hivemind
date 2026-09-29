# GOAL — 2026-09-29 — Documentation Consistency Sweep

## Objective

Bring README and user-facing architecture documentation into agreement with the implementation now on `main`.

The codebase has moved quickly and the top/middle sections of the README correctly describe:

- persistent per-room/persona runtime sessions,
- structured `AgentInstanceId`,
- runtime prompt timeout and cancellation,
- Hivemind-owned conversation routing,
- `POST /api/v1/turns`,
- deterministic memory,
- EventBus/WebSocket integration.

However, the lower `Architecture` and `Current limitations` sections still contain older statements that say every persona invocation starts a fresh Pi/OMP process and that no runtime survives a single invocation.

Those statements now contradict the implementation.

The rule is:

```text
Documentation must describe one architecture, not every architecture Hivemind has ever had.
```

## Fix the architecture diagram

Replace the stale flow:

```text
RuntimeInvoker
start fresh OMP or Pi process -> prompt -> stop process
```

with the current architecture:

```text
HivemindCore
    |
ConversationCoordinator
    |
Context Pack / Delta Builder
    |
RuntimePool
    |
room/persona AgentInstanceId
    |
live Pi or OMP session
    |
rotate / idle / timeout / shutdown
```

The diagram should also show that canonical room history and memory stay in SQLite.

## Fix runtime continuity wording

Use one consistent rule throughout the README:

```text
A runtime session may persist across turns for the same agent instance.
It is never shared across different rooms or personas.
```

Remove statements claiming:

- every invocation always starts a fresh process,
- every reply always stops its process,
- cross-turn context comes only from SQLite.

The correct behavior is:

- first prompt of an epoch receives a full Context Pack,
- subsequent compatible turns receive deltas,
- SQLite remains canonical,
- runtime context is a disposable cache,
- rotation/timeout/failure/idle/shutdown may replace the runtime,
- rehydration comes from canonical Hivemind state.

## Fix Current limitations

Keep limitations that are still true, for example:

- FTS5 is lexical rather than semantic/vector search,
- token-by-token response streaming is not implemented,
- agent-to-agent direct messaging/task delegation is not implemented,
- API is loopback-only and unauthenticated.

Remove limitations that are no longer true.

Do not describe implemented runtime persistence as a limitation.

## Verify endpoint documentation

Ensure the HTTP section includes the currently implemented endpoints:

```text
GET  /api/v1/health
GET  /api/v1/info
GET  /api/v1/agents
POST /api/v1/turns
GET  /api/v1/ws
```

The turn endpoint example should match the current request/response protocol.

## Verify identity documentation

Keep the current `ai1` structured identity explanation, but ensure no later section falls back to describing instance identity as raw `room/persona` concatenation.

Legacy slash-delimited values should remain documented only as legacy opaque data.

## Verify lifecycle documentation

Document all currently supported lifecycle controls consistently:

- `runtime.prompt_timeout_secs`,
- `runtime.idle_timeout_secs`,
- `context.runtime_rotate_tokens`,
- context-gap rotation,
- runtime failure discard,
- core shutdown cancellation.

Do not imply automatic turn retry.

## README architecture summary

The final README should communicate this model clearly:

```text
CLI / HTTP
     |
HivemindCore
     |
ConversationCoordinator
     |
Context + Memory
     |
RuntimePool
     |
AgentInstanceId(room, persona)
     |
Pi / OMP live session

EventBus -> WebSocket
SQLite -> canonical history/memory
```

## Scope

This is documentation-only unless a documentation check exposes an actual implementation bug.

Do not change runtime behavior merely to make old prose true.

Change the prose.

## Acceptance criteria

1. No README section says every invocation starts a fresh runtime.
2. No README section says every reply stops its runtime.
3. Persistent same-instance cross-turn runtime behavior is described consistently.
4. RuntimePool appears in the architecture diagram.
5. SQLite is clearly documented as canonical state.
6. The `POST /api/v1/turns` endpoint is documented with current semantics.
7. Typed `AgentInstanceId` and `ai1` external encoding are described consistently.
8. Current limitations contain only limitations that still exist.
9. Runtime timeout/idle/rotation/shutdown behavior is documented consistently.
10. `cargo fmt --all --check`, `cargo clippy --locked --all-targets --all-features -- -D warnings`, and `cargo test --locked --all-targets` still pass after any incidental code formatting.

## Non-goals

Do not add:

- task delegation,
- frontend UI,
- semantic/vector memory,
- authentication,
- new runtime behavior.

This goal is a documentation truth-maintenance pass after several architecture goals landed at once.
