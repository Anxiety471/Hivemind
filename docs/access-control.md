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

`examples/team.toml` is a ready-made team (Leader, Researcher, Implementor, Tester, Writer, and an Auditor built on a custom `security-auditor` role) with a system prompt and capabilities for each.

## Permissions

| Permission | Gates |
| --- | --- |
| `coordinate` | Plan root tasks; implies `delegate`, `group.manage`, `task.reassign` |
| `delegate` | `tasks.delegate` creating subtasks; implies `group.manage`, `task.reassign` |
| `review` | Be selected as reviewer; implies `task.decide` |
| `integrate` | Own integration tasks |
| `task.decide` | `tasks.decide` |
| `task.reassign` | `tasks.delegate` with a `task` argument |
| `group.manage` | `groups.create`, `groups.members.update`; `workspace.set`/`workspace.clear` in a group room |
| `workspace.write` | The runtime's file-editing tools (`edit`, `write`, notebooks); owning work tasks; `workspace.set` in a solo room |
| `workspace.exec` | The runtime's shell and code execution (`bash`, `python`); shell can also write files, so treat it as write-capable |
| `memory.private.write` | `memory.private.add/update/upsert` |
| `memory.group.write` | `memory.group.add/update/upsert` |
| `memory.persona.write` | `memory.persona.propose/update` |
| `memory.global.write` | `memory.global.propose/update` (the exact `Global:` user directive is still required) |
| `memory.archive` | `memory.archive` |

`memory.search`, `workspace.get`, `workspace.list`, messaging, and read tools are never gated. The coordinator of a root task may still delegate and manage groups on it without holding the permission.

## Built-in roles

| Role | Permissions |
| --- | --- |
| `observer` | none (read-only) |
| `researcher` | `memory.private.write`, `memory.group.write` (read-only workspace: cannot edit, write, or run shell) |
| `implementor` | `workspace.write`, `workspace.exec`, `memory.private.write`, `memory.group.write` |
| `worker` | same as `implementor` |
| `reviewer` | `review`, `memory.private.write` (read-only) |
| `coordinator` | `coordinate`, `memory.private.write`, `memory.group.write` (read-only) |
| `integrator` | `integrate`, `workspace.write`, `workspace.exec`, `memory.private.write` |
| `curator` | `memory.persona.write`, `memory.global.write`, `memory.archive`, `memory.private.write`, `memory.group.write` (read-only) |
| `lead` | `coordinate`, `review`, `memory.private.write`, `memory.group.write` (read-only) |
| `orchestrator` | `coordinate`, `task.decide`, `memory.private.write`, `memory.group.write`, `memory.archive` (pure delegator, read-only) |
| `leader` | `review` (implies `task.decide`), `memory.private.write`, `memory.group.write` (observer with a voice: read-only, reviews and decides, does not plan) |
| `tester` | `workspace.exec`, `memory.private.write`, `memory.group.write` (shell but no edit tools) |
| `writer` | `workspace.write`, `memory.private.write`, `memory.group.write` (edit tools but no shell) |

## Workspace tool restriction

A persona that declares roles and lacks `workspace.write` or `workspace.exec` starts its runtime with only the matching tools:

| Runtime | Mechanism |
| --- | --- |
| `pi` | `--tools` allowlist (`read,grep,find,ls` plus `edit,write` and/or `bash` when granted) |
| `omp` | `--tools` allowlist (`read,grep,glob,lsp,web_search,todo` plus `edit,write,notebook` and/or `bash,python`); sub-agents, browser, and desktop tools are off |
| `opencode` | `permission` config: `edit` and/or `bash` set to `deny` |

A persona with both permissions, or with no roles, is unrestricted. Coordination also refuses to make a persona without `workspace.write` the owner of a work task (plan, explicit owner, or reassignment); a persona without roles still may own work. The restriction covers the runtime's own tools only; a custom role needs `workspace.write`/`workspace.exec` added explicitly.

## Web access

Every persona keeps its runtime's web tools by default. Set `web = false` on a persona (`[[personas]]`, or `"web": false` in the agents API) to turn them off:

| Runtime | Effect of `web = false` |
| --- | --- |
| `omp` | Drops `web_search` from the `--tools` allowlist and loads an extra overlay (`harness/omp-noweb.yml`) with `web_search.enabled: false` and `fetch.enabled: false`; verified `web_search` leaves the tool list |
| `opencode` | `permission` config denies `webfetch` and `websearch` |
| `pi` | None: Pi has no web tool |

This only gates the runtime's own web tools. A persona with `workspace.exec` can still reach the network through the shell (`curl`), and OMP's `read` may still accept URLs; withhold `workspace.exec` for strict isolation.

## Compatibility

- A persona with **no `roles`** keeps today's behavior: gated memory tools are unrestricted, runtime tools are unrestricted, and coordination follows its direct `permissions`.
- Declaring **any role** makes gated memory tools deny-by-default: only permissions the roles and direct grants provide apply. It also restricts runtime workspace tools as above, so roles such as `reviewer`, `lead`, and `coordinator` are now read-only; add `implementor` or a direct `workspace.write` to let them edit.
- Coordination tools are always permission-based.
- Workspace tools (see [workspaces](workspaces.md)) follow the same rule as memory: unrestricted without roles, permission-based with them. A persona that cannot change its workspace is offered only `workspace.get` and `workspace.list`.
- The memory tool manifest is shared by all personas, so a restricted persona is still told the tools exist; a denied call returns `permission denied` and is audited.

## Separation of duties

- A non-root task's owner never reviews it (when more than one persona exists).
- `tasks.delegate` reassignment cannot make the task's reviewer its owner.
- Root tasks are exempt: the coordinator owns and reviews them by design.

## Audit log

Every gated decision (memory writes; `workspace.set`, `workspace.clear`; `tasks.plan.propose`, `tasks.delegate`, `tasks.decide`, `tasks.result.submit`, `tasks.review`, `tasks.block`, `groups.create`, `groups.members.update`) is recorded, allowed or denied, in `.hivemind/access.sqlite3` with persona, permission, action, resource, decision, and reason. The newest 10 000 rows are kept. A failed audit write is reported on stderr and never changes the decision.

```
hivemind access audit --denied --persona Reviewer --limit 20
GET /api/v1/access/audit?denied=true&persona=Reviewer&limit=20
```

## Not covered

Scoped grants (per group or workspace), per-role budgets, human approval gates, restricting the runtime's network or paths (only edit and shell tools are gated), delegation limits, and API principals. See `plan/2026-09-30/GOAL-2026-09-30-AGENT-ACCESS-CONTROL.md`.
