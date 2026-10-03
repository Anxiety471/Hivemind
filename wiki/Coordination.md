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
- `permissions` and `roles` are the only source of authority (see [Access Control](Access-Control) for the permission list, built-in roles, and audit log). A group role override never grants any.
- Eligibility also requires the same `workspace` as the task (the project boundary). Personas in another workspace cannot be messaged, grouped, or assigned.
- There is no separate classifier model. `coordination.planner` names the planning persona; without it the best-ranked persona holding `coordinate` plans. A structured plan (`--plan-file` / `plan` in the API) skips model planning entirely.

Autonomous work runs only while a long-lived core is running: `hivemind serve` (starts the scheduler) or `hivemind task run`. `task submit` only stores work.

## Lifecycle

`submitted → planning → ready → running → review → completed`, plus `blocked`, `needs_input`, `failed`, `cancelled`. Illegal transitions and stale revisions are rejected.

- A root task goes `planning`; its coordinator proposes a plan (`tasks.plan.propose`). Rust validates keys, owners (capabilities, workspace, permissions), reviewers, dependencies, cycles, size and depth, then commits atomically. Nothing runs at proposal time.
- A task becomes `ready` once every prerequisite is `completed`. A failed or cancelled prerequisite blocks dependants; a failed task blocks its root.
- `tasks.result.submit` moves a task to `review`. It never completes it. Approval needs ≥1 verification entry, no `failed` check, and a deliverable artifact. Explicit reviewers must differ from the owner; an automatically chosen reviewer prefers another persona holding `review` and otherwise falls back to the coordinator, which can be the owner in a one-persona hive. Evidence and deliverable checks still apply.
- When all children are `completed` the root goes to `review` and its coordinator accepts or rejects. Rejection sends a task back for repair (a root back to planning) until `max_attempts_per_task`.
- Missing skills, no coordinator, oversized mandatory goals, and unanswered questions surface as `needs_input` (answer with `POST /tasks/{id}/input`).
- Budget exhaustion (dispatches, tool actions, messages, elapsed time) blocks the root with a visible reason. `resume` with `extra_dispatches` / `extra_secs` raises it.
- Attempts hold expiring leases with fencing tokens. Results from stale or expired attempts are rejected. There are no automatic runtime retries. After a crash or restart, leftover `running` attempts become `interrupted` and their tasks `blocked`; `resume --retry` is the explicit authorization to replay them (side effects may repeat).
- `pause` stops new dispatch (running attempts finish). `cancel` cascades to descendants, drops queued deliveries, archives groups, and aborts running attempts.

## Isolation and integration

In a git workspace every work attempt gets its own worktree and branch (`hivemind/<task>-<attempt>`); Hivemind commits the result and records a `commit` artifact. Dependants start from a worktree with their prerequisites' commits merged. If a merge conflicts, the markers are left in place and announced; the attempt fails as `unresolved_conflict` (never committed as a success) unless the agent resolves them, so an `integrate` task (owner needs the `integrate` permission) is where conflicts get fixed. Reviewers get a read-only checkout of the submitted commit. Non-git workspaces are serialized: one work attempt at a time per workspace.

Worktree directories are removed after each attempt; branches stay. The live session for an attempt with a worktree is rotated afterwards because its working directory is gone.

## Messaging and groups

`messages.send` records the message and delivery rows in one transaction and returns; it never calls the recipient. Only `request` and `handoff` messages wake recipients (`status`, `ack`, `decision_proposal` never do; a message caused by an `ack`/`status`, or deeper than `max_message_depth`, is delivered without waking). Queued wakeups for one recipient collapse into a single inbox attempt; the recipient's deliveries become `acknowledged` when that attempt finishes. Identical sends and repeated idempotency keys return the original message. Handoffs use a bounded schema (`changes`, `contract`, `artifacts`, `verification`, `blockers`, `requested_action`). Artifact references must belong to the same root task. A message that answers another (`causation`) joins its thread; list one with `hivemind task messages <root> --thread <id>` or `GET /api/v1/messages?root=&thread=`.

Dynamic groups live in SQLite (configuration groups are untouched). `groups.create` resolves configured personas only, one distinct persona per requested capability; the same purpose and membership reuses the group. Membership changes are revision-checked and audited, and removed members' task sessions are rotated.

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

`USER_WAKE`, `AGENT_WAKE`, `TASK_WAKE`, and `RECOVERY_WAKE` are host-driven: the model never names or triggers them. `SCHEDULE_WAKE` is the only agent-authored wake and the only wake tool exposed — there is no agent-facing `wakeup.list` or `wakeup.cancel`, so an agent cannot enumerate or retract its own pending wakeups. A chat-room schedule may repeat (`repeat_seconds`, optionally bounded by `repeat_count`), and the user lists and cancels a room's schedules through `GET`/`DELETE /api/v1/rooms/{id}/schedules`. `EVENT_WAKE` is conceptual only: Hivemind has no event-to-wake subscription, so nothing observes CI or any other external event and wakes an agent; adding one would be a new host event source.

## Agent tools

Offered through the same ```` ```hivemind-tool ```` fence as memory tools, only inside task rooms and only when the persona's role and permissions allow them. The manifest is injected with the first prompt of each runtime epoch; later turns carry a one-line reminder.

`agents.list`, `messages.send|inbox|ack`, `groups.create|get|members.update`, `tasks.get|list|plan.propose|delegate|progress|ask|block|result.submit|review|decide`, `artifacts.get`, `context.lookup`. Memory tools are unchanged and keep their own limits.

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
- **Task Steering in Multi-Agent Task Trees.** In autonomous coordination tasks (`#/tasks`), three things steer running attempts:
  - `POST /api/v1/tasks/{id}/steer {"message"}`: pushed into every attempt running on that task now, and permanently recorded as task feedback so any subsequent reviewer or follow-up attempt inherits it (`409` when nothing runs).
  - `messages.send`: if a recipient persona is mid-attempt on the same root, the message is steered live into their session while also queueing in their inbox.
  - `tasks.decide`: when a decision proposal is accepted, it is broadcast live into the running session of every other persona working under that root task.
- **Questions.** `tasks.ask {"question", "to"?}` (work and plan attempts) keeps the attempt running and waits. The user answers with `POST /tasks/{id}/input` (or via the open questions card in the web UI); with `to`, the question is also sent to that persona as a request, and its reply with `causation` set to the question answers it (only that persona's reply counts, and it is consumed rather than re-delivered). Open questions show in `GET /tasks/{id}` under `questions`. After `question_timeout_secs` the tool returns "no answer" and the agent carries on or calls `tasks.block`. One open question at a time, at most `max_questions` per attempt. Events: `task.steered`, `task.question`, `task.answered`, `task.question_expired`.
- Only Pi and OMP support steering; OpenCode attempts still get messages through the inbox. Steering and open questions live in the serving process: a one-shot CLI process cannot reach them, and a restart drops open questions (the attempt is interrupted anyway). An attempt waiting on a question holds its concurrency slot and its live session against idle reaping.
## Context

Each dispatch prompt is built from structured state: mandatory goal and acceptance criteria (never clipped — an oversized goal makes the task `needs_input`), a capsule (status, blockers, accepted decisions, dependency contracts and handoff summaries, reviewer feedback, artifact references; newest kept within its byte budget), and at most five waiting messages. Older or larger records are reachable by exact reference with `context.lookup` / `artifacts.get`. Per-attempt section sizes are stored and served by `GET /tasks/{id}/context-metrics`.

## API and CLI

See [HTTP and WebSocket API](HTTP-and-WebSocket-API) and [CLI Reference](CLI-Reference). Highlights:

- `POST /api/v1/tasks` returns `202` immediately with the id and status URL; `GET /api/v1/tasks[/{id}]`, `/attempts`, `/context-metrics`, `POST /cancel|pause|resume|input|steer`.
- `GET /api/v1/events?after=N&root=` replays durable events. Snapshots (`tasks`, `tasks/{id}`) carry `event_high_water`; resume from `after=<high-water>` for gap-free replay after a reconnect or restart. WebSocket frames (`task.*`, `attempt.*`, `message.*`, `group.*`, `agent.activity.changed`) carry `durable_seq` next to the process-local `sequence`; on lag, refresh and replay.
- `GET /api/v1/agent-instances` derives `idle | queued | planning | working | waiting | reviewing | failed | offline` from durable attempts and queues; listing never starts a runtime.
- `hivemind task submit|list|show|cancel|pause|resume|watch|run`. `watch` disconnecting never cancels.

Errors use one shape: `{"error":{"code","message"}}`; internal failures are sanitized. Attempt records expose a failure class, not provider detail or worktree paths. The API defaults to loopback. Opt-in operator authentication enables remote binding; see [Execution](Execution).

## Known limits

- Coordination context estimates remain bytes/4. Measured Pi/OMP billing usage and persistent admission budgets are available through `/api/v1/usage`; unsupported reporting remains null. Budgets count dispatches, tool actions, messages, and time.
- Live WebSocket events are published by the process that made the change; changes made by a one-shot CLI process reach WebSocket clients of a running `serve` on its next scheduler pass (≤0.5 s), and always via `/events`.
- Runtime epoch and rotation reason are not recorded per attempt (`rotations_observed` is `null`).
- Wakeups are time-based or host-dispatched only. `TASK_WAKE` runs a task's own owner attempt when its dependencies complete, and an agent can schedule a time/repeat wakeup; there is no wake whose trigger is a task or issue reaching a state ("wake me when task X is ready"), and `EVENT_WAKE` has no event source, so nothing observes CI or an issue tracker.
- Non-goals unchanged: no autonomous merge or deploy, no multi-user API, no unrestricted agent creation.

Host-run verification and interrupted-work recovery are configured through [Execution](Execution).
