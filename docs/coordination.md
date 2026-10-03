# Autonomous agent coordination

Submit one task ("Fix the frontend form and backend validation"). Hivemind picks a coordinator, lets it propose a task graph, validates and commits the graph, runs each task in an isolated git worktree, routes reviews, and reports one result. Agents can DM each other and create task groups through host-bound tools. Everything that decides identity, permission, scheduling, or completion is deterministic Rust; models only interpret the request and do the work.

Coordination is **off by default**. Existing configurations behave exactly as before.

## Enable it

```toml
[coordination]
enabled = true
# planner = "Lead"        # optional persona that plans natural-language tasks
# max_dispatches = 64     # attempts charged to one root task and all descendants
# max_tool_actions = 400
# max_messages = 200
# max_plan_tasks = 32
# max_plan_depth = 6      # longest parent chain and dependency chain
# max_elapsed_secs = 3600
# max_attempts_per_task = 3
# max_concurrent = 4      # attempts running at once
# lease_secs = 300
# max_message_depth = 8   # causation chains deeper than this stop waking recipients
# question_timeout_secs = 600  # how long tasks.ask waits for an answer
# max_questions = 3       # tasks.ask questions per attempt

[[personas]]
id = "Lead"
workspace = "/path/to/repo"
permissions = ["coordinate", "delegate", "review"]

[[personas]]
id = "Back"
workspace = "/path/to/repo"
capabilities = ["backend"]

[[personas]]
id = "Front"
workspace = "/path/to/repo"
capabilities = ["frontend"]

[[personas]]
id = "Integrator"
workspace = "/path/to/repo"
capabilities = ["frontend", "backend"]
permissions = ["integrate"]
```

- `capabilities` are skill tags used only for matching. A `role` string is descriptive; nothing is inferred from it.
- `permissions` and `roles` are the only source of authority (see [access-control.md](access-control.md) for the permission list, built-in roles, and audit log). A group role override never grants any.
- Eligibility also requires the same `workspace` as the task (the project boundary). Personas in another workspace cannot be messaged, grouped, or assigned.
- There is no separate classifier model. `coordination.planner` names the planning persona; without it the best-ranked persona holding `coordinate` plans. A structured plan (`--plan-file` / `plan` in the API) skips model planning entirely.

Autonomous work runs only while a long-lived core is running: `hivemind serve` (starts the scheduler) or `hivemind task run`. `task submit` only stores work.

## Lifecycle

`submitted → planning → ready → running → review → completed`, plus `blocked`, `needs_input`, `failed`, `cancelled`. Illegal transitions and stale revisions are rejected.

- A root task goes `planning`; its coordinator proposes a plan (`tasks.plan.propose`). Rust validates keys, owners (capabilities, workspace, permissions), reviewers, dependencies, cycles, size and depth, then commits atomically, which is what creates the child issues. Nothing runs at proposal time. The coordinator routes by specialty: a frontend capability becomes a frontend ticket, a backend capability a backend ticket. Those specialists do the ticket. They cannot spawn further sub-issues. A persona with `decompose` who is not the root coordinator (the built-in researcher role) plans by default: their ticket is created in `planning`, they spawn helper sub-issues, and when those finish the ticket returns to `ready` so they synthesize the results. A coordinator-owned grouping issue completes when its sub-issues do, without a synthesis pass. A task may set `parent` to another key in the same plan to nest a sub-issue. `breakdown: false` forces a leaf; `breakdown: true` only schedules a follow-up when that owner already plans by default, so it does nothing on a specialist. A follow-up that proposes nothing leaves the sub-issue ready to work. The root still goes to review when every descendant is completed.
- A task becomes `ready` once every prerequisite is `completed`. A failed or cancelled prerequisite blocks dependants; a failed task blocks its root.
- `tasks.result.submit` moves a task to `review`. It never completes it. Approval needs ≥1 verification entry, no `failed` check, and a deliverable artifact. Explicit reviewers must differ from the owner; an automatically chosen reviewer prefers another persona holding `review` and otherwise falls back to the coordinator, which can be the owner in a one-persona hive. Evidence and deliverable checks still apply.
- When all children are `completed` the root goes to `review` and its coordinator accepts or rejects. Rejection sends a task back for repair (a root back to planning) until `max_attempts_per_task`.
- Missing skills, no coordinator, oversized mandatory goals, and unanswered questions surface as `needs_input` (answer with `POST /tasks/{id}/input`).
- **Sub-issues.** Creating an issue without a plan is what schedules the coordinator, and the committed plan is the automatic child-issue creation. `POST /tasks/{id}/children` lets the user add a further child under any live task of a running root, and children can take children of their own down to `max_plan_depth`. They are scheduled like delegated work: owner by capability unless given, ready once their `depends_on` complete. User-added sub-issues are the work itself; they are not planned again.
- Budget exhaustion (dispatches, tool actions, messages, elapsed time) blocks the root with a visible reason. `resume` with `extra_dispatches` / `extra_secs` raises it.
- Attempts hold expiring leases with fencing tokens. Results from stale or expired attempts are rejected. There are no automatic runtime retries. After a crash or restart, leftover `running` attempts become `interrupted` and their tasks `blocked`; `resume --retry` is the explicit authorization to replay them (side effects may repeat).
- `pause` stops new dispatch (running attempts finish). `cancel` cascades to descendants, drops queued deliveries, archives groups, and aborts running attempts.

## Isolation and integration

In a git workspace every work attempt gets its own worktree and branch (`hivemind/<task>-<attempt>`); Hivemind commits the result and records a `commit` artifact. Dependants start from a worktree with their prerequisites' commits merged. If a merge conflicts, the markers are left in place and announced; the attempt fails as `unresolved_conflict` (never committed as a success) unless the agent resolves them, so an `integrate` task (owner needs the `integrate` permission) is where conflicts get fixed. Reviewers get a read-only checkout of the submitted commit. Non-git workspaces are serialized: one work attempt at a time per workspace.

Worktree directories are removed after each attempt; branches stay. The live session for an attempt with a worktree is rotated afterwards because its working directory is gone.

## Messaging and groups

`messages.send` records the message and delivery rows in one transaction and returns; it never calls the recipient. Only `request` and `handoff` messages wake recipients (`status`, `ack`, `decision_proposal` never do; a message caused by an `ack`/`status`, or deeper than `max_message_depth`, is delivered without waking). Queued wakeups for one recipient collapse into a single inbox attempt; the recipient's deliveries become `acknowledged` when that attempt finishes. Identical sends and repeated idempotency keys return the original message. Handoffs use a bounded schema (`changes`, `contract`, `artifacts`, `verification`, `blockers`, `requested_action`). Artifact references must belong to the same root task. A message that answers another (`causation`) joins its thread; list one with `hivemind task messages <root> --thread <id>` or `GET /api/v1/messages?root=&thread=`.

Dynamic groups live in SQLite (configuration groups are untouched). `groups.create` resolves configured personas only, one distinct persona per requested capability; the same purpose and membership reuses the group. Membership changes are revision-checked and audited, and removed members' task sessions are rotated.

`wakeup.schedule {delay_seconds, intent?, reminder?, note?, label?, repeat_seconds?, repeat_count?, key?}` lets an agent wake itself later. In a task room it stores a durable self-addressed `wakeup` message whose delivery carries a `due_at`. At least one of the three purposes is required — `intent` (what to do when woken), `reminder` (the condition or time to act on), `note` (state to carry) — and each is delivered as a labeled line so the future self reads why it was woken. The scheduler and inbox ignore it until due, then it runs as a normal single inbox attempt carrying the body, and a completed or failed attempt never replays it. If the attempt is interrupted (crash, restart, lease loss) the wakeup is requeued, up to 3 claims in total, because losing a self-continuation is worse than repeating it; after the third interruption it fails. A wakeup that can never fire is never silent: Hivemind records a `wakeup.dropped` event with the reason (task cancelled or finished, root ended, persona removed, interrupted 3 times) and, when the root is still alive, sends the agent a non-waking `status` message with the wakeup's context that it sees the next time it works there. The delay must be 1s to 7 days and before the root deadline, at most 5 wakeups may be pending per agent per root task, and invalid requests create nothing. The scheduler does not poll for them: with nothing running it sleeps exactly until the next wakeup is due (plus a 50ms margin, capped at 30s as a safety net, and woken early by any new work); while attempts run it keeps its 500ms tick for completions and heartbeats.

In a chat room (`main`, `solo-<persona>`, `group-<id>`) there is no task, so a wakeup is stored in the `chat_wakeups` table and delivered through the durable turn queue instead: when it comes due the jobs worker submits the composed body as a turn in the same room, where it reads as a user-style message marked `[Hivemind wakeup <id>: you scheduled this; it is not a user message]`. The idempotency key is per fire — `<id>:<fires>` — so a recurring schedule's second fire is a new turn rather than a replay of the first; a row left `dispatched` by a crash is requeued for up to 3 attempts, then dropped. A chat wakeup may be recurring: `repeat_seconds` (1s to 7 days, the same bounds as `delay_seconds`) fires it again every interval after the first delay, and `repeat_count` (1..=1000) bounds how many times it fires in total; omitting `repeat_count` repeats until cancelled. Recurring wakeups are chat-room only — a task-room wakeup fires once. `label` is an optional short name (≤80 bytes) for the schedule. At most 5 chat wakeups may be outstanding per room, the at-least-one-purpose rule is identical, and the tool is offered wherever a chat room can be entered — threads have no wakeup target. Task rooms keep the message-queue path described above.

A user can see and stop a room's schedules with `GET /api/v1/rooms/{id}/schedules` (every schedule, newest first, in any state: `id`, `label`, `message`, `due_at`, `repeat_seconds`, `repeat_count`, `fires`, `state`, `created_at`) and `DELETE /api/v1/rooms/{id}/schedules/{sid}` (404 for an unknown or foreign schedule, 409 once it is `completed`/`cancelled`/`failed`, otherwise the cancelled schedule). Both answer 404 for rooms that are not chat rooms. There is still no `wakeup.list` or `wakeup.cancel` tool: an agent cannot enumerate or retract its own wakeups, only the user can.

### Wake types

Every wake is one of a small set of durable triggers; only the last is agent-authored.

| Wake type | Trigger | Example |
|---|---|---|
| `USER_WAKE` | A user turn, steer, or submitted root task arrives | “Fix login” |
| `AGENT_WAKE` | Another persona sends a `request` or `handoff` message | Marin asks Kurisu |
| `TASK_WAKE` | A dependency completes and the task is promoted to `ready` | a work attempt is dispatched |
| `SCHEDULE_WAKE` | A `wakeup.schedule` delivery comes due | a self-check later |
| `RECOVERY_WAKE` | An interrupted attempt or wakeup is requeued after a restart | Hivemind restarts mid-attempt |
| `EVENT_WAKE` | *(not implemented)* an external system event | CI fails |

`USER_WAKE`, `AGENT_WAKE`, `TASK_WAKE`, and `RECOVERY_WAKE` are host-driven: the model never names or triggers them. `SCHEDULE_WAKE` is the only agent-authored wake and the only wake tool exposed — there is no `wakeup.list` or `wakeup.cancel`, so an agent cannot enumerate or retract its pending wakeups. `EVENT_WAKE` is conceptual only: Hivemind has no event-to-wake subscription, so nothing observes CI or any other external event and wakes an agent; adding one would be a new host event source.

## Agent tools

Offered through the same ```` ```hivemind-tool ```` fence as memory tools, in task rooms and — for `wakeup.schedule` — in chat rooms too, and only when the persona's role and permissions allow them. The manifest is injected with the first prompt of each runtime epoch; later turns carry a one-line reminder.

`agents.list`, `messages.send|inbox|ack`, `wakeup.schedule`, `groups.create|get|members.update`, `tasks.get|list|plan.propose|delegate|progress|ask|block|result.submit|review|decide`, `artifacts.get`, `context.lookup`. Memory tools are unchanged and keep their own limits. Unlike the rest, `wakeup.schedule` is offered in `main`, `solo-<persona>`, and `group-<id>` rooms as well as task rooms; in a chat room it schedules the turn-queue wakeup described above, and in a task room it delegates to the coordination wakeup.

Actor, room, task, attempt, lease, and budget are bound by Hivemind; identity in arguments is ignored. Task text and agent messages are never user input: `Global:` directives and room-state directives are ignored in task rooms, so an agent cannot authorize a global memory write.

## Live steering and questions

A running session or task attempt can be reached while it works. Hivemind carries every message; runtimes never talk to each other.

- **Steer vs. Queue.** In Hivemind, *steer* and *queue* represent two distinct execution paths:
  - **Steer (immediate):** Injected directly into an active, in-flight session (Pi/OMP `steer` RPC) between tool calls and before the next model call. It adjusts the current generation in-place without creating a new turn job.
  - **Queue (sequential):** Dispatched as a fresh turn job stored in SQLite (`jobs`), waiting for the room's current turn to finish before running.
- **Chat Room Steering in Multi-Agent Rooms.** In rooms with multiple personas (e.g. `group-<id>` or `main`):
  - When a message is steered via `POST /api/v1/rooms/{id}/steer`, Hivemind queries actively replying agents in the room (`active_replies(room_id)`).
  - Every agent currently generating in that room receives the steered text mid-prompt into its live session. Members of the room that are not actively replying do not receive an in-flight prompt interruption.
  - The response `{"room_id": ..., "delivered_to": [...]}` reports exactly which personas took the text live (displayed in the UI badge, e.g. `Steer (Reviewer)`).
  - If no agent is actively replying when the steer arrives, `delivered_to` is empty, and the UI automatically falls back to queueing a standard sequential turn (`POST /turns`). Prefixing with `/queue <message>` explicitly queues a turn for the next reply sequence without attempting to steer.
- **Task Steering in Multi-Agent Task Trees.** In autonomous coordination tasks (`#/issues`), three things steer running attempts:
  - `POST /api/v1/tasks/{id}/steer {"message"}`: pushed into every attempt running on that task now, and permanently recorded as task feedback so any subsequent reviewer or follow-up attempt inherits it (`409` when nothing runs).
  - `messages.send`: if a recipient persona is mid-attempt on the same root, the message is steered live into their session while also queueing in their inbox.
  - `tasks.decide`: when a decision proposal is accepted, it is broadcast live into the running session of every other persona working under that root task.
- **Questions.** `tasks.ask {"question", "to"?}` (work and plan attempts) keeps the attempt running and waits. The user answers with `POST /tasks/{id}/input` (or via the open questions card in the web UI); with `to`, the question is also sent to that persona as a request, and its reply with `causation` set to the question answers it (only that persona's reply counts, and it is consumed rather than re-delivered). Open questions show in `GET /tasks/{id}` under `questions`. After `question_timeout_secs` the tool returns "no answer" and the agent carries on or calls `tasks.block`. One open question at a time, at most `max_questions` per attempt. Events: `task.steered`, `task.question`, `task.answered`, `task.question_expired`.
- Only Pi and OMP support steering; OpenCode attempts still get messages through the inbox. Steering and open questions live in the serving process: a one-shot CLI process cannot reach them, and a restart drops open questions (the attempt is interrupted anyway). An attempt waiting on a question holds its concurrency slot and its live session against idle reaping.
## Context

Each dispatch prompt is built from structured state: mandatory goal and acceptance criteria (never clipped — an oversized goal makes the task `needs_input`), a capsule (status, blockers, accepted decisions, dependency contracts and handoff summaries, reviewer feedback, artifact references; newest kept within its byte budget), and at most five waiting messages. Older or larger records are reachable by exact reference with `context.lookup` / `artifacts.get`. Per-attempt section sizes are stored and served by `GET /tasks/{id}/context-metrics`, together with each attempt's `runtime_epoch` (the live session that answered it), every runtime epoch in the task room with its `end_reason`, and `rotations_observed` / `rotations_by_reason` counted from epochs that ended in a rotation (`context_budget`, `context_gap`, `workspace_changed`, `attempt_finished`, ...; stops for `idle_timeout`, `prompt_timeout`, `runtime_failure`, and `core_shutdown` are not rotations).

## API and CLI

See the tables in the README. Highlights:

- `POST /api/v1/tasks` returns `202` immediately with the id and status URL; `GET /api/v1/tasks[/{id}]`, `/attempts`, `/context-metrics`, `POST /cancel|pause|resume|input|steer`.
- `GET /api/v1/events?after=N&root=` replays durable events. Snapshots (`tasks`, `tasks/{id}`) carry `event_high_water`; resume from `after=<high-water>` for gap-free replay after a reconnect or restart. WebSocket frames (`task.*`, `attempt.*`, `message.*`, `group.*`, `agent.activity.changed`) carry `durable_seq` next to the process-local `sequence`; on lag, refresh and replay.
- `GET /api/v1/agent-instances` derives `idle | queued | planning | working | waiting | reviewing | failed | offline` from durable attempts and queues; listing never starts a runtime.
- `hivemind task submit|list|show|cancel|pause|resume|watch|run`. `watch` disconnecting never cancels.

Errors use one shape: `{"error":{"code","message"}}`; internal failures are sanitized. Attempt records expose a failure class, not provider detail or worktree paths. The API defaults to loopback. Opt-in operator authentication enables remote binding; see [execution.md](execution.md).

## Known limits

- Coordination context estimates remain bytes/4. Measured Pi/OMP billing usage and persistent admission budgets are available through `/api/v1/usage`; unsupported reporting remains null. Budgets count dispatches, tool actions, messages, and time.
- Live WebSocket events are published by the process that made the change; changes made by a one-shot CLI process reach WebSocket clients of a running `serve` on its next scheduler pass (≤0.5 s), and always via `/events`.
- Epochs closed before end reasons were recorded have `end_reason: null` and are not counted as rotations.
- Wakeups are time-based or host-dispatched only. `TASK_WAKE` runs a task's own owner attempt when its dependencies complete, and an agent can schedule a time/repeat wakeup; there is no wake whose trigger is a task or issue reaching a state ("wake me when task X is ready"), and `EVENT_WAKE` has no event source, so nothing observes CI or an issue tracker.
- Non-goals unchanged: no autonomous merge or deploy, no multi-user API, no unrestricted agent creation.

Host-run verification and interrupted-work recovery are configured through [execution.md](execution.md).
