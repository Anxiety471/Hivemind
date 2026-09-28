# GOAL — 2026-09-28 — Hivemind Setup

## Objective

Make Hivemind easy to set up on a fresh machine with a clear, repeatable first-run workflow.

The user should not need to manually guess which files to create, which runtime binaries are missing, or whether the local environment is actually ready.

The target experience is:

```bash
git clone https://github.com/Anxiety471/Hivemind.git
cd Hivemind

cargo build
cargo run -- init
cargo run -- doctor
cargo run
```

After that, Hivemind should be ready to chat with configured agents.

## Scope

This goal covers local developer/user setup only.

It should establish:

- prerequisite checks,
- runtime detection,
- initial configuration generation,
- validation,
- clear setup errors,
- documentation for a clean first run.

Do not turn this into an installer framework or package manager project.

## Required prerequisites

Document and validate the minimum requirements:

- Rust stable,
- Cargo,
- at least one supported runtime binary,
- a configured/authenticated provider for that runtime.

Supported runtime checks should include the runtimes currently present in Hivemind, such as:

- `pi`,
- `omp`.

Do not require every supported runtime to be installed.

Hivemind only needs at least one runtime that is actually referenced by the configured agents.

## Init workflow

Improve or preserve:

```bash
cargo run -- init
```

The init command should generate a usable starter `hivemind.toml`.

The generated config should:

- contain at least two example agents,
- use the current preferred lightweight runtime where appropriate,
- include sensible comments/examples for model and reasoning settings,
- avoid requiring provider-specific secrets inside the repository,
- never overwrite an existing config unless `--force` is explicitly passed.

Example:

```toml
[runtime]
pi_binary = "pi"
omp_binary = "omp"

[conversation]
reply_order = ["Maomao", "Albedo"]

[[agents]]
name = "Maomao"
runtime = "pi"
workspace = "."
system_prompt = "You are Maomao."

[[agents]]
name = "Albedo"
runtime = "pi"
workspace = "."
system_prompt = "You are Albedo."
```

Adjust the exact configuration to match the runtime and conversation features implemented in the repository.

## Doctor command

Add:

```bash
hivemind doctor
```

or the Cargo equivalent:

```bash
cargo run -- doctor
```

The doctor command should inspect the local setup and print concise checks.

Example:

```text
Hivemind doctor

[ok] config: hivemind.toml
[ok] agent: Maomao
[ok] agent: Albedo
[ok] pi: /usr/bin/pi
[ok] workspace: .
[ok] runtime configuration
[ok] ready
```

Failures should be actionable:

```text
[error] pi runtime not found on PATH
        install/configure Pi or change the agent runtime
```

The command should not make paid/provider API calls merely to prove the binary exists unless an explicit deeper check is added later.

## Validation

Validate the configuration before chat starts.

At minimum check:

- config file exists,
- TOML parses,
- at least one agent exists,
- agent names are non-empty,
- agent names are unique,
- referenced runtime is supported,
- required runtime binary exists,
- configured workspace exists,
- reply order is valid if configured.

Fail before entering chat if setup is invalid.

Avoid letting the first user prompt become the moment Hivemind discovers that its runtime binary does not exist. Humans already have enough delayed error messages.

## Runtime discovery

Runtime lookup should be explicit and predictable.

Preferred behavior:

1. use the configured binary path/name,
2. resolve it through PATH when a bare command is supplied,
3. report the resolved executable in `doctor`,
4. reject missing executables before chat starts.

Do not silently substitute another runtime.

## Configuration safety

Keep local runtime/provider configuration out of version control.

Ensure generated/local files such as:

```text
hivemind.toml
```

remain ignored when appropriate.

Do not place:

- API keys,
- provider tokens,
- session credentials,
- machine-specific paths,

inside committed example files.

Example configuration files may show placeholders only.

## Setup documentation

Update the README so a fresh user can follow one canonical setup path.

The setup section should cover:

1. clone repository,
2. verify Rust,
3. install/configure Pi or OMP,
4. verify runtime independently,
5. build Hivemind,
6. run `init`,
7. inspect/edit `hivemind.toml`,
8. run `doctor`,
9. start chat.

Keep the quick-start path short.

Put detailed troubleshooting below it rather than making first-time setup read like a tax form.

## Error quality

Setup errors should state:

- what failed,
- which agent/runtime/config triggered it,
- what the user can do next.

Good:

```text
agent 'Maomao' uses runtime 'pi', but binary 'pi' was not found on PATH
```

Bad:

```text
runtime error
```

## Acceptance criteria

The goal is complete when:

1. A fresh clone can be built with documented commands.
2. `hivemind init` produces a valid starter config.
3. Existing config files are protected unless `--force` is used.
4. `hivemind doctor` exists.
5. `doctor` detects configured runtime binaries.
6. `doctor` validates agent workspaces.
7. `doctor` validates conversation/reply-order configuration.
8. Invalid runtime names fail clearly.
9. Missing binaries fail clearly.
10. Missing workspaces fail clearly.
11. Chat refuses to start with invalid configuration.
12. README contains one canonical setup workflow.
13. No secrets are committed.
14. `cargo test` passes.
15. `cargo clippy --all-targets --all-features -- -D warnings` passes.

## Tests to add

Add tests for:

- init config generation,
- refusing overwrite without `--force`,
- duplicate agent names,
- unsupported runtime names,
- missing runtime binaries,
- missing workspace,
- valid setup,
- invalid reply-order references,
- doctor output/status behavior where practical.

Runtime binary detection should be testable without depending on the developer's actual machine PATH.

## Non-goals

Do **not** implement these in this goal:

- package publishing,
- Homebrew/AUR/deb/rpm installers,
- Docker deployment,
- remote agents,
- VPS deployment,
- service/daemon mode,
- GUI setup wizard,
- automatic provider account login,
- automatic API key creation,
- agent-to-agent messaging,
- dynamic spawning.

Those can be separate goals.

## Definition of done

A new user should be able to go from:

```text
fresh clone
```

to:

```text
validated Hivemind configuration
+ runtime detected
+ agents ready
+ chat starts
```

without reading source code or discovering missing setup requirements one crash at a time.
