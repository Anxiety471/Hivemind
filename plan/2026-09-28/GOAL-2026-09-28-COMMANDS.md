# GOAL — 2026-09-28 — Commands and Conversation Spaces

## Objective

Give Hivemind a **real command-line interface**, not just slash commands after entering chat.

Hivemind should support both:

1. **shell commands**, such as:

   ```bash
   hivemind ask Albedo "review this architecture"
   hivemind group create backend Albedo Maomao
   hivemind chat --group backend
   ```

2. **interactive chat commands**, such as:

   ```text
   /ask Albedo review this architecture
   /group use backend
   ```

The shell command surface is the primary management interface. Interactive slash commands are convenience controls while a chat session is already running.

The same domain operations should be shared underneath both interfaces instead of implementing two unrelated command systems.

---

# Command architecture

Use three layers:

```text
Shell CLI (clap)
        |
        +--------------------+
        |                    |
Interactive parser      Shell subcommands
        |                    |
        +---------+----------+
                  |
            Command service
                  |
        +---------+----------+
        |                    |
   AgentManager        Conversation/Group state
        |
   Pi / OMP adapters
```

Shell commands and chat commands should call the same service/domain operations where their behavior overlaps.

Do not bury application behavior directly inside Clap handlers or the interactive input loop.

---

# Shell command surface

The target shell CLI should include:

```text
hivemind init
hivemind doctor

hivemind chat
hivemind chat --solo <agent>
hivemind chat --group <group>

hivemind agents
hivemind status
hivemind order

hivemind ask <agent> <message>
hivemind all <message>

hivemind group create <name> [agent...]
hivemind group list
hivemind group show <name>
hivemind group add <name> <agent>
hivemind group remove <name> <agent>
hivemind group delete <name>
```

Global options such as the existing config path should continue to work:

```bash
hivemind --config ./my-hive.toml agents
hivemind --config ./my-hive.toml chat
```

When developing through Cargo, all commands must have equivalent forms:

```bash
cargo run -- agents
cargo run -- ask Albedo "hello"
cargo run -- group list
```

---

# Shell command behavior

## `hivemind init`

Keep the existing initialization behavior.

It creates a starter configuration and refuses to overwrite an existing file unless `--force` is explicitly supplied.

Example:

```bash
hivemind init
hivemind init --force
```

---

## `hivemind doctor`

Validate the local Hivemind setup.

This belongs primarily to the setup milestone, but the CLI command hierarchy must reserve and support it cleanly.

Example:

```bash
hivemind doctor
```

---

## `hivemind chat`

Start an interactive conversation in the main hive.

Example:

```bash
hivemind chat
```

Bare input goes to all configured agents according to Hivemind's conversation/reply-order rules.

Running `hivemind` with no subcommand may remain an alias for `hivemind chat` for convenience and backward compatibility.

---

## `hivemind chat --solo <agent>`

Start directly in a solo conversation with one agent.

Example:

```bash
hivemind chat --solo Albedo
```

Only Albedo receives bare-text turns until the user switches conversations interactively.

Reject unknown agent names before chat starts.

---

## `hivemind chat --group <group>`

Start directly inside a configured group.

Example:

```bash
hivemind chat --group backend
```

Only members of that group receive bare-text turns.

Reject:

- unknown groups,
- empty groups.

---

## `hivemind agents`

Inspect configured agents without entering chat.

Example:

```bash
hivemind agents
```

Suggested output:

```text
Agents:
  1. Albedo [pi]
  2. Maomao [pi]
  3. Frieren [omp]
```

Show effective reply order.

Do not require starting provider-backed runtime sessions merely to list static configuration.

---

## `hivemind status`

Show useful current configuration/runtime readiness information without entering a conversation.

Example:

```bash
hivemind status
```

At minimum show:

- configured agent count,
- runtimes used,
- configured groups,
- effective reply order,
- whether required runtime executables can be resolved if that check is already available.

Do not make unnecessary paid model calls.

---

## `hivemind order`

Print the effective global speaker/reply order.

Example:

```bash
hivemind order
```

Output:

```text
Reply order:
  1. Albedo
  2. Maomao
  3. Frieren
```

This is read-only for now.

---

## `hivemind ask <agent> <message>`

Run a **one-shot solo prompt** from the shell.

Example:

```bash
hivemind ask Albedo "review the runtime boundary"
```

Expected lifecycle:

```text
load config
   |
start only required agent/runtime
   |
send prompt
   |
print reply
   |
clean shutdown
```

Do not start every configured agent for a one-agent request unless the architecture makes that unavoidable.

Unknown agents must fail before attempting runtime startup.

Exit with a non-zero status on execution failure.

---

## `hivemind all <message>`

Run a one-shot broadcast from the shell.

Example:

```bash
hivemind all "review the current architecture"
```

All configured agents may work concurrently.

Replies must be printed in deterministic Hivemind reply order, not completion order.

After the turn finishes, cleanly shut down all started runtime processes.

---

# Shell group management

Groups must be manageable without entering interactive chat.

Because shell commands are separate processes, group definitions cannot be purely in-memory anymore.

For this command goal, make named groups **configuration-backed**.

A suitable representation is:

```toml
[[groups]]
name = "backend"
members = ["Albedo", "Maomao"]

[[groups]]
name = "reviewers"
members = ["Albedo", "Frieren"]
```

The exact TOML shape may differ, but it must be deterministic and human-readable.

Group management commands explicitly mutate the configured Hivemind file. This is not a silent side effect: the user is explicitly invoking a configuration-changing command.

Writes should be safe:

1. load,
2. validate,
3. modify in memory,
4. serialize,
5. write atomically where practical.

Do not destroy unrelated formatting/configuration unnecessarily if a safer representation or update path is feasible.

---

## `hivemind group create <name> [agent...]`

Create and persist a named group.

Examples:

```bash
hivemind group create backend Albedo Maomao
hivemind group create reviewers
```

Reject:

- duplicate group names,
- reserved names such as `main`,
- unknown agents.

An empty group may exist but cannot be used for chat until it has at least one member.

---

## `hivemind group list`

List persisted groups.

Example:

```bash
hivemind group list
```

Output:

```text
Groups:
  backend    Albedo, Maomao
  reviewers  Albedo, Frieren
  empty      (no agents)
```

---

## `hivemind group show <name>`

Show one persisted group.

Example:

```bash
hivemind group show backend
```

Output:

```text
Group: backend
Members:
  1. Albedo [pi]
  2. Maomao [pi]

Effective reply order:
  1. Albedo
  2. Maomao
```

---

## `hivemind group add <name> <agent>`

Persistently add an agent to a group.

Example:

```bash
hivemind group add backend Frieren
```

Reject:

- unknown group,
- unknown agent,
- duplicate membership.

---

## `hivemind group remove <name> <agent>`

Persistently remove an agent from a group.

Example:

```bash
hivemind group remove backend Maomao
```

Reject removing a non-member.

An empty group may remain defined.

---

## `hivemind group delete <name>`

Delete a persisted group definition.

Example:

```bash
hivemind group delete backend
```

Deleting a group does not delete, stop, or modify its agents.

---

# Interactive conversation spaces

The interactive chat still supports three routing modes.

## Main hive

```text
main
  ├─ Albedo
  ├─ Maomao
  └─ Frieren
```

Bare text goes to all configured agents.

## Solo

```text
solo:Albedo
  └─ Albedo
```

Bare text goes only to the selected agent.

## Group

```text
group:backend
  ├─ Albedo
  └─ Maomao
```

Bare text goes only to persisted group members.

Conversation routing belongs to Hivemind core, not Pi or OMP.

---

# Interactive chat commands

While `hivemind chat` is running, support:

```text
/help
/agents
/status
/order
/where

/ask <agent> <message>
/all <message>

/solo <agent>
/main

/group create <name> [agent...]
/group list
/group show <name>
/group use <name>
/group add <name> <agent>
/group remove <name> <agent>
/group delete <name>

/quit
```

`/exit` remains an alias for `/quit`.

Where an interactive command has a shell equivalent, both should use the same underlying command/service logic.

---

# Interactive command semantics

## `/ask <agent> <message>`

Send one prompt to one agent without changing the active conversation.

Equivalent domain action to:

```bash
hivemind ask <agent> <message>
```

but it reuses the already-running agent worker/session when possible.

---

## `/all <message>`

Send one turn to the complete hive without changing the current conversation target.

Equivalent domain action to:

```bash
hivemind all <message>
```

but it reuses active runtime workers.

---

## `/solo <agent>`

Switch the current interactive routing target to one agent.

Does not restart unrelated agents.

---

## `/main`

Return to the default all-agent conversation.

---

## `/group use <name>`

Switch the current interactive routing target to a persisted group.

There is intentionally no shell equivalent `hivemind group use` because a shell process exits immediately and has no lasting active conversation.

The shell equivalent is:

```bash
hivemind chat --group <name>
```

---

## Interactive group mutation

`/group create`, `/group add`, `/group remove`, and `/group delete` should operate on the same persisted group registry as the shell commands.

Because these are explicit mutation commands, persisting the change is expected.

If an active group is deleted, automatically switch the current chat to `main`.

If an active group becomes empty, keep the group definition but reject bare-text prompts until the user switches or adds a member.

---

# Typed command models

Use typed representations for both command surfaces.

Conceptually:

```rust
enum CliCommand {
    Init { force: bool },
    Doctor,
    Chat { solo: Option<String>, group: Option<String> },
    Agents,
    Status,
    Order,
    Ask { agent: String, message: String },
    All { message: String },
    Group(GroupCommand),
}
```

and:

```rust
enum GroupCommand {
    Create { name: String, agents: Vec<String> },
    List,
    Show { name: String },
    Add { name: String, agent: String },
    Remove { name: String, agent: String },
    Delete { name: String },
}
```

Interactive commands may map into the same application actions where possible.

Do not duplicate business logic between shell and chat parsers.

---

# AgentManager operations

Support domain/runtime operations conceptually equivalent to:

```text
prompt_agent(agent_name, message)
prompt_agents(agent_names, message)
prompt_all(message)
```

Shell one-shot commands may create a temporary AgentManager scoped only to required agents.

Interactive chat should reuse its existing workers.

Do not call Pi or OMP directly from CLI command handlers.

---

# Deterministic ordering

Any command that involves multiple agents must obey Hivemind's reply-order policy:

- `hivemind all`,
- bare text in main,
- bare text in a group,
- `/all`.

Agents may execute asynchronously.

Hivemind decides presentation order.

For group conversations, use global reply order filtered to members.

---

# Important context limitation

A configured persistent agent may currently share runtime context across main, solo, and group routes.

This goal introduces command/routing structure, not per-room model isolation.

Do not claim that group chats have isolated agent memory unless a later session-isolation milestone implements it.

Shell one-shot commands naturally create temporary sessions because the process starts and ends around the command.

---

# Error behavior and exit codes

Shell commands should use conventional exit behavior:

```text
0  success
non-zero  invalid config, command failure, runtime failure, etc.
```

Errors must identify the relevant object.

Examples:

```text
error: no configured agent named 'Unknown'
```

```text
error: no group named 'backend'
```

```text
error: group 'backend' has no members
```

```text
error: runtime 'pi' for agent 'Albedo' could not be started
```

Malformed interactive commands should print useful usage without crashing.

---

# Help

Both:

```bash
hivemind --help
```

and:

```text
/help
```

must reflect the command surface they actually support.

Prefer structured command metadata so help text does not become a second manually maintained universe.

Expected shell help should make the CLI discoverable:

```text
Usage: hivemind <COMMAND>

Commands:
  init
  doctor
  chat
  agents
  status
  order
  ask
  all
  group
```

Nested help must work:

```bash
hivemind group --help
hivemind group create --help
```

---

# README

Document shell commands before interactive slash commands.

The short command reference should include:

```bash
hivemind init
hivemind doctor
hivemind chat
hivemind chat --solo Albedo
hivemind chat --group backend

hivemind agents
hivemind status
hivemind order

hivemind ask Albedo "hello"
hivemind all "hello"

hivemind group create backend Albedo Maomao
hivemind group list
hivemind group show backend
hivemind group add backend Frieren
hivemind group remove backend Maomao
hivemind group delete backend
```

Then document the equivalent interactive commands.

---

# Acceptance criteria

The goal is complete when:

1. Hivemind has first-class shell subcommands beyond `init` and `chat`.
2. `hivemind agents` lists configured agents without entering chat.
3. `hivemind status` reports useful local Hivemind state.
4. `hivemind order` prints effective reply order.
5. `hivemind ask <agent> <message>` performs a one-shot targeted prompt.
6. `hivemind all <message>` performs a one-shot multi-agent prompt.
7. One-shot runtime processes are always cleaned up.
8. `hivemind chat --solo <agent>` starts in solo mode.
9. `hivemind chat --group <group>` starts in a group.
10. Groups are persisted in Hivemind configuration.
11. Shell group commands can create/list/show/add/remove/delete groups.
12. Interactive group commands operate on the same group definitions.
13. Main, solo, and group routing work correctly.
14. `/ask` and `/all` do not change the active conversation.
15. `/where` reports the active interactive conversation.
16. Group multi-agent replies use deterministic filtered reply order.
17. Pi and OMP agents can be mixed in one group.
18. Unknown agents/groups fail before unnecessary runtime startup.
19. Shell failures return non-zero exit status.
20. Unknown interactive slash commands are not forwarded to agents.
21. `/quit` and `/exit` shut down running workers cleanly.
22. `hivemind --help` and nested command help are useful.
23. README documents both shell and interactive command workflows.
24. `cargo test` passes.
25. `cargo clippy --all-targets --all-features -- -D warnings` passes.

---

# Tests to add

Add deterministic tests for:

- Clap parsing for every shell command,
- global `--config` support with nested commands,
- shell `ask` targeting only one agent,
- shell `all` deterministic output ordering,
- one-shot process cleanup,
- chat starting in main/solo/group modes,
- unknown startup solo/group targets,
- group config serialization,
- group create/list/show/add/remove/delete,
- duplicate groups,
- duplicate membership,
- empty groups,
- typed interactive parsing,
- `/ask` and `/all`,
- main/solo/group routing,
- active group deletion,
- mixed Pi/OMP groups,
- help output matching implemented commands,
- non-zero shell failure exit paths.

Use fake runtime processes where possible so tests do not require provider API calls.

---

# Non-goals

Do not add these yet:

- agent-to-agent autonomous conversation,
- automatic speaker selection,
- debate/voting,
- `spawn`,
- `delegate`,
- shared memory,
- task management,
- dynamic runtime switching,
- provider billing/token commands,
- arbitrary shell execution,
- per-conversation isolated agent runtime sessions.

Those belong to later milestones.

---

## Definition of done

Hivemind should work as a real CLI application:

```text
hivemind
   |
   +-- inspect
   |     +-- agents
   |     +-- status
   |     +-- order
   |
   +-- one-shot work
   |     +-- ask
   |     +-- all
   |
   +-- manage
   |     +-- init
   |     +-- doctor
   |     +-- group ...
   |
   +-- interactive
         +-- chat
         +-- chat --solo
         +-- chat --group
```

The user should be able to manage and use Hivemind directly from the shell without entering an interactive chat merely to perform one action.
