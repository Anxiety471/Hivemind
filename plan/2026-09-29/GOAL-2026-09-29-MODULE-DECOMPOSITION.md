# GOAL — 2026-09-29 — Remaining Module Decomposition

## Objective

Continue the successful split of `conversation.rs` by decomposing the remaining monolithic implementation files before task/delegation work adds more behavior.

Current main-branch sizes are approximately:

```text
src/memory/mod.rs   ~77 KB
src/main.rs         ~44 KB
src/core.rs         ~30 KB
```

`conversation.rs` has already been split into responsibility-based submodules. Preserve that direction.

This goal is primarily structural.

Do not intentionally change user-visible behavior.

## Memory module

Split `src/memory/mod.rs` by responsibility.

Suggested shape:

```text
src/memory/
  mod.rs
  model.rs
  service.rs
  policy.rs
  search.rs
  tools.rs
  archive.rs
  store/
    mod.rs
    sqlite.rs
  tests.rs
```

Exact names may differ based on the existing implementation.

Responsibilities should be clear:

- model: Layer, Scope, Caller, records, provenance, status;
- service: public orchestration API;
- policy: scope authorization and write promotion rules;
- search: FTS request/ranking/result logic;
- archive: room/turn/message/runtime epoch canonical operations if useful;
- store/sqlite: schema, migrations, SQL;
- tools: memory tool request/response types if not owned by conversation bridge;
- tests: current regression suite.

Keep the existing public memory API stable where practical.

## CLI module

Move command parsing, routing/display helpers, and interactive shell behavior out of `src/main.rs`.

Suggested shape:

```text
src/cli/
  mod.rs
  args.rs
  shell.rs
  render.rs
  groups.rs
```

or equivalent.

The binary entry point should become thin:

```text
parse args
    |
call cli/application entry
    |
map final error to exit code
```

Do not move domain routing rules into CLI modules if the conversation-routing goal is concurrently moving them into core.

## Core module

`src/core.rs` is not yet catastrophically large, but split it only where a stable responsibility already exists.

Possible shape:

```text
src/core/
  mod.rs
  registry.rs
  lifecycle.rs
  tests.rs
```

Do not manufacture empty abstractions.

The core remains a composition/lifecycle root, not a dumping ground.

## Visibility discipline

The previous conversation split introduced `pub(super)` where sibling modules need access.

Follow the same rule:

- private by default,
- `pub(super)` for sibling implementation details,
- `pub(crate)` only when genuinely cross-module,
- `pub` only for supported library API.

Do not widen visibility merely to make tests compile.

## No behavior drift

The refactor must preserve:

- CLI commands,
- interactive commands,
- group persistence,
- memory search/write behavior,
- SQLite schema semantics,
- runtime epoch behavior,
- API behavior,
- EventBus behavior.

If a behavior change is required, isolate it in a separate commit/plan rather than hiding it inside the refactor.

## Concurrent-plan coordination

Other 2026-09-29 goals may touch identity, runtime lifecycle, and conversation routing.

Before moving code:

- re-read main,
- avoid rebasing old snapshots over new behavior,
- preserve public signatures recently introduced by other goals,
- prefer small sequential module moves.

## Tests

Move tests with their domain, but preserve coverage.

After each split:

```bash
cargo fmt --all --check
cargo test --all-targets
cargo clippy --all-targets --all-features -- -D warnings
```

Do not wait until the entire refactor is complete to discover 300 broken paths.

## Acceptance criteria

1. `src/memory/mod.rs` becomes a small module facade rather than the whole subsystem.
2. SQLite-specific code is isolated from memory domain models/policy.
3. Memory tests remain comprehensive.
4. `src/main.rs` becomes a thin executable entry point.
5. CLI parsing/rendering/shell code lives in focused modules.
6. Core/domain logic is not moved into CLI merely for convenience.
7. `src/core.rs` is split only where responsibilities are real.
8. Public API behavior remains compatible unless explicitly documented.
9. No database migration occurs solely because files moved.
10. `cargo fmt --all --check` passes.
11. `cargo test --all-targets` passes.
12. `cargo clippy --all-targets --all-features -- -D warnings` passes.

## Non-goals

Do not add:

- new task/delegation behavior,
- new memory semantics,
- new API endpoints,
- new providers,
- frontend code.

This goal is codebase surgery before the next growth spurt, because waiting until every file is 150 KB is technically a strategy, just not a respectable one.
