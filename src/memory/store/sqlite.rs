use std::cmp::Ordering;
use std::path::Path;
use std::sync::Mutex;

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

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
/// SQLite-backed canonical records. FTS5 indexes durable memories and archived messages.
pub struct MemoryStore {
    pub(crate) connection: Mutex<Connection>,
}
impl MemoryStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::from_connection(Connection::open(path).context("opening memory database")?)
    }
    pub fn in_memory() -> Result<Self> {
        Self::from_connection(
            Connection::open_in_memory().context("opening in-memory memory database")?,
        )
    }
    pub(in crate::memory) fn from_connection(connection: Connection) -> Result<Self> {
        connection.execute_batch("PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS memories (
              id TEXT PRIMARY KEY, layer TEXT NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL,
              kind TEXT NOT NULL, content TEXT NOT NULL, source_room_id TEXT, source_turn_id TEXT,
              source_message_id TEXT, source_actor TEXT, source_kind TEXT, created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','superseded','archived')),
              importance INTEGER NOT NULL CHECK(importance BETWEEN 0 AND 100), supersedes_memory_id TEXT,
              FOREIGN KEY(supersedes_memory_id) REFERENCES memories(id));
            CREATE INDEX IF NOT EXISTS memories_scope_status ON memories(scope_type, scope_id, status);
            CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, content, kind, tokenize='unicode61');
            CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS archive_turns (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), started_at INTEGER NOT NULL, completed_at INTEGER, metadata TEXT NOT NULL DEFAULT '{}');
            CREATE TABLE IF NOT EXISTS archive_participants (
              turn_id TEXT NOT NULL REFERENCES archive_turns(id) ON DELETE CASCADE, participant_id TEXT NOT NULL,
              role TEXT, PRIMARY KEY(turn_id, participant_id));
            CREATE TABLE IF NOT EXISTS archive_messages (
              id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), turn_id TEXT NOT NULL REFERENCES archive_turns(id),
              speaker TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS archive_room_turn ON archive_messages(room_id, created_at);
            CREATE TABLE IF NOT EXISTS group_state (
              group_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS runtime_epochs (
              id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), instance_id TEXT NOT NULL,
              identity_version INTEGER NOT NULL DEFAULT 0, runtime TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, metadata_json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS memory_revisions (
              revision_id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memories(id), content TEXT NOT NULL,
              provenance_json TEXT NOT NULL, created_at INTEGER NOT NULL, actor TEXT);
            CREATE INDEX IF NOT EXISTS memory_revisions_memory ON memory_revisions(memory_id, created_at);
            CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts USING fts5(id UNINDEXED, room_id UNINDEXED, turn_id UNINDEXED, speaker, content, tokenize='unicode61');")
            .context("initializing memory schema")?;
        let has_identity_version = {
            let mut statement = connection.prepare("PRAGMA table_info(runtime_epochs)")?;
            let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
            columns
                .collect::<rusqlite::Result<Vec<_>>>()?
                .iter()
                .any(|column| column == "identity_version")
        };
        if !has_identity_version {
            connection.execute(
                "ALTER TABLE runtime_epochs ADD COLUMN identity_version INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        connection.execute_batch(
            "CREATE INDEX IF NOT EXISTS runtime_epochs_identity_start ON runtime_epochs(identity_version,instance_id,started_at DESC)",
        )?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
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
        let c = self
            .connection
            .lock()
            .map_err(|_| anyhow!("memory store lock poisoned"))?;
        let mut q = c.prepare(
            "SELECT id FROM memories WHERE scope_type=?1 AND scope_id=?2 ORDER BY created_at,id",
        )?;
        let ids = q
            .query_map(params![kind, id.as_ref()], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.iter()
            .map(|id| load_record(&c, id)?.ok_or_else(|| anyhow!("memory disappeared during read")))
            .collect()
    }
    pub(crate) fn load(&self, id: &str) -> Result<Option<MemoryRecord>> {
        let c = self
            .connection
            .lock()
            .map_err(|_| anyhow!("memory store lock poisoned"))?;
        load_record(&c, id)
    }

    pub(crate) fn insert(&self, record: &MemoryRecord) -> Result<()> {
        let c = self
            .connection
            .lock()
            .map_err(|_| anyhow!("memory store lock poisoned"))?;
        let (scope_type, scope_id) = record.scope.kind_id();
        let tx = c.unchecked_transaction()?;
        if let Some(old) = &record.supersedes_memory_id {
            let old_record = load_record(&tx, old)?
                .ok_or_else(|| anyhow!("superseded memory does not exist"))?;
            if old_record.scope != record.scope || old_record.status != MemoryStatus::Active {
                bail!("only an active memory in the same scope may be superseded");
            }
            tx.execute(
                "UPDATE memories SET status='superseded',updated_at=?2 WHERE id=?1",
                params![old, record.created_at],
            )?;
        }
        tx.execute("INSERT INTO memories(id,layer,scope_type,scope_id,kind,content,source_room_id,source_turn_id,source_message_id,source_actor,source_kind,created_at,updated_at,status,importance,supersedes_memory_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",params![record.id,layer_str(record.layer),scope_type,scope_id.as_ref(),record.kind,record.content,record.provenance.source_room_id,record.provenance.source_turn_id,record.provenance.source_message_id,record.provenance.source_actor,record.provenance.source_kind,record.created_at,record.updated_at,record.status.as_str(),record.importance,record.supersedes_memory_id])?;
        tx.execute(
            "INSERT INTO memory_fts(id,content,kind) VALUES(?1,?2,?3)",
            params![record.id, record.content, record.kind],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn set_status(&self, id: &str, status: MemoryStatus, scope: &Scope) -> Result<()> {
        let c = self
            .connection
            .lock()
            .map_err(|_| anyhow!("memory store lock poisoned"))?;
        let (kind, scope_id) = scope.kind_id();
        let n=c.execute("UPDATE memories SET status=?1,updated_at=?2 WHERE id=?3 AND scope_type=?4 AND scope_id=?5",params![status.as_str(),now(),id,kind,scope_id.as_ref()])?;
        if n == 0 {
            bail!("memory not found in authorized scope");
        }
        Ok(())
    }
    pub(crate) fn update_record(&self, record: &MemoryRecord, actor: &str) -> Result<()> {
        let c = self
            .connection
            .lock()
            .map_err(|_| anyhow!("memory store lock poisoned"))?;
        let tx = c.unchecked_transaction()?;
        let old = load_record(&tx, &record.id)?.ok_or_else(|| anyhow!("memory not found"))?;
        if old.scope != record.scope || old.status != MemoryStatus::Active {
            bail!("only an active record in its original scope can be updated");
        }
        tx.execute("INSERT INTO memory_revisions(revision_id,memory_id,content,provenance_json,created_at,actor) VALUES(?1,?2,?3,?4,?5,?6)",params![new_id(),old.id,old.content,serde_json::to_string(&old.provenance)?,now(),actor])?;
        tx.execute("UPDATE memories SET kind=?1,content=?2,source_room_id=?3,source_turn_id=?4,source_message_id=?5,source_actor=?6,source_kind=?7,updated_at=?8,importance=?9 WHERE id=?10",params![record.kind,record.content,record.provenance.source_room_id,record.provenance.source_turn_id,record.provenance.source_message_id,record.provenance.source_actor,record.provenance.source_kind,record.updated_at,record.importance,record.id])?;
        tx.execute("DELETE FROM memory_fts WHERE id=?1", [&record.id])?;
        tx.execute(
            "INSERT INTO memory_fts(id,content,kind) VALUES(?1,?2,?3)",
            params![record.id, record.content, record.kind],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn archive_message(&self, message: &ArchivedMessage) -> Result<()> {
        let c = self
            .connection
            .lock()
            .map_err(|_| anyhow!("memory store lock poisoned"))?;
        let tx = c.unchecked_transaction()?;
        let existing_turn_room: Option<String> = tx
            .query_row(
                "SELECT room_id FROM archive_turns WHERE id=?1",
                [&message.turn_id],
                |r| r.get(0),
            )
            .optional()?;
        if existing_turn_room
            .as_deref()
            .is_some_and(|room| room != message.room_id)
        {
            bail!("turn id is already owned by another room");
        }
        tx.execute("INSERT INTO rooms(id,name,updated_at) VALUES(?1,'',?2) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at",params![message.room_id,message.created_at])?;
        tx.execute("INSERT INTO archive_turns(id,room_id,started_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO NOTHING",params![message.turn_id,message.room_id,message.created_at])?;
        upsert_archive_message(&tx, message)?;
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn archive_turn(&self, turn: &ArchivedTurn) -> Result<()> {
        let c = self
            .connection
            .lock()
            .map_err(|_| anyhow!("memory store lock poisoned"))?;
        let tx = c.unchecked_transaction()?;
        let existing_turn_room: Option<String> = tx
            .query_row(
                "SELECT room_id FROM archive_turns WHERE id=?1",
                [&turn.id],
                |r| r.get(0),
            )
            .optional()?;
        if existing_turn_room
            .as_deref()
            .is_some_and(|room| room != turn.room_id)
        {
            bail!("turn id is already owned by another room");
        }
        tx.execute("INSERT INTO rooms(id,name,updated_at) VALUES(?1,'',?2) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at",params![turn.room_id,turn.completed_at.unwrap_or(turn.started_at)])?;
        tx.execute("INSERT INTO archive_turns(id,room_id,started_at,completed_at,metadata) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET room_id=excluded.room_id,started_at=excluded.started_at,completed_at=excluded.completed_at,metadata=excluded.metadata",params![turn.id,turn.room_id,turn.started_at,turn.completed_at,turn.metadata.to_string()])?;
        tx.execute(
            "DELETE FROM archive_fts WHERE id IN (SELECT id FROM archive_messages WHERE turn_id=?1)",
            [&turn.id],
        )?;
        tx.execute("DELETE FROM archive_messages WHERE turn_id=?1", [&turn.id])?;
        tx.execute(
            "DELETE FROM archive_participants WHERE turn_id=?1",
            [&turn.id],
        )?;
        for participant in &turn.participants {
            tx.execute(
                "INSERT INTO archive_participants(turn_id,participant_id,role) VALUES(?1,?2,?3)",
                params![turn.id, participant.participant_id, participant.role],
            )?;
        }
        for message in &turn.messages {
            if message.room_id != turn.room_id || message.turn_id != turn.id {
                bail!("archived message must belong to the enclosing room and turn");
            }
            upsert_archive_message(&tx, message)?;
        }
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn search(
        &self,
        caller: &Caller,
        request: &SearchRequest,
    ) -> Result<Vec<SearchResult>> {
        let terms = fts_query(&request.query)?;
        if terms.is_empty() || request.limit == 0 {
            return Ok(vec![]);
        }
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
        let c = self
            .connection
            .lock()
            .map_err(|_| anyhow!("memory store lock poisoned"))?;
        let mut found = Vec::new();
        for scope in allowed {
            let (ty, id) = scope.kind_id();
            let mut q=c.prepare("SELECT m.id,bm25(memory_fts) FROM memory_fts JOIN memories m ON m.id=memory_fts.id WHERE memory_fts MATCH ?1 AND m.scope_type=?2 AND m.scope_id=?3 AND (?4=1 OR m.status='active')")?;
            let rows = q.query_map(
                params![
                    terms,
                    ty,
                    id.as_ref(),
                    i64::from(request.include_historical)
                ],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)),
            )?;
            for row in rows {
                let (id, relevance) = row?;
                if let Some(record) = load_record(&c, &id)? {
                    found.push(SearchResult {
                        score: rank_score(relevance, &record),
                        record,
                    });
                }
            }
        }
        if request.scopes.contains(&SearchScope::Archive) {
            let room = &caller.room_id;
            let mut q=c.prepare("SELECT a.id,bm25(archive_fts) FROM archive_fts JOIN archive_messages a ON a.id=archive_fts.id WHERE archive_fts MATCH ?1 AND a.room_id=?2")?;
            let rows = q.query_map(params![terms, room], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?))
            })?;
            for row in rows {
                let (id, relevance) = row?;
                let msg:ArchivedMessage=c.query_row("SELECT id,room_id,turn_id,speaker,content,created_at FROM archive_messages WHERE id=?1",[id],|r|Ok(ArchivedMessage{id:r.get(0)?,room_id:r.get(1)?,turn_id:r.get(2)?,speaker:r.get(3)?,content:r.get(4)?,created_at:r.get(5)?}))?;
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
        found.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(Ordering::Equal)
                .then_with(|| a.record.id.cmp(&b.record.id))
        });
        found.truncate(request.limit.min(100));
        Ok(found)
    }
}

fn load_record(c: &Connection, id: &str) -> Result<Option<MemoryRecord>> {
    c.query_row("SELECT id,layer,scope_type,scope_id,kind,content,source_room_id,source_turn_id,source_message_id,source_actor,source_kind,created_at,updated_at,status,importance,supersedes_memory_id FROM memories WHERE id=?1",[id],|r|{let layer:String=r.get(1)?;let st:String=r.get(2)?;let si:String=r.get(3)?;let status:String=r.get(13)?;Ok((r.get::<_,String>(0)?,layer,st,si,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,Option<String>>(6)?,r.get::<_,Option<String>>(7)?,r.get::<_,Option<String>>(8)?,r.get::<_,Option<String>>(9)?,r.get::<_,Option<String>>(10)?,r.get::<_,i64>(11)?,r.get::<_,i64>(12)?,status,r.get::<_,u8>(14)?,r.get::<_,Option<String>>(15)?))}).optional()?.map(|x|Ok(MemoryRecord{id:x.0,layer:parse_layer(&x.1)?,scope:Scope::from_parts(&x.2,x.3)?,kind:x.4,content:x.5,provenance:Provenance{source_room_id:x.6,source_turn_id:x.7,source_message_id:x.8,source_actor:x.9,source_kind:x.10},created_at:x.11,updated_at:x.12,status:parse_status(&x.13)?,importance:x.14,supersedes_memory_id:x.15})).transpose()
}
