# HTTP and WebSocket API

```bash
hivemind serve     # binds to http://127.0.0.1:7474
```

> [!CAUTION]
> Remote access and authentication are **not implemented**. The API has no authentication and must stay loopback-only. Don't expose it to other hosts or networks.

Building the server and serving health, info, and agent listings never starts Pi, OMP, or OpenCode. `serve` also runs the autonomous task scheduler when [Coordination](Coordination) is enabled. All endpoints use the `/api/v1` prefix.

## Endpoints

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/v1/health` | Liveness check; never contacts a provider |
| `GET` | `/api/v1/info` | Service metadata and protocol endpoints |
| `GET` | `/api/v1/agents` | Safe agent metadata (name and runtime only; no credentials) |
| `POST` | `/api/v1/turns` | Submit a conversation turn (`"wait": false` returns `202` immediately) |
| `GET` | `/api/v1/rooms`, `/api/v1/rooms/{id}` | Rooms (main, solo, group, archived) with participants, state, summary, and message counts |
| `GET` / `POST` | `/api/v1/rooms/{id}/threads` | List a room's user threads, or start one with `{"anchor_message_id","name"}` (`201`; `200` with the existing thread if that message already has one) |
| `GET` | `/api/v1/rooms/{id}/messages?limit=&before=` | Paged room history, oldest first within a page; page back with `next_before` |
| `POST` / `GET` | `/api/v1/tasks`, `/api/v1/tasks/{id}` | Submit (202) and inspect autonomous tasks |
| `GET` / `POST` | `/api/v1/tasks/{id}/attempts`, `/cancel`, `/pause`, `/resume`, `/input`, `/context-metrics` | Attempts, controls, and bounded context diagnostics |
| `GET` | `/api/v1/agents/{id}`, `/api/v1/agent-instances` | Capabilities and derived activity (never starts a runtime) |
| `GET` / `POST` | `/api/v1/messages`, `/api/v1/groups`, `/api/v1/groups/{id}` | Agent/operator messages and dynamic task groups |
| `GET` / `POST` / `PATCH` / `DELETE` | `/api/v1/chat-groups`, `/api/v1/chat-groups/{id}` | Configured chat groups (`group-<id>` rooms): create with `{"id","members"}`, edit `members`, `mode`, `member_roles`, `reply_order`, delete (`204`). Changes are written to the config file and apply immediately. Unrelated to the task groups under `/api/v1/groups` |
| `GET` | `/api/v1/access/personas` | Effective permissions per persona |
| `GET` | `/api/v1/access/audit?denied=&persona=&limit=` | Access audit log |
| `GET` | `/api/v1/events?after=N` | Durable, restart-safe event replay with a high-water mark |
| `GET` | `/api/v1/ws` | WebSocket live event stream |

Errors use one shape, `{"error":{"code","message"}}`, and internal failures are sanitized.

### Examples

```bash
curl http://127.0.0.1:7474/api/v1/health
# { "status": "ok", "service": "hivemind" }

curl http://127.0.0.1:7474/api/v1/info
# { "name": "hivemind", "version": "0.1.0", "api_version": "v1", "websocket": "/api/v1/ws" }

curl http://127.0.0.1:7474/api/v1/agents
# { "agents": [ { "name": "Reviewer", "runtime": "omp" }, { "name": "Engineer", "runtime": "pi" } ] }
```

## Submitting turns

```json
{"target":{"type":"group","id":"development"},"message":"Review the runtime lifecycle."}
```

Targets are `main`, `solo`, `group`, or `thread`. A thread is a child room anchored to one message of its parent room: it has its own history (`GET /rooms/{thread_id}/messages`) and runs with the parent's participants, mode and group. Threads cannot be nested and do not appear in `GET /rooms`; `GET /rooms/{thread_id}` returns `parent_room_id` and `anchor_message_id`.

The response includes `turn_id`, `room_id`, and an ordered list of `replies`, each with `persona_id`, `ok`, and `content`. Use `turn_id` and `room_id` to match the response to WebSocket events. Responses never include provider diagnostics or prompts.

| Status | Meaning |
| --- | --- |
| `202` | Only with `"wait": false`: the turn runs in the background; follow `conversation.*` and `agent.reply.*` events for `room_id` and read replies from room history |
| `400` | Malformed or empty request |
| `404` | Target not found |
| `503` | Shutting down |

On shutdown, core shutdown starts first and WebSocket clients are notified before Axum finishes in-flight HTTP requests. Interrupted HTTP turns still get a sanitized failed-reply response.

## WebSocket protocol

Frames are JSON envelopes with a `type`, an optional correlation `id`, and a `payload`.

```bash
websocat ws://127.0.0.1:7474/api/v1/ws        # or: npx wscat -c ws://127.0.0.1:7474/api/v1/ws
```

```jsonc
// ← on connect
{"type":"system.ready","payload":{"service":"hivemind","protocol_version":1}}
// → ping
{"type":"system.ping","id":"req-1","payload":{}}
// ← pong, same id
{"type":"system.pong","id":"req-1","payload":{}}
```

Unsupported or malformed messages get a `system.error` frame, and the connection stays open when possible.

### Streamed events

| Group | Events |
| --- | --- |
| Conversation | `conversation.turn.started`, `conversation.turn.completed` |
| Threads | `thread.created` with `thread_id`, `parent_room_id`, `anchor_message_id` |
| Replies | `agent.reply.started`, `agent.reply.completed`, `agent.reply.failed` |
| Runtime | `runtime.started`, `runtime.stopped`, `runtime.rotated`, `runtime.failed` |
| Coordination | `task.*`, `attempt.*`, `message.*`, `group.*`, `agent.activity.changed` |
| System | `system.events_lagged` with `missed_count` and `refresh_required: true` |

Conversation and runtime events are short-lived **notifications**, not canonical records; durable history and memory stay in SQLite. A subscriber that falls behind the bounded buffer gets `system.events_lagged` in place of the dropped events.

Coordination frames carry `durable_seq` next to the process-local `sequence`. Task snapshots carry `event_high_water`; after a reconnect or restart, replay from `GET /api/v1/events?after=<high-water>` for a gap-free stream.
