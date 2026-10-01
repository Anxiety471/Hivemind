# Web UI

`frontend/` contains a browser UI for `hivemind serve`. It uses only the public [HTTP and WebSocket API](HTTP-and-WebSocket-API).

```bash
hivemind serve                      # API on http://127.0.0.1:7474
cd frontend && npm install && npm run dev   # UI on http://127.0.0.1:5173
```

## Screens

- **Rooms**: main, group, direct, and task rooms with paged history (`/rooms/{id}/messages`). Messages are sent with `"wait": false`; replies appear live from `agent.reply.*` and `conversation.turn.*` events, and `agent.progress` text is shown while an agent replies. Any message can start a thread (`POST /rooms/{id}/threads`), which opens in a side panel with its own history and composer. Room details show the room state and summary. Task rooms are read-only.
- **Tasks**: root tasks, subtasks with dependencies, attempts, artifacts, evidence, and budget meters. Submit, pause, resume, cancel, and answer `needs_input`. Refreshes on `task.*` and `attempt.*` events.
- **Agents**: runtime, activity state (`/agent-instances`), workspace, capabilities, and effective permissions per persona.
- **Groups**: create, edit (members, mode, per-group roles, reply order), and delete chat groups via `/chat-groups`.
- **Workspaces**: allowed roots, group shared workspaces, and persona workspaces, editable in place.
- **Runtime sessions**: epochs per room with end reasons and rotation, plus **Rotate** for a live session (`POST /runtime/rotate`).
- **Live activity**: the raw WebSocket event stream with filters.

## Connection

The default server is `http://127.0.0.1:7474`; change it under **Connection** (stored in the browser) or set `VITE_HIVEMIND_URL` at build time. Loopback pages need no proxy because the server allows CORS from loopback origins. With an operator token, the UI sends `Authorization: Bearer <token>` over HTTP and the `hivemind.auth.<token>` subprotocol on the WebSocket; the page origin must be in `server.allowed_origins`.

## Demo without a model

`frontend/dev/demo.sh` runs `serve` against a throwaway hive whose personas use `frontend/dev/fake-pi.py`, a scripted stand-in for the Pi RPC runtime that never contacts a provider. `node frontend/dev/seed.mjs` fills it with conversations, a thread, two tasks, and a rotated session. See `frontend/README.md`.
