# Workspaces

Every persona runs its runtime (`pi`, `omp`, `opencode`) in a working directory. A persona always has its own `workspace`; a group can optionally have a **shared workspace** that all its members use inside that group. Users set both in the config, and agents can read and change them in chat with `workspace.*` tools.

## Which directory a turn runs in

| Room | Directory |
| --- | --- |
| Main (`all`) | Each persona's own `workspace` |
| Solo | That persona's own `workspace` |
| Group with a shared workspace | The group's `workspace`, for every member |
| Group without one | Each member's own `workspace`; members are told not to assume a shared directory |

A shared group workspace always wins over a member's own workspace inside that group, and only there.

## Configuring

```toml
[[personas]]
id = "Engineer"
workspace = "/home/me/projects/api"   # required; the persona's own directory

[[groups]]
name = "team"
members = ["Engineer", "Reviewer"]
workspace = "/home/me/projects/api"   # optional shared workspace

[workspaces]                          # optional: limit where agents may point
roots = ["/home/me/projects"]
```

`[workspaces] roots` limits agents only: paths you write in the config are never checked against it. A persona's `workspace` must be an existing directory when chat starts, and `hivemind doctor` reports one that is missing.

## Agent tools

Workspace tools are offered only in group rooms and solo rooms, never in the main room. A call uses the same `hivemind-tool` fence as the memory tools.

| Tool | Group room | Solo room |
| --- | --- | --- |
| `workspace.get()` | Shows the shared workspace, or that none is configured | Shows the persona's own workspace |
| `workspace.list()` | Each configured root and its visible subdirectories (up to 50) | Same |
| `workspace.set(path)` | Sets or replaces the group's shared workspace | Changes the persona's own `workspace` everywhere it runs |
| `workspace.clear()` | Removes the shared workspace; members go back to their own | Not available: a persona always has a workspace |

Agents are told to call `workspace.set` only with a path the user gave and never to invent one.

## Rules for agent changes

- The path must be absolute, at most 1024 bytes, and an existing directory.
- With `[workspaces] roots`, the path must resolve inside one of the roots. Symlinks are resolved first, so a link inside a root cannot point outside it. Without roots, any existing directory is accepted and `workspace.list` says there is nothing to list.
- The change is written to the config file before it takes effect. Only that one `workspace` key changes; comments and the rest of the file are kept. The write goes to a temporary file that replaces the config, so a failed write leaves the config unchanged.
- The new directory applies from the next message. A live runtime session still sitting in the old directory is stopped before that turn (`runtime.stopped` with reason `workspace_changed`) and a fresh one starts in the new directory.

## Access control

Changing a workspace is gated like memory writes (see [access-control.md](access-control.md)):

| Call | Permission |
| --- | --- |
| `workspace.set` / `workspace.clear` in a group room | `group.manage` (implied by `coordinate` and `delegate`) |
| `workspace.set` in a solo room | `workspace.write` |
| `workspace.get`, `workspace.list` | none |

A persona with no `roles` is unrestricted. A persona with roles that lack the permission is offered only `workspace.get` and `workspace.list`, and is told to have the user or another persona make the change. A denied call returns `permission denied`. Every gated call, allowed or denied, is recorded in `.hivemind/access.sqlite3` with the room as its resource (`hivemind access audit`).

## Coordination

When the workspace is a git repository, autonomous coordination attempts run in their own worktrees of it rather than in the directory itself; see [coordination.md](coordination.md#isolation-and-integration).
