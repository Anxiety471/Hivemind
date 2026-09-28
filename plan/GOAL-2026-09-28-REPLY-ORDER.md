# GOAL — 2026-09-28 — Deterministic Reply Order

## Objective

Add a **turn arbiter / speaker scheduler** so Hivemind decides which agent is allowed to reply first, second, third, and so on.

Agents may still perform work concurrently, but their responses must not be printed to the user in completion order.

Fastest response must not automatically become the first speaker.

## Problem

Hivemind can run multiple agents asynchronously.

Without an explicit speaking policy, output can become nondeterministic:

```text
turn 1:
Maomao finishes first
Albedo finishes second

turn 2:
Albedo finishes first
Maomao finishes second
```

That makes the conversation harder to follow and becomes dangerous once agents begin receiving other agents' replies as context.

Execution order and speaking order must therefore be separate concepts.

## Core rule

```text
agents may THINK concurrently
but Hivemind decides when they SPEAK
```

Hivemind owns conversation ordering.

A runtime adapter such as Pi or OMP must never decide presentation order.

## Desired flow

```text
User turn
   |
   +-----------------------------+
   |                             |
Agent A works async         Agent B works async
   |                             |
result ready                  result ready
   |                             |
   +-------------+---------------+
                 |
           Turn Arbiter
                 |
        deterministic ordering
                 |
       Agent A reply displayed
                 |
       Agent B reply displayed
```

The arbiter may buffer a completed response while waiting for an earlier scheduled speaker.

## Configuration

Add an explicit reply order at the Hivemind level.

Preferred shape:

```toml
[conversation]
reply_order = ["Albedo", "Maomao"]
```

Meaning:

1. Albedo is the first speaker.
2. Maomao is the second speaker.

The order is based on Hivemind agent names, not runtime type.

Pi and OMP agents may be mixed freely.

If `reply_order` is omitted, fall back to the order agents appear in `[[agents]]`.

## Validation

Validate configuration at startup.

Reject:

- duplicate names in `reply_order`,
- names that do not match a configured agent.

If some configured agents are omitted from `reply_order`, append them after explicitly listed agents using their original `[[agents]]` configuration order.

Example:

```toml
[conversation]
reply_order = ["Albedo"]

[[agents]]
name = "Maomao"

[[agents]]
name = "Albedo"

[[agents]]
name = "Frieren"
```

Effective order:

```text
Albedo
Maomao
Frieren
```

## Turn identity

Every user message should create a logical turn.

Conceptually:

```text
Turn 12
  user: "review this architecture"

  expected speakers:
    1. Albedo
    2. Maomao
    3. Frieren
```

Responses from different turns must never be interleaved.

Even if an agent from Turn 13 finishes before another agent from Turn 12, Turn 12 must finish presenting before Turn 13 responses are shown.

The exact internal turn ID representation is up to the implementation.

## Async execution

Do **not** solve ordering by making all agents execute serially.

Keep concurrent execution between independent agents where possible.

For a single turn:

1. dispatch work to all participating agents,
2. collect results asynchronously,
3. buffer results by agent,
4. emit them according to the effective reply order.

Example:

```text
Configured reply order:
1. Albedo
2. Maomao
3. Frieren

Actual completion:
Frieren -> 1.2s
Maomao  -> 2.0s
Albedo  -> 3.5s

Displayed:
Albedo
Maomao
Frieren
```

Concurrency is preserved while conversation order remains deterministic.

## Failures and timeouts

A failed earlier speaker must not permanently block all later speakers.

For this milestone:

- if an agent returns an error, print that error in the agent's scheduled position,
- then continue to the next scheduled speaker,
- if timeout handling already exists, treat timeout as that agent's result and continue,
- do not silently reorder successful agents around a failed one.

Example:

```text
Albedo> [error] runtime exited unexpectedly

Maomao> <normal response>
```

The turn still preserves speaker order.

## CLI behavior

Keep the existing output style, but make ordering deterministic.

`/agents` should show the effective reply order.

Example:

```text
Agents:
  1. Albedo [pi]
  2. Maomao [pi]
  3. Frieren [omp]
```

If useful, also label the first configured speaker as the lead speaker, but do not introduce new orchestration behavior yet.

## Runtime independence

Reply ordering belongs to Hivemind core.

Do not implement this independently inside:

- PiAdapter,
- OmpAdapter,
- future Codex adapter,
- future Claude adapter.

Runtime adapters return agent results.

Hivemind decides presentation order.

## Acceptance criteria

The goal is complete when:

1. Hivemind accepts an optional `[conversation].reply_order`.
2. Invalid agent names are rejected at config load.
3. Duplicate names are rejected.
4. Omitted agents are appended deterministically.
5. If no reply order is configured, `[[agents]]` order is used.
6. Agents still execute concurrently.
7. Results are displayed in the configured reply order regardless of completion timing.
8. An agent failure occupies its normal position and does not reorder later agents.
9. Responses from separate user turns cannot be interleaved.
10. Mixed Pi and OMP agents use the same ordering mechanism.
11. `/agents` exposes the effective order.
12. `cargo test` passes.
13. `cargo clippy --all-targets --all-features -- -D warnings` passes.

## Tests to add

Add deterministic tests for:

- explicit reply order,
- fallback to agent declaration order,
- partial reply order with omitted agents,
- duplicate reply-order entries,
- unknown agent names,
- completion order different from display order,
- failed first speaker followed by successful later speakers,
- mixed runtime agents,
- protection against cross-turn output interleaving.

Use mocked/fake runtimes where possible so timing can be controlled without real provider calls.

## Non-goals

Do **not** implement these yet:

- agents choosing the next speaker themselves,
- LLM-based speaker selection,
- voting,
- debate rounds,
- agent-to-agent messaging,
- passing one agent's answer into another agent during the same turn,
- dynamic spawning,
- `<spawn params=...>`,
- task delegation,
- shared memory,
- autonomous orchestration.

This milestone is only about deterministic turn presentation and speaker ordering.

## Definition of done

Hivemind should no longer behave like:

```text
whoever finishes first -> speaks first
```

It should behave like:

```text
agents work concurrently
        |
results arrive in any order
        |
Hivemind Turn Arbiter
        |
responses appear in intentional order
```

This gives Hivemind a stable conversation protocol before agent-to-agent communication and dynamic orchestration are introduced.
