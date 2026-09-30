# GOAL — 2026-09-30 — Backend Efficiency

## Objective

Make Hivemind's per-turn overhead small and flat: independent of disk fsync cost, room history length, group size, and the number of rooms and WebSocket clients.

Evidence: `plan/findings/2026-09-29-BACKEND-PERFORMANCE-BASELINE.md`, plus the baseline JSON in `plan/findings/bench/2026-09-30-baseline-{tmpfs,btrfs}.json` (commit `d3d4a50`, fake instant runtime, so every number is Hivemind overhead only).

Today, on a real disk (btrfs):

```text
solo turn, 50-turn history      157 ms p50   (~85% fsync wait)
solo turn, 500-turn history     236 ms p50   55 ms CPU
group of 8, 100-turn history    654 ms p50   209 ms CPU
8 rooms concurrently           1268 ms p50   5.6 turns/s total
```

On tmpfs, CPU per turn grows linearly with history (4 ms at 50 turns → 60 ms at 1000), and superlinearly with group size (8 members at 200 turns: 308 ms). Memory search accounts for 65% of solo turn time and 84% of a group-of-8 turn.

The rule is:

```text
Turn overhead is O(active turn), not O(room history) or O(members²).
No SQLite call blocks a tokio worker.
Every phase is measured with scripts/bench-backend.py against the recorded baseline.
```

## Decided policy

These were decided with the user on 2026-09-30. Do not reopen them in this goal.

- SQLite runs in `journal_mode=WAL` with `synchronous=NORMAL`. On power loss or an OS crash, the last few committed turns may be lost. The database is never corrupted, and an application crash loses nothing.
- `panic` stays `unwind`. Per-agent panic isolation in the coordinator is kept.
- `opt-level` stays `3`.
- There is no cap on live runtime children. `idle_timeout_secs` stays at 120 s.

## Benchmark gate

`scripts/bench-backend.py` runs the server against an instant fake Pi runtime. Its scenarios are `solo`, `group`, `concurrency`, `tools`, and `ws`, and it writes JSON.

Each phase must:

1. run `python3 scripts/bench-backend.py --out plan/findings/bench/<date>-<phase>-tmpfs.json`;
2. run the same with `--root ~/.cache/hmbench --turns 500 --group-turns 100 --tool-turns 100` for disk numbers;
3. quote the before/after numbers in its PR.

Numbers from different machines are not comparable. Always compare against a baseline taken on the same host.

## Phase 1 — SQLite configuration and write grouping

Measured: WAL + NORMAL takes a btrfs solo turn from 136 ms to 6.7 ms p50. This is a PRAGMA change, verified by a rebuild with `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`. There are currently about 17 fsyncs per turn.

- At open (`src/memory/store/sqlite.rs`), set:
  - `journal_mode=WAL`;
  - `synchronous=NORMAL`;
  - `busy_timeout`;
  - `temp_store=MEMORY`;
  - a bounded `cache_size`.
- Wrap every multi-statement write in one transaction. Known autocommit chains include:
  - `start_runtime_epoch` (2 commits);
  - `insert` followed by `set_topic_key`;
  - `touch_duplicate`;
  - `set_status`.
- Use `prepare_cached` for every repeated statement. There are about 40 call sites, and none are cached today.

## Phase 2 — Retrieval

Measured with spans on tmpfs at a 1000-turn solo history:

- `mem.search` takes 41.6 ms of a 64.3 ms turn.
- It is called 2× per member per turn, from `context_pack` and `turn_delta`.
- In a group of 8 at 200 turns, there are 16 searches per turn (275 ms of 327 ms).
- Each query matches about half of all archive rows.
- `rank_score` relevance saturates to 1.0 for every hit. This was checked against real bm25 values: 0 of about 1000 hits per query were unsaturated. Ranking therefore falls back to recency and scope only.

Required changes:

- Retrieve once per member per turn. Build the full pack only when the delta path is not used.
- Share the archive part of retrieval across all members of one turn. The query text and room are identical for every member; only the private and persona scopes differ.
- Push ranking and limits into SQL:
  - `ORDER BY bm25(...) LIMIT k` per scope;
  - select every needed column in the same query, with no N+1 `load_record`/`query_row` per hit.
- Room-scope the archive match inside FTS. Today `archive_fts MATCH` scans matches across **all rooms**, and `a.room_id` is filtered afterwards. Because of this, search cost grows with the global archive: in the WS scenario, a 0-client control turn drifted from 6.6 to 9.8 ms CPU while other rooms grew.
- Add a stopword filter and a token cap to `fts_query`.
- Replace the relevance normalization with one that preserves bm25 ordering, and add a test that asserts a stronger match outranks a weaker one of the same age and scope.

## Phase 3 — Append-only persistence and bounded load

Measured per solo turn at 1000 history:

| Item | Cost |
|---|---|
| `save_room` | 3.24 calls, 11.7 ms |
| `append_archive_turn` | 4 calls, 7.7 ms |
| `turn_fingerprint` | 4,135 calls |
| `load_room` | 8.2 ms, of which `recent_messages` is 6.4 ms with no LIMIT |

For a group of 8, `save_room` runs 10.2 times per turn.

`EXPLAIN QUERY PLAN` on a 2002-message database showed:

| Statement | Plan | Cost |
|---|---|---|
| `DELETE FROM archive_fts WHERE id=?` | full FTS scan | 0.85 ms (by rowid: 0.039 ms, 22× faster). Grows linearly. |
| `DELETE FROM memory_fts WHERE id=?` | full FTS scan | — |
| `archive_messages WHERE turn_id=?` (select and delete) | `SCAN archive_messages` | 0.148 ms (with an index: 0.028 ms) |
| `recent_messages` | uses `archive_room_turn`, but needs a temp B-tree for the `id` tiebreak | — |

Required changes:

- Persist only the active turn. Delete `prime_caches` and the fingerprint maps; they are also why RSS grows without bound (about 8 KB per turn).
- Load only the last `recent_turns`, or cache `RoomHistory` per room under the existing room lock and validate it with `PRAGMA data_version`.
- Shrink the snapshot row so it no longer re-serializes `completed_turns` in O(turns).
- Add a schema migration:
  - FTS tables keyed by rowid (external-content FTS5 or rowid-aligned inserts), with deletes by rowid;
  - an index on `archive_messages(turn_id)`;
  - an index on `archive_messages(room_id, created_at, id)`.

  The migration must upgrade an existing database in place.

## Phase 4 — Concurrency

Measured with 8 rooms, 25 turns each:

| Filesystem | Mode | Throughput | p50 |
|---|---|---|---|
| tmpfs | serial | 182 turns/s | 5.5 ms |
| tmpfs | concurrent | 101 turns/s | 77 ms |
| btrfs | serial | 5.3 turns/s | — |
| btrfs | concurrent | 5.6 turns/s | 1268 ms |

Every room serializes on one `std::sync::Mutex<Connection>` that is held on tokio workers, and nothing in `src` uses `spawn_blocking`.

- Move SQLite off the async workers. Either `spawn_blocking` or a single writer thread plus WAL read-only connections is acceptable.
- Use a `parking_lot` mutex for whatever lock remains.
- Readers must not wait behind a writer's fsync.

## Phase 5 — Fan-out and per-turn allocation

Measured on tmpfs with a fresh room per step, corrected for the global-archive drift above:

- One WebSocket client adds about 1.2 ms CPU per turn.
- 50 clients add about 16.6 ms CPU per turn, or about 0.08 ms per delivered frame (4.06 frames per client per turn).

Required changes:

- Publish `Arc<DomainEvent>`, and serialize each event to JSON once for all WebSocket clients instead of once per client.
- Hold `AgentConfig` as `Arc` instead of cloning it per participant per turn.
- Create and canonicalize the room directory once, not per turn (`src/conversation/store.rs:6-90`), and replace the 10 ms `flock` poll with a blocking acquire off the async worker.

## Phase 6 — Runtime robustness

Real Pi and OMP traces from 2026-09-30:

| Measurement | Result |
|---|---|
| `get_session_stats` round trip | 0.14–1.35 ms |
| OMP `get_last_assistant_text` round trip | 0.13–0.41 ms |
| Child exit after stdin EOF | Pi 31.5 ms, OMP 113.7 ms |
| Frames per prompt | OMP's first prompt sent about 75 KB (24 `message_update` frames, up to 2.4 KB each, plus a 19 KB `available_commands_update`) |

None of these are measurable costs next to model latency, so the probes and the frame parsing stay.

The one required change is robustness: `context_tokens()` (`get_session_stats`) has **no timeout** on the Pi or OMP turn path. Bound it with the same mechanism as the prompt timeout. On timeout, treat the session as failed: discard it, close its epoch, and emit no retry.

## Phase 7 — Build profile

- Add `[profile.release]` with `lto = "fat"`, `codegen-units = 1`, and `strip = true`, keeping `opt-level = 3` and `panic = "unwind"`. This measured 7.74 → 5.04 MB for `hivemind-server`.
- Trim `tokio` from `features = ["full"]` to the features actually used. Trim `axum` features the same way.
- Replace `src/bin/hivemind-server.rs` with a thin alias of `hivemind serve`, or drop it. Update the scripts and docs that invoke it.

## Tests

Every change must pass the existing suite. Add tests only for behavior a consumer could see:

- the WAL/NORMAL pragmas are active on a freshly opened store;
- the schema migration upgrades a pre-migration database (with history, FTS rows, and memories) without data loss, and search results match before and after;
- a stronger bm25 match outranks a weaker match of the same age and scope;
- archive search in room A never returns room B's messages;
- a turn persisted append-only reloads identically: same events, completed turns, state, and summary;
- a hung `get_session_stats` times out and discards the session;
- concurrent turns in different rooms make progress while one room is writing.

No test may call a real provider.

## Acceptance criteria

All numbers come from `scripts/bench-backend.py` on the baseline host.

1. btrfs solo turn at 100 history: p50 ≤ 15 ms (baseline 129 ms).
2. strace over 100 solo turns shows ≤ 2 `fsync`/`fdatasync` calls per turn on average (baseline about 17).
3. tmpfs solo turn at 1000 history: CPU ≤ 15 ms per turn (baseline 60.4 ms), and CPU at 1000 history is ≤ 1.5× CPU at 100.
4. tmpfs group of 8 at 200 history: CPU ≤ 60 ms per turn (baseline 307.6 ms).
5. Memory search calls per member per turn ≤ 1, and archive search runs once per turn per room.
6. Server RSS after 1000 solo turns is within 3 MB of RSS after 100 turns (baseline +7.9 MB).
7. tmpfs 8-room concurrent throughput ≥ serial throughput (baseline 101 vs 182 turns/s).
8. btrfs 8-room concurrent p50 ≤ 100 ms (baseline 1268 ms).
9. Server CPU added by 50 WebSocket clients is ≤ 50% of the baseline increase (about 16.6 ms per turn).
10. `get_session_stats` is bounded by a timeout on every runtime.
11. Release server binary is ≤ 5.1 MB (`hivemind-server` was dropped; the server is `hivemind serve`).
12. The existing database upgrades in place, and no memory or archive data is lost.
13. `cargo test --all-targets` passes.
14. `cargo clippy --all-targets --all-features -- -D warnings` passes.

## Non-goals

Do not add:

- a cap or LRU eviction for live runtime children (the user chose no cap);
- `panic = "abort"` or `opt-level = "s"`;
- `TCP_NODELAY`. The server binds only to loopback, and an A/B run showed no measurable effect (the p50 differences between runs were within noise);
- a `current_thread` runtime for the CLI. It measured 2.4 → 1.5 ms on one-shot commands, which is not worth a second runtime configuration;
- removal of `get_session_stats` or `get_last_assistant_text`, or header-first frame parsing, because each costs under 1.4 ms (see Phase 6);
- detaching old-session stops on rotation, because graceful exit takes 32–114 ms against a 0.8–1.7 s cold start;
- a new storage engine, a new search engine, or embeddings;
- changes to model-visible prompt content beyond what the retrieval fixes require.
