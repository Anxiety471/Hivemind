# Hivemind

Hivemind is an experimental, runtime-agnostic **meta-harness for persistent AI agents**.

Hivemind owns conversation context and the CLI, while [oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi) and [Pi](https://github.com/badlogic/pi-mono) provide disposable agent execution runtimes. The library also exposes an async HTTP/WebSocket API for health, agent metadata, and event streaming.

## Quick start

Prerequisites: Rust stable with Cargo, and at least one supported runtime
(Pi or OMP) installed and authenticated with a provider through that
runtime's own setup. Hivemind makes no provider API calls during setup.

~~~bash
git clone https://github.com/Anxiety471/Hivemind.git
cd Hivemind

rustc --version
cargo --version
pi --version       # or: omp --version
cargo build
cargo run -- init
~~~

Inspect `hivemind.toml`: the starter config uses Pi for both example agents,
so only Pi is required unless you change an agent's `runtime`. Configure a
provider/model in the runtime itself, then check local readiness and start:

~~~bash
cargo run -- doctor
cargo run
~~~

`doctor` checks only runtimes referenced by configured agents, resolves
binaries through `PATH` (or uses an explicitly configured executable path),
and checks workspaces and conversation reply order. `hivemind.toml` is local
and ignored by Git. `init` never overwrites it unless passed `--force`.

### Setup troubleshooting

- If `doctor` reports a missing runtime, install/configure it or set the
  matching `[runtime]` binary to its executable path. Only runtimes referenced
  by agents are checked.
- Workspaces must exist as directories; update `workspace` or create the
  directory before starting chat.
- Provider credentials belong to Pi or OMP. Verify authentication with that
  runtime's own setup; `doctor` checks executable presence without contacting a
  provider.
- Reply-order entries must be unique configured agent names. Omitted agents
  are appended in declaration order.


## Shell commands

The shell CLI is the primary interface for inspecting Hivemind, running one-shot
prompts, and managing persisted groups. `--config` also works before nested
commands (for example `hivemind --config ./my-hive.toml group list`).

~~~bash
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
~~~

Cargo users can run the same commands with `cargo run --`, such as
`cargo run -- ask Albedo "hello"` or `cargo run -- group list`. `init` refuses
to overwrite an existing configuration unless `--force` is supplied.

Group definitions live in `hivemind.toml`. Each group selects `mode = "broadcast"`
or `mode = "discussion"`, may override persona roles in `[groups.member_roles]`,
and may set a room-specific `reply_order` containing only its members. A partial
room order appends the remaining members in global effective order. Broadcast
invokes every participant concurrently with the same turn context; discussion
follows the effective room order and includes earlier same-turn replies.
Shell `ask <persona>` and `all` use the same Hivemind-owned turn coordinator
and durable turn store as interactive chat: `ask` records turns in that
persona's solo room, while `all` records turns in the `main` room regardless of
the active interactive route.

## Interactive chat commands

Inside `hivemind chat`, use slash commands to inspect status, switch routing,
manage persisted groups, or send a one-off turn without changing the active
conversation:

~~~text
/help
/agents
/status
/order
/where
/ask Albedo review this
/all review this
/solo Albedo
/main
/group create backend Albedo Maomao
/group list
/group show backend
/group use backend
/group add backend Frieren
/group remove backend Maomao
/group delete backend
/quit
/exit
~~~

`/ask` and `/all` leave the active route unchanged. `/ask` writes to the selected
persona's solo room; `/all` writes to the `main` room, so neither silently
continues the active group's history. `/exit` aliases `/quit`.
Deleting the active group returns the route to `main`; empty groups cannot be
used for chat, and bare turns in a group that becomes empty are rejected.
Group list/show still display empty groups. Removing a member also clears that
member's role and explicit room-order entries.

## Per-agent runtimes

Each agent selects a runtime independently. Hivemind supports OMP and Pi in one process:

~~~toml
[runtime]
omp_binary = "omp"
pi_binary = "pi"
# Maximum runtime prompt duration in seconds; 0 disables the prompt timeout.
prompt_timeout_secs = 300
# Seconds an unused agent-instance runtime stays alive; 0 never idles out.
idle_timeout_secs = 120

[[personas]]
id = "Maomao"
role = "Backend Engineer"
runtime = "pi"
workspace = "."
system_prompt = "You are Maomao."
model = "provider/model-id"
reasoning = "high"

[[personas]]
id = "Albedo"
role = "Reviewer"
runtime = "omp"
workspace = "."
system_prompt = "You are Albedo."
fast = true
~~~


`runtime` defaults to `"omp"` for older configurations; legacy `[[agents]]`
entries are accepted as personas. A new `init` config selects Pi for both
example personas, so installing both runtimes is not required. Both executable
settings default to `omp` and `pi`; workspace is used as the child process
working directory. System prompts, model, reasoning, and persona role are
settings; room member roles override the default persona role.

For OMP, `model` maps to `--model`, `reasoning` maps to `--thinking`, and the
older Hivemind key `thinking` remains accepted as an alias. OMP `fast` is
tri-state: omitted leaves its default unchanged; `true` or `false` is applied
once at session startup. `fast` is OMP-specific.

`runtime.prompt_timeout_secs` defaults to 300 seconds; set it to `0` to disable
the prompt timeout. If a prompt times out, Hivemind cancels that prompt,
discards the current runtime session, closes its runtime epoch, and does not
retry that user turn. The next turn starts with a fresh session rehydrated from
canonical room history.

Each agent instance is identified internally by its structured room and persona
IDs, not by joining them with a delimiter. At storage and public protocol
boundaries, Hivemind uses the stable, versioned `ai1` length-prefixed encoding
of those fields as `agent_instance_id`; it round-trips without guessing where
one ID ends and the other begins. Shell `ask`/`all`, interactive `chat` (main,
solo, group, `/ask`, `/all`), and any `HivemindCore::turn` caller use the same
identity. A session may persist across turns for the same agent instance, but
is never shared across different rooms or personas. The first prompt of a
session carries the full Context Pack; later turns in the same room send only a
room delta, and memory-tool follow-ups send only the tool result. At the next
turn boundary, a session rotates when its context reaches
`context.runtime_rotate_tokens` or when its next room delta cannot be built
(emitting `runtime.rotated`). A runtime failure discards the session without
retrying that turn; it also closes after `runtime.idle_timeout_secs` without
use and stops on core shutdown. This applies equally to Pi and OMP. Hivemind's
SQLite room history, state, and summary stay canonical, and every new session
is rehydrated from them.
Participants are resolved and validated before any runtime starts. Pi uses RPC
mode with `--no-session` and keeps its in-process context between prompts;
Hivemind waits for `agent_settled` and returns text blocks from the latest
assistant `message_end`.

Canonical history, memory, and runtime epochs live in `.hivemind/memory.sqlite3`
next to the selected config file: rooms, turns, and messages (L7), scoped
memory records with FTS5 search, runtime epochs, and group state. Legacy room
JSON is imported exactly once — on first load every legacy turn and the room
snapshot are written to SQLite, and the JSON file is removed only after that
migration succeeds.

Legacy private-memory rows keep their original `scope_type = 'agent_instance'`
and remain opaque to ordinary typed callers; new private-memory rows use
`agent_instance_v1` with the `ai1` encoding. Existing runtime epochs are kept
with identity version `0` and are not returned or closed through typed
identity lookup. New epochs use identity version `1` and the same encoded
identity. Hivemind never guesses how to split an old slash-delimited value.

Legacy JSON history identities have no version marker and remain opaque; import
reconstructs the typed identity only from the authoritative room and speaker
fields. New typed history entries carry
`agent_instance_identity_version = 1`, and only those entries are decoded as
the versioned identity.

`.hivemind/context/` now holds only room turn-lock files and any not-yet-migrated
legacy history. `[context]` configures the recent raw-turn window, summary size/
refresh cadence, and bounded approximate context budget. `runtime_rotate_tokens`
is the live context size at which that agent instance's runtime is rotated
before its next turn, and `runtime.idle_timeout_secs` is how long an unused
runtime stays alive.

## Application core and event stream

`serve`, `ask`, `all`, and interactive `chat` all construct the library
`HivemindCore`, which owns the ordered persona registry, one SQLite-backed
memory service, one durable conversation coordinator, a per-instance runtime
pool, and a bounded process-local event bus. Interactive `chat` shares one core
for the whole session. Each core turn prompts that room's live runtime per
persona and keeps it for the next turn (emitting
`runtime.started`/`runtime.rotated`/`runtime.stopped` events); core shutdown
stops every live runtime.

On `SIGINT`, interactive chat cancels the active turn through core shutdown,
reports the failed turn, and stops accepting input. The API also begins core
shutdown and notifies WebSocket clients before Axum drains in-flight HTTP
requests; interrupted HTTP turns retain the API's sanitized failed-reply
response.

Shell `ask` and `all` construct a core per command. Conversation targets
(main, solo persona, or group) are resolved by the core, including room
identity, mode, participants, roles, and effective reply order.

The loopback API accepts turns at `POST /api/v1/turns`; WebSocket remains the
live event stream. For example:

~~~json
{"target":{"type":"group","id":"development"},"message":"Review the runtime lifecycle."}
~~~

The response includes `turn_id`, `room_id`, and ordered `replies` with
`persona_id`, `ok`, and `content`. Match `turn_id` and `room_id` from the
response to `conversation.turn.started`, `agent.reply.*`, and
`conversation.turn.completed` WebSocket events. Target-not-found errors return
404, malformed/empty requests return 400, and shutdown returns 503; responses
do not include provider diagnostics or prompts. Construction and health/info/
agent listing do not start Pi or OMP. Runtime lifecycle and conversation events
are ephemeral notifications, not canonical records; durable room history and
memory remain in SQLite.

The library's `core`, `events`, `conversation`, `config`, `runtime`, and
`memory` modules expose this kernel for embedding. Room transcripts, summaries,
memory records, and runtime epochs stay canonical in
`.hivemind/memory.sqlite3`, relative to the config file; `.hivemind/context/`
holds turn-lock files and legacy JSON awaiting one-time migration.

`HivemindCore::events().subscribe()` returns an independent bounded Tokio
broadcast receiver of typed `DomainEvent`s. The stream includes process-local
sequence/ID/timestamp metadata and lifecycle, turn, reply, and runtime events.
It is ephemeral notification only—not canonical state or history—and slow
consumers must handle `RecvError::Lagged` (for example, refresh from the
authoritative API state).

The WebSocket stream forwards these events as `conversation.turn.started`,
`conversation.turn.completed`, `agent.reply.started`, `agent.reply.completed`,
`agent.reply.failed`, `runtime.started`, `runtime.stopped`,
`runtime.rotated`, and
`runtime.failed`. A subscriber that falls behind the bounded buffer receives
`system.events_lagged` with `missed_count` and `refresh_required: true`
instead of the dropped events.

Room state changes only from explicit line-oriented directives in user input;
successful agent prose is never interpreted as a state update. Use:

~~~text
Goal: ship the parser safely
Decision: use typed updates
Assign: Maomao = implement parser
Question: should malformed lines be rejected?
Completed: define the update syntax
Global: Hivemind architecture: runtimes are disposable
~~~

`Goal` replaces the current goal; repeated `Decision`, `Question`, and
`Completed` values are stored once; `Assign` uses `persona = task` and replaces
that persona's assignment. The structured state is included in each later
context pack.

A `Global:` line is an explicit user instruction authorizing exactly one
global memory write for that turn: an agent's `memory.global.propose` is
accepted only when its content exactly matches the trimmed text after
`Global:`. Proposals without the directive, with different wording, or with
merely broad-sounding prompt text are rejected deterministically; the
authorization is bound by Hivemind to the turn and message of the directive,
never to model- or tool-supplied arguments.


## Deterministic reply order

The optional `[conversation]` table controls the global deterministic order:

~~~toml
[conversation]
reply_order = ["Albedo", "Maomao"]
~~~

Omitted personas follow declaration order. Groups may override the global
order with their own member-only `reply_order` and select their own `mode`.
Main/all turns use broadcast mode; solo turns use the same room/history/context
architecture with one participant.

## Deterministic memory

Hivemind owns a seven-layer memory system that works without any LLM. The
default is `[memory] mode = "deterministic"`: storage, retrieval, and policy
are plain code paths, so memory keeps working when no model, provider, or
quota is available.

| Layer | Owner | Behavior |
| --- | --- | --- |
| Harness working context | Pi/OMP session | Disposable; rebuilt from the layers below if the runtime restarts. |
| Recent conversation | room | Bounded raw window set by `[context] recent_turns`; older turns stay in the archive. |
| Group shared memory | group | Visible only to that group's members. |
| Private memory | agent instance | Visible only to that structured room/persona identity; identical personas in different rooms have separate memories. |
| Persona memory | persona | Shared across all instances of the same persona. |
| Hivemind global | system-wide | Durable project-wide facts, held to the strictest policy. |
| Canonical archive | Hivemind | Durable source of truth for rooms, turns, messages, and memory records. |

The external `agent_instance_id` representation is versioned and unambiguous;
it is a serialization of the structured IDs, not the identity itself. Existing
SQLite scope or runtime-epoch values written as legacy `room/persona` strings
are preserved as opaque values. Hivemind does not split or reassign them based
on the delimiter, since IDs may themselves contain `/`; they are not treated as
the new canonical structured identity unless a mapping is known from
authoritative structured data.

- **Storage**: a local SQLite archive with FTS5 full-text indexes over
  memories and archived messages. Search is deterministic and needs no model
  or embedding service.
- **Scope binding**: Hivemind attaches the caller's own context to every
  memory request and resolves the actual group/instance/persona from it —
  requests never name an owner, so an agent cannot read another group's
  memory or another instance's private notes, and cannot impersonate a
  different persona.
- **Writes**: private and group writes are accepted directly within the
  caller's own scope. Persona and global writes are stricter proposals that
  Hivemind's policy validates before committing; an agent's bare opinion
  never becomes global truth.
- **Provenance and supersession**: every record keeps where it came from
  (room, turn, message, actor). Corrections create revisions, and a new
  memory may supersede an older one — the old record remains as `superseded`
  rather than deleted, so history stays searchable.
- **One tool bridge**: agents reach memory through a single Hivemind-owned
  tool bridge shared by Pi and OMP; runtime adapters only carry the
  transport. Hivemind also injects the generated guidance telling each agent
  which capabilities exist, which scopes it may touch, and that searching
  memory is preferred over pretending to remember.

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
        Hivemind CLI (chat / ask / all)      embedding callers
                        |                          |
                        +------------+-------------+
                                     |
                               HivemindCore
                     (one per chat session / command)
                                     |
                         ConversationCoordinator
          (SQLite room history, state, summary via MemoryService)
                                     |
                     Context Pack per persona invocation
                                     |
                              RuntimeInvoker
          start fresh OMP or Pi process -> prompt -> stop process
                                     |
                    reply stored in SQLite room history
                                     |
                  next invocation rehydrates from SQLite
~~~

Every persona invocation starts a fresh Pi or OMP process and stops it after
the reply; no runtime session outlives an invocation, so runtime state is
disposable: every prompt is rebuilt from Hivemind's durable SQLite transcript,
summary, and shared state.
Broadcast invocations run concurrently; discussion invokes personas in
effective reply order and includes earlier same-turn replies. Room turns are
serialized by the room lock.

The important boundary is that an **agent belongs to Hivemind, not to a runtime**. OMP and Pi are runtime adapters behind the same `HarnessSession` (`prompt` / `shutdown`) boundary; runtime selection happens per agent.


## Current limitations

Hivemind is intentionally focused on core harness and interface foundations:

- Every persona invocation starts and stops its own Pi or OMP process, which
  adds process startup latency per reply; cross-turn context comes only from
  the durable room transcript, summary, and shared state.
- If a runtime process fails mid-turn, Hivemind reports an agent-attributed error rather than pretending the failed conversation continued.
- Memory search is SQLite FTS5 full-text matching, not semantic/embedding search; no vector database is used.
- Responses are collected after each turn rather than streamed token-by-token.
- Agent-to-agent messaging is not implemented.

Runtime sessions live for as long as the core that started them: `ask`/`all`
create a core per command and `chat` keeps one for the session, and each core
stops every session it started, so no runtime session is orphaned at exit.

## License

No license has been selected yet.
