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

`wakeup.schedule {delay_seconds, context, key?}` lets an agent wake itself later: it stores a durable self-addressed `wakeup` message whose delivery carries a `due_at`. The scheduler and inbox ignore it until due, then it runs as a normal single inbox attempt carrying `context`, and is never replayed (an interrupted attempt marks it failed, like any delivery). The delay must be 1s to 7 days and before the root deadline, at most 5 wakeups may be pending per agent per root task, and invalid requests create nothing.

## Agent tools

Offered through the same ```` ```hivemind-tool ```` fence as memory tools, only inside task rooms and only when the persona's role and permissions allow them. The manifest is injected with the first prompt of each runtime epoch; later turns carry a one-line reminder.

`agents.list`, `messages.send|inbox|ack`, `wakeup.schedule`, `groups.create|get|members.update`, `tasks.get|list|plan.propose|delegate|progress|block|result.submit|review|decide`, `artifacts.get`, `context.lookup`. Memory tools are unchanged and keep their own limits.

Actor, room, task, attempt, lease, and budget are bound by Hivemind; identity in arguments is ignored. Task text and agent messages are never user input: `Global:` directives and room-state directives are ignored in task rooms, so an agent cannot authorize a global memory write.

## Context

Each dispatch prompt is built from structured state: mandatory goal and acceptance criteria (never clipped — an oversized goal makes the task `needs_input`), a capsule (status, blockers, accepted decisions, dependency contracts and handoff summaries, reviewer feedback, artifact references; newest kept within its byte budget), and at most five waiting messages. Older or larger records are reachable by exact reference with `context.lookup` / `artifacts.get`. Per-attempt section sizes are stored and served by `GET /tasks/{id}/context-metrics`, together with each attempt's `runtime_epoch` (the live session that answered it), every runtime epoch in the task room with its `end_reason`, and `rotations_observed` / `rotations_by_reason` counted from epochs that ended in a rotation (`context_budget`, `context_gap`, `workspace_changed`, `attempt_finished`, ...; stops for `idle_timeout`, `prompt_timeout`, `runtime_failure`, and `core_shutdown` are not rotations).

## API and CLI

See the tables in the README. Highlights:

- `POST /api/v1/tasks` returns `202` immediately with the id and status URL; `GET /api/v1/tasks[/{id}]`, `/attempts`, `/context-metrics`, `POST /cancel|pause|resume|input`.
- `GET /api/v1/events?after=N&root=` replays durable events. Snapshots (`tasks`, `tasks/{id}`) carry `event_high_water`; resume from `after=<high-water>` for gap-free replay after a reconnect or restart. WebSocket frames (`task.*`, `attempt.*`, `message.*`, `group.*`, `agent.activity.changed`) carry `durable_seq` next to the process-local `sequence`; on lag, refresh and replay.
- `GET /api/v1/agent-instances` derives `idle | queued | planning | working | waiting | reviewing | failed | offline` from durable attempts and queues; listing never starts a runtime.
- `hivemind task submit|list|show|cancel|pause|resume|watch|run`. `watch` disconnecting never cancels.

Errors use one shape: `{"error":{"code","message"}}`; internal failures are sanitized. Attempt records expose a failure class, not provider detail or worktree paths. The API defaults to loopback. Opt-in operator authentication enables remote binding; see [execution.md](execution.md).

## Known limits

- Coordination context estimates remain bytes/4. Measured Pi/OMP billing usage and persistent admission budgets are available through `/api/v1/usage`; unsupported reporting remains null. Budgets count dispatches, tool actions, messages, and time.
- Live WebSocket events are published by the process that made the change; changes made by a one-shot CLI process reach WebSocket clients of a running `serve` on its next scheduler pass (≤0.5 s), and always via `/events`.
- Epochs closed before end reasons were recorded have `end_reason: null` and are not counted as rotations.
- Non-goals unchanged: no autonomous merge or deploy, no multi-user API, no unrestricted agent creation.

Host-run verification and interrupted-work recovery are configured through [execution.md](execution.md).
