# GOAL — 2026-09-29 — OpenCode Runtime

## Objective

Add `opencode` as a third live runtime next to `pi` and `omp`, behind the existing `HarnessSession` boundary, and use the OpenCode free-model service to test the Hivemind meta harness end to end with a real third-party runtime.

The rule is:

```text
OpenCode obeys the same lifecycle contract as Pi and OMP.
No OpenCode-specific behavior leaks into pool, core, memory, API, or conversation code.
```

## Current state

- `HarnessSession` (`src/runtime/mod.rs`) exposes `prompt`, `context_tokens`, `shutdown`; `create_session` dispatches on `agent.runtime`.
- Adapters `src/runtime/pi.rs` and `src/runtime/omp.rs` wrap stdio JSONL RPC children.
- Runtime names/binaries are hard-coded in: `runtime/mod.rs`, `setup.rs` (two matches and error text), `cli/render.rs`, `config.rs` (`RuntimeConfig.omp_binary` / `pi_binary` and defaults).
- OpenCode v2.0.18 is installed locally (`~/.bun/bin/opencode`).
- Free models seen in `opencode models`: `opencode/big-pickle`, `opencode/nemotron-3-ultra-free`, `opencode/nemotron-3.5-lightning-free`, `opencode/mimo-v2.6-flash-free`, `opencode/longcat-2.5-preview-free`, `opencode/ling-3.0-flash-fin-free`, `opencode/space-bunny-free`.
- Verified: `opencode run --standalone -m opencode/big-pickle --format json "reply with just: ok"` emits JSON event lines (`{"type":"text","sessionID":...,"part":{"text":"ok"}}`) in about 4 s.
- OpenCode server mode (`opencode serve`) is documented with an OpenAPI spec at `/doc`: create session, send message and wait, `prompt_async`, abort, delete session, `/global/health`, `/event` SSE, optional basic auth via `OPENCODE_SERVER_PASSWORD`. The public docs describe an older version; installed v2.0.18 `serve` also lists `--stdio` and `--service`. The protocol MUST be re-verified against the installed binary.

## Step 1 — Transport spike (no repo changes)

Decide the transport by experiment against the installed binary.

Candidates, in order of preference:

1. `opencode serve --stdio` or `opencode acp`: stdio protocol, reuses the existing child-transport shape used by Pi/OMP.
2. `opencode serve` child plus loopback HTTP: random port, random password, one OpenCode session id held across prompts.
3. `opencode run --format json --session <id>` per turn: no long-lived child, but cold start every turn and context persists on disk outside Hivemind's "disposable cache" invariant. Last resort.

The spike MUST establish, with captured transcripts saved as test fixtures:

- how to start, and how readiness is detected,
- how to create one session and send a turn with an explicit `provider/model` and Hivemind's system prompt,
- how the final assistant text is extracted (concatenated text parts, ignoring reasoning/tool parts),
- where token/context usage is reported (for `context_tokens`),
- how a turn is aborted,
- how the session is deleted and the child exits,
- whether a killed child leaves orphan processes,
- what the process name is in `ps` (Pi's process title differs from its command line; use `pgrep -x`-style checks only after confirming).

Record the chosen transport and why in the adapter's module docs.

## Step 2 — Configuration

- Add `runtime.opencode_binary`, default `"opencode"`, with a serde default so existing configs still load.
- Agent `runtime = "opencode"` and `model = "provider/model-id"` (e.g. `opencode/big-pickle`), split into provider and model id for the OpenCode API.
- Reject the OMP-specific `fast` setting for OpenCode with a clear per-agent error, like Pi does.
- Reasoning setting: pass through only if OpenCode supports it in the spike; otherwise reject with a clear error rather than silently ignoring.
- Provider credentials remain managed by OpenCode and are never stored in Hivemind config. Update the default-config header comment accordingly.

## Step 3 — Adapter

Create `src/runtime/opencode.rs` with `OpencodeSession::start(binary, agent)`:

- validate the workspace directory,
- spawn the child in the agent workspace with `kill_on_drop`,
- bounded, cancel-safe startup (same semantics as the existing OMP startup test: a hanging startup is killed on core shutdown),
- create one OpenCode session,
- `prompt` returns the assistant text only; cancellation is external (`tokio::select!` in the pool), and dropping the prompt future must not leave the session unusable without the pool discarding it,
- `context_tokens` from the runtime-reported usage, `None` when unavailable,
- `shutdown`: delete the session, close/kill the child with the existing bounded kill fallback, reap it,
- sticky failure state like Pi/OMP, with errors naming the agent.

Isolation: the child MUST NOT be able to open a listening port reachable off-host (bind loopback only) and MUST use a per-session secret if HTTP is chosen.

Permissions: decide the default for tool/file permission prompts so a turn never blocks waiting for a human. Match Pi/OMP behavior as the reference and document the choice; do not auto-approve more than Pi/OMP effectively allow.

## Step 4 — Wiring

- `create_session` arm for `"opencode"`.
- `setup.rs`: both runtime matches, binary resolution and messages become `supported: pi, omp, opencode`.
- `cli/render.rs`: show the opencode binary.
- Update the unsupported-runtime error in `runtime/mod.rs`.
- Runtime events, runtime epochs, and public API payloads carry the runtime name as a plain string; verify nothing branches on `pi`/`omp` elsewhere (grep before editing).

## Step 5 — Tests (no real providers)

Fake OpenCode fixture following the existing `Fixture` pattern in `runtime/mod.rs`:

- `create_session` dispatches one pi, one omp, and one opencode agent independently,
- startup failure names the agent and binary,
- hanging startup is cancelled by core shutdown and the child is reaped,
- prompt returns only assistant text,
- prompt timeout aborts/kills, discards the session, and the next turn starts a fresh child,
- crash mid-prompt surfaces a runtime failure and closes the epoch,
- `context_tokens` present and absent,
- `fast` rejected,
- legacy config without `opencode_binary` loads with the default,
- `setup` doctor reports opencode binary present/missing.

Existing lifecycle tests for Pi/OMP must keep passing unchanged.

## Step 6 — End-to-end with the free service

Opt-in only (`HIVEMIND_E2E_OPENCODE=1` or an `#[ignore]` test); never part of default `cargo test`. Use an isolated `XDG_DATA_HOME`/config dir per run so OpenCode session state does not touch the user's real data, and a scratch workspace with no secrets (free tiers may forward prompts to third-party providers).

Scenarios, against real `opencode/*-free` models:

1. Single agent, two turns: context retained (recall a word given in turn 1).
2. Two agents in one room on different free models: reply order follows `conversation.reply_order`, each sees the other's prior reply in shared context.
3. Memory tool round trip: agent saves and later recalls a memory through Hivemind's memory tools; verify actual store contents rather than the agent's claim.
4. Context rotation: `context_target_tokens = 1500`, `runtime_rotate_tokens = 1501` (see runtime lessons: keep the default target unless calibrating; the pack has fixed overhead) and observe `runtime.rotated` on the WebSocket.
5. Prompt timeout: very small `prompt_timeout_secs` produces `prompt_timeout`, epoch closed, next turn fresh.
6. Mixed room: one `pi`, one `omp`, one `opencode` agent in the same room, all replying in order.
7. Shutdown: after `core.shutdown()` no `opencode` child remains (verify with `ps`/`pgrep` using the process name confirmed in the spike).

Model choice is data, not code: pick from `opencode models` filtered by `-free`; skip the run with a clear message if none is available or the service rate-limits. No retries in product code to mask flakiness.

Capture the E2E as a repeatable script under the existing verification conventions, and record results in `GOAL-2026-09-29-E2E-VERIFICATION-GAPS.md` if that plan tracks them.

## Step 7 — Documentation

- README: supported runtimes list, `opencode_binary` setting, example agent block, the free-model E2E instructions and their caveats.
- Config example and default-config comments.
- Changelog entry if the repo keeps one.

## Risks

- Free models are rate limited, flaky, and change names; E2E is opt-in and model list is queried at run time.
- OpenCode v2 API drift versus published docs; adapter is built against the spiked behavior of the installed version. Doctor SHOULD print the detected version and warn, not block, on an untested one.
- OpenCode persists sessions on disk; shutdown deletes the session and E2E isolates data dirs.
- Blocking permission prompts would hang a turn; covered by the prompt timeout, but the default policy must be decided in Step 3.

## Acceptance criteria

1. `runtime = "opencode"` agents start, reply, and stop through `HarnessSession` with no OpenCode-specific code outside `runtime/opencode.rs`, config, setup, and render.
2. `runtime.opencode_binary` is configurable and legacy configs still load.
3. OpenCode sessions persist across turns for one agent instance and are never shared across rooms or personas.
4. Prompt timeout and core shutdown cancel a hung OpenCode turn, discard the session, and close the runtime epoch.
5. No OpenCode child (or grandchild) survives `core.shutdown()`.
6. `setup` doctor validates and reports the opencode binary.
7. Unit tests use a fake OpenCode; none call a real provider.
8. Opt-in E2E passes scenarios 1–7 against a real free model, including the mixed pi/omp/opencode room.
9. README documents the runtime and the E2E procedure.
10. `cargo test --all-targets` passes.
11. `cargo clippy --all-targets --all-features -- -D warnings` passes.

(`cargo fmt --check` is not an acceptance gate: the repo has pre-existing rustfmt diffs; match the surrounding style and do not reformat unrelated code.)

## Non-goals

Do not add:

- automatic prompt retries or provider failover,
- OpenCode agent/plugin/MCP management from Hivemind,
- exposing OpenCode's TUI, share, or fork features,
- a runtime plugin system or dynamic runtime registration,
- provider credential storage in Hivemind config.
