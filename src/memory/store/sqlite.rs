use std::cmp::Ordering;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Row, TransactionBehavior};

use super::super::*;

fn layer_str(l: Layer) -> &'static str {
    match l {
        Layer::RecentConversation => "recent_conversation",
        Layer::Group => "group",
        Layer::Private => "private",
        Layer::Persona => "persona",
        Layer::Global => "global",
        Layer::Archive => "archive",
    }
}
fn parse_layer(x: &str) -> Result<Layer> {
    Ok(match x {
        "recent_conversation" => Layer::RecentConversation,
        "group" => Layer::Group,
        "private" => Layer::Private,
        "persona" => Layer::Persona,
        "global" => Layer::Global,
        "archive" => Layer::Archive,
        _ => bail!("invalid layer {x}"),
    })
}
fn parse_status(x: &str) -> Result<MemoryStatus> {
    Ok(match x {
        "active" => MemoryStatus::Active,
        "superseded" => MemoryStatus::Superseded,
        "archived" => MemoryStatus::Archived,
        _ => bail!("invalid status {x}"),
    })
}

/// Read-only connections opened next to the writer for file databases (WAL
/// readers never wait behind the writer).
const READERS: usize = 2;
/// Most recent archive matches re-ranked by bm25 per search.
const ARCHIVE_CANDIDATES: i64 = 64;
/// Statements kept prepared per connection.
const STATEMENT_CACHE: usize = 128;

/// Run `f`, telling a multi-threaded tokio runtime that this worker is about
/// to block on SQLite so other tasks are moved off it. Outside a runtime, and
/// on a current-thread runtime (where `block_in_place` would panic), run inline.
fn blocking<T>(f: impl FnOnce() -> T) -> T {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(f)
        }
        _ => f(),
    }
}

macro_rules! record_cols {
    () => {
        "m.id,m.layer,m.scope_type,m.scope_id,m.kind,m.content,m.source_room_id,m.source_turn_id,m.source_message_id,m.source_actor,m.source_kind,m.created_at,m.updated_at,m.status,m.importance,m.supersedes_memory_id"
    };
}

type RawRecord = (
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
    i64,
    String,
    u8,
    Option<String>,
);

fn raw_record(r: &Row<'_>) -> rusqlite::Result<RawRecord> {
    Ok((
        r.get(0)?,
        r.get(1)?,
        r.get(2)?,
        r.get(3)?,
        r.get(4)?,
        r.get(5)?,
        r.get(6)?,
        r.get(7)?,
        r.get(8)?,
        r.get(9)?,
        r.get(10)?,
        r.get(11)?,
        r.get(12)?,
        r.get(13)?,
        r.get(14)?,
        r.get(15)?,
    ))
}

fn decode_record(x: RawRecord) -> Result<MemoryRecord> {
    Ok(MemoryRecord {
        id: x.0,
        layer: parse_layer(&x.1)?,
        scope: Scope::from_parts(&x.2, x.3)?,
        kind: x.4,
        content: x.5,
        provenance: Provenance {
            source_room_id: x.6,
            source_turn_id: x.7,
            source_message_id: x.8,
            source_actor: x.9,
            source_kind: x.10,
        },
        created_at: x.11,
        updated_at: x.12,
        status: parse_status(&x.13)?,
        importance: x.14,
        supersedes_memory_id: x.15,
    })
}

fn load_record(c: &Connection, id: &str) -> Result<Option<MemoryRecord>> {
    c.prepare_cached(concat!(
        "SELECT ",
        record_cols!(),
        " FROM memories m WHERE m.id=?1"
    ))?
    .query_row([id], raw_record)
    .optional()?
    .map(decode_record)
    .transpose()
}

fn scope_key(scope: &Scope) -> String {
    let (ty, id) = scope.kind_id();
    hex_key('s', &format!("{ty}:{id}"))
}

/// SQLite-backed canonical records. FTS5 indexes durable memories and archived
/// messages; both FTS tables are keyed by the rowid of their base row and carry
/// an exact scope/room token so a MATCH is scoped inside FTS itself.
///
/// The writer connection is serialized by a mutex; file databases also get
/// read-only WAL connections so readers never queue behind a write. Rowid
/// alignment relies on the base tables never being `VACUUM`ed.
pub struct MemoryStore {
    pub(crate) connection: Mutex<Connection>,
    readers: Vec<Mutex<Connection>>,
    next_reader: AtomicUsize,
}
impl MemoryStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let writer = Connection::open(path).context("opening memory database")?;
        Self::configure(&writer)?;
        Self::initialize(&writer)?;
        let readers = (0..READERS)
            .map(|_| {
                let reader = Connection::open_with_flags(
                    path,
                    OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
                )
                .context("opening memory database reader")?;
                Self::tune(&reader)?;
                Ok(Mutex::new(reader))
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            connection: Mutex::new(writer),
            readers,
            next_reader: AtomicUsize::new(0),
        })
    }
    pub fn in_memory() -> Result<Self> {
        Self::from_connection(
            Connection::open_in_memory().context("opening in-memory memory database")?,
        )
    }
    pub(in crate::memory) fn from_connection(connection: Connection) -> Result<Self> {
        Self::configure(&connection)?;
        Self::initialize(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
            readers: Vec::new(),
            next_reader: AtomicUsize::new(0),
        })
    }

    fn tune(c: &Connection) -> Result<()> {
        c.busy_timeout(Duration::from_secs(5))?;
        c.pragma_update(None, "temp_store", "MEMORY")?;
        c.pragma_update(None, "cache_size", -512)?;
        c.set_prepared_statement_cache_capacity(STATEMENT_CACHE);
        Ok(())
    }

    /// WAL + `synchronous=NORMAL`: an application crash loses nothing; an OS
    /// crash or power loss may drop the last few commits but never corrupts.
    fn configure(c: &Connection) -> Result<()> {
        Self::tune(c)?;
        c.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get::<_, String>(0))
            .context("enabling WAL journal mode")?;
        c.pragma_update(None, "synchronous", "NORMAL")?;
        c.pragma_update(None, "foreign_keys", "ON")?;
        Ok(())
    }

    fn initialize(connection: &Connection) -> Result<()> {
        connection.execute_batch("
            CREATE TABLE IF NOT EXISTS memories (
              id TEXT PRIMARY KEY, layer TEXT NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL,
              kind TEXT NOT NULL, content TEXT NOT NULL, source_room_id TEXT, source_turn_id TEXT,
              source_message_id TEXT, source_actor TEXT, source_kind TEXT, created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','superseded','archived')),
              importance INTEGER NOT NULL CHECK(importance BETWEEN 0 AND 100), supersedes_memory_id TEXT,
              FOREIGN KEY(supersedes_memory_id) REFERENCES memories(id));
            CREATE INDEX IF NOT EXISTS memories_scope_status ON memories(scope_type, scope_id, status);
            CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS archive_turns (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), started_at INTEGER NOT NULL, completed_at INTEGER, metadata TEXT NOT NULL DEFAULT '{}');
            CREATE INDEX IF NOT EXISTS archive_turns_room ON archive_turns(room_id);
            CREATE TABLE IF NOT EXISTS archive_participants (
              turn_id TEXT NOT NULL REFERENCES archive_turns(id) ON DELETE CASCADE, participant_id TEXT NOT NULL,
              role TEXT, PRIMARY KEY(turn_id, participant_id));
            CREATE TABLE IF NOT EXISTS archive_messages (
              id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), turn_id TEXT NOT NULL REFERENCES archive_turns(id),
              speaker TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS archive_messages_turn ON archive_messages(turn_id);
            CREATE INDEX IF NOT EXISTS archive_room_created_id ON archive_messages(room_id, created_at, id);
            CREATE TABLE IF NOT EXISTS group_state (
              group_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS runtime_epochs (
              id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), instance_id TEXT NOT NULL,
              identity_version INTEGER NOT NULL DEFAULT 0, runtime TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, metadata_json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS memory_revisions (
              revision_id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memories(id), content TEXT NOT NULL,
              provenance_json TEXT NOT NULL, created_at INTEGER NOT NULL, actor TEXT);
            CREATE INDEX IF NOT EXISTS memory_revisions_memory ON memory_revisions(memory_id, created_at);")
            .context("initializing memory schema")?;
        let has_column = |table: &str, column: &str| -> Result<bool> {
            let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
            let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
            Ok(columns
                .collect::<rusqlite::Result<Vec<_>>>()?
                .iter()
                .any(|name| name == column))
        };
        if !has_column("runtime_epochs", "identity_version")? {
            connection.execute(
                "ALTER TABLE runtime_epochs ADD COLUMN identity_version INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        if !has_column("memories", "topic_key")? {
            connection.execute("ALTER TABLE memories ADD COLUMN topic_key TEXT", [])?;
        }
        connection.execute_batch(
            "CREATE UNIQUE INDEX IF NOT EXISTS memories_active_topic_key ON memories(scope_type,scope_id,topic_key) WHERE status='active' AND topic_key IS NOT NULL;
             CREATE INDEX IF NOT EXISTS runtime_epochs_identity_start ON runtime_epochs(identity_version,instance_id,started_at DESC)",
        )?;
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version < 1 {
            // v1: FTS tables keyed by base-table rowid (deletes by rowid instead
            // of a full FTS scan) with an indexed room/scope token, rebuilt from
            // the canonical rows so no memory or archive data is lost.
            let tx = connection.unchecked_transaction()?;
            tx.execute_batch(
                "DROP TABLE IF EXISTS memory_fts;
                 DROP TABLE IF EXISTS archive_fts;
                 DROP INDEX IF EXISTS archive_room_turn;
                 CREATE VIRTUAL TABLE memory_fts USING fts5(scope_key, content, kind, tokenize='unicode61');
                 CREATE VIRTUAL TABLE archive_fts USING fts5(room_key, speaker, content, tokenize='unicode61');
                 INSERT INTO memory_fts(rowid,scope_key,content,kind) SELECT rowid,'s'||hex(scope_type||':'||scope_id),content,kind FROM memories;
                 INSERT INTO archive_fts(rowid,room_key,speaker,content) SELECT rowid,'r'||hex(room_id),speaker,content FROM archive_messages;
                 PRAGMA user_version=1;",
            )
            .context("migrating full-text indexes")?;
            tx.commit()?;
        }
        Ok(())
    }

    /// Run `f` on a read connection.
    pub(in crate::memory) fn read<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        blocking(|| {
            if self.readers.is_empty() {
                return f(&self.connection.lock());
            }
            let count = self.readers.len();
            let start = self.next_reader.fetch_add(1, AtomicOrdering::Relaxed) % count;
            for offset in 0..count {
                if let Some(reader) = self.readers[(start + offset) % count].try_lock() {
                    return f(&reader);
                }
            }
            f(&self.readers[start].lock())
        })
    }
    /// Run `f` on the writer connection.
    pub(in crate::memory) fn write<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T>,
    ) -> Result<T> {
        blocking(|| f(&self.connection.lock()))
    }
    /// Run `f` inside one immediate write transaction.
    pub(in crate::memory) fn tx<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        blocking(|| {
            let mut connection = self.connection.lock();
            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let out = f(&tx)?;
            tx.commit()?;
            Ok(out)
        })
    }
    /// Changes whenever another connection or process commits to the database.
    pub fn data_version(&self) -> Result<i64> {
        self.write(|c| Ok(c.pragma_query_value(None, "data_version", |row| row.get(0))?))
    }

    pub fn get(&self, caller: &Caller, id: &str) -> Result<Option<MemoryRecord>> {
        let record = self.load(id)?;
        if let Some(record) = &record {
            ensure_can_access(caller, &record.scope)?;
        }
        Ok(record)
    }
    pub fn records_in_scope(&self, caller: &Caller, scope: &Scope) -> Result<Vec<MemoryRecord>> {
        ensure_can_access(caller, scope)?;
        let (kind, id) = scope.kind_id();
        self.read(|c| {
            let mut q = c.prepare_cached(concat!(
                "SELECT ",
                record_cols!(),
                " FROM memories m WHERE m.scope_type=?1 AND m.scope_id=?2 ORDER BY m.created_at,m.id"
            ))?;
            let rows = q
                .query_map(params![kind, id.as_ref()], raw_record)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows.into_iter().map(decode_record).collect()
        })
    }
    pub(crate) fn load(&self, id: &str) -> Result<Option<MemoryRecord>> {
        self.read(|c| load_record(c, id))
    }

    #[cfg(test)]
    pub(crate) fn insert(&self, record: &MemoryRecord) -> Result<()> {
        self.insert_keyed(record, None)
    }
    /// Insert `record` (superseding its predecessor) and its FTS row, and
    /// optionally bind an upsert `topic_key`, in one transaction.
    pub(crate) fn insert_keyed(
        &self,
        record: &MemoryRecord,
        topic_key: Option<&str>,
    ) -> Result<()> {
        let (scope_type, scope_id) = record.scope.kind_id();
        self.tx(|tx| {
            if let Some(old) = &record.supersedes_memory_id {
                let old_record = load_record(tx, old)?
                    .ok_or_else(|| anyhow!("superseded memory does not exist"))?;
                if old_record.scope != record.scope || old_record.status != MemoryStatus::Active {
                    bail!("only an active memory in the same scope may be superseded");
                }
                tx.prepare_cached("UPDATE memories SET status='superseded',updated_at=?2 WHERE id=?1")?
                    .execute(params![old, record.created_at])?;
            }
            tx.prepare_cached("INSERT INTO memories(id,layer,scope_type,scope_id,kind,content,source_room_id,source_turn_id,source_message_id,source_actor,source_kind,created_at,updated_at,status,importance,supersedes_memory_id,topic_key) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)")?
                .execute(params![record.id,layer_str(record.layer),scope_type,scope_id.as_ref(),record.kind,record.content,record.provenance.source_room_id,record.provenance.source_turn_id,record.provenance.source_message_id,record.provenance.source_actor,record.provenance.source_kind,record.created_at,record.updated_at,record.status.as_str(),record.importance,record.supersedes_memory_id,topic_key])?;
            let rowid = tx.last_insert_rowid();
            tx.prepare_cached("INSERT INTO memory_fts(rowid,scope_key,content,kind) VALUES(?1,?2,?3,?4)")?
                .execute(params![rowid, scope_key(&record.scope), record.content, record.kind])?;
            Ok(())
        })
    }
    /// Id of the active record carrying `key` in exactly this scope.
    pub(crate) fn find_active_by_key(&self, scope: &Scope, key: &str) -> Result<Option<String>> {
        let (kind, scope_id) = scope.kind_id();
        self.read(|c| {
            Ok(c.prepare_cached("SELECT id FROM memories WHERE scope_type=?1 AND scope_id=?2 AND topic_key=?3 AND status='active'")?
                .query_row(params![kind, scope_id.as_ref(), key], |r| r.get(0))
                .optional()?)
        })
    }
    /// Active record in this scope whose content equals `normalized` after
    /// whitespace/case normalization; bumps its `updated_at` when found.
    pub(crate) fn touch_duplicate(
        &self,
        scope: &Scope,
        layer: Layer,
        normalized: &str,
        timestamp: i64,
    ) -> Result<Option<MemoryRecord>> {
        let (kind, scope_id) = scope.kind_id();
        self.tx(|tx| {
            let rows = tx
                .prepare_cached("SELECT id,content FROM memories WHERE scope_type=?1 AND scope_id=?2 AND layer=?3 AND status='active'")?
                .query_map(params![kind, scope_id.as_ref(), layer_str(layer)], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let Some((id, _)) = rows
                .into_iter()
                .find(|(_, content)| normalize_content(content) == normalized)
            else {
                return Ok(None);
            };
            tx.prepare_cached("UPDATE memories SET updated_at=?2 WHERE id=?1")?
                .execute(params![id, timestamp])?;
            load_record(tx, &id)
        })
    }
    pub(crate) fn set_status(&self, id: &str, status: MemoryStatus, scope: &Scope) -> Result<()> {
        let (kind, scope_id) = scope.kind_id();
        let n = self.write(|c| {
            Ok(c.prepare_cached("UPDATE memories SET status=?1,updated_at=?2 WHERE id=?3 AND scope_type=?4 AND scope_id=?5")?
                .execute(params![status.as_str(), now(), id, kind, scope_id.as_ref()])?)
        })?;
        if n == 0 {
            bail!("memory not found in authorized scope");
        }
        Ok(())
    }
    pub(crate) fn update_record(&self, record: &MemoryRecord, actor: &str) -> Result<()> {
        self.tx(|tx| {
            let old = load_record(tx, &record.id)?.ok_or_else(|| anyhow!("memory not found"))?;
            if old.scope != record.scope || old.status != MemoryStatus::Active {
                bail!("only an active record in its original scope can be updated");
            }
            tx.prepare_cached("INSERT INTO memory_revisions(revision_id,memory_id,content,provenance_json,created_at,actor) VALUES(?1,?2,?3,?4,?5,?6)")?
                .execute(params![new_id(), old.id, old.content, serde_json::to_string(&old.provenance)?, now(), actor])?;
            tx.prepare_cached("UPDATE memories SET kind=?1,content=?2,source_room_id=?3,source_turn_id=?4,source_message_id=?5,source_actor=?6,source_kind=?7,updated_at=?8,importance=?9 WHERE id=?10")?
                .execute(params![record.kind,record.content,record.provenance.source_room_id,record.provenance.source_turn_id,record.provenance.source_message_id,record.provenance.source_actor,record.provenance.source_kind,record.updated_at,record.importance,record.id])?;
            let rowid: i64 = tx
                .prepare_cached("SELECT rowid FROM memories WHERE id=?1")?
                .query_row([&record.id], |r| r.get(0))?;
            tx.prepare_cached("DELETE FROM memory_fts WHERE rowid=?1")?
                .execute([rowid])?;
            tx.prepare_cached("INSERT INTO memory_fts(rowid,scope_key,content,kind) VALUES(?1,?2,?3,?4)")?
                .execute(params![rowid, scope_key(&record.scope), record.content, record.kind])?;
            Ok(())
        })
    }
    pub(crate) fn archive_message(&self, message: &ArchivedMessage) -> Result<()> {
        self.tx(|tx| {
            let existing_turn_room: Option<String> = tx
                .prepare_cached("SELECT room_id FROM archive_turns WHERE id=?1")?
                .query_row([&message.turn_id], |r| r.get(0))
                .optional()?;
            if existing_turn_room
                .as_deref()
                .is_some_and(|room| room != message.room_id)
            {
                bail!("turn id is already owned by another room");
            }
            touch_room(tx, &message.room_id, message.created_at)?;
            tx.prepare_cached("INSERT INTO archive_turns(id,room_id,started_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO NOTHING")?
                .execute(params![message.turn_id, message.room_id, message.created_at])?;
            upsert_archive_message(tx, message)
        })
    }
    pub(crate) fn archive_turn(&self, turn: &ArchivedTurn) -> Result<()> {
        self.tx(|tx| {
            let existing_turn_room: Option<String> = tx
                .prepare_cached("SELECT room_id FROM archive_turns WHERE id=?1")?
                .query_row([&turn.id], |r| r.get(0))
                .optional()?;
            if existing_turn_room
                .as_deref()
                .is_some_and(|room| room != turn.room_id)
            {
                bail!("turn id is already owned by another room");
            }
            touch_room(tx, &turn.room_id, turn.completed_at.unwrap_or(turn.started_at))?;
            tx.prepare_cached("INSERT INTO archive_turns(id,room_id,started_at,completed_at,metadata) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET room_id=excluded.room_id,started_at=excluded.started_at,completed_at=excluded.completed_at,metadata=excluded.metadata")?
                .execute(params![turn.id,turn.room_id,turn.started_at,turn.completed_at,turn.metadata.to_string()])?;
            tx.prepare_cached("DELETE FROM archive_fts WHERE rowid IN (SELECT rowid FROM archive_messages WHERE turn_id=?1)")?
                .execute([&turn.id])?;
            tx.prepare_cached("DELETE FROM archive_messages WHERE turn_id=?1")?
                .execute([&turn.id])?;
            tx.prepare_cached("DELETE FROM archive_participants WHERE turn_id=?1")?
                .execute([&turn.id])?;
            for participant in &turn.participants {
                tx.prepare_cached("INSERT INTO archive_participants(turn_id,participant_id,role) VALUES(?1,?2,?3)")?
                    .execute(params![turn.id, participant.participant_id, participant.role])?;
            }
            for message in &turn.messages {
                if message.room_id != turn.room_id || message.turn_id != turn.id {
                    bail!("archived message must belong to the enclosing room and turn");
                }
                upsert_archive_message(tx, message)?;
            }
            Ok(())
        })
    }
    /// Apply incremental turn writes atomically (see [`TurnAppend`]).
    pub(crate) fn append_turns(&self, appends: &[TurnAppend]) -> Result<()> {
        self.tx(|tx| {
            for append in appends {
                touch_room(tx, &append.room_id, append.completed_at.unwrap_or(append.started_at))?;
                let changed = tx
                    .prepare_cached("INSERT INTO archive_turns(id,room_id,started_at,completed_at,metadata) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET completed_at=COALESCE(excluded.completed_at,archive_turns.completed_at),metadata=excluded.metadata WHERE archive_turns.room_id=excluded.room_id")?
                    .execute(params![append.turn_id,append.room_id,append.started_at,append.completed_at,append.metadata.to_string()])?;
                if changed == 0 {
                    bail!("turn id is already owned by another room");
                }
                for participant in &append.participants {
                    tx.prepare_cached("INSERT OR IGNORE INTO archive_participants(turn_id,participant_id,role) VALUES(?1,?2,?3)")?
                        .execute(params![append.turn_id, participant.participant_id, participant.role])?;
                }
                for message in &append.messages {
                    if message.room_id != append.room_id || message.turn_id != append.turn_id {
                        bail!("archived message must belong to the enclosing room and turn");
                    }
                    upsert_archive_message(tx, message)?;
                }
                if let Some((state_id, state)) = &append.state_turn {
                    let changed = tx
                        .prepare_cached("INSERT INTO archive_turns(id,room_id,started_at,completed_at,metadata) VALUES(?1,?2,?3,NULL,?4) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata WHERE archive_turns.room_id=excluded.room_id")?
                        .execute(params![state_id, append.room_id, append.started_at, state.to_string()])?;
                    if changed == 0 {
                        bail!("turn id is already owned by another room");
                    }
                }
            }
            Ok(())
        })
    }
    /// All turns and messages of one room in one consistent read.
    pub(crate) fn room_archive(&self, room_id: &str) -> Result<RoomArchive> {
        self.read(|c| {
            let tx = c.unchecked_transaction()?;
            let messages = tx
                .prepare_cached("SELECT id,room_id,turn_id,speaker,content,created_at FROM archive_messages WHERE room_id=?1 ORDER BY created_at,id")?
                .query_map([room_id], message_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let raw = tx
                .prepare_cached("SELECT id,completed_at,metadata FROM archive_turns WHERE room_id=?1 ORDER BY rowid")?
                .query_map([room_id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?, r.get::<_, String>(2)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let turns = raw
                .into_iter()
                .map(|(id, completed_at, metadata)| {
                    let metadata = if matches!(metadata.as_str(), "" | "null" | "{}") {
                        serde_json::Value::Null
                    } else {
                        serde_json::from_str(&metadata).context("decoding archived turn metadata")?
                    };
                    Ok(ArchivedTurnMeta { id, completed_at, metadata })
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(RoomArchive { messages, turns })
        })
    }
    pub(crate) fn search(
        &self,
        caller: &Caller,
        request: &SearchRequest,
    ) -> Result<Vec<SearchResult>> {
        let query_terms = fts_terms(&request.query)?;
        if query_terms.is_empty() || request.limit == 0 {
            return Ok(vec![]);
        }
        let terms = fts_query(&query_terms);
        let limit = request.limit.min(100) as i64;
        let mut allowed = Vec::new();
        for scope in &request.scopes {
            allowed.push(match scope {
                SearchScope::Group => Scope::Group(caller.group_id.clone()),
                SearchScope::Instance => Scope::AgentInstance(caller.agent_instance_id.clone()),
                SearchScope::Persona => Scope::Persona(caller.persona_id.clone()),
                SearchScope::Global => Scope::Hivemind,
                SearchScope::Archive => Scope::Archive(caller.room_id.clone()),
            });
        }
        let mut found = self.read(|c| {
            let mut found = Vec::new();
            for scope in &allowed {
                let (ty, id) = scope.kind_id();
                let pattern = format!("scope_key:\"{}\" AND ({terms})", scope_key(scope));
                let mut q = c.prepare_cached(concat!(
                    "SELECT ",
                    record_cols!(),
                    ",bm25(memory_fts,0.0,1.0,1.0) AS rel FROM memory_fts JOIN memories m ON m.rowid=memory_fts.rowid WHERE memory_fts MATCH ?1 AND m.scope_type=?2 AND m.scope_id=?3 AND (?4=1 OR m.status='active') ORDER BY rel LIMIT ?5"
                ))?;
                let rows = q
                    .query_map(
                        params![pattern, ty, id.as_ref(), i64::from(request.include_historical), limit],
                        |r| Ok((raw_record(r)?, r.get::<_, f64>(16)?)),
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                for (raw, relevance) in rows {
                    let record = decode_record(raw)?;
                    found.push(SearchResult {
                        score: rank_score(relevance, &record),
                        record,
                    });
                }
            }
            if request.scopes.contains(&SearchScope::Archive) {
                let room = &caller.room_id;
                let pattern = format!("room_key:\"{}\" AND ({terms})", hex_key('r', room));
                // bm25 needs document frequencies that cost a scan of every
                // posting list, so it grows with room history. Walk matches
                // newest-first (FTS5 stops early on `ORDER BY rowid DESC LIMIT`)
                // and rank that bounded candidate pool by how many query terms
                // each message contains.
                let pool = limit.max(ARCHIVE_CANDIDATES);
                let mut q = c.prepare_cached("SELECT a.id,a.room_id,a.turn_id,a.speaker,a.content,a.created_at FROM archive_fts JOIN archive_messages a ON a.rowid=archive_fts.rowid WHERE archive_fts MATCH ?1 AND a.room_id=?2 ORDER BY archive_fts.rowid DESC LIMIT ?3")?;
                let rows = q
                    .query_map(params![pattern, room, pool], message_from_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                for msg in rows {
                    // rank_score expects bm25's sign: stronger match = more negative.
                    let relevance = -(matched_terms(&query_terms, &msg.content) as f64);
                    let record = MemoryRecord {
                        id: msg.id.clone(),
                        layer: Layer::Archive,
                        scope: Scope::Archive(msg.room_id.clone()),
                        kind: msg.speaker.clone(),
                        content: msg.content,
                        provenance: Provenance {
                            source_room_id: Some(msg.room_id),
                            source_turn_id: Some(msg.turn_id),
                            source_message_id: Some(msg.id.clone()),
                            source_actor: Some(msg.speaker),
                            source_kind: Some("room_message".into()),
                        },
                        created_at: msg.created_at,
                        updated_at: msg.created_at,
                        status: MemoryStatus::Active,
                        importance: 20,
                        supersedes_memory_id: None,
                    };
                    found.push(SearchResult {
                        score: rank_score(relevance, &record),
                        record,
                    });
                }
            }
            Ok(found)
        })?;
        found.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(Ordering::Equal)
                .then_with(|| a.record.id.cmp(&b.record.id))
        });
        found.truncate(limit as usize);
        Ok(found)
    }
}
