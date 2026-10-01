# Hivemind web UI

A small browser UI for `hivemind serve`, built with Vite, TypeScript, and Preact. It talks only to the public `/api/v1` HTTP and WebSocket API, so it needs nothing beyond a running server.

| Screen | What it covers |
| --- | --- |
| **Rooms** | Main, group, direct, and task rooms; paged history; live "replying" indicators; threads (start one on any message, reply in a side panel); room state and summary |
| **Tasks** | Root tasks, subtasks with dependencies, attempts, artifacts, evidence, budget meters; submit, pause, resume, cancel, and answer `needs_input` |
| **Agents** | Each persona's runtime, live activity state, workspace, capabilities, and effective permissions |
| **Groups** | Create, edit (members, mode, per-group roles, reply order), and delete chat groups |
| **Workspaces** | Allowed roots, group shared workspaces, persona workspaces |
| **Runtime sessions** | Session epochs per room, rotation reasons, and a Rotate button for live sessions |
| **Live activity** | The raw WebSocket event stream with filters |

## Run it

```bash
# 1. Start Hivemind (any working config)
hivemind serve                     # http://127.0.0.1:7474

# 2. Start the UI
cd frontend
npm install
npm run dev                        # http://127.0.0.1:5173
```

The UI connects to `http://127.0.0.1:7474` by default. Change it under **Connection** in the sidebar (saved in the browser), or set `VITE_HIVEMIND_URL` at build time. The server allows browser calls from any loopback origin, so no proxy is needed.

`npm run build` writes a static bundle to `dist/`; serve it from any loopback origin (`npm run preview` does this on port 4173).

### Remote servers

When `server.token_env` is configured, enter the operator token under **Connection**. HTTP calls send it as `Authorization: Bearer …` and the WebSocket sends it as the `hivemind.auth.<token>` subprotocol. The page's origin must be listed in `server.allowed_origins`.

## Demo without a model

`dev/demo.sh` starts `hivemind serve` against a throwaway hive in `dev/.demo/` whose personas run `dev/fake-pi.py`, a scripted stand-in for the Pi RPC runtime. It never contacts a provider: chat prompts get canned replies, and task attempts submit results and approve reviews through the normal coordination tools. Build the server first (`cargo build` at the repo root).

```bash
sh dev/demo.sh                     # terminal 1: server on :7474
node dev/seed.mjs                  # terminal 2: conversations, a thread, two tasks, one rotation
npm run dev                        # terminal 3: the UI
```

`FAKE_PI_DELAY=4 sh dev/demo.sh` slows replies down so the live indicators are easy to see. Delete `dev/.demo/` to start over.
