# Getting Started

## Prerequisites

- Rust stable with Cargo.
- At least one supported runtime (**Pi** or **OMP**; **OpenCode** also works), installed and signed in to a provider through that runtime's own setup. Hivemind never calls a provider during setup.

## Install and configure

```bash
git clone https://github.com/Anxiety471/Hivemind.git
cd Hivemind

rustc --version && cargo --version
pi --version            # or: omp --version

cargo build
cargo run -- init       # writes hivemind.toml (never overwrites without --force)
```

Open `hivemind.toml`. The starter config uses **Pi for both example personas** (`Engineer` and `Reviewer`), so you only need Pi unless you change a persona's `runtime`. Set up a provider and model inside the runtime itself. See [Configuration](Configuration) for every option, and `hivemind.example.toml` in the repo for a commented example.

## Check and chat

```bash
cargo run -- doctor     # checks runtimes, workspaces, and reply order
cargo run               # starts interactive chat in the main room
```

`doctor` only checks runtimes that your configured personas use. It finds binaries on `PATH` (or at an explicit executable path) and checks workspaces and reply order. It never contacts a provider. `hivemind.toml` is local-only and ignored by Git.

Some first things to try:

```bash
cargo run -- ask Engineer "What's in this workspace?"     # one persona, once
cargo run -- all "Introduce yourselves."                   # every persona, once
cargo run -- chat --group development                      # a configured group
```

Inside chat, type `/help` for slash commands. See [CLI Reference](CLI-Reference).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Missing runtime | Install or configure it, or set the matching `[runtime]` binary (`pi_binary`, `omp_binary`, `opencode_binary`) to its executable path. Only runtimes that personas use are checked. |
| Workspace errors | Each persona `workspace` must be an existing directory. Update it or create the directory before starting chat. |
| Provider / auth errors | Credentials belong to Pi, OMP, or OpenCode. Check authentication with that runtime's own setup. |
| Reply order errors | Entries must be unique names of configured personas. Personas you leave out are added in declaration order. |

## Next steps

- Build a team with roles: copy from `examples/team.toml` and read [Access Control](Access-Control).
- Give a group a shared directory: [Workspaces](Workspaces).
- Let agents work on their own: [Coordination](Coordination).
- Drive Hivemind from code or a UI: [HTTP and WebSocket API](HTTP-and-WebSocket-API).
