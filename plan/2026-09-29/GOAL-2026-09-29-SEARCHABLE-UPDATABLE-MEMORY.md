# GOAL — 2026-09-29 — Searchable, Updatable Agent Memory

## Objective

Make agents find and update existing memory instead of appending duplicates.

The memory service already supports full-text search, in-place update with revision history, and supersession. The agent-facing tool bridge withholds what agents need to use them. The rule is:

```text
Search first. If a result matches, update it by id (or upsert by key).
Add only when nothing matches.
```

## Verified baseline (2026-09-29)

Throwaway test calling `execute_memory_tool` directly against an in-memory `MemoryService` (removed after the run):

| Probe | Observed |
| --- | --- |
| `memory.private.add` "user timezone is UTC" twice | two distinct records (`…-000000-…`, `…-000001-…`) |
| then add "user timezone is CET" | third record; **3 stored, 3 active**, UTC and CET both active |
| `memory.search` "timezone" output contains any stored record id | **false** |
| `memory.persona.update` | `unknown memory tool 'memory.persona.update'` |

Cause locations:

- `src/conversation/memory_tools.rs` `execute_memory_tool`: search lines render `- [layer] content (source…)` with no `record.id`.
- `src/conversation/coordinator.rs` (~line 666): the context-pack retrieval section has the same format.
- `tool_write` hard-codes `supersedes_memory_id: None`.
- `MemoryService::add_*` always inserts; no duplicate or key check.
- `update_persona` and `update_global` exist in `src/memory/service.rs` but no tool calls them.

Already working, keep unchanged:

- FTS5 + `bm25` search in `src/memory/store/sqlite.rs`, scoped per caller.
- `update()` rewrites the record and replaces its `memory_fts` row.
- `memory_revisions` keeps history.
- Scope and owner come from the server-built `Caller`, never tool args.

## Step 1 — Expose ids

Render the id in search results and the context-pack retrieval section:

```text
- [private] #memory-0179… (updated 2026-09-29) user timezone is UTC (source: …)
```

- Share one formatter between `memory.search` output and the pack section so they cannot diverge.
- Keep the 300-char content truncation.
- Archive results are room messages, not updatable memory. Label them without an update hint.
- Verify the context-pack token overhead still fits `MIN_CONTEXT_TARGET_TOKENS`. Existing calibration: pack overhead is several hundred tokens.

## Step 2 — Upsert by key

Add tools:

- `memory.private.upsert(key, content)`
- `memory.group.upsert(key, content)` (group manifest only)

Semantics:

- Add a nullable `topic_key` column to `memories`, with the same `PRAGMA table_info` migration style used for `runtime_epochs.identity_version`.
- Add a partial unique index on `(scope_type, scope_id, topic_key)` where `status='active' AND topic_key IS NOT NULL`.
- If an active record with that key exists in the caller's scope, run the existing `update` path. That keeps the revision row and the FTS replacement.
- Otherwise insert.
- Scope is derived from the caller as today, so an agent cannot upsert into another instance's or group's memory.
- Do not reuse `kind` as the key: the default `"note"` would collide.

## Step 3 — Duplicate guard on add

In `add_private` and `add_group`, before insert:

- If an active record in the same scope has identical whitespace/case-normalized content, return that record instead of inserting, and bump `updated_at`.
- Tool result: `already stored as <id>` rather than `stored …`.
- Deterministic; no model dependency (`memory.mode` stays `deterministic`).
- Persona and global proposals keep their stricter validation and are not deduplicated by this step.

Non-goal: fuzzy or semantic dedupe.

## Step 4 — Update tools for broad layers

Add `memory.persona.update(id, content)` and `memory.global.update(id, content)`.

- They route through the existing `update_persona` / `update_global`, so `validate_broad_proposal` still applies.
- `memory.global.update` remains accepted only when the content exactly matches a `Global:` directive in the current user turn.
- Add both to the manifests. Group and room manifests differ only by group tools.

## Step 5 — Manifest wording

In both `GROUP_MEMORY_TOOL_MANIFEST` and `ROOM_MEMORY_TOOL_MANIFEST`:

- Replace "Search before claiming to remember" with the rule above: search, then update or upsert, and add only if nothing matches.
- Document the `#id` format in results and the `key` argument.
- Keep the room manifest's "no group memory; never claim to have saved group memory" sentence.

## Tests

Follow `src/conversation/tests.rs` and `src/memory/tests.rs` conventions. Permanent tests only for consumer-visible behavior:

- Search output includes the id; `update` with that id changes content and leaves one record.
- Search after update returns the new content only.
- Upsert twice with the same key gives one active record and one `memory_revisions` row.
- Upsert with the same key in another instance or room does not touch the first record.
- Exact-duplicate add stores no second record and reports the existing id.
- Persona/global update follows the same authorization tests as their propose paths.
- `topic_key` migration opens an existing database created before the column existed.

## Acceptance criteria

1. Every non-archive search hit shows a usable memory id in tool output and in the context pack.
2. An agent can revise a fact by id without creating a second active record.
3. Upsert by key is idempotent and scope-bound.
4. Exact duplicate adds do not create records.
5. Persona and global memory can be updated through tools under existing policy.
6. Manifests instruct search → update/upsert → add.
7. Old databases open and migrate.
8. `cargo test` passes.
9. `cargo clippy --all-targets --all-features -- -D warnings` passes.

The repo is deliberately not rustfmt-clean, so `cargo fmt --check` is not a gate. Match the surrounding dense style.

## Known unrelated failure

The all-targets API test that expects Pi defaults instead of OMP fails at baseline. Do not treat it as a regression.

## Non-goals

- Model-based or embedding retrieval (`memory.mode` stays `deterministic`).
- Automatic summarization or compaction of memory.
- Changing scope, provenance, or authorization rules.
- Cross-room or cross-persona write access.
- Changing archive (L7) storage or search.
