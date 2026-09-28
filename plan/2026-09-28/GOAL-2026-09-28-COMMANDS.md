# GOAL — 2026-09-28 — Commands

## Objective

Give the current Hivemind CLI a small, explicit command system instead of continuing to grow ad-hoc string matches inside the chat loop.

This goal is for **commands that make sense with the system Hivemind already has today**:

- configured agents,
- Pi and OMP runtimes,
- one runtime session/worker per agent,
- broadcast user turns,
- deterministic reply ordering,
- local CLI operation.

Do not use this milestone to sneak in spawning, delegation, shared memory, or other future orchestration features.

## Two command levels

Hivemind has two different command surfaces and they should remain distinct.

### Process commands

These are invoked from the shell:

```text
hivemind init
hivemind chat
hivemind doctor
```

`init` and `chat` already exist. `doctor` belongs to the setup milestone and should integrate cleanly when that goal lands.

### Chat commands

These are entered after Hivemind is running:

```text
/help
/agents
/status
/order
/ask <agent> <message>
/all <message>
/quit
```

Bare text should remain equivalent to broadcasting a normal user turn to all configured agents.

## Command parser

Do not keep expanding this pattern:

```rust
match input {
    "/agents" => ...
    "/help" => ...
    "/quit" => ...
}
```

Introduce a small command parser with a typed representation.

Conceptually:

```rust
enum ChatCommand {
    Help,
    Agents,
    Status,
    Order,
    Ask { agent: String, message: String },
    All { message: String },
    Quit,
}
```

The exact implementation is flexible.

Parsing commands and executing commands should be separate concerns.

Unknown slash commands should produce a useful error instead of being sent to every agent as a normal prompt.

Example:

```text
You> /spwan Maomao

Unknown command: /spwan
Run /help to list available commands.
```

Yes, humans will typo commands. The parser should survive this historic discovery.

## Required chat commands

### `/help`

Show all currently supported chat commands with short usage text.

Example:

```text
/help
/agents
/status
/order
/ask <agent> <message>
/all <message>
/quit
```

Keep it compact.

### `/agents`

Show configured agents in effective reply order.

Include:

- order number,
- agent name,
- runtime,
- workspace when useful,
- whether its worker/session is currently available.

Example:

```text
Agents:
  1. Albedo [pi] ready
  2. Maomao [pi] ready
  3. Frieren [omp] ready
```

Do not expose secrets or provider credentials.

### `/status`

Show the health/state of the current Hivemind process.

At minimum:

- number of configured agents,
- number of available agent workers,
- runtime used by each agent,
- current effective reply order.

Example:

```text
Hivemind status
  agents: 3
  ready: 3/3

  Albedo   pi    ready
  Maomao   pi    ready
  Frieren  omp   ready
```

This is runtime/session status, not token billing or provider account status.

### `/order`

Show the effective reply/speaker order for the current configuration.

Example:

```text
Reply order:
  1. Albedo
  2. Maomao
  3. Frieren
```

If no explicit reply order is configured, show the resolved fallback order rather than merely saying "default."

This command is read-only for this milestone.

Do not add runtime mutation such as `/order set ...` yet.

### `/ask <agent> <message>`

Send one prompt to exactly one configured Hivemind agent.

Example:

```text
You> /ask Albedo review the current runtime boundary

Albedo> ...
```

Other agents must not receive that user turn.

The target is identified by Hivemind agent name, not runtime process identity.

Agent matching should be deterministic. Prefer exact names. If names contain spaces, support a clear syntax such as quoted names:

```text
/ask "Code Reviewer" inspect this
```

Do not silently choose between ambiguous partial names.

### `/all <message>`

Explicitly broadcast a prompt to every configured agent.

Example:

```text
/all review the current architecture
```

This should use exactly the same multi-agent turn path as normal bare-text input.

Therefore:

```text
hello
```

and:

```text
/all hello
```

have equivalent dispatch semantics.

Replies must still obey Hivemind's deterministic reply-order policy.

### `/quit`

Cleanly leave the chat and shut down all agent workers/runtime processes.

Keep `/exit` as an alias for backward compatibility.

Do not terminate the process before normal runtime cleanup completes.

## Bare text

Normal text without a leading command remains the primary interaction:

```text
You> review this architecture
```

It means:

```text
broadcast this user turn to all configured agents
```

This preserves the existing Hivemind behavior.

A line beginning with `/` is reserved for Hivemind commands.

## Agent targeting

The AgentManager needs a clean way to address one agent as well as all agents.

Conceptually support:

```text
prompt_all(message)
prompt_agent(agent_name, message)
```

Do not bypass the worker/session abstraction by talking directly to Pi or OMP from the command handler.

Targeted prompts should still use the selected agent's existing live worker/session.

## Concurrency and ordering

`/all` and bare-text broadcast should retain concurrent execution across independent agents.

`/ask` targets one agent only.

Command output itself should not race with agent output.

A chat command must complete its terminal output before another prompt is accepted/presented in a way that produces mixed lines.

## Error behavior

Commands should return concise, actionable errors.

Examples:

```text
/ask
error: usage: /ask <agent> <message>
```

```text
/ask Unknown hello
error: no configured agent named 'Unknown'
```

```text
/wat
error: unknown command '/wat'; run /help
```

Do not panic on malformed command input.

## Help consistency

There must be one source of truth for command names/usage where practical.

Do not maintain one command list in the parser and another manually drifting list in `/help`.

Tests should catch accidental divergence.

## README

Update the CLI documentation to show the current chat commands.

Keep the README section short:

```text
/help
/agents
/status
/order
/ask <agent> <message>
/all <message>
/quit
```

More detailed semantics can live in a dedicated documentation section/file if needed.

## Acceptance criteria

The goal is complete when:

1. Chat commands are parsed through a dedicated command parser.
2. `/help` lists supported commands.
3. `/agents` shows configured agents in effective reply order.
4. `/status` shows current local agent/runtime health.
5. `/order` shows the resolved reply order.
6. `/ask <agent> <message>` prompts only the selected agent.
7. `/all <message>` prompts all configured agents.
8. Bare text remains equivalent to broadcast.
9. Unknown slash commands are not forwarded to agents.
10. Malformed commands produce usage errors without crashing.
11. `/quit` and `/exit` shut all runtime processes down cleanly.
12. Pi and OMP agents are addressed through the same command system.
13. Existing deterministic reply ordering remains intact for broadcasts.
14. README command documentation is updated.
15. `cargo test` passes.
16. `cargo clippy --all-targets --all-features -- -D warnings` passes.

## Tests to add

Add tests for:

- parsing every supported command,
- unknown commands,
- missing command arguments,
- quoted agent names if supported,
- exact agent lookup,
- targeted `/ask` dispatch,
- `/all` dispatch,
- bare-text broadcast behavior,
- reply ordering after `/all`,
- `/quit` and `/exit` aliases,
- help output staying aligned with supported commands.

Use fake workers/runtimes for dispatch tests where possible.

## Non-goals

Do **not** add commands for features Hivemind does not have yet.

Specifically, no:

- `/spawn`,
- `/delegate`,
- `/message-agent`,
- `/vote`,
- `/memory`,
- `/task`,
- `/team`,
- dynamic runtime switching,
- provider billing/token commands,
- arbitrary shell execution.

Those commands belong to future feature milestones after the underlying capabilities exist.

## Definition of done

The interactive CLI should move from:

```text
a few hard-coded slash strings
```

to:

```text
typed command parser
        |
        +-- inspect current hive
        +-- inspect order/status
        +-- target one agent
        +-- broadcast to all agents
        +-- cleanly exit
```

The command surface should describe what Hivemind can actually do today, not advertise features that exist only in our collective imagination.
