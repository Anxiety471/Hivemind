# GOAL — 2026-09-28 — Commands and Conversation Spaces

## Objective

Give Hivemind a real command system for controlling **who the user is talking to**.

The CLI should support:

- normal hive-wide conversation,
- one-off prompts to a specific agent,
- a persistent solo conversation with one agent,
- named group chats containing selected agents,
- adding/removing agents from group chats,
- switching between conversation spaces,
- inspecting the current hive, reply order, and runtime state.

The important rule is that **bare text goes to the currently active conversation space**.

This keeps the CLI understandable as Hivemind grows instead of making every line mean "summon every agent and hope the terminal sorts out the social consequences."

---

## Conversation spaces

Hivemind should have three conversation modes.

### Main hive

The default conversation.

```text
main
  ├─ Albedo
  ├─ Maomao
  └─ Frieren
```

Bare text is sent to all configured agents.

### Solo chat

A conversation focused on one agent.

```text
solo:Albedo
  └─ Albedo
```

Bare text is sent only to that agent until the user leaves or switches conversations.

### Group chat

A named conversation containing a selected subset of configured agents.

```text
group:backend
  ├─ Albedo
  └─ Maomao
```

Bare text is sent only to members of that group.

A group is owned by Hivemind, not by Pi or OMP.

---

## Process commands

These remain shell-level commands:

```text
hivemind init
hivemind chat
hivemind doctor
```

`init` and `chat` already exist.

`doctor` belongs to the setup goal and should integrate cleanly when implemented.

---

## Chat commands

The interactive command surface should include:

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

---

## Typed command parser

Do not continue growing ad-hoc string matching in the chat loop.

Introduce a typed parser.

Conceptually:

```rust
enum ChatCommand {
    Help,
    Agents,
    Status,
    Order,
    Where,

    Ask {
        agent: String,
        message: String,
    },

    All {
        message: String,
    },

    Solo {
        agent: String,
    },

    Main,

    GroupCreate {
        name: String,
        agents: Vec<String>,
    },

    GroupList,

    GroupShow {
        name: String,
    },

    GroupUse {
        name: String,
    },

    GroupAdd {
        name: String,
        agent: String,
    },

    GroupRemove {
        name: String,
        agent: String,
    },

    GroupDelete {
        name: String,
    },

    Quit,
}
```

The exact internal shape may differ.

Parsing and execution should remain separate concerns.

Unknown slash commands must not be forwarded to agents.

---

# Core commands

## `/help`

Show the available commands and concise usage.

Keep one source of truth where practical so help output does not drift away from the parser.

---

## `/agents`

Show all configured Hivemind agents in effective reply order.

Include:

- order,
- agent name,
- runtime,
- readiness/session state when available.

Example:

```text
Agents:
  1. Albedo [pi] ready
  2. Maomao [pi] ready
  3. Frieren [omp] ready
```

Do not expose provider credentials or secrets.

---

## `/status`

Show the current local Hivemind state.

At minimum:

```text
Hivemind status
  agents: 3
  ready: 3/3
  conversation: group:backend

  Albedo   pi    ready
  Maomao   pi    ready
  Frieren  omp   ready
```

This is local process/runtime state.

It is not provider billing/token status.

---

## `/order`

Show the resolved global reply order.

Example:

```text
Reply order:
  1. Albedo
  2. Maomao
  3. Frieren
```

For a group conversation, group replies should use this order filtered to members of that group unless group-specific ordering is added in a future goal.

This command is read-only for this milestone.

---

## `/where`

Show the active conversation space.

Examples:

```text
conversation: main
participants: Albedo, Maomao, Frieren
```

```text
conversation: solo
participant: Albedo
```

```text
conversation: group:backend
participants: Albedo, Maomao
```

---

# One-off targeting

## `/ask <agent> <message>`

Send exactly one prompt to exactly one agent **without changing the active conversation**.

Example:

```text
You> /ask Albedo inspect the runtime boundary

Albedo> ...
```

If the user is currently in `group:backend`, they remain in `group:backend` afterward.

Agent names should be matched exactly.

If names contain spaces, support quoted names:

```text
/ask "Code Reviewer" inspect this
```

Do not guess ambiguous partial names.

---

## `/all <message>`

Send one prompt to every configured agent **without changing the active conversation**.

Example:

```text
/all summarize your current state
```

This is a one-off global broadcast.

It should obey deterministic reply ordering.

---

# Solo conversation

## `/solo <agent>`

Enter a persistent solo conversation mode with one configured agent.

Example:

```text
You> /solo Albedo
Switched to solo chat with Albedo.

Albedo> ready

You> review the scheduler
Albedo> ...
```

After switching, ordinary text is sent only to Albedo.

The user remains in solo mode until switching to:

- `/main`, or
- another `/solo`, or
- `/group use <name>`.

The command changes routing state. It does not terminate other agents.

---

## `/main`

Return to the default main hive conversation.

Example:

```text
/main
Switched to main hive.
```

Afterward, bare text again goes to all configured agents.

---

# Group chats

## `/group create <name> [agent...]`

Create a named group chat.

Examples:

```text
/group create backend Albedo Maomao
```

or:

```text
/group create reviewers
```

If no agents are provided, create an empty group that can be populated with `/group add`.

Group names must be unique.

Reserved names such as `main` should be rejected.

Creating a group does not automatically switch into it unless the implementation explicitly documents that behavior. Prefer creation without implicit switching.

---

## `/group list`

List all group chats.

Example:

```text
Groups:
  backend    Albedo, Maomao
  reviewers  Frieren, Albedo
  empty      (no agents)
```

Mark the active group when applicable.

---

## `/group show <name>`

Show one group's details.

Example:

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

## `/group use <name>`

Switch the active conversation to a named group.

Example:

```text
/group use backend
Switched to group:backend.
```

Afterward, bare text goes only to members of that group.

Attempting to use an empty group should fail clearly:

```text
error: group 'backend' has no agents
```

---

## `/group add <name> <agent>`

Add a configured agent to an existing group.

Example:

```text
/group add backend Frieren
```

Reject:

- unknown group,
- unknown agent,
- duplicate membership.

Adding an agent should not restart unrelated runtime workers.

---

## `/group remove <name> <agent>`

Remove an agent from a group.

Example:

```text
/group remove backend Maomao
```

Reject removing an agent that is not a member.

If the active group becomes empty, keep the group definition but prevent bare prompts until another member is added or the user switches conversations.

---

## `/group delete <name>`

Delete a group chat definition.

Example:

```text
/group delete backend
```

Deleting a group must not delete or stop the agents themselves.

If the deleted group is currently active, automatically return to `main` and print that transition.

---

# Bare text routing

Bare text is routed according to the active conversation.

### Main

```text
active = main

You> review this
```

Dispatch to all configured agents.

### Solo

```text
active = solo:Albedo

You> review this
```

Dispatch only to Albedo.

### Group

```text
active = group:backend

You> review this
```

Dispatch only to members of `backend`.

This routing must happen in Hivemind core.

Runtime adapters must not know about groups.

---

# Group ordering

Group replies must remain deterministic.

Given:

```text
Global order:
1. Albedo
2. Maomao
3. Frieren
```

and:

```text
group:backend
- Frieren
- Albedo
```

the effective group order is:

```text
1. Albedo
2. Frieren
```

Do not use completion speed as speaker order.

Agents may execute concurrently, but Hivemind controls presentation order.

---

# Conversation state

Introduce a small Hivemind-owned conversation state model.

Conceptually:

```rust
enum ConversationTarget {
    Main,
    Solo(String),
    Group(String),
}
```

and:

```rust
struct GroupChat {
    name: String,
    members: Vec<String>,
}
```

The exact types are flexible.

Do not put group ownership inside PiAdapter or OmpAdapter.

---

# Group persistence

For this milestone, group definitions may be **process-local** unless persistence is straightforward.

At minimum, groups created with commands must survive for the duration of the running Hivemind process.

Do not silently edit `hivemind.toml` as a side effect of chat commands.

Persisted group configuration can be introduced separately once the runtime behavior is proven.

---

# Runtime/session behavior

All targeting must go through the AgentManager/worker abstraction.

The manager should support operations conceptually equivalent to:

```text
prompt_agent(agent, message)
prompt_agents(agent_names, message)
prompt_all(message)
```

Do not call Pi or OMP directly from command handlers.

A solo/group command changes which workers participate in a turn.

It does not create a second copy of an agent unless a future conversation-isolation milestone explicitly introduces per-chat runtime sessions.

For now, the existing agent runtime/session semantics remain authoritative.

---

# Important context limitation

A configured agent currently owns its runtime/session according to Hivemind's existing runtime model.

Therefore, if the same persistent agent participates in:

- main,
- a solo chat,
- and a group chat,

its underlying runtime may retain context across those routes.

This goal is about **routing and chat membership**, not isolated per-room agent memory.

Do not pretend group conversations have fully isolated model context unless the runtime implementation actually provides it.

A separate goal should address per-conversation session isolation if we decide each room needs independent agent memory.

---

# Error behavior

Commands must fail clearly without panicking.

Examples:

```text
/solo Unknown
error: no configured agent named 'Unknown'
```

```text
/group use missing
error: no group named 'missing'
```

```text
/group add backend Unknown
error: no configured agent named 'Unknown'
```

```text
/group add backend Albedo
error: Albedo is already a member of group 'backend'
```

```text
/wat
error: unknown command '/wat'; run /help
```

---

# README

Update the CLI documentation with a compact command reference:

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

---

# Acceptance criteria

The goal is complete when:

1. Chat commands are handled by a dedicated typed parser.
2. `/help` documents the supported command surface.
3. `/agents` shows configured agents.
4. `/status` shows local runtime/agent state and active conversation.
5. `/order` shows deterministic global reply order.
6. `/where` shows the active conversation and participants.
7. `/ask` prompts one agent without changing conversation mode.
8. `/all` broadcasts once without changing conversation mode.
9. `/solo <agent>` switches bare-text routing to one agent.
10. `/main` returns bare-text routing to the full hive.
11. Groups can be created.
12. Groups can be listed and inspected.
13. Agents can be added to groups.
14. Agents can be removed from groups.
15. Groups can be deleted.
16. The user can switch into a group with `/group use`.
17. Bare text in a group reaches only group members.
18. Group replies follow global reply order filtered to group membership.
19. Mixed Pi and OMP agents can participate in one group.
20. Unknown agents/groups and malformed commands produce useful errors.
21. Unknown slash commands are never forwarded to agents.
22. `/quit` and `/exit` perform clean runtime shutdown.
23. Existing main-hive behavior remains available.
24. README command documentation is updated.
25. `cargo test` passes.
26. `cargo clippy --all-targets --all-features -- -D warnings` passes.

---

# Tests to add

Add deterministic tests for:

- command parsing,
- malformed commands,
- quoted agent names,
- main/solo/group routing,
- switching conversation targets,
- `/ask` not changing the current target,
- `/all` not changing the current target,
- group creation,
- duplicate group names,
- empty groups,
- adding agents,
- duplicate membership,
- removing agents,
- deleting active groups,
- unknown agents/groups,
- group ordering,
- mixed Pi/OMP membership,
- help output matching implemented commands.

Use fake workers/runtimes where practical.

---

# Non-goals

Do not add these yet:

- agents automatically talking to one another,
- one agent seeing another agent's answer within the same turn,
- autonomous speaker selection,
- debate/voting,
- `/spawn`,
- `/delegate`,
- shared memory,
- task management,
- dynamic runtime switching,
- provider billing/token commands,
- arbitrary shell execution,
- persistent group storage,
- isolated runtime sessions per conversation room.

Those need separate milestones.

---

## Definition of done

The CLI should support intentional conversation routing:

```text
                    Hivemind
                       |
       +---------------+---------------+
       |               |               |
      main            solo           groups
       |               |               |
   all agents       one agent      selected agents
```

The user decides **which conversation they are in**, while Hivemind decides which agents receive the turn and in what order their replies are presented.
