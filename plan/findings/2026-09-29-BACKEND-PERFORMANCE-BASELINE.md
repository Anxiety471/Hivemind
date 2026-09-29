# Findings — 2026-09-29 — Backend Performance Baseline

Status: investigation in progress, stopped early on request. This file records measured facts, audit findings, and the remaining work needed to finish the efficiency plan. The final plan should go in `plan/2026-09-29/GOAL-2026-09-29-BACKEND-EFFICIENCY.md`, which does not exist yet.

## Method

- Binary: `target/release/hivemind-server` (default release profile), commit `5dfde8c`.
- Runtime: `/tmp/hmbench/fakepi.py` is a fake Pi RPC process that replies instantly. Numbers below measure **Hivemind overhead only**, not model latency.
- Driver: Python `http.client` with keep-alive, `POST /api/v1/turns`, and a solo target unless noted.
- Disks: `/tmp` is tmpfs (fsync costs almost nothing). `~/.cache/hmbench` is btrfs on `/dev/sda2`, which gives real-disk numbers.
- Tools: strace (`-c -f`, used as a wrapper) and `eu-stack` wall-clock stack sampling of a `line-tables-only` build (`target/prof`). Samply and perf are blocked because `perf_event_paranoid=2`, and ptrace attach is blocked because `ptrace_scope=1`. Sampling works through `prctl(PR_SET_PTRACER_ANY)` in `preexec_fn`.

## Measured baseline

### Process footprint

| Metric | Value |
|---|---|
| Server idle RSS | 8.6 MB, 17 threads (16 tokio workers + main) |
| Server RSS after 1000 turns | 18.6 MB. Grows about 8 KB per turn and never shrinks, which is consistent with the fingerprint caches never being evicted. |
| Startup to `/health` 200 | 88 ms on tmpfs, 414 ms on btrfs (schema DDL and fsyncs) |
| First turn (fake runtime spawn) | 150–160 ms |

### Real runtime children (these dominate the system footprint)

| Runtime | First frame | Tree RSS after 2 s idle |
|---|---|---|
| `pi --mode rpc --no-session` | 1.7 s | 155 MB |
| `omp --mode rpc --no-ui --no-session` | 1.35 s | 320 MB |
| `opencode acp` | 0.8 s | 259 MB (2 processes) |

- One child runs per (room, persona). N rooms × M personas means N×M children of 150–320 MB each until the 120 s idle reaper runs. There is no cap.
- Hivemind itself is about 1/20 of a single child's memory. To make the whole system "small", you have to limit the number of live children.

### Per-turn latency: solo, fake runtime

| Condition | p50 | p90 | Server CPU per turn |
|---|---|---|---|
| tmpfs, turns 0–50 | 13.7 ms | 20.5 ms | — |
| tmpfs, turns 250–300 | 56.5 ms | 90.4 ms | 26.8 ms (average over 300 turns) |
| btrfs, turns 0–50 | 143 ms | 164 ms | — |
| btrfs, turns 100–150 | 208 ms | 276 ms | 27.6 ms (average); wall time was 196 ms per turn |

On real disk, about 85% of turn wall time is waiting on fsync.

### Syscalls: strace -c -f, 101 turns, tmpfs

| Syscall | Count | Per turn |
|---|---|---|
| `pwrite64` | 18,286 | ~180 |
| `fcntl` | 9,547 | ~95 |
| `newfstatat` (3,797 errors) | 5,024 | ~50 |
| `fsync` | 1,704 | **~17** |
| `openat` | 1,195 | ~12 |
| `unlink` | 426 | ~4 (DELETE-journal files) |
| `flock` | 101 | 1 |

### Wall-clock stack samples, btrfs, 100-turn history

- `fsync` accounted for 214 of 268 busy samples (**80%**).
- The remaining samples were SQLite reads and writes.

### SQLite durability experiment (btrfs, 100 turns, no code change)

WAL was pre-set on the DB file. `synchronous=NORMAL` was applied through a rebuild with `LIBSQLITE3_FLAGS=-DSQLITE_DEFAULT_WAL_SYNCHRONOUS=1`, output in `target/sqlwal`.

| Mode | p50 | p90 | CPU per turn |
|---|---|---|---|
| Default (DELETE journal, FULL) | 135.9 ms | 240.0 ms | 15.4 ms |
| WAL + FULL | 48.4 ms | 65.0 ms | 9.3 ms |
| **WAL + NORMAL** | **6.7 ms** | **10.0 ms** | 6.4 ms |

WAL + NORMAL is **about 20× faster** per turn, from a PRAGMA change alone.

### History growth (WAL + NORMAL, btrfs, 1000 turns in one room)

| Turns | p50 | p90 | CPU per turn | RSS |
|---|---|---|---|---|
| 100 | 6.6 ms | 10.9 ms | 6.6 ms | 10.7 MB |
| 300 | 18.0 ms | 29.7 ms | 17.5 ms | 13.3 MB |
| 500 | 29.2 ms | 47.7 ms | 28.8 ms | 15.7 MB |
| 1000 | 57.3 ms | 85.3 ms | 56.5 ms | 18.6 MB |

- Growth is linear, **about 5.7 ms CPU per 100 turns of history, on every turn**. Extrapolated [INFERENCE]: about 0.57 s CPU per turn at 10k turns.
- The DB was 6.0 MB after 1000 turns.

### O(history) CPU attribution (tmpfs, 1000-turn history, 296 busy samples)

| Frame (inclusive) | Share of samples |
|---|---|
| `search` (FTS retrieval) | **55%** |
| `recent_messages` | 3.4% |
| `turn_fingerprint` | 2.0% |
| `archive_turn` | 1.0% |
| `load_room` | 0.3% |
| Unattributed (inlined frames under `submit_turn`) | ~38% |

- Leaf split: 164 samples in SQLite, 119 other, 13 in alloc/free.
- An earlier 400-turn sample showed the hot frame as `query_row<ArchivedMessage>`. That is the archive-hit N+1 at `src/memory/store/sqlite.rs:383`.

### Group turns and concurrency (8 personas)

| Condition | tmpfs | btrfs |
|---|---|---|
| Broadcast group of 3, p50 | 28.5 ms | 216 ms |
| 8 rooms concurrent, throughput | 78.8 turns/s | **6.8 turns/s** |
| 8 rooms concurrent, p50 | 92 ms | **1009 ms** |
| Same rooms serial, throughput | 124.5 turns/s | 5.1 turns/s |

Concurrency is *slower* than serial on tmpfs. All rooms serialize on one `std::sync::Mutex<Connection>`, which blocks tokio workers (there is no `spawn_blocking` anywhere in `src`).

### Binary size (`hivemind-server`)

| Profile | Size |
|---|---|
| Default release | 7.74 MB (CLI `hivemind` is 8.67 MB) |
| `strip=symbols` | 6.05 MB |
| + `lto="fat"`, `codegen-units=1` | 5.04 MB (CLI 5.45 MB) |
| + `panic="abort"` | 4.62 MB |
| + `opt-level="s"` | 3.02 MB |

- `panic="abort"` is **not safe as-is**. The coordinator turns a panicking agent `JoinSet` task into a per-agent error, and `kill_on_drop` children would be orphaned on abort.
- Dependency graph: 110 unique crates.

## Ranked root causes (code evidence from the audits)

1. **fsync-heavy SQLite configuration.** `src/memory/store/sqlite.rs:52` sets only `PRAGMA foreign_keys=ON`, so the database runs with the DELETE journal and `synchronous=FULL`. That produces about 17 fsyncs per turn. Many writes are separate autocommits, for example `start_runtime_epoch` (2 commits), `set_topic_key` after `insert`, `touch_duplicate`, and `set_status`.
2. **FTS retrieval is O(matches) and runs twice per member per turn.**
   - `sqlite.rs:329-417`: there is no `ORDER BY rank LIMIT` in SQL, results are sorted and truncated in Rust, and there is an N+1 `load_record` or `query_row` per hit (lines 367 and 383).
   - `memory_fts` is scanned once per scope, up to 4 times.
   - `fts_query` ORs every token with no stopword filter or token cap.
   - `coordinator.rs:497-502`: `context_pack` and `turn_delta` both call `memory_retrieval`, and the pack is built eagerly even when the delta is used.
   - `rank_score` clamps `-bm25*1e6` to [0,1], which saturates to 1.0, so relevance is effectively constant. This is a ranking bug that also blocks pushing LIMIT into SQL [INFERENCE: not run].
3. **Whole-history reload and rewrite on every turn.**
   - `store.rs:506-565` `load_room` calls `recent_messages(usize::MAX)`, which has no LIMIT and an O(M×T) `Vec::contains`.
   - `save_room` runs 1 + N + 2–4 times per turn. Each run re-hashes every historical turn (`turn_fingerprint`), rewrites the active turn with delete plus re-insert of messages and FTS rows, and re-serializes an O(turns) snapshot (`completed_turns`).
   - The fingerprint maps are never evicted, which explains the RSS growth.
4. **FTS deletes by an UNINDEXED column scan the whole FTS table.** The statements are `archive.rs:32`, `sqlite.rs:251`, and `sqlite.rs:306`. There is also no index on `archive_messages(turn_id)`.
5. **Blocking SQLite on async workers behind one global mutex.** This serializes rooms and stalls WebSocket and runtime I/O on the same worker.
6. **Statements are never cached.** There are about 40 `prepare`, `execute`, and `query_row` call sites, and none use `prepare_cached`, so SQLite re-parses every statement (`sqlite3RunParser` appears in the samples).
7. **Runtime layer.**
   - A `get_session_stats` round trip runs before every Pi/OMP turn, and it has **no timeout** (a robustness bug).
   - OMP makes an extra `get_last_assistant_text` round trip.
   - Rotation, context-gap, and failure stops wait up to 2–3 s for a graceful child exit on the turn path.
   - Every stdout frame is parsed into a full `serde_json::Value` DOM.
   - There is no cap on live children.
8. **Small, cheap items.**
   - `TCP_NODELAY` is not set (`api/mod.rs`).
   - `DomainEvent` is deep-cloned per subscriber, and WebSocket JSON is re-serialized per client.
   - Each turn does `create_dir_all`, `canonicalize`, and a 10 ms flock poll (`store.rs:6-90`).
   - `AgentConfig` is cloned per participant per turn.
   - `tokio` uses `features=["full"]`.
   - `src/bin/hivemind-server.rs` duplicates `hivemind serve`.

### Already good (do not re-propose)

- Runtime child reuse per (room, persona) with delta prompts.
- The per-slot tokio mutex, and the parking_lot map lock that is never held across `.await`.
- A broadcast event bus with `Lagged` handling.
- Typed JSON HTTP responses.
- An O(1) `len/4` token estimate.
- Config held as `Arc` and loaded once.
- No runtime probing at startup.

## Recommended order (first = biggest measured win per effort)

1. **SQLite pragmas plus transaction grouping.**
   - Add `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout`, `temp_store=MEMORY`, and `cache_size` at open.
   - Wrap multi-statement writes in single transactions.
   - Measured: turns go from 136 ms to 6.7 ms p50 on disk. One file.
2. **Retrieval.**
   - Use one FTS query per store with SQL `ORDER BY bm25 LIMIT k` and all columns selected (no N+1), plus `prepare_cached`.
   - Retrieve once per member per turn and build the pack lazily.
   - Add stopwords and a token cap, and fix the relevance normalization.
   - This targets 55%+ of the growing CPU.
3. **Append-only persistence and a bounded load.**
   - Write only the active turn, and delete `prime_caches` and the fingerprint maps.
   - Load only the last `recent_turns`, or cache `RoomHistory` per room under the existing room lock, validated with `PRAGMA data_version`.
   - Shrink the snapshot row.
   - Schema migration: external-content FTS5 keyed by rowid, plus indexes `archive_messages(turn_id)` and `(room_id, created_at, id)`.
4. **Concurrency.**
   - Move SQLite off the async workers, using either `spawn_blocking` or one DB actor thread plus WAL read-only connections.
   - Use `parking_lot::Mutex`.
   - Re-measure the 8-room benchmark.
5. **Runtime.**
   - Cache context usage from stream frames (as OpenCode already does) and drop `get_session_stats` and `get_last_assistant_text`.
   - Detach old-session stops on rotation.
   - Parse frames header-first.
   - Add `max_live_sessions` with LRU eviction.
6. **Build profile.**
   - Add `[profile.release]` with `lto="fat"`, `codegen-units=1`, `strip=true` (7.74 → 5.04 MB).
   - Trim `tokio` and `axum` features.
   - Drop the duplicate server binary, or make it a thin alias.
   - Decide `panic="abort"` separately; it needs panic-isolation redesign first.
7. **Cheap latency items.** `TCP_NODELAY`, `Arc<DomainEvent>` with serialize-once, `Arc<AgentConfig>`, and the room-dir/flock fixes.

## Missing before the plan is complete

- [ ] **Write the plan file** `plan/2026-09-29/GOAL-2026-09-29-BACKEND-EFFICIENCY.md` using the existing GOAL format (Objective, phases, Acceptance criteria, Non-goals), built from the order above.
- [ ] **Turn the benchmark into a repeatable script**, for example `scripts/bench-backend.py` plus the fake Pi. Record the baseline JSON so every phase can be compared against it. The throwaway harness currently lives only in `/tmp/hmbench/fakepi.py` and in the eval session.
- [ ] **Attribute the remaining ~38% of O(history) CPU** that is hidden by inlining. Re-sample with `-C force-frame-pointers=yes` and `debug=1`, or add temporary `Instant` spans around `load_room`, `refresh_summary`, `context_pack`, `turn_delta`, and `save_room`.
- [ ] **Run `EXPLAIN QUERY PLAN`** for the `recent_messages`, archive FTS search, and FTS delete statements to confirm the full-scan claims (items 3 and 4 are code-read only).
- [ ] **Measure memory-tool turns** (a fake runtime that emits a `hivemind-tool` block). Tool follow-ups rebuild the full pack up to 4 times; this is unmeasured.
- [ ] **Measure group turn cost versus member count** (1, 3, 8) with long history. Save amplification is O(N) per turn, and the rewrite is O(N²).
- [ ] **Benchmark WebSocket fan-out**: with 0/1/10/50 WS clients connected, measure turn latency and server CPU. Also verify the `TCP_NODELAY` effect.
- [ ] **Capture real Pi/OMP stdio traces** to confirm usage fields (`message_end.message.usage`) and the `message_update` payload size before choosing the frame-parse and stats-probe fixes.
- [ ] **Measure real-runtime rotation and stop latency** (the time the child takes to exit after stdin EOF) to size the detached-stop win.
- [ ] **Measure CLI one-shot startup** (`hivemind ask`, `status`) with `tokio` multi-thread vs `current_thread`.
- [ ] **Decide policy with the user**:
  - `panic="abort"` (extra size win versus panic isolation);
  - `opt-level="s"` (3.0 MB versus speed);
  - the default `idle_timeout` and `max_live_sessions` values (memory versus cold-start latency, since a cold start costs 0.8–1.7 s).
- [ ] **Clean up**: `~/.cache/hmbench`, the `/tmp/hmbench-*` dirs, and the build dirs `target/{prof,sz-lto,sz-abort,sz-s,sz-strip,sqlwal}` (several GB). Samply was installed to `~/.cargo/bin` but is unusable without `perf_event_paranoid<=1`.
