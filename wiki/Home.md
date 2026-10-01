# 🐝 Hivemind

**A runtime-agnostic meta-harness for persistent AI agents.**

Hivemind owns the conversation, the memory, and the CLI. [Pi](https://github.com/badlogic/pi-mono), [oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi), and OpenCode just do the thinking.

> [!WARNING]
> Hivemind is experimental. The HTTP/WebSocket API defaults to loopback; remote binding requires an operator token. See [Execution](Execution).

## What it gives you

- **Agents belong to Hivemind, not to a runtime.** Pi, OMP, and OpenCode are interchangeable adapters behind one `HarnessSession` boundary, picked per persona.
- **Canonical SQLite history.** Rooms, turns, summaries, state, and memory live in `.hivemind/memory.sqlite3`. Any runtime session can be rebuilt from it.
- **Persistent, disposable sessions.** A session lives across turns for one room + persona, rotates when its context budget fills, and is thrown away on failure without losing anything.
- **Rooms and groups.** Talk to one persona (solo), all of them (main), or a persisted group in `broadcast` or `discussion` mode, with a deterministic reply order.
- **Seven-layer memory that needs no LLM**, using FTS5 search, scope binding, provenance, and supersession.
- **Roles and permissions** decided in Rust, with an audit log.
- **Autonomous coordination** (opt-in): submit one task and Hivemind plans, delegates, isolates work in git worktrees, routes reviews, and reports a result.
- **Embeddable core** with a typed event bus, plus a loopback HTTP/WebSocket API and a browser UI built on it.

## Pages

| Page | What's in it |
| --- | --- |
| [Getting Started](Getting-Started) | Install, `init`, `doctor`, first chat, troubleshooting |
| [CLI Reference](CLI-Reference) | Shell commands and in-chat slash commands |
| [Configuration](Configuration) | `hivemind.toml`: personas, runtimes, groups, context, room state directives |
| [Architecture](Architecture) | Core, coordinator, runtime pool, session lifecycle, storage |
| [Memory](Memory) | The seven memory layers, scope binding, writes and provenance |
| [Workspaces](Workspaces) | Which directory a turn runs in, shared group workspaces, `workspace.*` tools |
| [Access Control](Access-Control) | Permissions, built-in roles, tool restriction, audit log |
| [Coordination](Coordination) | Autonomous tasks: lifecycle, isolation, messaging, agent tools |
| [HTTP and WebSocket API](HTTP-and-WebSocket-API) | Endpoints, turn submission, WebSocket protocol and events |
| [Web UI](Web-UI) | The browser UI in `frontend/`: rooms, threads, tasks, groups, workspaces, sessions |
| [Backend Efficiency](Backend-Efficiency) | Durability, threading, retrieval, benchmarks |
| [Limitations](Limitations) | What Hivemind does not do yet |

## Quick taste

```bash
git clone https://github.com/Anxiety471/Hivemind.git && cd Hivemind
cargo build
cargo run -- init      # writes hivemind.toml
cargo run -- doctor    # checks runtimes and workspaces
cargo run              # interactive chat in the main room
```

---

The wiki is generated from the repository's `wiki/` folder, which is built from the [README](https://github.com/Anxiety471/Hivemind#readme) and [`docs/`](https://github.com/Anxiety471/Hivemind/tree/main/docs). When they disagree, the repository wins.
