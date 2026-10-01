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
6. The worker runs in the **delegating persona's workspace**, even when the
   worker is a different persona.
7. **The persona owns retries.** On failure Hivemind wakes the requesting
   persona with a notice (speaker `hivemind`, worker text quoted line by line,
   never parsed for directives). The persona retries with `retry_of` or tells
   the user; Hivemind never retries itself. Only the requester, in the same
   room, may retry a failed/cancelled task, once, up to `[tasks] max_attempts`
   (default 3). A failure on the last attempt goes to the user.
8. **Threads belong to the user.** Any thread can be entered
   (`hivemind chat --task <id>`, `/task <id>`) and the worker replies with full
   tools in the same workspace. Task records are durable under
   `.hivemind/tasks`; threads survive restarts.
9. The API exposes each task's full brief and report, the follow-up reply, and
   the thread transcript (`GET /api/v1/tasks[/{id}]`) — never workspace paths
   or process ids.
10. Limits: brief ≤ 8,000 bytes, report ≤ 4,000 bytes, `[tasks] max_concurrent`
    (default 4). Shutdown cancels running tasks; one-shot `ask`/`all` wait.

## Non-goals

- Nested delegation, task dependencies, or task planning.
- Resuming a task after a restart (records persist; a running task is shown as
  interrupted).
- Streaming worker progress into the originating room.
- Per-persona opt-out of read-only chat.
- Sending thread replies through the HTTP API (reading is supported).

## Done / verified how

- Allowlist flags and the "never full by default" rule: unit tests on both
  adapters' argument builders, plus an end-to-end test that launches a fake Pi
  and asserts the chat session got `--tools read,grep,find,ls` and the worker's
  did not. Mutation-checked: making chat `Full` fails that test.
- Delegate → worker → report → next-turn context, shared workspace, failure →
  persona wake-up → persona retry, retry ownership and limits, user reply in a
  thread, durable records and interrupted tasks, validation errors, worker
  cannot delegate, concurrency cap, cancel on shutdown: `tasks::tests`. Notice
  turns never parse directives: `conversation::tests` and `tasks::tests`.
  API briefs/reports/transcripts: `api::routes::tests`.
- **Not verified against real Pi/OMP.** The flag names come from their
  documentation; neither binary was available in the build environment. Run a
  real chat and confirm an agent cannot write a file before relying on this.

## Decisions

- Worker workspace: always the delegating persona's. Resolved.
- Retry: the persona's decision, never automatic. Resolved.
- Briefs and reports: exposed through the API. Resolved.
- Threads: user-accessible and durable. Resolved.

## Open questions

- A persona woken by a failure sees a roster of only itself in a group room;
  should the notice turn carry the whole group?
- Should user replies in a thread also be summarized back into the parent room?
- Should the API accept thread replies once it routes chat turns?
