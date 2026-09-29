# GOAL — 2026-09-29 — Runtime Lifecycle Hardening

## Objective

Make live Pi/OMP runtime sessions bounded, cancellable, and reclaimable under hangs, shutdown, and long-running server use.

The current `RuntimePool` correctly keeps one live session per agent instance, rotates on context limits, idles sessions, and shuts down ordinary sessions. Two lifecycle gaps remain:

1. an in-flight prompt can hold the slot lock past shutdown grace and Hivemind currently logs that it will stop "when its reply ends";
2. idle sessions are stopped, but empty slot entries remain in the pool map.

The rule is:

```text
No provider/runtime call may make Hivemind impossible to shut down.
No dead runtime slot should live forever.
```

## Prompt cancellation

Add a pool/core shutdown signal visible to in-flight invocations.

Conceptually:

```text
session.prompt(...)
       |
       +-- reply
       +-- prompt timeout
       +-- core shutdown cancellation
```

Use `tokio::select!`, a watch channel, CancellationToken, or an equivalent bounded mechanism.

The runtime task that owns the session must regain control after cancellation and call the session shutdown path.

Do not abandon a child process merely because the slot lock could not be acquired.

## Prompt timeout

Add a configurable runtime prompt timeout.

Example configuration:

```toml
[runtime]
prompt_timeout_secs = 300
```

Exact default may be adjusted.

If `0` means disabled, document it explicitly.

On timeout:

- cancel the prompt future,
- mark the runtime invocation failed/timed out,
- close the runtime epoch,
- shut down/kill the child using the existing bounded child shutdown,
- discard the live session,
- require fresh rehydration on the next turn.

Never retry the user turn automatically after an uncertain provider-side execution.

## Shutdown semantics

Target shutdown sequence:

```text
core.shutdown
    |
stop accepting new turns
    |
signal cancellation to in-flight runtime prompts
    |
bounded grace
    |
session shutdown / child kill fallback
    |
close epochs
    |
empty runtime pool
```

`HivemindCore::shutdown()` remains idempotent.

After it returns, Hivemind should not knowingly own a live Pi/OMP child.

## Runtime events

Extend or clarify events for abnormal termination.

Useful reasons/codes:

- `prompt_timeout`,
- `core_shutdown`,
- `runtime_failure`,
- `idle_timeout`,
- `context_budget`,
- `context_gap`.

Avoid publishing sensitive provider errors to public WebSocket clients.

Internal logs may retain richer diagnostics.

## Idle slot eviction

After an idle runtime is stopped, remove its vacant slot from `RuntimePool.slots`.

Do this safely.

Because callers may hold cloned `Arc<Mutex<Slot>>` handles, only remove the map entry when it still points to the same slot that was examined.

A pattern using `Arc::ptr_eq` or equivalent identity checking is appropriate.

Do not remove a slot that was concurrently reused/replaced.

## Reaper lifecycle

The idle reaper should terminate when:

- the pool shuts down,
- the pool is dropped,
- idle timeout is disabled.

Avoid leaking one background task per transient pool forever.

If needed, keep a JoinHandle or shutdown signal under the pool lifecycle.

## HarnessSession boundary

Keep Pi/OMP behind one shared abstraction.

If cancellation requires a small trait change, prefer a runtime-neutral operation plus external cancellation of `prompt()`, rather than adding Pi-specific/OMP-specific application behavior.

Do not put lifecycle policy inside only one adapter.

## README correction

Fix the current contradictory wording that says a live runtime is per `room/persona` but also says no runtime session is shared across turns.

The intended rule is:

```text
A runtime session may persist across turns for the same agent instance.
It is never shared across different rooms or personas.
```

## Tests

Add fake runtime tests for:

- prompt never returns,
- prompt timeout kills/discards the session,
- core shutdown cancels a hanging prompt,
- shutdown remains bounded,
- next turn after timeout starts a fresh runtime,
- runtime epoch closes after timeout/cancellation,
- no automatic retry after timeout,
- idle runtime stops,
- idle empty slot is removed,
- concurrently reused slot is not accidentally removed,
- reaper stops with pool shutdown,
- repeated shutdown is safe.

Tests must not call real providers.

## Acceptance criteria

1. A hung prompt cannot indefinitely prevent core shutdown.
2. Runtime prompt timeout is configurable.
3. Timeout/cancellation discards the unsafe session.
4. Runtime epochs are closed on every terminal path.
5. Child processes have a bounded kill fallback.
6. Empty idle slots are evicted from the pool map.
7. Slot eviction is race-safe.
8. Reaper lifecycle is bounded.
9. Runtime events distinguish major stop/failure reasons.
10. README runtime continuity wording is correct.
11. Pi and OMP obey the same lifecycle contract.
12. `cargo fmt --all --check` passes.
13. `cargo test --all-targets` passes.
14. `cargo clippy --all-targets --all-features -- -D warnings` passes.

## Non-goals

Do not add:

- automatic prompt retries,
- distributed runtime recovery,
- provider failover,
- job scheduling,
- task delegation.

This goal only hardens the lifecycle of the live runtime pool.
