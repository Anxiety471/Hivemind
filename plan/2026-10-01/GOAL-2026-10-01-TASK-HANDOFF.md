# GOAL — 2026-10-01 — Read-Only Chat and Task-Thread Handoff

## Objective

Chat agents must not edit the workspace directly. Anything that changes files
or runs commands is handed to a **task thread**: a separate room with its own
worker session. The chat agent only reports what it handed off; Hivemind posts
the worker's result back when it finishes.

The architectural rule is:

```text
Chat rooms read and talk. Task threads change things.
Hivemind enforces the split; the prompt only explains it.
```

## Requirements

1. Every runtime session started for a chat route is launched read-only, with
   a runtime-level tool allowlist (no shell, edit, write, or sub-agent tools).
   Pi: `--tools read,grep,find,ls`. OMP: `--tools read,grep,glob`.
2. `ToolAccess` is a required argument to session start; no code path defaults
   to full access. Only a task-thread worker is `Full`.
3. A chat agent hands work off with `task.delegate {brief, persona?}` through
   the existing tool bridge. The delegating identity comes from the
   host-built `Caller`, never from tool arguments.
4. The tool returns immediately with a task id. The worker runs in room
   `task/<id>` with its own session, sees only the brief, and cannot delegate.
5. On completion or failure Hivemind posts a bounded report into the room that
   asked, as its own completed turn, and emits `task.*` events.
6. Limits: brief ≤ 8,000 bytes, report ≤ 4,000 bytes, `[tasks] max_concurrent`
   (default 4). Shutdown cancels running tasks; one-shot `ask`/`all` wait.

## Non-goals

- Nested delegation, task dependencies, or task planning.
- Resuming a task after a restart; persisting the task registry.
- Streaming worker progress into the originating room.
- Per-persona opt-out of read-only chat.

## Done / verified how

- Allowlist flags and the "never full by default" rule: unit tests on both
  adapters' argument builders, plus an end-to-end test that launches a fake Pi
  and asserts the chat session got `--tools read,grep,find,ls` and the worker's
  did not. Mutation-checked: making chat `Full` fails that test.
- Delegate → worker → report → next-turn context, validation errors, worker
  cannot delegate, concurrency cap, cancel on shutdown: `tasks::tests`.
- **Not verified against real Pi/OMP.** The flag names come from their
  documentation; neither binary was available in the build environment. Run a
  real chat and confirm an agent cannot write a file before relying on this.

## Open questions

- Should a worker be allowed a different workspace than the persona's?
- Should a failed task be retried, or always surface to the user first?
- Should briefs and reports be exposed through the API, or stay in rooms?
