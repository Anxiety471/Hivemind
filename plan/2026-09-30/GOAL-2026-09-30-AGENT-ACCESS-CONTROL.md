# GOAL — 2026-09-30 — Agent Access Control (roles and permissions)

**Status: implemented (`src/access.rs`; shipped behavior in `docs/access-control.md`). The sections below remain the original plan.**

## Objective

Give personas enforceable, auditable permissions instead of a role string that only describes them. A persona's authority comes from named **roles** (bundles of permissions) plus optional direct grants. Hivemind decides in Rust, without a model, what a persona may do, and records every gated decision.

Today (verified in code):

| Area | State |
| --- | --- |
| `AgentConfig.permissions` | Four values (`coordinate`, `delegate`, `review`, `integrate`), validated against `COORDINATION_PERMISSIONS`. |
| `AgentConfig.role`, group `member_roles` | Prompt text only. Not authorization. |
| Coordination tools | Gated in `coordination/tools.rs::allowed` (manifest and execute) and by ad-hoc checks in `service.rs` (`delegate`, `reassign`, `decide`, `review`). |
| Memory tools | Not gated per persona. Scope safety is inside `MemoryService`; global writes need a `Global:` user directive. |
| Reviewer independence | Enforced at plan time only (`policy.rs`). `reassign` can make the owner the reviewer. |
| Audit | Only coordination task events. No record of denied or memory-write actions. |

## Design decisions

1. **Permissions are the enforced unit; roles are bundles.** Effective permissions = union of the persona's roles and its direct `permissions`, expanded by a fixed implication table. Direct `permissions` keep working unchanged.
2. **One resolver.** `src/access.rs` owns the permission list, built-in roles, implications, resolution, tool-to-permission mapping, and the audit log. `Roster` (coordination) and the memory tool loop both consume it.
3. **Compatibility.** A persona with no `roles` is *unrestricted for memory tools* (today's behavior). Declaring at least one role makes memory writes deny-by-default: only permissions the roles grant apply. Coordination is always permission-based, as it is today. Existing configs do not change behavior.
4. **Identity is never taken from arguments.** Memory and coordination calls are already bound to the Hivemind-created caller/lease. Authorization keys off that persona only.
5. **Implication table** (a holder of the left permission also holds the right ones):
   - `coordinate` → `delegate`, `group.manage`, `task.reassign`
   - `delegate` → `group.manage`, `task.reassign`
   - `review` → `task.decide`

   `coordinate` deliberately does not imply `task.decide`: it would widen who is offered `tasks.decide` today.
6. **Separation of duties is enforced in code.** A non-root task's owner never reviews it (when more than one persona exists, mirroring the plan-time rule). `tasks.delegate` reassignment cannot make the owner equal the reviewer. Root tasks are exempt because the coordinator owns and reviews them by design.
7. **Audit every gated action.** Allow and deny are recorded in `access.sqlite3` (data dir) with persona, permission, action, resource, decision, reason. The log is bounded (newest 10 000 rows). A failed audit write never blocks or reverses an authorization decision; it is reported on stderr.
8. Roles cannot be edited by agents. They live in `hivemind.toml`; custom role names cannot shadow built-ins.

## Permission catalogue

Existing: `coordinate`, `delegate`, `review`, `integrate`.

New:

| Permission | Gates |
| --- | --- |
| `memory.private.write` | `memory.private.add/update/upsert` |
| `memory.group.write` | `memory.group.add/update/upsert` |
| `memory.persona.write` | `memory.persona.propose/update` |
| `memory.global.write` | `memory.global.propose/update` (the `Global:` directive requirement still applies) |
| `memory.archive` | `memory.archive` |
| `task.decide` | `tasks.decide` |
| `task.reassign` | `tasks.delegate` with a `task` argument |
| `group.manage` | `groups.create`, `groups.members.update` |

`memory.search`, message tools, and read tools stay ungated.

## Built-in roles

| Role | Permissions |
| --- | --- |
| `observer` | none (search and read only) |
| `worker` | `memory.private.write`, `memory.group.write` |
| `reviewer` | `review`, `memory.private.write` |
| `coordinator` | `coordinate`, `memory.private.write`, `memory.group.write` |
| `integrator` | `integrate`, `memory.private.write` |
| `curator` | `memory.persona.write`, `memory.global.write`, `memory.archive`, `memory.private.write`, `memory.group.write` |
| `lead` | `coordinate`, `review`, `memory.private.write`, `memory.group.write` |

Config:

```toml
[roles.qa]                       # custom role
permissions = ["review", "memory.private.write"]

[[agents]]
name = "Reviewer"
roles = ["reviewer", "qa"]       # optional
permissions = ["integrate"]      # optional direct grants
```

## Phases

1. **Resolver and config.** `src/access.rs`; `AgentConfig.roles`, `HivemindConfig.roles`; validation (unknown permission, unknown role, shadowed built-in, empty role name).
2. **Coordination integration.** `Roster` stores effective permissions; `tools.rs` and `service.rs` use `task.decide`, `task.reassign`, `group.manage`; separation-of-duties checks.
3. **Memory gating.** `ConversationCoordinator` holds the policy; `invoke_with_memory` authorizes before executing a memory tool call.
4. **Audit.** SQLite log written from both paths; API `GET /api/v1/access/personas` and `GET /api/v1/access/audit`; CLI `hivemind access show` and `hivemind access audit`.
5. **Docs and tests.** `docs/access-control.md`; unit tests for resolution/validation, memory gating, separation of duties, audit; smoke run of the CLI.

## Acceptance

- A persona with no roles behaves exactly as before (existing tests pass unchanged).
- A persona with `roles = ["observer"]` cannot write private/group/persona/global memory or archive; `memory.search` still works; each denial is audited.
- A `worker` cannot use `memory.global.*` even with a valid `Global:` directive.
- A persona holding only `delegate` can create groups and reassign; a persona holding neither cannot, and is not offered those tools.
- Reassigning a task so owner equals reviewer fails.
- Config with an unknown permission or role, or a custom role named like a built-in, fails validation with a message naming the persona/role.
- `hivemind access show` prints effective permissions per persona; `hivemind access audit --denied` lists denials.

## Not in this change (future)

Scoped grants (`integrate@workspace:x`), per-role budgets, human approval gates (`requires_approval`), restricting the underlying runtime's own tools (shell, network, paths) per role, delegation limits (grant only what you hold), API principals/human roles, time-bound elevation, workspace-tool gating (`workspace.write`), minimum-disclosure `agents.list` (hiding other personas' permissions), and audit export/retention config. These need designs of their own; none is required for the behavior above.
