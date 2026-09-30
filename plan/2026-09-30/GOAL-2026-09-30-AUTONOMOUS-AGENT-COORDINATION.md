# GOAL — 2026-09-30 — Autonomous Agent Coordination

## Objective and status

**Status: implemented in `src/coordination/` (see `docs/coordination.md` for the shipped behavior, defaults, and known gaps). The sections below remain the original plan.**

A user submits one task, such as “Fix this frontend and backend.” A Hivemind agent (either Jev(as classifier) or a Real Agent, based on configuration) selects eligible agents, lets a coordinator propose a decomposition, validates the resulting dependency graph, and runs the work without requiring the user to route every message. Agents can send DMs, create task groups by role/capability, exchange concrete handoffs, and report verifiable results. The API exposes durable task state and live activity.

Keep Rust as the application core and runtime adapters as execution transports. Keep deterministic storage, authorization, scheduling, and context assembly usable without a model. Models interpret ambiguous requests and perform work; they do not become the source of truth for identity, permissions, scheduling, or completion.

## Current implementation to extend

Reviewed against main commit `cfb865a5c4590087db63bafc862cc20e9d982495` (backend efficiency, PR #10).

| Existing component | Current behavior | Required extension |
| --- | --- | --- |
| `src/core.rs`, `src/core/registry.rs` | Persona registry, target resolution, shared services | Role/capability selection, coordination services, live instance projections |
| `src/conversation/coordinator.rs` | Serialized turns per room; broadcast/discussion; context packs and epoch-bound deltas | Typed agent/task inputs without pretending agent messages are user input |
| `src/conversation/memory_tools.rs` | Fenced, adapter-independent memory tool loop | General capability dispatcher preserving memory policy and old tool syntax |
| `src/cli/groups.rs`, `src/commands.rs` | User-created groups persisted through configuration | Durable dynamic task groups, created through validated agent tools |
| `src/runtime/pool.rs`, `src/identity.rs` | Disposable sessions keyed by structured room/persona identity | Task execution metadata and durable dispatch references without changing identity encoding |
| `src/memory/store/*` | SQLite WAL/NORMAL, scoped FTS, append-only turn changes | Indexed task/message/outbox tables and incremental projections |
| `src/events.rs`, `src/api/*` | Bounded process-local notifications and basic turn endpoints | Task/agent/message endpoints plus durable event replay |

A solo user/persona room is not an agent-to-agent DM. A role string is descriptive today; it is not an authorization rule. Room assignments are user directives, not a durable executable task graph.

The existing “summary” is a bounded suffix of older narrative, not semantic compaction. The current archive search ranks the newest 64 matching candidates, so old decisions must also have exact task/record lookup paths. Preserve the efficiency work described in [backend-efficiency.md](../../docs/backend-efficiency.md).

## Design decisions

1. Add `TaskService`, `MessagingService`, `GroupService`, `CoordinationPolicy`, and a durable scheduler under `HivemindCore`. Keep transport handlers thin.
2. Resolve skills with configured capability tags, project/workspace eligibility, and task policy. A group role override cannot grant new permissions.
3. The coordinator model proposes structured plans. Rust validates owners, scope, dependencies, budgets, and cycles before committing and dispatching them.
4. Use durable asynchronous mailboxes. Sending a DM acknowledges persistence; it never recursively calls the recipient's runtime while the sender holds a room/session lock.
5. A task group is a workspace for selected participants. Ordinary posts do not broadcast prompts to everyone. Mentioned recipients and actionable requests receive targeted inbox entries.
6. Store dynamic groups in SQLite. Configuration groups remain supported and readable; agents cannot rewrite `hivemind.toml`.
7. Distinguish configured personas, room/persona instances, and task attempts in public state. One persona may be working in multiple rooms.
8. Preserve the current no-cap policy for live runtime children and the 120-second idle default. Bound autonomous work per task and queue; do not introduce a runtime-child LRU or global live-child cap.
9. Autonomous work runs while a long-lived core is running (`serve`, or explicit CLI task-run mode). A one-shot command is not a background daemon.
10. Keep API access loopback-only. Remote authentication and hosting are separate work.

## Phase 1 — Durable task model and coordination policy

Add backward-compatible persona `capabilities` and coordination permission configuration. Existing configs continue to load; no free-form role-to-permission inference. Define deterministic matching and stable tie-breaking: eligibility, capability coverage, active assignment count, configured order. Return `needs_input` when a necessary skill or scope is missing.

Create versioned migrations for:

- `tasks`: id, parent/root id, objective, acceptance criteria, required capabilities, workspace/project, coordinator, owner, status, revision, policy/budget, timestamps.
- `task_dependencies`: task id, prerequisite id, required handoff/contract.
- `task_attempts`: task id, attempt id, instance id, runtime epoch, dispatch id, lease/fencing token, heartbeat, result, failure/cancellation classification.
- `task_artifacts`: immutable reference/version, producer attempt, kind, content hash where available, bounded description.
- `coordination_events` and transactional outbox: durable sequence, task/room/actor references, event type, small payload.

Use one root-task identity for budgets, all descendant work, and duplicate detection. Validate graph size/depth and reject dependency cycles. Dependencies become ready only after validated prerequisite completion. Define revision-based updates and idempotency keys for mutations.

Task lifecycle:

`submitted → planning → ready → running → review → completed`

Alternate states: `blocked`, `needs_input`, `failed`, `cancelled`. A paused root stops new dispatch; in-flight handling is explicit. Terminal roots do not accept new autonomous work. Parent completion requires all required children and integration acceptance.

**Acceptance:** migrations preserve existing rooms/memory; unauthorized state transitions and stale revisions fail; cyclic plans fail; duplicate submission creates one root task; no provider is contacted by task/status reads.

## Phase 2 — Agent DMs and dynamic role-based groups

Create `agent_messages`, `message_deliveries`, `dynamic_groups`, and `group_members`. Every message records sender persona/instance, task/root, room/thread, recipients, kind, correlation/causation ids, bounded body, artifact references, and timestamps.

Message kinds: `request`, `handoff`, `status`, `decision_proposal`, `ack`. Only requests, designated handoffs, and explicit task wakeups schedule work. Acknowledgments and status reports do not elicit automatic acknowledgments.

DM rules:

- Select a recipient persona in the same authorized project/task; target an existing eligible task instance or create an explicit task-scoped DM instance.
- Record original sender identity separately from the destination instance. The destination does not inherit the sender's private memory.
- Persist the message, delivery rows, and outbox event atomically. Retry transport delivery by id; acknowledge processing separately.
- Messages are explicitly shared content. Artifact references and searches still enforce recipient access; a reference never widens scope.
- Track queued, delivered, processing, acknowledged, failed, and cancelled delivery states. “Delivered” does not mean the recipient accepted or completed work.

Group rules:

- `groups.create` accepts task id, purpose, and required roles/capabilities or explicit eligible members.
- Resolve only configured personas; group creation does not create arbitrary agents or spawn unlimited new workers.
- Reuse a task group with the same purpose/membership key. Record creator, membership revisions, and lifecycle.
- Membership changes are authorized and audited. Removed members lose future group reads/writes; rotate affected sessions at the next safe boundary because already-seen context cannot be erased.
- Closing a root archives its transient groups and cancels pending wakeups. Keep durable history and artifact references.

**Acceptance:** frontend can DM backend and create an eligible frontend/backend/reviewer group; sender spoofing and cross-project reads fail; duplicate sends/groups are idempotent; a DM to a busy instance queues without a nested-lock deadlock; status/ack exchange cannot form an autonomous loop.

## Phase 3 — One Hivemind tool surface, visible to agents

Generalize the existing memory-only loop into a typed dispatcher. Preserve existing memory tool names, fenced syntax, action bounds, provenance, scope binding, and exact `Global:` authorization. Agent coordination calls are not user directives and cannot authorize global memory writes.

Proposed tools:

| Tool | Purpose |
| --- | --- |
| `agents.list` | Discover bounded role/capability/availability metadata |
| `messages.send`, `messages.inbox`, `messages.ack` | DMs or authorized group posts and bounded mailbox reads |
| `groups.create`, `groups.get`, `groups.members.update` | Create and manage eligible task groups |
| `tasks.get`, `tasks.list`, `tasks.plan.propose` | Inspect scoped work and propose a validated task graph |
| `tasks.delegate`, `tasks.progress`, `tasks.block` | Assign eligible work, update progress, surface blockers |
| `tasks.result.submit` | Submit artifacts and verification evidence for review |
| `artifacts.get`, `context.lookup` | Fetch a bounded, authorized artifact or exact durable record |
| Existing `memory.*` | Search/update scoped durable memory |

Host-created invocation context binds actor, room, task, attempt, authorization, and budget. Ignore model-supplied identity/permission claims. Validate structured arguments, sizes, ids, revisions, membership, and task state. Tool errors are bounded and actionable.

Inject a compact capability manifest at every new runtime epoch: allowed tool names, minimal calling examples, current task role, scope restrictions, and remaining work budget. Send short reminders on later turns; expose detailed schemas on demand. Explicitly teach agents that sending a message queues work, proposing a plan does not execute it immediately, and a result submission does not self-certify completion.

**Acceptance:** fake Pi, OMP, and OpenCode adapters can each discover and invoke coordination tools; the manifest reflects permissions; malformed/excessive calls stop within bounds; unavailable tools do not appear as granted capabilities.

## Phase 4 — Autonomous decomposition and execution

A submitted natural-language task selects one eligible coordinator. It proposes children, owners/capabilities, acceptance criteria, dependency edges, interface contracts, and integration/review work. Rust validates and commits the plan. Explicit structured user plans can bypass model planning; without a usable planner, natural-language tasks remain `needs_input` rather than pretending to decompose.

Scheduler behavior:

- Claim ready attempts transactionally, with expiring leases, heartbeats, and fencing tokens. Apply existing per-instance session serialization.
- Dispatch independent children concurrently after required contract decisions. Pass only the child's objective, relevant constraints, prerequisite handoffs, and bounded inbox items.
- Replanning changes pending work through revision checks. Running attempts require an explicit cancellation/handoff boundary.
- Keep repo edits isolated in per-task/attempt worktrees where Git is available. Publish commits/diffs as artifacts; an integrator resolves conflicts and runs combined checks. For non-Git workspaces use explicit file ownership and serialize overlapping writes.
- Propagate cancellation through descendants and queued deliveries. Bound shutdown and persist interrupted attempt state.
- Enforce configurable root-task limits for dispatches, tool actions, messages, plan depth, elapsed time, and optional measured token usage. Charge descendants to the root; report unknown token usage honestly.
- Deduplicate work and suppress repeated equivalent delegations/message cycles using root/causation chains and bounded wakeup rules. Budget exhaustion moves the task to a visible blocked state.
- Preserve no automatic runtime-turn retries. On crash/restart, mark an expired running attempt interrupted; never blindly replay possible file/tool effects. Reconcile recorded artifacts and side effects before an explicitly authorized replacement attempt.
- Emit progress from durable state. “Completed” requires referenced deliverables and verification evidence; model confidence is not evidence. Unknown or unavailable checks remain visible.

Example acceptance scenario:

1. User submits “Fix the frontend form and backend validation.”
2. Coordinator selects frontend, backend, and reviewer by configured capabilities; creates a task group.
3. Backend publishes the agreed request/response/error contract.
4. Frontend and backend implement independent work in isolated worktrees; they DM only for specific questions or handoffs.
5. Reviewer checks each result; integrator combines the changes and runs the relevant tests.
6. User receives one result with changes, evidence, and any unresolved limitations.

**Acceptance:** one submission reaches a verified integrated result with fake runtimes and a fixture repo, without manual routing; missing skills block visibly; conflicting edits are isolated; dependency failures stop dependants; interruption/cancellation/budget exhaustion do not report success.

## Phase 5 — Lean context and reliable handoffs

Build context control alongside the task schema, before enabling unrestricted autonomy. Preserve canonical archives while shrinking model-visible inputs.

Maintain a versioned task capsule: objective, acceptance criteria, owner/role, active constraints/decisions with source ids, current status, next action, blockers, dependency contracts, and artifact references. Agents propose decisions; policy records their scope and reviewer/coordinator acceptance. Task decisions do not silently become global memory.

Packing order:

1. Required identity, permissions/tool manifest, immediate instruction, and applicable acceptance criteria.
2. Current task capsule and essential dependency contracts/blockers.
3. New actionable inbox messages and handoff records since the instance cursor.
4. Bounded relevant memory hits and recent task-local exchanges.
5. Optional older narrative or exact artifact excerpts requested by the agent.

Apply independent byte/token budgets to sections and the total. The existing four-bytes-per-token budget is an approximation, not proof of actual model usage; reserve headroom for runtime prompts/tool schemas and outputs, and use measured runtime usage where available. Reject/route oversized mandatory inputs to explicit ingestion/chunking instead of silently clipping goals, schemas, or acceptance criteria.

- Never load all rooms, every agent's inbox, entire group history, or raw build logs into a prompt.
- Deduplicate references already represented in the capsule. Preserve changed revisions and distinguish superseded facts.
- Handoffs use a bounded schema: changes, interface contract, artifact refs, verification, unresolved blockers, requested action.
- Large diffs, logs, and documents stay outside the prompt. Authorized paginated reads expose needed excerpts.
- Give each instance separate message/task/capsule cursors, bound to its runtime epoch and membership revision. Commit consumption only after the corresponding execution checkpoint; replay remains idempotent.
- Rotate on context budget, task boundary when appropriate, invalid cursor, or changed permissions. Rehydrate from the capsule and scoped retrieval.
- Deterministic capsules come from structured state. An optional model summarizer may propose narrative compaction, but must preserve source references and cannot overwrite authoritative decisions.
- Bound active completed-item lists and move old items to indexed storage. Exact record/task lookups recover early constraints that recency-limited FTS misses.
- Expose pack sizes by section, retrieved count, estimated/measured tokens, compaction count, rotation reason, and missing/truncated optional sections.

**Acceptance:** a 100-step fixture task survives rotations and recalls an early contract by exact reference; unrelated DM content never enters another task pack; repeated handoffs do not grow packs linearly; mandatory content stays complete; task capsule + recent context stays within the configured budget. Measure recall/contract adherence separately from token reduction.

## Phase 6 — Tracking API and CLI

Proposed additions; preserve existing `/api/v1/turns`, health/info, agent-list fields, and WebSocket behavior. Start with additive fields/versioned DTOs and contract tests.

| Method / endpoint | Behavior |
| --- | --- |
| `POST /api/v1/tasks` | Validate/persist task, return 202 + task id/status URL; no wait for model completion |
| `GET /api/v1/tasks`, `GET /api/v1/tasks/{id}` | Paginated task graph, ownership, progress, blockers, acceptance/result refs |
| `GET /api/v1/tasks/{id}/attempts` | Attempt state, sanitized failures, heartbeat, runtime correlation |
| `POST /api/v1/tasks/{id}/cancel` | Idempotent cascading cancellation |
| `POST /api/v1/tasks/{id}/pause`, `.../resume` | Control dispatch; resume does not implicitly replay interrupted side effects |
| `GET /api/v1/agents/{id}`, `GET /api/v1/agent-instances` | Persona capabilities and actual instance/task activity |
| `POST /api/v1/messages`, `GET /api/v1/messages` | Validated user/operator messages and paginated authorized history |
| `POST /api/v1/groups`, `GET /api/v1/groups/{id}` | Create/inspect dynamic groups with task membership |
| `GET /api/v1/tasks/{id}/context-metrics` | Bounded context/budget/rotation diagnostics |
| `GET /api/v1/events?after=...` | Durable paginated event replay and restart-safe cursor |

Agent-facing tools use host-bound identity, not these operator HTTP endpoints. Loopback operator access remains a trusted local boundary, not per-user authentication. Avoid exposing raw prompts, credentials, private notes, environment contents, or unrestricted paths.

Distinguish persona availability from instance execution: idle, queued, planning, working, waiting, reviewing, failed, offline. Derive activity from durable attempts/leases plus runtime lifecycle; a configured persona is not necessarily running. Progress reports state counts and milestones; do not invent percent-complete from prose.

Publish `task.*`, `message.*`, `group.*`, and `agent.activity.changed` notifications through the existing shared event serialization path. Durable event ids/sequences are separate from process-local event bus sequence. On WS lag or reconnect, refresh projections and replay from a durable cursor; snapshot/replay protocol must define a high-water mark to avoid gaps.

Add `hivemind task submit|list|show|cancel|watch|run` and interactive equivalents. Document that `submit` stores work while `serve`/`task run` processes it. Watching disconnects independently of task cancellation.

**Acceptance:** an API client can submit once, disconnect, reconnect after restart, and reconstruct task status/events; invalid/stale mutations return consistent sanitized errors; listing tasks/agents never starts a runtime.

## Implementation order and reviewable slices

| Slice | Deliverable | Dependency |
| --- | --- | --- |
| 1 | Schema, typed task states, policy/capabilities, capsules, migrations | Existing efficiency foundation |
| 2 | Queued DMs, dynamic groups, durable outbox | 1 |
| 3 | General dispatcher and compact permission-bound discovery | 1–2 |
| 4 | Scheduler with leases, budgets, cancellation, safe interruption | 1–3 |
| 5 | Planner validation, delegation, isolated edits, integration/review | 4 |
| 6 | Complete delta packing, bounded retrieval and long-task context checks | Starts in 1; finishes before autonomy rollout |
| 7 | Tracking API/CLI, durable replay, docs and E2E scenario | Incrementally from 1; final gate after 5–6 |

Keep each slice independently reviewable. Do not begin with a frontend redesign or a new memory provider. The first usable milestone is two agents exchanging one queued DM with API-visible ownership and a bounded task capsule.

## Validation and release gates

Use fake runtimes for deterministic CI. Real provider tests are opt-in and are not needed to prove scheduler or authorization behavior.

- State/ACL/idempotency/migration tests; spoofed actor, inaccessible artifact, removed membership, stale lease and revision cases.
- Concurrent mutual DMs with busy rooms; outbox crash between commit and publish; restart while an attempt has unknown side effects.
- Fixture repository E2E covering frontend/backend contract, parallel edits, reviewer rejection, repair task, integration evidence, and cancellation.
- Long-run context E2E comparing prompt bytes and early-contract recall at 10, 100, and 1000 events; explicit rehydration after rotation.
- WS lag/reconnect/restart replay and task snapshot high-water behavior.
- `cargo test --all-targets` and `cargo clippy --all-targets --all-features -- -D warnings`.
- Re-run existing backend benchmarks on the same host, with coordination disabled and enabled; record before/after results. Investigate >10% legacy p50/CPU regressions beyond benchmark noise. Add mailbox/task/active-queue scenarios and verify overhead grows with active bounded work, not historical messages or all configured agents.
- Do not regress one retrieval per member, shared room archive retrieval, indexed bounded reads, append-only writes, shared WS serialization, runtime timeout handling, or scope isolation.

**Release acceptance:** the user's single frontend/backend request is decomposed, executed, reviewed and integrated; DMs and role-selected groups are visible and auditable; the user can track and cancel the work; context remains bounded through long tasks; missing information, budgets, and interrupted attempts surface as honest states.

## Non-goals

No unrestricted agent creation, autonomous deployment/merge, remote API exposure, new model subscription, embeddings/vector database, full transcript broadcast, perpetual agent discussion, or guarantee that summarization eliminates context rot. This plan reduces irrelevant context and tests continuity; model reliability still needs evidence.
