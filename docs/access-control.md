# Access control

A persona's authority is the union of its **roles'** permissions and its direct `permissions`, expanded by the implications below. Hivemind decides in Rust; a model never grants itself anything, and identity always comes from the Hivemind-bound room, persona, and task lease, never from tool arguments. The `role` string on a persona and `member_roles` on a group are prompt text only.

```toml
[roles.qa]                         # custom role; built-in names are reserved
permissions = ["review", "memory.private.write"]

[[personas]]
id = "Reviewer"
roles = ["reviewer", "qa"]         # optional
permissions = ["integrate"]        # optional direct grants
```

`hivemind access show` prints each persona's effective permissions; `GET /api/v1/access/personas` returns the same.

## Permissions

| Permission | Gates |
| --- | --- |
| `coordinate` | Plan root tasks; implies `delegate`, `group.manage`, `task.reassign` |
| `delegate` | `tasks.delegate` creating subtasks; implies `group.manage`, `task.reassign` |
| `review` | Be selected as reviewer; implies `task.decide` |
| `integrate` | Own integration tasks |
| `task.decide` | `tasks.decide` |
| `task.reassign` | `tasks.delegate` with a `task` argument |
| `group.manage` | `groups.create`, `groups.members.update` |
| `memory.private.write` | `memory.private.add/update/upsert` |
| `memory.group.write` | `memory.group.add/update/upsert` |
| `memory.persona.write` | `memory.persona.propose/update` |
| `memory.global.write` | `memory.global.propose/update` (the exact `Global:` user directive is still required) |
| `memory.archive` | `memory.archive` |

`memory.search`, messaging, and read tools are never gated. The coordinator of a root task may still delegate and manage groups on it without holding the permission.

## Built-in roles

| Role | Permissions |
| --- | --- |
| `observer` | none |
| `worker` | `memory.private.write`, `memory.group.write` |
| `reviewer` | `review`, `memory.private.write` |
| `coordinator` | `coordinate`, `memory.private.write`, `memory.group.write` |
| `integrator` | `integrate`, `memory.private.write` |
| `curator` | `memory.persona.write`, `memory.global.write`, `memory.archive`, `memory.private.write`, `memory.group.write` |
| `lead` | `coordinate`, `review`, `memory.private.write`, `memory.group.write` |

## Compatibility

- A persona with **no `roles`** keeps today's behavior: gated memory tools are unrestricted, and coordination follows its direct `permissions`.
- Declaring **any role** makes gated memory tools deny-by-default: only permissions the roles and direct grants provide apply.
- Coordination tools are always permission-based.
- The memory tool manifest is shared by all personas, so a restricted persona is still told the tools exist; a denied call returns `permission denied` and is audited.

## Separation of duties

- A non-root task's owner never reviews it (when more than one persona exists).
- `tasks.delegate` reassignment cannot make the task's reviewer its owner.
- Root tasks are exempt: the coordinator owns and reviews them by design.

## Audit log

Every gated decision (memory writes; `tasks.plan.propose`, `tasks.delegate`, `tasks.decide`, `tasks.result.submit`, `tasks.review`, `tasks.block`, `groups.create`, `groups.members.update`) is recorded, allowed or denied, in `.hivemind/access.sqlite3` with persona, permission, action, resource, decision, and reason. The newest 10 000 rows are kept. A failed audit write is reported on stderr and never changes the decision.

```
hivemind access audit --denied --persona Reviewer --limit 20
GET /api/v1/access/audit?denied=true&persona=Reviewer&limit=20
```

## Not covered

Scoped grants (per group or workspace), per-role budgets, human approval gates, restricting the runtime's own tools (shell, network, paths), delegation limits, API principals, and gating of workspace tools. See `plan/2026-09-30/GOAL-2026-09-30-AGENT-ACCESS-CONTROL.md`.
