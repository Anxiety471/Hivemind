# Hivemind

Hivemind is an experimental, runtime-agnostic **meta-harness for persistent AI agents**.

The first proof of concept is intentionally CLI-only: Hivemind owns the agents and conversation surface, while [oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi) and [Pi](https://github.com/badlogic/pi-mono) provide agent execution runtimes.

## POC acceptance target

With OMP installed and authenticated:

~~~bash
cargo run -- init
cargo run
~~~

Then:

~~~text
You> hello, remember the word pineapple

Maomao> <reply produced by OMP>
Albedo> <reply produced by OMP>

You> what word did I ask you to remember?

Maomao> <reply drawn from its own live session>
Albedo> <reply drawn from its own live session>
~~~

Both configured agents receive every user turn independently through the OMP adapter and reply through Hivemind. Each agent keeps one live OMP session for the whole chat process, so later turns can draw on earlier context from that agent's own conversation.

## Requirements

- `omp` on `PATH` for agents configured with `runtime = "omp"`
- `pi` on `PATH` for agents configured with `runtime = "pi"`
- Configure provider credentials for the selected runtime using that runtime's own setup; Hivemind does not authenticate providers itself.

Check the installed CLI:

~~~bash
omp --version
pi --version
~~~

Before using an agent, verify its runtime is configured with a working provider/model (`omp -p "hello"` for OMP); set up Pi authentication through Pi's own CLI instructions.

## Quick start

~~~bash
git clone https://github.com/Anxiety471/Hivemind.git
cd Hivemind

cargo run -- init
cargo run
~~~

The generated `hivemind.toml` contains two example agents.

Useful CLI commands while chatting:

~~~text
/agents   list configured agents
/help     show commands
/quit     exit
~~~

You can also use another config file:

~~~bash
cargo run -- --config ./my-hive.toml chat
~~~

## Per-agent runtimes

Each agent selects a runtime independently. Hivemind supports OMP and Pi in one process:

~~~toml
[runtime]
omp_binary = "omp"
pi_binary = "pi"

[[agents]]
name = "Maomao"
runtime = "pi"
workspace = "."
system_prompt = "You are Maomao."
model = "provider/model-id"
reasoning = "high"

[[agents]]
name = "Albedo"
runtime = "omp"
workspace = "."
system_prompt = "You are Albedo."
fast = true
~~~

`runtime` defaults to `"omp"` for older configurations. Both executable settings default to `omp` and `pi`. Workspace is used as the child process working directory. System prompts, model, and reasoning are agent settings; each adapter passes model/reasoning only through options supported by that runtime. In particular, `fast` is OMP-specific and setting it for a Pi agent is an explicit configuration error.

For OMP, `model` maps to `--model`, `reasoning` maps to `--thinking`, and the older Hivemind key `thinking` remains accepted as an alias. OMP `fast` is tri-state: omitted leaves OMP's default unchanged; `true` or `false` is explicitly applied once at session startup. If OMP reports fast mode is unavailable, startup fails with the agent-specific error.

Pi runs in RPC mode with `--no-session`. Before each turn Hivemind requests a new Pi session, so an agent does not retain conversation context between user turns. Pi model and reasoning use its `--model` and `--thinking` options; its system prompt uses `--append-system-prompt`.

Each configured agent owns a separate runtime process/session. OMP keeps its live session across turns; Pi resets its conversation for every turn.

Pi uses the configured working directory as its workspace. Its RPC stream is newline-delimited JSON; Hivemind waits for `agent_settled` and returns text blocks from the latest assistant `message_end`, rather than treating the prompt command response as completion.

## Architecture

~~~text
                 Hivemind CLI
                      |
             Runtime / Agent Manager
                      |
        +-------------+-------------+
        |                           |
   Agent worker                Agent worker
   owns OMP or Pi session      owns OMP or Pi session
        |                           |
   runtime RPC child           runtime RPC child
        |                           |
     response                   response
        +-------------+-------------+
                      |
                   terminal
~~~

One worker task per agent owns its session, so prompts to one agent are always processed strictly in order while different agents work concurrently. A user turn fans out to all workers at once, and replies are printed in configuration order.

The important boundary is that an **agent belongs to Hivemind, not to a runtime**. OMP and Pi are runtime adapters behind the same `HarnessSession` (`prompt` / `shutdown`) boundary; runtime selection happens per agent.

## Current limitations

This remains a deliberately narrow CLI:

- Pi starts a fresh RPC session before each turn; cross-turn conversation context is intentionally not retained.
- If a runtime process fails mid-turn, Hivemind reports an agent-attributed error rather than pretending the failed conversation continued.
- Hivemind does not persist memory or task history.
- Responses are collected after each turn rather than streamed token-by-token.
- Agent-to-agent messaging is not implemented.

Hivemind eagerly starts one process per configured agent and shuts sessions down on exit, avoiding orphaned runtime processes.

## License

No license has been selected yet.
