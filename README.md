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

## Deterministic reply order

The optional `[conversation]` table controls the order in which agents are listed and their replies are presented:

~~~toml
[conversation]
reply_order = ["Albedo", "Maomao"]
~~~

Names listed there appear first in that order; any configured agents omitted from the list follow in their declaration order. If `reply_order` is omitted, declaration order is used. Names must be unique and refer to configured agents. Agents still receive each turn concurrently; only presentation is ordered.

## HTTP and WebSocket API

Hivemind provides an async HTTP API and WebSocket interface for frontends and orchestration tools.

### Starting the server

Run the server with:

~~~bash
cargo run --bin hivemind-server
~~~

By default, the server binds strictly to the loopback interface at:

~~~text
http://127.0.0.1:7474
~~~

> **Security note:** Remote exposure and authentication are not implemented. The API is unauthenticated and must remain loopback-only; do not expose it to other hosts or networks.

### HTTP endpoints

All HTTP endpoints use the `/api/v1` version prefix.

#### Health check (`GET /api/v1/health`)

A lightweight check to verify the process is alive without contacting AI providers:

~~~bash
curl http://127.0.0.1:7474/api/v1/health
~~~

Expected JSON response:

~~~json
{
  "status": "ok",
  "service": "hivemind"
}
~~~

#### Server info (`GET /api/v1/info`)

Returns service metadata and protocol endpoints:

~~~bash
curl http://127.0.0.1:7474/api/v1/info
~~~

Expected JSON response:

~~~json
{
  "name": "hivemind",
  "version": "0.1.0",
  "api_version": "v1",
  "websocket": "/api/v1/ws"
}
~~~

#### Configured agents (`GET /api/v1/agents`)

Lists configured agent metadata safe for clients to view (excluding keys, tokens, or credentials):

~~~bash
curl http://127.0.0.1:7474/api/v1/agents
~~~

Expected JSON response:

~~~json
{
  "agents": [
    {
      "name": "Albedo",
      "runtime": "omp"
    },
    {
      "name": "Maomao",
      "runtime": "pi"
    }
  ]
}
~~~

### WebSocket interface

The WebSocket endpoint is available at:

~~~text
ws://127.0.0.1:7474/api/v1/ws
~~~

#### Connection lifecycle and protocol

Messages use a standard JSON envelope with `type`, optional correlation `id`, and a `payload` object:

1. **Ready event**: Upon connecting, the server immediately emits a `system.ready` event:
   ~~~json
   {
     "type": "system.ready",
     "payload": {
       "service": "hivemind",
       "protocol_version": 1
     }
   }
   ~~~

2. **Ping / Pong**: Clients can send a `system.ping` message:
   ~~~json
   {
     "type": "system.ping",
     "id": "123",
     "payload": {}
   }
   ~~~
   The server replies with `system.pong` preserving the `id`:
   ~~~json
   {
     "type": "system.pong",
     "id": "123",
     "payload": {}
   }
   ~~~

3. **Errors**: Unsupported or malformed messages return a `system.error` frame with details while keeping the connection open when possible.

#### Interacting via CLI

You can test the WebSocket interface using a CLI WebSocket tool such as `websocat`:

~~~bash
websocat ws://127.0.0.1:7474/api/v1/ws
~~~

Once connected, `system.ready` will be received. You can paste a ping frame:

~~~json
{"type":"system.ping","id":"req-1","payload":{}}
~~~

and observe the matching `system.pong` reply.

*Alternative tools:* You can also use `wscat`, for example `npx wscat -c ws://127.0.0.1:7474/api/v1/ws`.

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
