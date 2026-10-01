# Backend efficiency

How Hivemind keeps per-turn overhead small and flat: independent of disk fsync cost, room history length, group size, and the number of rooms and WebSocket clients. Numbers measure Hivemind only (the benchmark uses an instant fake runtime), never model latency.

The rule the design follows:

```text
Turn overhead is O(active turn), not O(room history) or O(members²).
No SQLite call blocks a tokio worker.
```

## Durability

SQLite (`.hivemind/memory.sqlite3`) runs in `journal_mode=WAL` with `synchronous=NORMAL`.

| Failure | Outcome |
|---|---|
| Application crash | Nothing lost |
| OS crash or power loss | The last few committed turns may be lost |
| Any of the above | The database is never corrupted |

Other connection settings: `busy_timeout` 5 s, `temp_store=MEMORY`, 512 KiB page cache per connection, 128 cached prepared statements per connection. Existing databases switch to WAL on first open.

## Connections and threading

- One **writer** connection behind a `parking_lot` mutex. Multi-statement writes run in one `IMMEDIATE` transaction.
- File databases also open two **read-only** WAL connections, so reads never queue behind a write. In-memory databases (tests) use the single connection.
- Every SQLite call goes through one choke point (`MemoryStore::read` / `write` / `tx`). On a multi-thread tokio runtime it runs inside `block_in_place`, so the worker's other tasks move away while it blocks. On a current-thread runtime, or outside a runtime, it runs inline.
- The per-room file lock is acquired with `spawn_blocking`, not polled. The context directory is created and canonicalized once per coordinator.
- On Linux/glibc, `main` sets `M_ARENA_MAX=1` before starting the runtime. Per-thread arenas scattered the long-lived room caches and made RSS grow with history.

## Schema (user_version 1)

| Table | Change |
|---|---|
| `memory_fts` | Columns `scope_key, content, kind`; rowid equals `memories.rowid`. |
| `archive_fts` | Columns `room_key, speaker, content`; rowid equals `archive_messages.rowid`. |
| Indexes | `archive_messages(turn_id)`, `archive_messages(room_id, created_at, id)`, `archive_turns(room_id)`. |

- `scope_key` / `room_key` is one exact token: a prefix letter plus uppercase hex of the scope or room id. A column-filtered `MATCH` scopes a query to one room or scope inside FTS instead of scanning every room and filtering afterwards.
- Deletes are by rowid rather than a full FTS scan.
- The migration runs on open in one transaction. It drops the old FTS tables and rebuilds them from `memories` and `archive_messages`, so no data is lost. A database that predates the FTS tables is backfilled as well.
- Rowid alignment assumes the base tables are never `VACUUM`ed.
- Do not open one database with a pre-migration binary and a current binary at the same time; the old binary writes the old FTS columns.

## Retrieval

Each member does exactly one retrieval per turn. The result feeds both the full context pack and the delta prompt.

- **Archive hits** depend only on the room and the input, so they are searched once per turn and shared by all members. One extra row covers the active turn's own message, which is filtered out.
- **Memory scopes** (group, instance, persona, global) are searched per member with `ORDER BY bm25 LIMIT k`, selecting every column in the same query. Relevance is `s/(1+s)` of the bm25 strength `s`, which is monotone, so bm25 order survives into the final score. The final score also mixes importance, recency, scope and status.
- **Archive ranking is not bm25.** bm25 has to scan every posting list of the query terms, so its cost grows with room size. The archive query walks matches newest first (`ORDER BY rowid DESC LIMIT 64`, which FTS5 stops early on), then ranks that candidate pool by how many distinct query terms each message contains, with recency as the tie-break. An old but highly relevant message outside the newest 64 matches is not found.
- **Query terms:** lowercased, deduplicated, stopwords removed (kept only if nothing else is left), capped at 16, OR-joined.

## Persistence of a turn

`ContextStore` gained `checkout`, `release` and `save_changes`. `save_room` and `load_room` remain for full reads and for the JSON store.

A turn writes only what changed, in one transaction per save:

1. After the summary refresh (if it changed): the state snapshot.
2. After the user message: the turn row and that message.
3. After each reply: that reply only.
4. At the end: the completion flag and the snapshot.

Where the data lives:

- **Room snapshot** (`room-state:<room>` turn metadata): `state`, `summary`, `summarized_turn_count`, `maintenance_errors`. It stays O(1).
- **Completion** is `archive_turns.completed_at`.
- **Failed replies and legacy identities** are stored in the owning turn row's `metadata` (`errors`, `legacy_agent_instance_ids`).
- **Old snapshots** carrying `completed_turns`, `error_message_ids` or `legacy_agent_instance_ids` are upgraded on first load: the ids move onto their turn rows and the snapshot is rewritten without the lists.

### Room history cache

`SqliteContextStore` keeps the parsed history of up to 32 recently used rooms. `checkout` removes the entry (the turn owns it), and `release` puts it back after the last save.

- An entry is trusted only if `PRAGMA data_version` on the writer connection is unchanged, so a write by another process forces a reload.
- The version is read before a cold load, so a concurrent commit is detected later rather than masked.
- If a turn fails part-way the history is dropped, and the next turn reloads from SQLite.
- `release` drops contentless events, so a cached history equals a fresh reload.
- The turn scans (`recent_events`, `refresh_summary`, `turn_delta`) assume a turn's events are contiguous. Turns are serialized per room, so this holds.

## Fan-out

- `EventBus` publishes `Arc<DomainEvent>`. Each event's WebSocket frame is serialized once (`DomainEvent::frame_with`) and shared by every client. The wire format is unchanged.
- Each client task feeds the first event plus anything arriving within 1 ms, then flushes once. A burst of lifecycle events costs one loopback write instead of one each.
- `Participant.agent` is `Arc<AgentConfig>`, and `AgentRegistry` hands out shared `Arc`s instead of cloning configs per turn.

## Runtime robustness

`get_session_stats` (`context_tokens()`) on the turn path is bounded by `prompt_timeout_secs`. On timeout the pool publishes a `prompt_timeout` failure, stops the session, closes its epoch, evicts the slot and returns an error. There is no retry.

## Build

`[profile.release]` sets `lto = "fat"`, `codegen-units = 1`, `strip = true`, `opt-level = 3`, `panic = "unwind"`. `tokio` and `axum` features are trimmed to what the code uses. The standalone `hivemind-server` binary is gone: run `hivemind serve`.

## Measuring

```bash
cargo build --release --bin hivemind
python3 scripts/bench-backend.py --out plan/findings/bench/<date>-<phase>-tmpfs.json
python3 scripts/bench-backend.py --root ~/.cache/hmbench --turns 500 \
  --group-turns 100 --tool-turns 100 --out plan/findings/bench/<date>-<phase>-btrfs.json
```

- `--root` picks the filesystem; tmpfs hides fsync cost.
- Scenarios: `solo`, `group`, `concurrency`, `tools`, `ws`.
- Compare only against a baseline from the same host.
- Full-text ranking drifts as other rooms grow, so use a control step when comparing.

Results on the reference host (baseline commit `d3d4a50` versus this work):

| Metric | Before | After |
|---|---|---|
| btrfs solo turn @100 history, p50 | 129 ms | 2.0 ms |
| fsync per solo turn | ~17 | 0.11 |
| tmpfs solo @1000 history, CPU/turn | 60.4 ms | 1.8 ms |
| tmpfs group of 8 @200, CPU/turn | 307.6 ms | 4.8 ms |
| RSS growth, 100 to 1000 turns | +7.9 MB | +2.4 MB |
| tmpfs 8-room throughput (serial / concurrent) | 182 / 101 turns/s | 728 / 805 turns/s |
| btrfs 8-room concurrent p50 | 1268 ms | 8.6 ms |
| Extra CPU from 50 WebSocket clients | +16.6 ms/turn | +4.6 ms/turn |

The release binary is 5.6 MB (`hivemind`, which includes the CLI).
