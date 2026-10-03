# Web UI

`frontend/` contains a browser UI for `hivemind serve`. It uses only the public [HTTP and WebSocket API](HTTP-and-WebSocket-API).

```bash
hivemind serve                      # API on http://127.0.0.1:7474
cd frontend && bun install && bun run dev   # UI on http://127.0.0.1:5173
# or: cd frontend && npm install && npm run dev
```

## Layout and navigation

The UI follows Linear's layout: a sidebar (Issues, Rooms, Library; *Hive*: Agents, Groups, Workspaces; *System*: Runtime sessions, Live activity, Setup guide; Settings), and on every page a 44px top bar with the title, tabs, and actions above dense list rows.

- **Command menu**: <kbd>⌘K</kbd> / <kbd>Ctrl+K</kbd> or *Search* in the sidebar. Search issues (by title or `HM-` key), rooms, and agents, jump to any page, create an issue, agent, or group, or switch the theme.
- **Shortcuts**: <kbd>C</kbd> creates an issue from anywhere; <kbd>G</kbd> then <kbd>I</kbd> Issues, <kbd>R</kbd> Rooms, <kbd>L</kbd> Library, <kbd>A</kbd> Agents, <kbd>G</kbd> Groups, <kbd>W</kbd> Workspaces, <kbd>S</kbd> Sessions, <kbd>V</kbd> Live activity, <kbd>,</kbd> Settings; <kbd>?</kbd> lists them all.
- **Theme**: System, Light, or Dark under **Settings → Appearance** (stored in the browser).

## Screens

- **Rooms**: main, group, direct, and task rooms with paged history (`/rooms/{id}/messages`). Messages are sent with `"wait": false`; replies appear live from `agent.reply.*` and `conversation.turn.*` events, and `agent.progress` text is shown while an agent replies. Typing `@` in a composer (rooms and threads) lists the room's participants; filter by typing, move with Up/Down, pick with Enter, Tab, or a click, dismiss with Esc. The inserted `@Name` is what the server's mention detection matches. Any message can start a thread (`POST /rooms/{id}/threads`), which opens in a side panel with its own history and composer. Room details show the room state and summary. Task rooms are read-only.
- **Slash commands**: a composer message that starts with `/` is a command. `/help` lists them, `/skills` lists the configured [skills](Configuration#skills), `/skill:<name> [request]` asks the room's agents to read and use that skill, and `/tools` lists the tool names agents can call (`GET /skills`, `GET /skills/{name}?path=`, `GET /tools`). Typing `/` opens a menu of the commands followed by one `/skill:<name>` row per skill, filtered as you type: Up/Down to move, Tab completes, Enter completes a partial command or runs a complete one, Esc closes. `/help`, `/skills` and `/tools` answer locally and are not sent to any agent; start a message with `//` to send a literal leading slash.
- **Issues** (`#/issues`, Linear-style): every coordination task is an issue. The list groups root issues by status (Needs attention, In Review, In Progress, Todo, Backlog, Done, Canceled) and expands each into its sub-issue tree; a board view shows the same groups as columns, and filtering searches every depth. `C` opens the new-issue modal (title, description, acceptance criteria, labels, and optional sub-issues sent as the plan; leave them empty to let the coordinator plan). An issue page shows the breadcrumb of its parents, description, acceptance criteria, the nested sub-issue tree with progress, an inline *Add sub-issue* field, steering, results, and activity, with status, people, labels, budget, and pause/resume/cancel in the side panel. Any live issue of a running root can spawn sub-issues, which can spawn their own (`POST /tasks/{id}/children`). Refreshes on `task.*` and `attempt.*` events.
- **Agents**: one row per persona with runtime, model, activity state (`/agent-instances`), capabilities, and workspace; click a row for permissions, roles, groups, and group workspace overrides.
- **Groups**: create, edit (members, mode, per-group roles, reply order), and delete chat groups via `/chat-groups`.
- **Workspaces**: allowed roots, group shared workspaces, and persona workspaces, editable in place.
- **Runtime sessions**: epochs per room with end reasons and rotation, plus **Rotate** for a live session (`POST /runtime/rotate`).
- **Live activity**: the raw WebSocket event stream with filters.

## Managing agents, workspaces and rooms

- **Agents** can be created, edited and deleted. A card shows the agent's own workspace separately from any group workspace that replaces it inside a group. Typed input survives a failed save, and an edit made elsewhere is flagged without discarding yours.
- **Workspaces** lets you add several workspaces next to the existing ones and pick them for agents and groups. Adding one never restricts where agents may work (that is what `[workspaces] roots` is for).
- The **room panel** on the right of every conversation has Details, Settings, and Sessions tabs. Settings cover nickname, pinning, muting, mode, reply order, and workspace; controls that do not apply to a room kind say why. **Details** also lists the room's self-scheduled wakeups (label, the intent/reminder/note body, recurrence, next fire time, state) with a **Cancel** button, backed by `GET`/`DELETE /rooms/{id}/schedules`.
- Agent replies render as Markdown. The server also normalizes line endings, escape codes and blank-line runs, so every runtime reads the same.

## Connection

The default server is `http://127.0.0.1:7474`; change it under **Settings → Connection** (stored in the browser) or set `VITE_HIVEMIND_URL` at build time. Loopback pages need no proxy because the server allows CORS from loopback origins. With an operator token, the UI sends `Authorization: Bearer <token>` over HTTP and the `hivemind.auth.<token>` subprotocol on the WebSocket; the page origin must be in `server.allowed_origins`.

## Demo without a model

`frontend/dev/demo.sh` runs `serve` against a throwaway hive whose personas use `frontend/dev/fake-pi.py`, a scripted stand-in for the Pi RPC runtime that never contacts a provider. `bun frontend/dev/seed.mjs (or: node frontend/dev/seed.mjs)` fills it with conversations, a thread, two tasks, and a rotated session. See `frontend/README.md`.
