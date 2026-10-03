# CLI Reference

The shell CLI is the main way to inspect Hivemind, run one-shot prompts, and manage groups and tasks. With Cargo, put `cargo run --` in front of any command. `--config` also works before nested commands, for example `hivemind --config ./my-hive.toml group list`.

## Shell commands

| Command | Description |
| --- | --- |
| `hivemind init [--force]` | Create a starter configuration |
| `hivemind doctor` | Check local configuration and runtime executables |
| `hivemind chat` | Interactive chat in the `main` room (the default with no command) |
| `hivemind chat --solo <persona>` | Chat with one persona |
| `hivemind chat --group <name>` | Chat in a persisted group |
| `hivemind agents` | List configured personas |
| `hivemind status` | Show configuration and runtime readiness |
| `hivemind order` | Print the effective reply order |
| `hivemind ask <persona> "<msg>"` | Prompt one persona once (recorded in its solo room) |
| `hivemind all "<msg>"` | Prompt every persona once (recorded in `main`) |
| `hivemind group create <name> <members…>` | Create a group |
| `hivemind group list` / `show <name>` | Inspect groups |
| `hivemind group add` / `remove <name> <persona>` | Change membership |
| `hivemind group delete <name>` | Delete a group |
| `hivemind serve` | Start the loopback HTTP/WebSocket API on `127.0.0.1:7474` (and the task scheduler) |
| `hivemind task submit "<objective>"` | Store an autonomous task; `serve` or `task run` processes it |
| `hivemind task list` / `show` / `cancel` / `pause` / `resume <id>` | Inspect and control tasks |
| `hivemind task watch <id>` | Follow a task's durable events; Ctrl-C stops watching, never the task |
| `hivemind task run [--until-idle]` | Process stored tasks in the foreground |
| `hivemind issue list` / `show` / `dismiss <id>` | Inspect the backlog. Issues are not implemented |
| `hivemind issue run` | Run one council now. Do not run this while `serve` is already in a council |
| `hivemind access show` | Print each persona's effective permissions |
| `hivemind access audit [--denied] [--persona <p>] [--limit N]` | Read the access audit log |

`ask` and `all` go through the same turn coordinator and durable turn store as interactive chat. `all` always writes to the `main` room, whatever the active interactive route is.

## Slash commands in chat

| Command | Description |
| --- | --- |
| `/help` | Show available commands |
| `/agents` · `/status` · `/order` · `/where` | Inspect personas, readiness, order, and the active route |
| `/ask <persona> <msg>` | One-off turn in that persona's solo room |
| `/all <msg>` | One-off turn in the `main` room |
| `/solo <persona>` · `/main` | Switch the active route |
| `/group create\|list\|show\|use\|add\|remove\|delete …` | Manage groups; `use` switches to a group |
| `/quit` · `/exit` | Leave chat |

`/ask` and `/all` **don't change the active route**, so they never quietly add to the active group's history.

## Group behavior

- Deleting the active group sends you back to `main`.
- Empty groups can't be used for chat; bare turns in a group that has become empty are rejected. `list` and `show` still display them.
- Removing a member also clears that member's role and any explicit room-order entries for it.

On `SIGINT`, chat cancels the active turn through core shutdown, reports the failed turn, and stops taking input.
