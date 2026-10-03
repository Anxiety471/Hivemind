# HTTP and WebSocket API

```bash
hivemind serve     # binds to http://127.0.0.1:7474
```

> [!CAUTION]
> Loopback is the default. Remote binding requires an operator token, HTTPS/WSS, and an explicit origin allowlist. See [Execution](Execution).

Building the server and serving health, info, and agent listings never starts Pi, OMP, or OpenCode. `serve` also runs the autonomous task scheduler when [Coordination](Coordination) is enabled. All endpoints use the `/api/v1` prefix. A browser UI built on this API lives in `frontend/`; see [Web UI](Web-UI).

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
| `POST` | `/api/v1/rooms/{id}/steer` | Steer text into actively replying agents in a room mid-flight (`{"message"}`); returns `{"room_id","delivered_to"}` |
| `POST` / `GET` | `/api/v1/tasks`, `/api/v1/tasks/{id}` | Submit (202) and inspect autonomous tasks |
| `GET` / `POST` | `/api/v1/tasks/{id}/attempts`, `/cancel`, `/pause`, `/resume`, `/input`, `/steer`, `/context-metrics` | Attempts, controls (`/input` also answers a running `tasks.ask`; `/steer` messages a running attempt), and bounded context diagnostics |
| `GET` | `/api/v1/agents/{id}`, `/api/v1/agent-instances` | Capabilities and derived activity (never starts a runtime) |
| `GET` / `POST` | `/api/v1/messages`, `/api/v1/groups`, `/api/v1/groups/{id}` | Agent/operator messages and dynamic task groups |
| `GET` / `POST` / `PATCH` / `DELETE` | `/api/v1/chat-groups`, `/api/v1/chat-groups/{id}` | Configured chat groups (`group-<id>` rooms): create with `{"id","members"}`, edit `members`, `mode`, `member_roles`, `reply_order`, delete (`204`). Changes are written to the config file and apply immediately. Unrelated to the task groups under `/api/v1/groups` |
| `GET` | `/api/v1/rooms/{id}/runtime-sessions?limit=` | Runtime sessions (epochs) per agent in a room: runtime, start/end, end reason, and whether the end was a rotation. `ended_at: null` means still open |
| `POST` | `/api/v1/runtime/rotate` | `{"agent_instance_id"}`: stop that agent's live session so its next prompt starts fresh (`202`; watch `runtime.rotated`) |
| `GET` / `POST` / `DELETE` | `/api/v1/workspaces` | Allowed roots, workspaces you added (`known`), each group's shared workspace, and each persona's own. `POST {"path"}` adds a workspace (`201`; duplicates are `409`); `DELETE {"path"}` removes one no persona or group uses (`409` otherwise). Adding never restricts anything |
| `POST` | `/api/v1/agents` | Create an agent: `{"id", "runtime", "system_prompt", "workspace", "model", "reasoning", "fast", "role", "capabilities", "permissions", "roles"}` (`201`). The whole configuration is validated, written to the config file, then applied live |
| `PUT` / `DELETE` | `/api/v1/agents/{id}` | Replace an agent's definition (omitted fields are cleared; the id cannot change) or delete it (`204`). Deleting is refused (`409`) while a group or the coordination planner uses it, and for the last agent. Live sessions of a changed or deleted agent are rotated. `GET` includes the editable `config` |
| `GET` / `PATCH` | `/api/v1/rooms/{id}/settings` | Settings of the main conversation, a direct message (`solo-<id>`), or a group (`group-<id>`): `nickname`, `pinned`, `muted` for all; `mode`, `reply_order`, `workspace`, `follow_up_limit` (a number 0-64, `"unlimited"`, or `null` for the default; groups only) where they apply. `unavailable` explains each control that does not apply; sending one is `400 not_applicable`. Rooms also carry `settings` in `/api/v1/rooms` |
| `PUT` / `DELETE` | `/api/v1/workspaces/groups/{id}` | Set (`{"path"}`) or clear a group's shared workspace; returns the new snapshot |
| `PUT` | `/api/v1/workspaces/personas/{id}` | Change a persona's own workspace |
| `GET` | `/api/v1/access/roles` | Built-in and custom role definitions with their permissions |
| `GET` / `PUT` | `/api/v1/config` | Budgets, runtime programs and timeouts, skill folders, project-folder roots, and verification checks. `PUT` sends the whole operator document (`context`, `execution`, `coordination`, `runtime`, `skills`, `workspace_roots`); personas, groups, and known workspaces stay as they are. The file is validated and written without dropping comments, then applied to this process. The response adds `restart`: it lists `coordination` when coordination is on in the file and this process started with it off, which needs a new `hivemind serve`. A `config.changed` event (`scope` `operator`) follows a successful save |
| `GET` | `/api/v1/skills` | Skills from `[skills] dirs` (`name`, `description`, `argument_hint`, `source`) and the directories scanned |
| `GET` | `/api/v1/skills/{name}?path=` | A skill's `SKILL.md`, or another file inside its folder via `path`, plus the other files it ships. `404` for an unknown skill or a path outside the folder |
| `GET` | `/api/v1/tools` | Tool names agents can call through the `hivemind-tool` fence, grouped by namespace |
| `GET` | `/api/v1/access/personas` | Effective permissions per persona |
| `GET` | `/api/v1/access/audit?denied=&persona=&limit=` | Access audit log |
| `GET` | `/api/v1/events?after=N` | Durable, restart-safe event replay with a high-water mark |
| `GET` | `/api/v1/ws` | WebSocket live event stream |

Workspace changes use the same checks as the agent `workspace.*` tools: an absolute, existing directory, inside `[workspaces] roots` when roots are configured. They are written to the config file, and a runtime session in the old directory is replaced before the next turn. Persona definitions are managed through `/api/v1/agents`; roles stay read-only, so edit those in the config. A `config.changed` event (`scope` `agents` or `rooms`) is published after these changes. Saving through `/api/v1/config` publishes `scope` `operator`.

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
websocat ws://127.0.0.1:7474/api/v1/ws        # or: bunx wscat -c ws://127.0.0.1:7474/api/v1/ws · or: npx wscat -c ws://127.0.0.1:7474/api/v1/ws
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

### Subscribing to rooms

By default a connection receives every event. Send `{"type":"events.subscribe","id":"s1","payload":{"room_ids":["main","group-dev"]}}` to limit room-scoped events (conversation, replies, `thread.created` for the parent room) to those rooms; the server answers `events.subscribed`. A thread is its own room, so list its id too. An empty list restores the full stream. Runtime and coordination events are not room-scoped and always arrive.

### Browser access (CORS)

Pages served from `localhost`, `127.0.0.1` or `[::1]` (any port) may call the API from a browser, including preflight requests. With authentication enabled, browser origins must match `server.allowed_origins` exactly. HTTP requests and WebSocket upgrades require operator authentication.

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

See [Execution](Execution) for durable turn status/cancel/retry endpoints, `agent.progress` frames, usage budgets, host verification checks, and recovery actions.
