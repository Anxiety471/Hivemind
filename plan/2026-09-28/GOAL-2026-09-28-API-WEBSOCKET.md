# GOAL — 2026-09-28 — HTTP API and WebSocket Foundation

## Objective

Initialize Hivemind's network interface so future frontends, remote clients, and orchestration tools can talk to the Rust core through a stable HTTP API and WebSocket protocol.

Before implementing anything, inspect the repository for an existing API/server implementation.

If a usable API already exists, extend it rather than creating a duplicate server.

If no API exists, create the API foundation and initialize WebSocket support.

At the time this goal was written, the repository has no `src/api`, `src/server.rs`, or `src/websocket.rs` implementation and `Cargo.toml` has no HTTP/WebSocket framework dependency, so this goal currently requires creating the server foundation.

## Important concurrency note

Other Hivemind goals may be modifying:

- `src/main.rs`,
- `src/config.rs`,
- runtime management,
- command parsing,
- conversation/group state.

Re-read the current working tree immediately before editing those files.

Do not overwrite unrelated changes from the other active goals.

Prefer new modules and small integration points over broad refactors.

---

# Architecture

Target structure:

```text
                    Hivemind Core
                         |
              +----------+----------+
              |                     |
            CLI                  API Server
                                     |
                        +------------+------------+
                        |                         |
                     HTTP API                 WebSocket
                        |                         |
                 request/response          live events/messages
```

The API and CLI must use the same Hivemind domain/runtime services.

Do not create a second implementation of agent management inside the web server.

Runtime adapters remain below Hivemind core:

```text
API / CLI
    |
Hivemind services
    |
AgentManager
    |
Pi / OMP
```

---

# HTTP stack

Use a lightweight Rust async web stack that fits the existing Tokio runtime.

Preferred choice:

```text
axum
tokio
tower / tower-http where actually needed
serde / serde_json
```

Enable Axum WebSocket support.

Do not add a heavyweight web framework merely to expose a few JSON endpoints.

---

# Module layout

Prefer a structure similar to:

```text
src/
  api/
    mod.rs
    routes.rs
    state.rs
    error.rs
    websocket.rs
    protocol.rs
```

Exact filenames may differ.

Keep transport-specific code under the API module.

Do not place WebSocket frame parsing inside runtime adapters.

---

# Shared application state

Create a small shared server state object.

Conceptually:

```rust
#[derive(Clone)]
struct ApiState {
    // configuration / immutable metadata
    // handles to Hivemind services when required
}
```

Do not put raw Pi/OMP child process handles directly into HTTP handlers.

Handlers should call Hivemind-level services.

If the current core is not yet reusable from both CLI and server, introduce the smallest necessary boundary.

A library target such as `src/lib.rs` is acceptable if needed, but avoid rewriting unrelated command work merely to create it.

---

# Server startup

The API must have a clear executable startup path.

Preferred eventual UX:

```bash
hivemind serve
```

However, because the command-system goal may be editing the main CLI concurrently, avoid creating a merge war merely to add one subcommand.

If `hivemind serve` cannot be wired cleanly without conflicting with active command work, create a temporary dedicated binary such as:

```bash
cargo run --bin hivemind-server
```

and leave the server core ready for the command layer to expose later.

Do not leave the API without any runnable entry point.

---

# Bind address

Default to loopback only:

```text
127.0.0.1
```

Suggested default port:

```text
7474
```

Example:

```text
http://127.0.0.1:7474
```

Do not bind to `0.0.0.0` by default.

Remote/network exposure requires an explicit later decision because Hivemind may control local coding agents and workspaces.

If host/port configuration is introduced, keep defaults safe and predictable.

---

# API versioning

All application HTTP routes should use a versioned prefix:

```text
/api/v1
```

WebSocket should use:

```text
/api/v1/ws
```

Do not create a mixture of versioned and unversioned application endpoints.

---

# Initial HTTP endpoints

This goal initializes the API foundation, not every future Hivemind operation.

Implement at least the following.

## `GET /api/v1/health`

Must be cheap and must not call a model/provider.

Response example:

```json
{
  "status": "ok",
  "service": "hivemind"
}
```

This endpoint should prove that the Rust API process is alive.

---

## `GET /api/v1/info`

Return basic server/protocol information.

Example:

```json
{
  "name": "hivemind",
  "version": "0.1.0",
  "api_version": "v1",
  "websocket": "/api/v1/ws"
}
```

Version should come from package metadata rather than being duplicated manually when practical.

---

## `GET /api/v1/agents`

Return configured Hivemind agent metadata that is safe for a client to see.

Example:

```json
{
  "agents": [
    {
      "name": "Albedo",
      "runtime": "pi"
    },
    {
      "name": "Maomao",
      "runtime": "omp"
    }
  ]
}
```

Do not expose:

- provider tokens,
- API keys,
- environment secrets,
- raw authentication/session data.

If current command/config work has already introduced reply-order or readiness metadata, expose it only through shared domain state rather than reimplementing its logic.

---

# Optional route integration

If the concurrently implemented group/command domain is already stable when this goal is executed, it is acceptable to expose read-only endpoints such as:

```text
GET /api/v1/groups
GET /api/v1/groups/:name
```

Do not block this API milestone waiting for group management.

Do not duplicate group logic inside API handlers.

---

# JSON response conventions

Return JSON consistently.

Success responses should have predictable shapes.

Errors should also be JSON.

Example:

```json
{
  "error": {
    "code": "agent_not_found",
    "message": "no configured agent named 'Unknown'"
  }
}
```

Create a small API error type that maps application errors to appropriate HTTP statuses.

Do not return Rust debug dumps or internal stack/context chains to clients by default.

Internal details may still be logged locally.

---

# WebSocket endpoint

Initialize:

```text
GET /api/v1/ws
```

using a standard WebSocket upgrade.

The connection should stay alive until:

- the client disconnects,
- the server shuts down,
- a protocol/transport error requires closure.

Do not create one WebSocket connection per agent.

The socket is a Hivemind client connection.

---

# WebSocket protocol

Define a small versioned JSON message envelope now so future work does not invent incompatible message shapes every week.

Suggested client/server envelope:

```json
{
  "type": "event.name",
  "id": "optional-correlation-id",
  "payload": {}
}
```

Rules:

- `type` is required,
- `id` is optional and used for request/response correlation,
- `payload` is event-specific,
- unknown message types return a protocol error rather than crashing the connection.

Keep the protocol module independent from Axum-specific frame types where practical.

---

# Initial WebSocket events

This milestone only needs enough behavior to prove the socket is real and establish the protocol.

## Server -> client: `system.ready`

Send immediately after successful connection.

Example:

```json
{
  "type": "system.ready",
  "payload": {
    "service": "hivemind",
    "protocol_version": 1
  }
}
```

---

## Client -> server: `system.ping`

Example:

```json
{
  "type": "system.ping",
  "id": "123",
  "payload": {}
}
```

Server responds:

```json
{
  "type": "system.pong",
  "id": "123",
  "payload": {}
}
```

Preserve the correlation ID.

---

## Server -> client: `system.error`

For malformed JSON or unsupported application messages, return a structured error when the connection can remain open.

Example:

```json
{
  "type": "system.error",
  "id": "123",
  "payload": {
    "code": "unsupported_message",
    "message": "unsupported websocket message type"
  }
}
```

Do not panic on malformed client input.

---

# Future message protocol compatibility

Design the envelope so future milestones can add events such as:

```text
conversation.turn.started
agent.reply.started
agent.reply.delta
agent.reply.completed
agent.error
group.updated
agent.status.changed
```

Do **not** implement the full event system yet.

This milestone establishes transport and protocol foundations only.

---

# Connection management

Implement connection handling cleanly enough that multiple WebSocket clients can connect.

For this milestone:

- connections are independent,
- no authentication is required because the server binds to loopback by default,
- no durable subscriptions are required,
- no message replay is required.

Do not use global mutable state without synchronization.

Avoid unbounded channels.

If channels are introduced, use bounded queues and define behavior when a slow client cannot keep up.

---

# Graceful shutdown

API shutdown must be clean.

On Ctrl-C or service shutdown:

1. stop accepting new HTTP connections,
2. close/finish active WebSocket connections where practical,
3. shut down any Hivemind runtime services owned by the server,
4. exit without orphan Pi/OMP processes.

Do not let the API server bypass the runtime cleanup guarantees already being built into Hivemind.

---

# Logging

Add concise server logs for:

- bind address,
- startup,
- shutdown,
- HTTP errors worth diagnosing,
- WebSocket connect/disconnect,
- unexpected protocol errors.

Do not log secrets or entire provider payloads.

If structured tracing is added, keep the dependency/configuration minimal.

---

# CORS

Because a TypeScript frontend is planned, support browser access deliberately.

Default development policy should permit only known local development origins where practical, for example:

```text
http://localhost:5173
http://127.0.0.1:5173
```

Do not default to unrestricted `*` CORS together with credentials.

If CORS configuration is not needed for the first transport tests, keep it disabled until the frontend requires it rather than opening everything preemptively.

---

# Security baseline

For this milestone:

- bind to loopback by default,
- never expose secrets in API responses,
- validate JSON payloads,
- place reasonable limits on WebSocket message size if supported cleanly,
- reject malformed input without crashing,
- do not expose arbitrary filesystem operations,
- do not expose arbitrary shell execution,
- do not create an unauthenticated remote-control API on all interfaces.

Remote authentication/authorization is a later milestone before intentional non-local exposure.

---

# API availability check

Before creating server code, explicitly inspect whether API infrastructure already exists.

Check at minimum:

- Cargo dependencies for an HTTP framework,
- `src/api/`,
- server modules/binaries,
- existing HTTP routes,
- existing WebSocket handling.

If an implementation appeared because another concurrent task created one:

1. inspect it,
2. reuse it,
3. fill missing requirements from this goal,
4. do not create a second HTTP server.

This check is part of the acceptance criteria.

---

# Tests

Add tests that do not require provider API calls.

At minimum test:

- router construction,
- `GET /api/v1/health`,
- `GET /api/v1/info`,
- `GET /api/v1/agents`,
- 404 behavior,
- JSON error formatting,
- WebSocket upgrade,
- `system.ready` on connect,
- ping/pong correlation,
- malformed WebSocket JSON,
- unsupported WebSocket message type,
- multiple independent WebSocket connections.

Prefer in-process router/server tests.

Do not require Pi or OMP network/provider authentication to test transport behavior.

---

# Acceptance criteria

The goal is complete when:

1. The implementation checks for an existing API before creating a new one.
2. Exactly one HTTP server architecture exists in Hivemind.
3. Hivemind has a runnable API server entry point.
4. The server defaults to `127.0.0.1`.
5. The server exposes versioned `/api/v1` routes.
6. `GET /api/v1/health` returns a healthy JSON response.
7. `GET /api/v1/info` returns API/version metadata.
8. `GET /api/v1/agents` returns safe configured-agent metadata.
9. API errors use structured JSON.
10. `GET /api/v1/ws` successfully upgrades to WebSocket.
11. WebSocket sends `system.ready` after connection.
12. `system.ping` receives correlated `system.pong`.
13. Malformed/unsupported messages are handled without server crashes.
14. Multiple WebSocket clients can connect independently.
15. API handlers do not directly manage Pi/OMP implementation details.
16. Shutdown does not leave orphan runtime processes.
17. No secrets are returned by API endpoints.
18. README documents how to start and test the API/WebSocket.
19. `cargo test` passes.
20. `cargo clippy --all-targets --all-features -- -D warnings` passes.

---

# Manual verification

Document a simple HTTP check:

```bash
curl http://127.0.0.1:7474/api/v1/health
```

Expected:

```json
{"status":"ok","service":"hivemind"}
```

Also document one simple WebSocket test using an available CLI client such as `websocat` or equivalent:

```text
connect -> ws://127.0.0.1:7474/api/v1/ws

server:
{"type":"system.ready",...}

client:
{"type":"system.ping","id":"1","payload":{}}

server:
{"type":"system.pong","id":"1","payload":{}}
```

Do not make the test instructions depend on one specific third-party WebSocket client being installed.

---

# Non-goals

Do not expand this milestone into:

- a full TypeScript frontend,
- REST CRUD for every Hivemind feature,
- agent-to-agent autonomous messaging,
- full token streaming from providers,
- remote Internet exposure,
- authentication/authorization,
- TLS termination,
- reverse proxy configuration,
- persistent database storage,
- distributed workers,
- arbitrary filesystem APIs,
- arbitrary shell-command APIs.

Those require separate plans.

---

## Definition of done

Hivemind should evolve from:

```text
CLI only
```

to:

```text
                Hivemind Core
                 /         \
              CLI         Network API
                           /        \
                        HTTP      WebSocket
```

A local client should be able to verify the service over HTTP and establish a stable WebSocket connection, while the existing CLI and runtime architecture remain intact.
