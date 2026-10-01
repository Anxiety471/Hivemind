# Memory

Hivemind has a seven-layer memory system that **works without any LLM**. The default is `[memory] mode = "deterministic"`: storage, retrieval, and policy are plain code, so memory keeps working when no model, provider, or quota is available.

## Layers

| Layer | Owner | Behavior |
| --- | --- | --- |
| Harness working context | Pi/OMP/OpenCode session | Disposable; rebuilt from the layers below if the runtime restarts |
| Recent conversation | room | Raw window capped by `[context] recent_turns`; older turns stay in the archive |
| Group shared memory | group | Visible only to that group's members |
| Private memory | agent instance | Visible only to that room/persona identity; the same persona in different rooms gets separate memories |
| Persona memory | persona | Shared by every instance of the same persona |
| Hivemind global | system-wide | Durable project-wide facts, under the strictest policy |
| Canonical archive | Hivemind | Durable source of truth for rooms, turns, messages, and memory records |

## How it works

- **Storage.** A local SQLite archive with FTS5 full-text indexes over memories and archived messages. Search is deterministic and needs no embedding service.
- **Scope binding.** Hivemind attaches the caller's own context to every memory request and works out the group, instance, and persona from it. Requests never name an owner. An agent can't read another group's memory or another instance's private notes, and can't pose as a different persona.
- **Writes.** Private and group writes are accepted directly within the caller's own scope. Persona and global writes are proposals that Hivemind's policy checks before committing. An agent's bare opinion never becomes global truth.
- **Global writes need the user.** A global write is accepted only when the user's turn carries a `Global:` directive and the proposal's content exactly matches it (see [Configuration](Configuration#room-state-directives)).
- **Provenance and supersession.** Every record keeps its origin (room, turn, message, actor). Corrections create revisions. An old record is kept as `superseded` instead of being deleted, so history stays searchable.
- **One tool bridge.** Pi, OMP, and OpenCode reach memory through a single tool bridge owned by Hivemind, using a ```` ```hivemind-tool ```` fence. Runtime adapters only carry the transport. Hivemind also tells each agent which capabilities it has, which scopes it may touch, and that it should search memory rather than pretend to remember.

## Permissions

When a persona declares `roles`, memory writes are gated by `memory.private.write`, `memory.group.write`, `memory.persona.write`, `memory.global.write`, and `memory.archive`. `memory.search` is never gated. A persona without roles is unrestricted. See [Access Control](Access-Control).

## Retrieval details

Each member does exactly one retrieval per turn. Memory scopes are ranked with bm25 mixed with importance, recency, scope, and status; the archive is ranked by distinct query-term matches over the newest 64 hits. See [Backend Efficiency](Backend-Efficiency#retrieval).

## Limits

Search is SQLite FTS5 full-text matching, not semantic or embedding search. There is no vector database.
