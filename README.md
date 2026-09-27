# Hivemind

Hivemind is an experimental, runtime-agnostic **meta-harness for persistent AI agents**.

The first proof of concept is intentionally CLI-only: Hivemind owns the agents and conversation surface, while [oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi) is the first supported execution harness.

## POC acceptance target

With OMP installed and authenticated:

```bash
cargo run -- init
cargo run
```

Then:

```text
You> hello

Maomao> <reply produced by OMP>
Albedo> <reply produced by OMP>
```

Both configured agents receive the same user turn independently through the OMP adapter and reply through Hivemind.

## Requirements

- Rust stable
- `omp` available on `PATH`
- OMP already configured with a working provider/model

Verify OMP first:

```bash
omp --version
omp -p "hello"
```

## Quick start

```bash
git clone https://github.com/Anxiety471/Hivemind.git
cd Hivemind

cargo run -- init
cargo run
```

The generated `hivemind.toml` contains two example agents. Edit their names, prompts, model, thinking level, or workspace as needed.

Useful CLI commands while chatting:

```text
/agents   list configured agents
/help     show commands
/quit     exit
```

You can also use another config file:

```bash
cargo run -- --config ./my-hive.toml chat
```

## POC architecture

```text
                 Hivemind CLI
                      |
               user input: hello
                      |
              +-------+-------+
              |               |
           Maomao           Albedo
              |               |
        Runtime Adapter  Runtime Adapter
              |               |
             OMP             OMP
              |               |
          response         response
              +-------+-------+
                      |
                   terminal
```

The important boundary is that an **agent belongs to Hivemind, not to OMP**. OMP is merely a runtime adapter. Future adapters can support Codex, Claude Code, or another harness without changing agent identity or the CLI protocol.

## Current limitations

This is deliberately a narrow POC:

- OMP is the only runtime.
- Each turn is currently a fresh headless OMP invocation.
- Hivemind does not yet persist memory or task history.
- Responses are collected after each harness invocation rather than streamed token-by-token.
- Agent-to-agent messaging comes after this first user-to-agents acceptance path.

The next logical step is replacing/augmenting the one-shot OMP adapter with OMP's RPC mode so Hivemind can own persistent sessions and normalized runtime events.

## License

No license has been selected yet.
