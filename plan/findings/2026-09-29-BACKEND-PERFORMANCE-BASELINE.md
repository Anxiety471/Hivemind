# Findings — 2026-09-29 — Backend Performance Baseline

Status: investigation complete (2026-09-30). The plan is in `plan/2026-09-30/GOAL-2026-09-30-BACKEND-EFFICIENCY.md`. The 2026-09-30 follow-up measurements below supersede the ranked items and recommendations where they disagree.

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

## Follow-up measurements (2026-09-30, commit `d3d4a50`)

The repeatable harness is `scripts/bench-backend.py`, which embeds its own fake Pi and has the scenarios `solo`, `group`, `concurrency`, `tools`, and `ws`. Baseline JSON: `plan/findings/bench/2026-09-30-baseline-tmpfs.json` (solo 1000, group/tools 200) and `plan/findings/bench/2026-09-30-baseline-btrfs.json` (solo 500, group/tools 100).

### O(history) attribution: `Instant` spans, tmpfs

The spans were inclusive and added in a scratch worktree, not committed. Earlier profiling left about 38% of the time unattributed because of inlining; the spans account for it: it is `save_room` plus `load_room`.

| Span (solo) | 50 turns | 500 turns | 1000 turns |
|---|---|---|---|
| `turn_internal` | 5.9 ms | 32.1 ms | 64.3 ms |
| `mem.search` (2 calls) | 2.2 | 21.1 | **41.6** (65%) |
| `save_room` (3.24 calls) | 1.6 | 6.4 | 11.7 (18%) |
| `load_room` | 0.25 | 2.9 | 8.2 (13%), of which `recent_messages` is 6.4 |
| `turn_fingerprint` calls | 107 | 2,015 | 4,135 |
| `runtime.invoke` (fake) | 1.7 | 0.8 | 1.1 |

Group turns at 200 history:

- 8 members: `turn_internal` takes 327 ms. `mem.search` runs 16 times (275 ms, 84%), and `save_room` runs 10.2 times (43 ms).
- 3 members: 60.7 ms in total, of which search is 47.9 ms.

Every member searches the archive with the same query, so archive work scales as members × history.

### `EXPLAIN QUERY PLAN` (2002-message DB): items 3 and 4 confirmed

| Statement | Plan | Time |
|---|---|---|
| `DELETE FROM archive_fts WHERE id=?` | `SCAN archive_fts VIRTUAL TABLE INDEX 0:` | 0.85 ms (by rowid: 0.039 ms) |
| `DELETE FROM archive_fts WHERE id IN (… turn_id=?)` | FTS scan plus `SCAN archive_messages` | 1.37 ms |
| `DELETE FROM memory_fts WHERE id=?` | full FTS scan | — |
| `archive_messages WHERE turn_id=?` (select and delete) | `SCAN archive_messages` | 0.148 ms (indexed: 0.028 ms) |
| `recent_messages` | `archive_room_turn` index, plus a temp B-tree for the `id` tiebreak | — |
| archive search | `SCAN archive_fts … M5`, with `a.room_id` filtered **after** the global match | — |

Because the room filter is applied after a global match, archive search cost grows with every room's history. In the WS scenario, a 0-client control turn drifted from 6.6 to 9.8 ms CPU while other rooms grew.

### Ranking bug: confirmed

On real data, each OR query matched about 1000 of 2002 rows, and bm25 ranged from −11.3 to −2e−6. After `(-bm25*1e6).clamp(0,1)`, **0 hits were unsaturated**, so relevance is always 1.0 and results are ranked by recency and scope only.

### Memory-tool turns (tmpfs, 200 history)

| Tool calls per turn | Runtime prompts | CPU per turn | p90 |
|---|---|---|---|
| 0 | 1 | 13.2 ms | 16.4 ms |
| 1 | 2 | 12.2 ms | 16.5 ms |
| 4 | 5 | 18.0 ms | 43.0 ms |

A tool follow-up costs about 1.2 ms CPU and does not rebuild the pack. On btrfs, 4 calls take p50 from 132 to 289 ms, because of the extra fsynced saves.

### Group cost versus member count

| Members | tmpfs CPU/turn @50 | tmpfs CPU/turn @200 | btrfs p50 @100 | btrfs CPU/turn @100 |
|---|---|---|---|---|
| 1 | 5.2 ms | 13.2 ms | 131 ms | 20.4 ms |
| 3 | 15.6 ms | 59.8 ms | 236 ms | 55.2 ms |
| 8 | 64.8 ms | **307.6 ms** | 654 ms | 208.6 ms |

### Concurrency (8 rooms × 25 turns)

| Filesystem | Serial | Concurrent |
|---|---|---|
| tmpfs | 182 turns/s, p50 5.5 ms | 101 turns/s, p50 77 ms |
| btrfs | 5.3 turns/s, p50 165 ms | 5.6 turns/s, p50 **1268 ms** |

### WebSocket fan-out and `TCP_NODELAY`

Each client count ran in a fresh room at the same history, with a trailing 0-client control step.

- **Fan-out cost (tmpfs):** CPU per turn was 6.6 / 8.6 / 14.2 / 25.6 ms for 0 / 1 / 10 / 50 clients, and 9.8 ms for the trailing 0-client control.
- **Estimated overhead:** correcting for drift (about 0.8 ms per step), 50 clients cost about 16.6 ms CPU per turn, or about 0.08 ms per delivered frame (4.06 frames per client per turn).
- **`TCP_NODELAY`:** in an A/B test (`ListenerExt::tap_io` + `set_nodelay`, 2–3 alternating runs), the difference was within run-to-run noise. The server binds to loopback only, so this item is dropped.

### Real Pi/OMP stdio (2 prompts each; raw traces not kept)

- **Usage fields:** the assistant `message_end.message.usage` carries `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, and `cost` on both runtimes. Non-assistant `message_end` frames have no usage.
  - Pi: `get_session_stats.contextUsage.tokens` equals the last `totalTokens` exactly.
  - OMP: it differs by about 5 tokens (14237 vs 14241).
- **Round trips:** `get_session_stats` takes 0.14–1.35 ms, and OMP `get_last_assistant_text` takes 0.13–0.41 ms. Neither is worth removing; only the missing timeout matters.
- **Frame sizes:**
  - Pi prompt: 3–4 `message_update` frames, each ≤ 253 B.
  - OMP's first prompt (which included tool calls): 24 `message_update` frames (49 KB, max 2.4 KB), plus a 19 KB `available_commands_update`.
  - OMP's second prompt: about 5.6 KB of updates.

  Header-first parsing would save only an estimated well under 1 ms per turn [INFERENCE], so it is dropped.
- **Latency and memory:**
  - Cold first frame: Pi 3.8 s. OMP `ready` arrives at 1.6 s, and its first frame 0.37 s after the prompt.
  - Tree RSS after 2 prompts: Pi 173 MB, OMP 402 MB.

### Stop and rotation latency

A child exits after stdin EOF in 31.5 ms (Pi) and 113.7 ms (OMP). The 2 s grace period is only reached by a hung child. Detaching the stop on rotation would save at most about 0.1 s, against a 0.8–1.7 s cold start, so it is dropped.

### CLI one-shot startup (median of 40 runs each)

| Command | Multi-thread | `current_thread` |
|---|---|---|
| `--help` | 2.4 ms | 1.5 ms |
| `status` | 2.5–2.6 ms | 1.5–1.6 ms |
| `ask` (fake Pi) | 43–46 ms | 37–47 ms |

`ask` is dominated by spawning the runtime. The difference is negligible, so this item is dropped.

### Policy decisions (user, 2026-09-30)

- WAL + `synchronous=NORMAL`.
- Keep `panic = "unwind"`.
- `opt-level = 3`.
- No live-session cap; `idle_timeout_secs` stays at 120.

## Checklist

- [x] Plan file `plan/2026-09-30/GOAL-2026-09-30-BACKEND-EFFICIENCY.md`.
- [x] Repeatable benchmark `scripts/bench-backend.py`, with baseline JSON in `plan/findings/bench/`.
- [x] Remaining O(history) CPU attributed (spans).
- [x] `EXPLAIN QUERY PLAN` for `recent_messages`, archive search, and the FTS deletes.
- [x] Memory-tool turns measured.
- [x] Group cost versus member count (1/3/8).
- [x] WebSocket fan-out (0/1/10/50) and `TCP_NODELAY`.
- [x] Real Pi/OMP stdio traces.
- [x] Real-runtime stop latency.
- [x] CLI startup, multi-thread versus `current_thread`.
- [x] Policy decisions.
- [x] Cleanup of benchmark scratch data, scratch build dirs, and the samply install.
