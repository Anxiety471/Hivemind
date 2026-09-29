# GOAL — 2026-09-29 — Typed Agent Instance Identity

## Objective

Replace delimiter-built agent instance strings such as:

```text
{room}/{persona}
```

with a collision-safe typed identity owned by Hivemind.

Current code still constructs and keys runtime/private-memory identity with strings like `format!("{room}/{}", persona)`. Because room and persona IDs are not restricted from containing `/`, different logical identities can collapse into the same string.

Example:

```text
room = "a/b", persona = "c"    -> a/b/c
room = "a",   persona = "b/c"  -> a/b/c
```

That is unacceptable for runtime isolation and private memory.

The architectural rule is:

```text
Identity is structured internally.
Strings are serialization, not identity.
```

## Target type

Introduce an explicit type, for example:

```rust
#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct AgentInstanceId {
    pub room_id: RoomId,
    pub persona_id: PersonaId,
}
```

Exact naming is flexible.

Do not use a raw concatenated string as the `HashMap` key inside `RuntimePool`.

## Scope

Migrate all places that currently treat an agent instance as an arbitrary string:

- conversation coordinator,
- runtime pool,
- memory caller/private scope,
- runtime epochs,
- domain events,
- tests,
- WebSocket/public event mapping.

Keep public protocol serialization explicit.

## Stable serialization

If a stable external/storage representation is needed, use a versioned unambiguous encoding.

Acceptable strategies include:

- length-prefixed encoding,
- escaping plus a version prefix,
- a deterministic opaque identifier derived from structured fields.

Do not rely on a delimiter that user-controlled IDs may contain.

Example conceptual representation:

```text
ai1:<encoded-room>:<encoded-persona>
```

The encoding format must round-trip exactly.

## Storage compatibility

Existing SQLite rows may already contain legacy `room/persona` strings.

Do not guess how to split ambiguous legacy IDs.

Preferred migration behavior:

1. preserve legacy rows,
2. write new records using the new canonical representation,
3. use already separate room/persona columns where available,
4. only migrate a legacy value when its mapping is known from authoritative structured data,
5. document legacy handling.

Historical data must not be silently reassigned to a different agent instance.

## Validation

Config IDs may remain human-friendly and may contain ordinary punctuation unless there is a separate reason to restrict them.

The identity layer must be robust enough that validation does not need to ban `/` merely to compensate for bad encoding.

## Events

Internally, prefer typed identity.

At the WebSocket boundary, map it to a stable public `agent_instance_id` string.

Do not expose Rust `Debug` formatting as the protocol.

## Tests

Add tests proving distinct identities for:

- `room=a/b, persona=c`,
- `room=a, persona=b/c`,
- Unicode IDs,
- spaces and punctuation,
- same persona in two rooms,
- two personas in one room,
- runtime pool lookup,
- private-memory isolation,
- runtime epoch attribution,
- public serialization round-trip.

## Acceptance criteria

1. RuntimePool no longer uses delimiter-concatenated strings as logical identity.
2. Private memory does not depend on ambiguous `room/persona` concatenation.
3. Runtime epoch attribution uses the same canonical identity.
4. Internal events can carry the typed identity or its canonical form.
5. Public WebSocket `agent_instance_id` remains stable and explicit.
6. Legacy stored data is preserved safely.
7. Collision regression tests pass.
8. Existing room/persona behavior remains compatible.
9. `cargo fmt --all --check` passes.
10. `cargo test --all-targets` passes.
11. `cargo clippy --all-targets --all-features -- -D warnings` passes.

## Non-goals

Do not turn this into:

- user/account identity,
- distributed node identity,
- authentication,
- random per-turn IDs,
- a full database redesign.

This goal is specifically about making room/persona agent-instance identity safe and typed.
