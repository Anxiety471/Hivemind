use std::{cmp::Ordering, path::Path};

use anyhow::{anyhow, bail, Context, Result};
use crate::db::{ComponentSpec, Database, Dialect, Migration, Options, Row, Session, Step, TableSpec, Target, Value, SQLITE_READERS};
use crate::params;

use super::super::*;

const ARCHIVE_CANDIDATES: i64 = 64;

macro_rules! record_cols {
    () => {
        "m.id,m.layer,m.scope_type,m.scope_id,m.kind,m.content,m.source_room_id,m.source_turn_id,m.source_message_id,m.source_actor,m.source_kind,m.created_at,m.updated_at,m.status,m.importance,m.supersedes_memory_id"
    };
}

type RawRecord = (
    String, String, String, String, String, String, Option<String>, Option<String>, Option<String>,
    Option<String>, Option<String>, i64, i64, String, u8, Option<String>,
);

fn raw_record(row: &Row) -> crate::db::Result<RawRecord> {
    Ok((
        row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?,
        row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?, row.get(11)?,
        row.get(12)?, row.get(13)?, row.get(14)?, row.get(15)?,
    ))
}

fn layer_str(layer: Layer) -> &'static str {
    match layer {
        Layer::RecentConversation => "recent_conversation",
        Layer::Group => "group",
        Layer::Private => "private",
        Layer::Persona => "persona",
        Layer::Global => "global",
        Layer::Archive => "archive",
    }
}

fn parse_layer(value: &str) -> Result<Layer> {
    Ok(match value {
        "recent_conversation" => Layer::RecentConversation,
        "group" => Layer::Group,
        "private" => Layer::Private,
        "persona" => Layer::Persona,
        "global" => Layer::Global,
        "archive" => Layer::Archive,
        _ => bail!("invalid layer {value}"),
    })
}

fn parse_status(value: &str) -> Result<MemoryStatus> {
    Ok(match value {
        "active" => MemoryStatus::Active,
        "superseded" => MemoryStatus::Superseded,
        "archived" => MemoryStatus::Archived,
        _ => bail!("invalid status {value}"),
    })
}

fn decode_record(raw: RawRecord) -> Result<MemoryRecord> {
    Ok(MemoryRecord {
        id: raw.0,
        layer: parse_layer(&raw.1)?,
        scope: Scope::from_parts(&raw.2, raw.3)?,
        kind: raw.4,
        content: raw.5,
        provenance: Provenance {
            source_room_id: raw.6,
            source_turn_id: raw.7,
            source_message_id: raw.8,
            source_actor: raw.9,
            source_kind: raw.10,
        },
        created_at: raw.11,
        updated_at: raw.12,
        status: parse_status(&raw.13)?,
        importance: raw.14,
        supersedes_memory_id: raw.15,
    })
}

fn load_record(session: &Session<'_>, id: &str) -> Result<Option<MemoryRecord>> {
    let raw = session.query_opt(
        concat!("SELECT ", record_cols!(), " FROM memories m WHERE m.id=?1"),
        &params![id],
        raw_record,
    )?;
    raw.map(decode_record).transpose()
}

fn scope_key(scope: &Scope) -> String {
    let (kind, id) = scope.kind_id();
    hex_key('s', &format!("{kind}:{id}"))
}

const MIGRATIONS: [Migration; 1] = [Migration {
    version: 1,
    sqlite: Step::Code(super::sqlite::migrate_v1),
    postgres: Step::Sql(super::postgres::V1),
    mysql: Step::Sql(super::mysql::V1),
}];

/// Canonical memory, runtime epoch, and room archive storage.
pub struct MemoryStore {
    database: Database,
}

impl MemoryStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::connect(&Target::SqliteFile(path.as_ref().to_owned())).context("opening memory database")
    }

    pub fn in_memory() -> Result<Self> {
        let readers = {
            #[cfg(test)]
            if std::env::var("HIVEMIND_TEST_DATABASE_URL").ok().is_some_and(|url| !url.is_empty()) {
                2
            } else {
                0
            }
            #[cfg(not(test))]
            {
                0
            }
        };
        let database = Database::in_memory(
            "memory",
            Options { readers, track_version: true },
        )?;
        Self::from_database(database)
    }

    pub fn connect(target: &Target) -> Result<Self> {
        let readers = match target {
            Target::SqliteFile(_) => SQLITE_READERS,
            Target::Postgres(_) | Target::Mysql(_) => 2,
            Target::SqliteMemory => 0,
        };
        let database = Database::connect(
            target,
            "memory",
            Options { readers, track_version: true },
        )?;
        Self::from_database(database)
    }

    fn from_database(database: Database) -> Result<Self> {
        database.migrate(&MIGRATIONS)?;
        if database.dialect() == Dialect::Sqlite {
            // The legacy initializer has always applied these idempotent
            // has-column patches on every open, including user_version=1 files.
            database.write(super::sqlite::initialize)?;
        }
        Ok(Self { database })
    }

    pub fn database(&self) -> &Database {
        &self.database
    }

    pub fn spec() -> ComponentSpec {
        ComponentSpec { name: "memory", tables: &TABLES, finish }
    }

    pub(crate) fn read<T>(&self, f: impl FnOnce(&Session<'_>) -> Result<T>) -> Result<T> {
        self.database.read(f)
    }

    pub(crate) fn write<T>(&self, f: impl FnOnce(&Session<'_>) -> Result<T>) -> Result<T> {
        self.database.write(f)
    }

    pub(crate) fn tx<T>(&self, f: impl FnOnce(&Session<'_>) -> Result<T>) -> Result<T> {
        self.database.tx(f)
    }

    pub fn data_version(&self) -> Result<i64> {
        Ok(self.database.data_version()?)
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
        let rows = self.read(|session| {
            Ok(session.query_map(
                concat!("SELECT ", record_cols!(), " FROM memories m WHERE m.scope_type=?1 AND m.scope_id=?2 ORDER BY m.created_at,m.id"),
                &params![kind, id.as_ref()],
                raw_record,
            )?)
        })?;
        rows.into_iter().map(decode_record).collect()
    }

    pub(crate) fn load(&self, id: &str) -> Result<Option<MemoryRecord>> {
        self.read(|session| load_record(session, id))
    }

    #[cfg(test)]
    pub(crate) fn insert(&self, record: &MemoryRecord) -> Result<()> {
        self.insert_keyed(record, None)
    }

    /// Insert `record` (superseding its predecessor) and its SQLite FTS row,
    /// and optionally bind an upsert key, in one transaction.
    pub(crate) fn insert_keyed(&self, record: &MemoryRecord, topic_key: Option<&str>) -> Result<()> {
        let (scope_type, scope_id) = record.scope.kind_id();
        self.tx(|session| {
            if let Some(old) = &record.supersedes_memory_id {
                let old_record = load_record(session, old)?
                    .ok_or_else(|| anyhow!("superseded memory does not exist"))?;
                if old_record.scope != record.scope || old_record.status != MemoryStatus::Active {
                    bail!("only an active memory in the same scope may be superseded");
                }
                session.execute(
                    "UPDATE memories SET status='superseded',updated_at=?2 WHERE id=?1",
                    &params![old, record.created_at],
                )?;
            }
            session.execute(
                "INSERT INTO memories(id,layer,scope_type,scope_id,kind,content,source_room_id,source_turn_id,source_message_id,source_actor,source_kind,created_at,updated_at,status,importance,supersedes_memory_id,topic_key) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
                &params![record.id,layer_str(record.layer),scope_type,scope_id.as_ref(),record.kind,record.content,record.provenance.source_room_id,record.provenance.source_turn_id,record.provenance.source_message_id,record.provenance.source_actor,record.provenance.source_kind,record.created_at,record.updated_at,record.status.as_str(),record.importance,record.supersedes_memory_id,topic_key],
            )?;
            insert_memory_fts(session, record)?;
            Ok(())
        })
    }

    pub(crate) fn find_active_by_key(&self, scope: &Scope, key: &str) -> Result<Option<String>> {
        let (kind, scope_id) = scope.kind_id();
        self.read(|session| {
            Ok(session.query_opt(
                "SELECT id FROM memories WHERE scope_type=?1 AND scope_id=?2 AND topic_key=?3 AND status='active'",
                &params![kind, scope_id.as_ref(), key],
                |row| row.get(0),
            )?)
        })
    }

    pub(crate) fn touch_duplicate(
        &self,
        scope: &Scope,
        layer: Layer,
        normalized: &str,
        timestamp: i64,
    ) -> Result<Option<MemoryRecord>> {
        let (kind, scope_id) = scope.kind_id();
        self.tx(|session| {
            let rows = session.query_map(
                "SELECT id,content FROM memories WHERE scope_type=?1 AND scope_id=?2 AND layer=?3 AND status='active'",
                &params![kind, scope_id.as_ref(), layer_str(layer)],
                |row| Ok((row.get::<String>(0)?, row.get::<String>(1)?)),
            )?;
            let Some((id, _)) = rows.into_iter().find(|(_, content)| normalize_content(content) == normalized) else {
                return Ok(None);
            };
            session.execute("UPDATE memories SET updated_at=?2 WHERE id=?1", &params![id, timestamp])?;
            load_record(session, &id)
        })
    }

    pub(crate) fn set_status(&self, id: &str, status: MemoryStatus, scope: &Scope) -> Result<()> {
        let (kind, scope_id) = scope.kind_id();
        let changed = self.write(|session| {
            session.execute(
                "UPDATE memories SET status=?1,updated_at=?2 WHERE id=?3 AND scope_type=?4 AND scope_id=?5",
                &params![status.as_str(), now(), id, kind, scope_id.as_ref()],
            )
        })?;
        if changed == 0 {
            bail!("memory not found in authorized scope");
        }
        Ok(())
    }

    pub(crate) fn update_record(&self, record: &MemoryRecord, actor: &str) -> Result<()> {
        self.tx(|session| {
            let old = load_record(session, &record.id)?.ok_or_else(|| anyhow!("memory not found"))?;
            if old.scope != record.scope || old.status != MemoryStatus::Active {
                bail!("only an active record in its original scope can be updated");
            }
            session.execute(
                "INSERT INTO memory_revisions(revision_id,memory_id,content,provenance_json,created_at,actor) VALUES(?1,?2,?3,?4,?5,?6)",
                &params![new_id(), old.id, old.content, serde_json::to_string(&old.provenance)?, now(), actor],
            )?;
            session.execute(
                "UPDATE memories SET kind=?1,content=?2,source_room_id=?3,source_turn_id=?4,source_message_id=?5,source_actor=?6,source_kind=?7,updated_at=?8,importance=?9 WHERE id=?10",
                &params![record.kind,record.content,record.provenance.source_room_id,record.provenance.source_turn_id,record.provenance.source_message_id,record.provenance.source_actor,record.provenance.source_kind,record.updated_at,record.importance,record.id],
            )?;
            refresh_memory_fts(session, record)?;
            Ok(())
        })
    }

    pub(crate) fn archive_message(&self, message: &ArchivedMessage) -> Result<()> {
        self.tx(|session| {
            let turn_room = session.query_opt(
                "SELECT room_id FROM archive_turns WHERE id=?1",
                &params![message.turn_id],
                |row| row.get::<String>(0),
            )?;
            if turn_room.as_deref().is_some_and(|room| room != message.room_id) {
                bail!("turn id is already owned by another room");
            }
            touch_room(session, &message.room_id, message.created_at)?;
            if turn_room.is_none() {
                insert_archive_turn(session, &message.turn_id, &message.room_id, message.created_at, None, "{}")?;
            }
            upsert_archive_message(session, message)
        })
    }

    pub(crate) fn archive_turn(&self, turn: &ArchivedTurn) -> Result<()> {
        self.tx(|session| {
            let existing_room = session.query_opt(
                "SELECT room_id FROM archive_turns WHERE id=?1",
                &params![turn.id],
                |row| row.get::<String>(0),
            )?;
            if existing_room.as_deref().is_some_and(|room| room != turn.room_id) {
                bail!("turn id is already owned by another room");
            }
            touch_room(session, &turn.room_id, turn.completed_at.unwrap_or(turn.started_at))?;
            if existing_room.is_some() {
                session.execute(
                    "UPDATE archive_turns SET room_id=?1,started_at=?2,completed_at=?3,metadata=?4 WHERE id=?5",
                    &params![turn.room_id, turn.started_at, turn.completed_at, turn.metadata.to_string(), turn.id],
                )?;
            } else {
                insert_archive_turn(session, &turn.id, &turn.room_id, turn.started_at, turn.completed_at, &turn.metadata.to_string())?;
            }
            delete_turn_messages(session, &turn.id)?;
            session.execute("DELETE FROM archive_messages WHERE turn_id=?1", &params![turn.id])?;
            session.execute("DELETE FROM archive_participants WHERE turn_id=?1", &params![turn.id])?;
            for participant in &turn.participants {
                session.execute(
                    "INSERT INTO archive_participants(turn_id,participant_id,role) VALUES(?1,?2,?3)",
                    &params![turn.id, participant.participant_id, participant.role],
                )?;
            }
            for message in &turn.messages {
                if message.room_id != turn.room_id || message.turn_id != turn.id {
                    bail!("archived message must belong to the enclosing room and turn");
                }
                upsert_archive_message(session, message)?;
            }
            Ok(())
        })
    }

    /// Apply incremental turn writes atomically.
    pub(crate) fn append_turns(&self, appends: &[TurnAppend]) -> Result<()> {
        self.tx(|session| {
            for append in appends {
                touch_room(session, &append.room_id, append.completed_at.unwrap_or(append.started_at))?;
                let existing_room = session.query_opt(
                    "SELECT room_id FROM archive_turns WHERE id=?1",
                    &params![append.turn_id],
                    |row| row.get::<String>(0),
                )?;
                if existing_room.as_deref().is_some_and(|room| room != append.room_id) {
                    bail!("turn id is already owned by another room");
                }
                if existing_room.is_some() {
                    session.execute(
                        "UPDATE archive_turns SET completed_at=COALESCE(?1,completed_at),metadata=?2 WHERE id=?3 AND room_id=?4",
                        &params![append.completed_at, append.metadata.to_string(), append.turn_id, append.room_id],
                    )?;
                } else {
                    insert_archive_turn(session, &append.turn_id, &append.room_id, append.started_at, append.completed_at, &append.metadata.to_string())?;
                }
                for participant in &append.participants {
                    let exists = session.exists(
                        "SELECT 1 FROM archive_participants WHERE turn_id=?1 AND participant_id=?2",
                        &params![append.turn_id, participant.participant_id],
                    )?;
                    if !exists {
                        session.execute(
                            "INSERT INTO archive_participants(turn_id,participant_id,role) VALUES(?1,?2,?3)",
                            &params![append.turn_id, participant.participant_id, participant.role],
                        )?;
                    }
                }
                for message in &append.messages {
                    if message.room_id != append.room_id || message.turn_id != append.turn_id {
                        bail!("archived message must belong to the enclosing room and turn");
                    }
                    upsert_archive_message(session, message)?;
                }
                if let Some((state_id, state)) = &append.state_turn {
                    let room = session.query_opt(
                        "SELECT room_id FROM archive_turns WHERE id=?1",
                        &params![state_id],
                        |row| row.get::<String>(0),
                    )?;
                    if room.as_deref().is_some_and(|room| room != append.room_id) {
                        bail!("turn id is already owned by another room");
                    }
                    if room.is_some() {
                        session.execute(
                            "UPDATE archive_turns SET metadata=?1 WHERE id=?2 AND room_id=?3",
                            &params![state.to_string(), state_id, append.room_id],
                        )?;
                    } else {
                        insert_archive_turn(session, state_id, &append.room_id, append.started_at, None, &state.to_string())?;
                    }
                }
            }
            Ok(())
        })
    }

    pub(crate) fn room_archive(&self, room_id: &str) -> Result<RoomArchive> {
        self.database.read_tx(|session| {
            let messages = session.query_map(
                "SELECT id,room_id,turn_id,speaker,content,created_at FROM archive_messages WHERE room_id=?1 ORDER BY created_at,id",
                &params![room_id],
                message_from_row,
            )?;
            let turn_order = if session.dialect() == Dialect::Sqlite { "rowid" } else { "seq" };
            let turns_sql = format!("SELECT id,completed_at,metadata FROM archive_turns WHERE room_id=?1 ORDER BY {turn_order}");
            let raw = session.query_map(&turns_sql, &params![room_id], |row| {
                Ok((row.get::<String>(0)?, row.get::<Option<i64>>(1)?, row.get::<String>(2)?))
            })?;
            let turns = raw.into_iter().map(|(id, completed_at, metadata)| {
                let metadata = if matches!(metadata.as_str(), "" | "null" | "{}") {
                    serde_json::Value::Null
                } else {
                    serde_json::from_str(&metadata).context("decoding archived turn metadata")?
                };
                Ok(ArchivedTurnMeta { id, completed_at, metadata })
            }).collect::<Result<Vec<_>>>()?;
            Ok(RoomArchive { messages, turns })
        })
    }

    pub(crate) fn search(&self, caller: &Caller, request: &SearchRequest) -> Result<Vec<SearchResult>> {
        let query_terms = fts_terms(&request.query)?;
        if query_terms.is_empty() || request.limit == 0 {
            return Ok(Vec::new());
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
        let dialect = self.database.dialect();
        let include_historical = request.include_historical;
        let mut found = self.read(|session| {
            let mut found = Vec::new();
            for scope in &allowed {
                let (kind, id) = scope.kind_id();
                let rows = memory_search_rows(session, dialect, scope, &query_terms, &terms, kind, id.as_ref(), include_historical, limit)?;
                for (raw, relevance) in rows {
                    let record = decode_record(raw)?;
                    if dialect == Dialect::Mysql && matched_terms(&query_terms, &record.content) == 0 {
                        continue;
                    }
                    found.push(SearchResult { score: rank_score(relevance, &record), record });
                }
            }
            if request.scopes.contains(&SearchScope::Archive) {
                // A thread caller also searches its parent room's archive. Walk
                // every covered room with the existing per-room query plan and
                // merge into one ranked result list; `archive_rooms`
                // de-duplicates, so no message is pushed twice.
                let pool = limit.max(ARCHIVE_CANDIDATES);
                for room in archive_rooms(caller) {
                    let messages = archive_search_rows(session, dialect, &room, &query_terms, &terms, pool)?;
                    for message in messages {
                        if dialect == Dialect::Mysql
                            && matched_terms(&query_terms, &format!("{} {}", message.speaker, message.content)) == 0
                        {
                            continue;
                        }
                        let relevance = -(matched_terms(&query_terms, &message.content) as f64);
                        let record = MemoryRecord {
                            id: message.id.clone(),
                            layer: Layer::Archive,
                            scope: Scope::Archive(message.room_id.clone()),
                            kind: message.speaker.clone(),
                            content: message.content,
                            provenance: Provenance {
                                source_room_id: Some(message.room_id),
                                source_turn_id: Some(message.turn_id),
                                source_message_id: Some(message.id.clone()),
                                source_actor: Some(message.speaker),
                                source_kind: Some("room_message".into()),
                            },
                            created_at: message.created_at,
                            updated_at: message.created_at,
                            status: MemoryStatus::Active,
                            importance: 20,
                            supersedes_memory_id: None,
                        };
                        found.push(SearchResult { score: rank_score(relevance, &record), record });
                    }
                }
            }
            Ok(found)
        })?;
        found.sort_by(|a, b| {
            b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal).then_with(|| a.record.id.cmp(&b.record.id))
        });
        found.truncate(limit as usize);
        Ok(found)
    }
}

fn insert_memory_fts(session: &Session<'_>, record: &MemoryRecord) -> Result<()> {
    if session.dialect() == Dialect::Sqlite {
        let rowid: i64 = session.scalar("SELECT rowid FROM memories WHERE id=?1", &params![record.id])?;
        session.execute(
            "INSERT INTO memory_fts(rowid,scope_key,content,kind) VALUES(?1,?2,?3,?4)",
            &params![rowid, scope_key(&record.scope), record.content, record.kind],
        )?;
    }
    Ok(())
}

fn refresh_memory_fts(session: &Session<'_>, record: &MemoryRecord) -> Result<()> {
    if session.dialect() == Dialect::Sqlite {
        let rowid: i64 = session.scalar("SELECT rowid FROM memories WHERE id=?1", &params![record.id])?;
        session.execute("DELETE FROM memory_fts WHERE rowid=?1", &params![rowid])?;
        insert_memory_fts(session, record)?;
    }
    Ok(())
}

fn insert_archive_turn(
    session: &Session<'_>, id: &str, room_id: &str, started_at: i64,
    completed_at: Option<i64>, metadata: &str,
) -> Result<()> {
    session.execute(
        "INSERT INTO archive_turns(id,room_id,started_at,completed_at,metadata) VALUES(?1,?2,?3,?4,?5)",
        &params![id, room_id, started_at, completed_at, metadata],
    )?;
    Ok(())
}

fn delete_turn_messages(session: &Session<'_>, turn_id: &str) -> Result<()> {
    if session.dialect() == Dialect::Sqlite {
        session.execute(
            "DELETE FROM archive_fts WHERE rowid IN (SELECT rowid FROM archive_messages WHERE turn_id=?1)",
            &params![turn_id],
        )?;
    }
    Ok(())
}

fn memory_search_rows(
    session: &Session<'_>, dialect: Dialect, scope: &Scope, query_terms: &[String],
    fts: &str, scope_type: &str, scope_id: &str, include_historical: bool, limit: i64,
) -> Result<Vec<(RawRecord, f64)>> {
    let active_filter = if include_historical { "" } else { " AND m.status='active'" };
    let rows = match dialect {
        Dialect::Sqlite => {
            let pattern = format!("scope_key:\"{}\" AND ({fts})", scope_key(scope));
            let sql = format!(
                "SELECT {},bm25(memory_fts,0.0,1.0,1.0) AS rel FROM memory_fts JOIN memories m ON m.rowid=memory_fts.rowid WHERE memory_fts MATCH ?1 AND m.scope_type=?2 AND m.scope_id=?3{active_filter} ORDER BY rel LIMIT ?4",
                record_cols!(),
            );
            session.query_map(&sql, &params![pattern, scope_type, scope_id, limit], |row| {
                Ok((raw_record(row)?, row.get::<f64>(16)?))
            })?
        }
        Dialect::Postgres => {
            let query = query_terms.join(" | ");
            let sql = format!(
                "SELECT {},-ts_rank(m.search_vector,to_tsquery('simple',?1)) AS rel FROM memories m WHERE m.search_vector @@ to_tsquery('simple',?1) AND m.scope_type=?2 AND m.scope_id=?3{active_filter} ORDER BY rel DESC LIMIT ?4",
                record_cols!(),
            );
            session.query_map(&sql, &params![query, scope_type, scope_id, limit], |row| {
                Ok((raw_record(row)?, row.get::<f64>(16)?))
            })?
        }
        Dialect::Mysql => {
            let mut values = vec![Value::from(query_terms.join(" ")), Value::from(scope_type), Value::from(scope_id), Value::from(limit.max(ARCHIVE_CANDIDATES))];
            let mut short_terms = Vec::new();
            for term in query_terms.iter().filter(|term| term.chars().count() < 3) {
                let index = values.len() + 1;
                values.push(Value::from(format!("%{term}%")));
                short_terms.push(format!("LOWER(m.content) LIKE ?{index} OR LOWER(m.kind) LIKE ?{index}"));
            }
            let mut candidates = vec!["MATCH(m.content,m.kind) AGAINST (?1 IN BOOLEAN MODE)".to_owned()];
            candidates.extend(short_terms);
            let sql = format!(
                "SELECT {},MATCH(m.content,m.kind) AGAINST (?1 IN BOOLEAN MODE) AS rel FROM memories m WHERE ({}) AND m.scope_type=?2 AND m.scope_id=?3{active_filter} ORDER BY rel DESC,m.updated_at DESC,m.id LIMIT ?4",
                record_cols!(), candidates.join(" OR "),
            );
            session.query_map(&sql, &values, |row| Ok((raw_record(row)?, row.get::<f64>(16)?)))?
        }
    };
    Ok(rows)
}

fn archive_search_rows(
    session: &Session<'_>, dialect: Dialect, room: &str, query_terms: &[String],
    fts: &str, pool: i64,
) -> Result<Vec<ArchivedMessage>> {
    match dialect {
        Dialect::Sqlite => {
            let pattern = format!("room_key:\"{}\" AND ({fts})", hex_key('r', room));
            Ok(session.query_map(
                "SELECT a.id,a.room_id,a.turn_id,a.speaker,a.content,a.created_at FROM archive_fts JOIN archive_messages a ON a.rowid=archive_fts.rowid WHERE archive_fts MATCH ?1 AND a.room_id=?2 ORDER BY archive_fts.rowid DESC LIMIT ?3",
                &params![pattern, room, pool],
                message_from_row,
            )?)
        }
        Dialect::Postgres => {
            let query = query_terms.join(" | ");
            Ok(session.query_map(
                "SELECT id,room_id,turn_id,speaker,content,created_at FROM archive_messages WHERE search_vector @@ to_tsquery('simple',?1) AND room_id=?2 ORDER BY created_at DESC,id DESC LIMIT ?3",
                &params![query, room, pool],
                message_from_row,
            )?)
        }
        Dialect::Mysql => {
            let mut values = vec![Value::from(query_terms.join(" ")), Value::from(room), Value::from(pool)];
            let mut short_terms = Vec::new();
            for term in query_terms.iter().filter(|term| term.chars().count() < 3) {
                let index = values.len() + 1;
                values.push(Value::from(format!("%{term}%")));
                short_terms.push(format!("LOWER(a.content) LIKE ?{index} OR LOWER(a.speaker) LIKE ?{index}"));
            }
            let mut candidates = vec!["MATCH(a.speaker,a.content) AGAINST (?1 IN BOOLEAN MODE)".to_owned()];
            candidates.extend(short_terms);
            Ok(session.query_map(
                &format!("SELECT a.id,a.room_id,a.turn_id,a.speaker,a.content,a.created_at FROM archive_messages a WHERE ({}) AND a.room_id=?2 ORDER BY a.created_at DESC,a.id DESC LIMIT ?3", candidates.join(" OR ")),
                &values,
                message_from_row,
            )?)
        }
    }
}


fn finish(database: &Database) -> crate::db::Result<()> {
    match database.dialect() {
        Dialect::Sqlite => database.tx(super::sqlite::finish),
        Dialect::Postgres => database.write(super::postgres::finish),
        Dialect::Mysql => database.write(super::mysql::finish),
    }
}

fn by_id(_: Dialect) -> &'static str { "id" }
fn group_order(_: Dialect) -> &'static str { "group_id" }
fn archive_turn_order(dialect: Dialect) -> &'static str {
    if dialect == Dialect::Sqlite { "rowid" } else { "seq" }
}
fn archive_message_order(_: Dialect) -> &'static str { "room_id,created_at,id" }
fn participant_order(_: Dialect) -> &'static str { "turn_id,participant_id" }
fn revision_order(_: Dialect) -> &'static str { "memory_id,created_at,revision_id" }

const TABLES: [TableSpec; 8] = [
    TableSpec {
        name: "memories",
        columns: &["id","layer","scope_type","scope_id","kind","content","source_room_id","source_turn_id","source_message_id","source_actor","source_kind","created_at","updated_at","status","importance","supersedes_memory_id","topic_key"],
        order_by: by_id,
        serial: None,
        self_reference: Some("supersedes_memory_id"),
    },
    TableSpec {
        name: "rooms",
        columns: &["id","name","updated_at"],
        order_by: by_id,
        serial: None,
        self_reference: None,
    },
    TableSpec {
        name: "runtime_epochs",
        columns: &["id","room_id","instance_id","identity_version","runtime","started_at","ended_at","metadata_json"],
        order_by: by_id,
        serial: None,
        self_reference: None,
    },
    TableSpec {
        name: "group_state",
        columns: &["group_id","state_json","updated_at","updated_by"],
        order_by: group_order,
        serial: None,
        self_reference: None,
    },
    TableSpec {
        name: "archive_turns",
        columns: &["id","room_id","started_at","completed_at","metadata"],
        order_by: archive_turn_order,
        serial: None,
        self_reference: None,
    },
    TableSpec {
        name: "archive_participants",
        columns: &["turn_id","participant_id","role"],
        order_by: participant_order,
        serial: None,
        self_reference: None,
    },
    TableSpec {
        name: "archive_messages",
        columns: &["id","room_id","turn_id","speaker","content","created_at"],
        order_by: archive_message_order,
        serial: None,
        self_reference: None,
    },
    TableSpec {
        name: "memory_revisions",
        columns: &["revision_id","memory_id","content","provenance_json","created_at","actor"],
        order_by: revision_order,
        serial: None,
        self_reference: None,
    },
];
