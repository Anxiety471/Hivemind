# GOAL — 2026-09-29 — Core Conversation Routing and Turn Transport

## Objective

Move conversation target resolution out of the CLI and into the Hivemind application/domain layer, then expose one safe API path for submitting turns.

The current CLI still owns concepts such as:

- `Route::Main`,
- `Route::Solo`,
- `Route::Group`,
- route-to-room conversion,
- participant resolution,
- group role resolution.

That means a future HTTP/WebSocket client would need to duplicate CLI routing logic.

The rule is:

```text
Interfaces choose a target.
HivemindCore resolves what that target means.
```

## Domain target type

Introduce a transport-neutral conversation target.

Conceptually:

```rust
pub enum ConversationTarget {
    Main,
    Solo { persona_id: String },
    Group { group_id: String },
}
```

The exact type names are flexible.

Move route identity resolution into the library/core/conversation domain.

Resolution includes:

- room ID,
- room display name,
- group ID,
- conversation mode,
- participants,
- member roles,
- effective reply order.

CLI code must not be the canonical owner of these rules.

## Core API

Provide one high-level entry point such as:

```rust
core.send_turn(target, message).await
```

or equivalent.

The lower-level `CoreTurnRequest` may remain for tests/internal use, but interfaces should normally use the resolved domain target path.

## Runtime and memory identity

Target resolution must produce the same room/persona identity used by:

- runtime pool,
- memory scopes,
- room archive,
- events.

Integrate with the typed agent-instance identity goal rather than rebuilding `"{room}/{persona}"` strings.

## Group mutations and stale core state

Interactive CLI currently mutates a separate `HivemindConfig` after `HivemindCore` has already been constructed.

Eliminate split authority.

Choose one explicit model:

1. group mutations go through a core-owned configuration/group service and update effective state, or
2. group mutations require a controlled core reload/rebuild.

Do not silently let CLI-local config and core-owned config disagree.

Persist successful group changes back to TOML through the existing safe edit path.

## Turn result

Return a structured outcome.

Conceptually:

```rust
pub struct TurnOutcome {
    pub turn_id: String,
    pub room_id: String,
    pub replies: Vec<TurnReply>,
}
```

This allows API clients to correlate returned replies with EventBus events.

Do not force clients to infer the turn ID from event timing.

## HTTP turn endpoint

After routing is core-owned, add one loopback API endpoint for submitting a turn.

Suggested shape:

```text
POST /api/v1/turns
```

Example request:

```json
{
  "target": {
    "type": "group",
    "id": "development"
  },
  "message": "Review the new runtime lifecycle."
}
```

Example response:

```json
{
  "turn_id": "...",
  "room_id": "...",
  "replies": [
    {
      "persona_id": "maomao",
      "ok": true,
      "content": "..."
    }
  ]
}
```

Exact JSON may differ, but it must be versioned under `/api/v1` and explicitly mapped.

## Why HTTP first

The current WebSocket already works well as a live event stream.

For this milestone, the simplest reliable interaction model is:

```text
HTTP POST -> submit/await turn
WebSocket -> observe live events
```

This avoids blocking the WebSocket read loop while a model inference is running.

A later plan may add WebSocket command submission if it materially improves the frontend.

## Concurrency

The conversation coordinator already serializes work per room.

Preserve that behavior.

Different rooms should remain able to execute concurrently.

The API must not add a global turn mutex.

## Error mapping

Map domain errors explicitly:

- unknown persona -> 404 or validated client error,
- unknown group -> 404,
- empty message -> 400,
- core shutting down -> 503,
- runtime failure -> structured turn reply failure or appropriate server response,
- malformed target -> 400.

Do not expose provider secrets or raw internal error chains in JSON.

## Events

A submitted API turn must emit the same EventBus events as a CLI turn.

There must not be a special "API conversation implementation."

One turn path, many interfaces.

## Tests

Add tests proving:

- CLI main/solo/group target resolution equals core resolution,
- API uses the same core resolution,
- group roles/mode/order are identical across interfaces,
- interactive group mutation cannot leave the active core stale,
- HTTP POST returns the generated turn ID,
- EventBus turn ID matches HTTP result,
- two rooms may run concurrently,
- same room remains serialized,
- unknown target returns safe structured error,
- API does not leak system prompts/provider details.

## Acceptance criteria

1. `Route` semantics are no longer owned exclusively by `main.rs`.
2. Core resolves main/solo/group targets.
3. CLI uses core target resolution.
4. Group mutation cannot silently diverge from core state.
5. One structured turn outcome includes turn ID and room ID.
6. `POST /api/v1/turns` submits through the same conversation path.
7. WebSocket events correlate with the returned turn ID.
8. No duplicate API-specific agent/group resolution exists.
9. Existing CLI behavior remains compatible.
10. Existing WebSocket ready/ping/pong behavior remains compatible.
11. `cargo fmt --all --check` passes.
12. `cargo test --all-targets` passes.
13. `cargo clippy --all-targets --all-features -- -D warnings` passes.

## Non-goals

Do not add:

- remote Internet exposure,
- authentication,
- frontend UI,
- streaming tokens,
- multi-user tenancy,
- task delegation.

This milestone makes conversation routing a core capability and gives the existing local API a real turn submission path.
