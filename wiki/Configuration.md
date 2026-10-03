# Configuration

Hivemind reads `hivemind.toml` (create it with `hivemind init`, or pass another file with `--config`). The database lives in `.hivemind/` next to the config file. **Configure** in the web UI edits the budgets, runtime timeouts, skill folders, and project-folder roots on this page and writes them back to the file. Those changes apply to the running hive. Turning coordination on when this process started with it off takes effect after `hivemind serve` is started again. A commented starting point is in [`hivemind.example.toml`](https://github.com/Anxiety471/Hivemind/blob/main/hivemind.example.toml); a full role-based team is in [`examples/team.toml`](https://github.com/Anxiety471/Hivemind/blob/main/examples/team.toml).

## Runtimes

```toml
[runtime]
omp_binary = "omp"
pi_binary = "pi"
opencode_binary = "opencode"
prompt_timeout_secs = 300   # max seconds of runtime inactivity before a prompt times out; 0 disables
idle_timeout_secs = 120     # how long an unused session stays alive; 0 = never idle out
```

## Personas

Each persona picks its own runtime, so Pi, OMP, and OpenCode can run side by side in one process.

```toml
[[personas]]
id = "Engineer"
role = "Backend Engineer"
runtime = "pi"
workspace = "."
system_prompt = "You are the Engineer."
model = "provider/model-id"
reasoning = "high"

[[personas]]
id = "Reviewer"
role = "Reviewer"
runtime = "omp"
workspace = "."
system_prompt = "You are the Reviewer."
fast = true

[[personas]]
id = "Scout"
runtime = "opencode"
workspace = "."
system_prompt = "You are the Scout."
model = "opencode/big-pickle"   # free opencode/*-free models need no API key
```

| Key | Notes |
| --- | --- |
| `id` | Persona name used everywhere (CLI, reply order, groups) |
| `runtime` | `"pi"`, `"omp"`, or `"opencode"`. Defaults to `"omp"` for older configs. Legacy `[[agents]]` entries are read as personas. |
| `workspace` | Working directory for the runtime process. Must exist. See [Workspaces](Workspaces). |
| `system_prompt` | The persona's instructions |
| `model` | OMP/Pi: maps to `--model`. OpenCode: `provider/model-id`, selected per session over ACP. |
| `reasoning` | OMP: maps to `--thinking` (legacy key `thinking` still accepted). Rejected for OpenCode. |
| `fast` | OMP only. Leave out for the default, or `true`/`false` to apply once at session start. |
| `role` | Descriptive role text for prompts. Grants nothing. Group `member_roles` override it. |
| `roles` | Access roles that grant permissions. See [Access Control](Access-Control). |
| `permissions` | Direct permission grants. See [Access Control](Access-Control). |
| `capabilities` | Skill tags used to match tasks. See [Coordination](Coordination). |

### OpenCode notes

Hivemind runs `opencode acp` (Agent Client Protocol over stdio, no port), one child per room + persona, and deletes the OpenCode session on shutdown. The persona's `system_prompt` replaces OpenCode's `build` agent prompt. Hivemind sets `"permission": "allow"` in the child's config, so OpenCode never waits for approval, just like Pi and OMP. **Treat the workspace as untrusted-model territory:** an agent can read and write anything your user can, unless [roles](Access-Control) restrict it. OpenCode's reported context already includes its built-in prompt (several thousand tokens), so set `runtime_rotate_tokens` accordingly.

## Reply order and groups

```toml
[conversation]
reply_order = ["Reviewer", "Engineer"]

[[groups]]
id = "development"
mode = "discussion"
members = ["Engineer", "Reviewer"]
reply_order = ["Reviewer", "Engineer"]
# workspace = "/abs/path/to/project"   # optional shared workspace
[groups.member_roles]
Engineer = "Backend Engineer"
Reviewer = "Architecture Reviewer"
```

- Personas you leave out of `reply_order` follow declaration order.
- **Main/all** turns use broadcast mode. **Solo** turns use the same room/history/context setup with one participant.
- A group's `reply_order` may only list members. A partial order puts the remaining members after it, in global order.

| Mode | Behavior |
| --- | --- |
| `broadcast` | All participants run concurrently with the same turn context |
| `discussion` | Participants run in effective order; each sees the earlier replies from the same turn |

## Context

```toml
[context]
recent_turns = 6                 # raw recent-turn window
summary_max_tokens = 2000
context_target_tokens = 12000    # approximate context budget
runtime_rotate_tokens = 24000    # live context size that rotates a session before its next turn
summary_refresh_turns = 4
```

## Memory

```toml
[memory]
mode = "deterministic"   # local SQLite with FTS5; no LLM required
```

See [Memory](Memory).

## Workspaces

```toml
[workspaces]
roots = ["/abs/path/to/projects"]   # optional: limits where agents may point a workspace
```

See [Workspaces](Workspaces).

## Skills

```toml
[skills]
dirs = ["~/.agents/skills"]   # each directory holds <name>/SKILL.md folders; earlier directories win duplicate names
```

Runtimes start with their own skill discovery switched off, so agents only know the skills listed here. They are offered in every room as `skills.list()` and `skills.read(name, path?)` calls through the `hivemind-tool` fence: the prompt names each skill with a one-line description, and the agent reads the instructions (or another file in the skill folder) when a request matches. Reads cannot leave the skill folder and are cut at 64 KiB. Directories are rescanned on every call, so new skills need no restart; changing `dirs` does. Nothing is offered when `dirs` is empty.

## Coordination

`[coordination] enabled = true` turns on autonomous tasks. All keys and budgets are on the [Coordination](Coordination) page.

## Room state directives

Room state changes only from explicit, line-based directives in **user** input. Agent prose is never treated as a state update.

```text
Goal: ship the parser safely
Decision: use typed updates
Assign: Engineer = implement parser
Question: should malformed lines be rejected?
Completed: define the update syntax
Global: Hivemind architecture: runtimes are disposable
```

- `Goal` replaces the current goal.
- Repeated `Decision`, `Question`, and `Completed` values are stored once.
- `Assign` takes `persona = task` and replaces that persona's assignment.
- Every later context pack includes the structured state.
- `Global:` lets through **exactly one** global memory write for that turn. An agent's `memory.global.propose` is accepted only if its content exactly matches the trimmed text after `Global:`. The authorization is tied to the directive's turn and message, never to model-supplied arguments.
