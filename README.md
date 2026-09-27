# Hivemind

Hivemind is an experimental, runtime-agnostic **meta-harness for persistent AI agents**.

The first proof of concept is intentionally CLI-only: Hivemind owns the agents and conversation surface, while [oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi) is the first supported execution harness.

## POC acceptance target

With OMP installed and authenticated:

~~~bash
cargo run -- init
cargo run
~~~

Then:

~~~text
You> hello

Maomao> <reply produced by OMP>
Albedo> <reply produced by OMP>
~~~

Both configured agents receive the same user turn independently through the OMP adapter and reply through Hivemind.

## Requirements

- Rust stable
- `omp` available on `PATH`
- OMP already configured with a working provider/model

Verify OMP first:

~~~bash
omp --version
omp -p "hello"
~~~

## Quick start

~~~bash
git clone https://github.com/Anxiety471/Hivemind.git
cd Hivemind

cargo run -- init
cargo run
~~~

The generated `hivemind.toml` contains two example agents.

Useful CLI commands while chatting:

~~~text
/agents   list configured agents
/help     show commands
/quit     exit
~~~

You can also use another config file:

~~~bash
cargo run -- --config ./my-hive.toml chat
~~~

## Per-agent runtime settings

Each agent can choose its own OMP model, reasoning level, and fast-mode preference:

~~~toml
[[agents]]
name = "Maomao"
runtime = "omp"
workspace = "."
system_prompt = "You are Maomao."

model = "provider/model-id"
reasoning = "high"
fast = true
~~~

All three settings are optional:

- `model` maps to OMP's `--model`.
- `reasoning` maps to OMP's `--thinking`. The older Hivemind key `thinking` is still accepted as an alias.
- `fast` is tri-state:
  - omitted: Hivemind leaves OMP's fast-mode state alone and uses normal headless mode.
  - `true`: Hivemind starts OMP in RPC mode and explicitly enables fast mode before prompting.
  - `false`: Hivemind starts OMP in RPC mode and explicitly disables fast mode before prompting.

Fast mode is model/provider dependent. If OMP reports that fast mode is unavailable for the selected model, Hivemind surfaces that error for the affected agent.

Agents remain separate processes. Three configured OMP agents means three independent OMP invocations, each with its own model/reasoning/fast configuration.

## POC architecture

~~~text
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
~~~

The important boundary is that an **agent belongs to Hivemind, not to OMP**. OMP is merely a runtime adapter. Future adapters can support Codex, Claude Code, or another harness without changing agent identity or the CLI protocol.

## Current limitations

This is deliberately a narrow POC:

- OMP is the only runtime.
- Each turn still gets a fresh OMP process.
- Agents without an explicit `fast` setting use OMP's headless text mode.
- Agents with an explicit `fast` setting use a disposable OMP RPC process so Hivemind can set fast mode deterministically.
- Hivemind does not yet persist memory or task history.
- Responses are collected after each harness invocation rather than streamed token-by-token.
- Agent-to-agent messaging comes after this first user-to-agents acceptance path.

The next RPC step is keeping a per-agent OMP process alive across turns so Hivemind can own persistent sessions and normalized runtime events without changing the runtime adapter contract.

## License

No license has been selected yet.
