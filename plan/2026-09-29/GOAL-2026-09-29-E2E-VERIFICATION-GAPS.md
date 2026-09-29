# GOAL — 2026-09-29 — E2E Verification Gaps

## Objective

A full end-to-end run with real Pi and OMP runtimes passed: CLI (`init` refusal, `doctor`, `agents`, `status`, `order`, `ask`, `all`, `group` CRUD), interactive `chat` with all slash commands, both group modes with member roles and room reply order, all five state directives, all eight memory tools with SQLite-verified rows (including revisions and cross-instance rejection), the HTTP API (health/info/agents, `POST /turns` for main/solo/group, 400/404 errors), the WebSocket stream (ready/ping/pong, turn/reply/runtime lifecycle frames), live session rotation, and graceful SIGINT shutdown with no orphaned processes.

Three fixable gaps surfaced during that run:

1. a configuration that passes validation can still fail every turn at runtime;
2. shutdown can drop domain-event frames that were already queued for WebSocket clients;
3. main-branch CI is currently red on the formatting gate.

The rule is:

```text
If Hivemind accepts a config, Hivemind must be able to run it.
If Hivemind queued a lifecycle event for a client, the client must receive it before close.
If CI enforces a gate, main must pass it.
```

## Context budget validation floor

Observed: with `[context] context_target_tokens = 100` the config passes
`HivemindConfig` validation (the only rule is "must be positive"), then **every**
turn fails before any runtime starts:

```text
context pack: current turn and participant/state context exceed configured context_target_tokens (100)
```

The fixed pack overhead (current turn, participant/state context, and the
injected memory-tool guidance) is far above any tiny positive budget, so a
legal-looking config is unrunnable.

Fix:

- reject `context_target_tokens` below a conservative documented floor that
  comfortably holds the fixed pack overhead even before history is added;
- include the measured size in the pack-overflow error so the message says
  both the actual and configured values, not only the limit;
- let `doctor` report the same floor problem instead of only reporting
  `[ok] runtime configuration`.

Keep the floor a single named constant with a comment; do not spread magic
numbers across validation, pack building, and doctor.

## WebSocket shutdown frame drain

Observed twice in live captures: at `SIGINT`, the server published
`runtime.stopped` (`core_shutdown`) for every live session, but the WebSocket
client received the close instead of the queued frames — a run with five
`runtime.started` frames logged only four `runtime.stopped` frames, and the
rotation run lost both shutdown stops after `conversation.turn.completed`.

The cause is the `select!` in the WebSocket handler: once the shutdown watch
fires, the close branch can win while the broadcast receiver still holds
pending events.

Fix:

- before closing, drain already-queued events from the subscribed receiver
  (bounded drain, for example until `try_recv` reports empty or a small frame
  budget is reached), then send the close;
- keep the whole sequence bounded; the drain must not be able to block
  shutdown indefinitely;
- do not add replay, history, or durable buffering — events stay ephemeral;
  a lagging client still refreshes authoritative state.

## Formatting baseline

Observed: `cargo fmt --all --check` fails locally with four pre-existing
diffs, and the latest main-branch CI run (`Check formatting`) fails the same
way, so Clippy and Test are skipped and main is red:

```text
src/runtime/omp.rs:728
src/runtime/omp.rs:735
src/runtime/omp.rs:770
src/cli/app.rs:351
```

Fix: format exactly those spots, keep the change formatting-only, and confirm
the CI workflow completes all three steps green on main.

## Coverage debt

Paths exercised by tests or code inspection but not by this live run — no
defect found, listed so the next verification round does not forget them:

- persona `model`, `reasoning`, and OMP `fast` overrides (left at defaults);
- `prompt_timeout`, `idle_timeout`, and `context_gap` stop reasons (only
  `core_shutdown` and `context_budget` were observed live);
- WebSocket `system.error` for unsupported messages and
  `system.events_lagged` for slow consumers;
- interactive `chat` SIGINT cancellation, `POST /turns` returning 503 during
  shutdown, and summary refresh cadence across many turns;
- an OMP reply narrating "no result yet" instead of emitting the
  `hivemind-tool` fence. Hivemind correctly treated the prose as the final
  answer and the database confirmed nothing executed — model-side behavior,
  not a host defect. Optional follow-up: tighten the manifest wording so a
  demanded tool call cannot be answered with narration.

## Tests

Add deterministic tests, no real providers:

- a config with `context_target_tokens` under the floor is rejected at load
  with a message naming the floor;
- the pack-overflow error carries measured and configured sizes;
- a core that publishes events immediately before shutdown delivers those
  queued frames to a WebSocket subscriber before the close frame (fake
  runtime, in-process);
- the shutdown drain stays bounded when no further frames arrive;
- formatting, Clippy, and all-target tests pass.

## Acceptance criteria

1. An undersized `context_target_tokens` fails at config load, not on every turn.
2. Pack-overflow errors report measured size alongside the configured limit.
3. `doctor` flags a config below the context floor.
4. Lifecycle frames queued before shutdown reach the WebSocket client before close.
5. Shutdown remains bounded; the drain cannot deadlock or hang.
6. The four known formatting diffs are gone and `cargo fmt --all --check` passes.
7. The main-branch CI run completes with formatting, Clippy, and tests all green.
8. `cargo test --all-targets` passes.
9. `cargo clippy --all-targets --all-features -- -D warnings` passes.
10. No real provider calls are required by any new test.

## Non-goals

Do not add:

- durable event replay or WebSocket event history,
- automatic prompt retries or provider failover,
- provider diagnostics in API responses or public events,
- authentication or remote exposure,
- broad memory-manifest redesign,
- unrelated refactors under the guise of "formatting".

Coverage-debt items stay documentation until a concrete defect appears; this
goal fixes the three observed gaps.
