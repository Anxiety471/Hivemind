//! Deterministic, model-independent durable memory storage and policy.
use std::{
    cmp::Ordering,
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Layer {
    RecentConversation,
    Group,
    Private,
    Persona,
    Global,
    Archive,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "type", content = "id", rename_all = "snake_case")]
pub enum Scope {
    Conversation(String),
    Group(String),
    AgentInstance(String),
    Persona(String),
    Hivemind,
    Archive(String),
}
impl Scope {
    fn kind_id(&self) -> (&'static str, &str) {
        match self {
            Self::Conversation(id) => ("conversation", id),
            Self::Group(id) => ("group", id),
            Self::AgentInstance(id) => ("agent_instance", id),
            Self::Persona(id) => ("persona", id),
            Self::Hivemind => ("hivemind", "hivemind"),
            Self::Archive(id) => ("archive", id),
        }
    }
    fn from_parts(kind: &str, id: String) -> Result<Self> {
        Ok(match kind {
            "conversation" => Self::Conversation(id),
            "group" => Self::Group(id),
            "agent_instance" => Self::AgentInstance(id),
            "persona" => Self::Persona(id),
            "hivemind" if id == "hivemind" => Self::Hivemind,
            "archive" => Self::Archive(id),
            _ => bail!("invalid memory scope {kind}:{id}"),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryStatus {
    Active,
    Superseded,
    Archived,
}
impl MemoryStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Superseded => "superseded",
            Self::Archived => "archived",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Provenance {
    pub source_room_id: Option<String>,
    pub source_turn_id: Option<String>,
    pub source_message_id: Option<String>,
    pub source_actor: Option<String>,
    /// Deterministic source classification used to validate broader proposals.
    pub source_kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryRecord {
    pub id: String,
    pub layer: Layer,
    pub scope: Scope,
    pub kind: String,
    pub content: String,
    pub provenance: Provenance,
    pub created_at: i64,
    pub updated_at: i64,
    pub status: MemoryStatus,
    pub importance: u8,
    pub supersedes_memory_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryWrite {
    pub id: Option<String>,
    pub kind: String,
    pub content: String,
    pub provenance: Provenance,
    pub importance: u8,
    pub supersedes_memory_id: Option<String>,
}

/// Server-created authorization context; never deserialize this from model/tool arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caller {
    pub room_id: String,
    pub group_id: String,
    pub instance_id: String,
    pub persona_id: String,
    pub actor: String,
    pub trusted: bool,
    pub provenance: Provenance,
    authorized_global_proposal: Option<UserAuthorizedGlobalProposal>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
struct UserAuthorizedGlobalProposal {
    exact_content: String,
    provenance: Provenance,
}
pub type AccessContext = Caller;
impl Caller {
    /// Build an invocation context from host-resolved room and agent identity.
    pub fn agent(
        room_id: impl Into<String>,
        group_id: impl Into<String>,
        instance_id: impl Into<String>,
        persona_id: impl Into<String>,
        actor: impl Into<String>,
    ) -> Self {
        Self {
            room_id: room_id.into(),
            group_id: group_id.into(),
            instance_id: instance_id.into(),
            persona_id: persona_id.into(),
            actor: actor.into(),
            trusted: false,
            provenance: Provenance::default(),
            authorized_global_proposal: None,
        }
    }
    pub fn trusted_user(actor: impl Into<String>) -> Self {
        Self {
            room_id: String::new(),
            group_id: String::new(),
            instance_id: String::new(),
            persona_id: String::new(),
            actor: actor.into(),
            trusted: true,
            provenance: Provenance::default(),
            authorized_global_proposal: None,
        }
    }
    pub fn with_provenance(mut self, provenance: Provenance) -> Self {
        self.provenance = provenance;
        self
    }
    /// Bind one exact global-memory proposal to a parsed, structured user instruction.
    /// Call only for host-validated events; never pass model/tool arguments here.
    pub fn authorize_global_proposal_from_user_event(
        mut self,
        exact_content: impl Into<String>,
        provenance: Provenance,
    ) -> Result<Self> {
        let exact_content = exact_content.into();
        if exact_content.trim().is_empty() || exact_content.chars().count() > 16_384 {
            bail!("authorized global content must contain 1 to 16384 characters");
        }
        if provenance.source_kind.as_deref() != Some("explicit_user_instruction")
            || (provenance.source_turn_id.is_none() && provenance.source_message_id.is_none())
        {
            bail!("global authorization requires a structured user instruction with canonical provenance");
        }
        self.authorized_global_proposal = Some(UserAuthorizedGlobalProposal { exact_content, provenance });
        Ok(self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchScope {
    Group,
    Instance,
    Persona,
    Global,
    Archive,
}
#[derive(Debug, Clone)]
pub struct SearchRequest {
    pub query: String,
    pub scopes: Vec<SearchScope>,
    pub limit: usize,
    pub include_historical: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub record: MemoryRecord,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchivedMessage {
    pub id: String,
    pub room_id: String,
    pub turn_id: String,
    pub speaker: String,
    pub content: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchiveParticipant {
    pub participant_id: String,
    pub role: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchivedTurn {
    pub id: String,
    pub room_id: String,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub metadata: serde_json::Value,
    pub participants: Vec<ArchiveParticipant>,
    pub messages: Vec<ArchivedMessage>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GroupStateRecord {
    pub group_id: String,
    pub state: serde_json::Value,
    pub updated_at: i64,
    pub updated_by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RuntimeEpoch {
    pub id: String,
    pub room_id: String,
    pub instance_id: String,
    pub runtime: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub metadata: serde_json::Value,
}

/// SQLite-backed canonical records. FTS5 indexes durable memories and archived messages.
pub struct MemoryStore {
    connection: Mutex<Connection>,
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
    fn from_connection(connection: Connection) -> Result<Self> {
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
              runtime TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, metadata_json TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS runtime_epochs_instance_start ON runtime_epochs(instance_id, started_at DESC);
            CREATE TABLE IF NOT EXISTS memory_revisions (
              revision_id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memories(id), content TEXT NOT NULL,
              provenance_json TEXT NOT NULL, created_at INTEGER NOT NULL, actor TEXT);
            CREATE INDEX IF NOT EXISTS memory_revisions_memory ON memory_revisions(memory_id, created_at);
            CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts USING fts5(id UNINDEXED, room_id UNINDEXED, turn_id UNINDEXED, speaker, content, tokenize='unicode61');")
            .context("initializing memory schema")?;
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
            .query_map(params![kind, id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.iter()
            .map(|id| load_record(&c, id)?.ok_or_else(|| anyhow!("memory disappeared during read")))
            .collect()
    }
    fn load(&self, id: &str) -> Result<Option<MemoryRecord>> {
        let c = self
            .connection
            .lock()
            .map_err(|_| anyhow!("memory store lock poisoned"))?;
        load_record(&c, id)
    }

    fn insert(&self, record: &MemoryRecord) -> Result<()> {
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
        tx.execute("INSERT INTO memories(id,layer,scope_type,scope_id,kind,content,source_room_id,source_turn_id,source_message_id,source_actor,source_kind,created_at,updated_at,status,importance,supersedes_memory_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",params![record.id,layer_str(record.layer),scope_type,scope_id,record.kind,record.content,record.provenance.source_room_id,record.provenance.source_turn_id,record.provenance.source_message_id,record.provenance.source_actor,record.provenance.source_kind,record.created_at,record.updated_at,record.status.as_str(),record.importance,record.supersedes_memory_id])?;
        tx.execute(
            "INSERT INTO memory_fts(id,content,kind) VALUES(?1,?2,?3)",
            params![record.id, record.content, record.kind],
        )?;
        tx.commit()?;
        Ok(())
    }
    fn set_status(&self, id: &str, status: MemoryStatus, scope: &Scope) -> Result<()> {
        let c = self
            .connection
            .lock()
            .map_err(|_| anyhow!("memory store lock poisoned"))?;
        let (kind, scope_id) = scope.kind_id();
        let n=c.execute("UPDATE memories SET status=?1,updated_at=?2 WHERE id=?3 AND scope_type=?4 AND scope_id=?5",params![status.as_str(),now(),id,kind,scope_id])?;
        if n == 0 {
            bail!("memory not found in authorized scope");
        }
        Ok(())
    }
    fn update_record(&self, record: &MemoryRecord, actor: &str) -> Result<()> {
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
    fn archive_message(&self, message: &ArchivedMessage) -> Result<()> {
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
    fn archive_turn(&self, turn: &ArchivedTurn) -> Result<()> {
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
    fn search(&self, caller: &Caller, request: &SearchRequest) -> Result<Vec<SearchResult>> {
        let terms = fts_query(&request.query)?;
        if terms.is_empty() || request.limit == 0 {
            return Ok(vec![]);
        }
        let mut allowed = Vec::new();
        for scope in &request.scopes {
            allowed.push(match scope {
                SearchScope::Group => Scope::Group(caller.group_id.clone()),
                SearchScope::Instance => Scope::AgentInstance(caller.instance_id.clone()),
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
                params![terms, ty, id, i64::from(request.include_historical)],
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

/// Policy-checked operations exposed to the future single tool bridge.
pub struct MemoryService {
    store: MemoryStore,
}
impl MemoryService {
    pub fn new(store: MemoryStore) -> Self {
        Self { store }
    }
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Ok(Self::new(MemoryStore::open(path)?))
    }
    pub fn store(&self) -> &MemoryStore {
        &self.store
    }
    pub fn add_private(&self, caller: &Caller, write: MemoryWrite) -> Result<MemoryRecord> {
        self.accept(
            caller,
            Scope::AgentInstance(caller.instance_id.clone()),
            Layer::Private,
            write,
            false,
        )
    }
    pub fn add_group(&self, caller: &Caller, write: MemoryWrite) -> Result<MemoryRecord> {
        self.accept(
            caller,
            Scope::Group(caller.group_id.clone()),
            Layer::Group,
            write,
            false,
        )
    }
    pub fn propose_persona(&self, caller: &Caller, write: MemoryWrite) -> Result<MemoryRecord> {
        self.accept(
            caller,
            Scope::Persona(caller.persona_id.clone()),
            Layer::Persona,
            write,
            true,
        )
    }
    pub fn propose_global(&self, caller: &Caller, write: MemoryWrite) -> Result<MemoryRecord> {
        self.accept(caller, Scope::Hivemind, Layer::Global, write, true)
    }
    fn accept(
        &self,
        caller: &Caller,
        scope: Scope,
        layer: Layer,
        mut write: MemoryWrite,
        broad: bool,
    ) -> Result<MemoryRecord> {
        if !caller.trusted
            && (caller.room_id.is_empty()
                || caller.instance_id.is_empty()
                || caller.persona_id.is_empty()
                || caller.actor.is_empty())
        {
            bail!("caller lacks server-established identity");
        }
        if matches!(&scope, Scope::Group(group) if group.is_empty()) {
            bail!("group memory requires an authorized group");
        }
        write.provenance = effective_provenance(caller, &write.content, write.provenance);
        validate_write(&write)?;
        if broad {
            validate_broad_proposal(caller, &scope, &write)?;
        }
        let timestamp = now();
        let record = MemoryRecord {
            id: write.id.unwrap_or_else(new_id),
            layer,
            scope,
            kind: write.kind,
            content: write.content,
            provenance: normalized_provenance(caller, write.provenance),
            created_at: timestamp,
            updated_at: timestamp,
            status: MemoryStatus::Active,
            importance: write.importance.min(100),
            supersedes_memory_id: write.supersedes_memory_id,
        };
        self.store.insert(&record)?;
        Ok(record)
    }
    pub fn archive(&self, caller: &Caller, id: &str) -> Result<()> {
        let r = self
            .store
            .load(id)?
            .ok_or_else(|| anyhow!("memory not found"))?;
        ensure_can_access(caller, &r.scope)?;
        if !caller.trusted && matches!(r.layer, Layer::Persona | Layer::Global) {
            bail!("only a trusted caller may archive persona or global memory");
        }
        self.store.set_status(id, MemoryStatus::Archived, &r.scope)
    }
    pub fn update_private(
        &self,
        caller: &Caller,
        id: &str,
        write: MemoryWrite,
    ) -> Result<MemoryRecord> {
        self.update(caller, id, write, Layer::Private)
    }
    pub fn update_group(
        &self,
        caller: &Caller,
        id: &str,
        write: MemoryWrite,
    ) -> Result<MemoryRecord> {
        self.update(caller, id, write, Layer::Group)
    }
    pub fn update_persona(
        &self,
        caller: &Caller,
        id: &str,
        write: MemoryWrite,
    ) -> Result<MemoryRecord> {
        self.update(caller, id, write, Layer::Persona)
    }
    pub fn update_global(
        &self,
        caller: &Caller,
        id: &str,
        write: MemoryWrite,
    ) -> Result<MemoryRecord> {
        self.update(caller, id, write, Layer::Global)
    }
    fn update(
        &self,
        caller: &Caller,
        id: &str,
        mut write: MemoryWrite,
        expected: Layer,
    ) -> Result<MemoryRecord> {
        write.provenance = effective_provenance(caller, &write.content, write.provenance);
        validate_write(&write)?;
        let mut record = self
            .store
            .load(id)?
            .ok_or_else(|| anyhow!("memory not found"))?;
        ensure_can_access(caller, &record.scope)?;
        if record.layer != expected {
            bail!("memory is not in the requested layer");
        }
        if matches!(expected, Layer::Persona | Layer::Global) {
            validate_broad_proposal(caller, &record.scope, &write)?;
        }
        record.kind = write.kind;
        record.content = write.content;
        record.importance = write.importance.min(100);
        record.provenance = normalized_provenance(caller, write.provenance);
        record.updated_at = now();
        self.store.update_record(&record, &caller.actor)?;
        Ok(record)
    }
    pub fn search(&self, caller: &Caller, request: &SearchRequest) -> Result<Vec<SearchResult>> {
        if request.scopes.is_empty() {
            bail!("at least one search scope is required");
        }
        if request.scopes.contains(&SearchScope::Group) && caller.group_id.is_empty()
            || request.scopes.contains(&SearchScope::Instance) && caller.instance_id.is_empty()
            || request.scopes.contains(&SearchScope::Persona) && caller.persona_id.is_empty()
            || request.scopes.contains(&SearchScope::Archive) && caller.room_id.is_empty()
        {
            bail!("caller lacks identity for requested scope");
        }
        self.store.search(caller, request)
    }
    /// Replace structured state for the caller's current group only.
    pub fn set_group_state(&self, caller: &Caller, state: serde_json::Value) -> Result<GroupStateRecord> {
        if caller.group_id.is_empty() { bail!("group state requires a current group"); }
        let record = GroupStateRecord { group_id: caller.group_id.clone(), state, updated_at: now(), updated_by: caller.actor.clone() };
        let c = self.store.connection.lock().map_err(|_| anyhow!("memory store lock poisoned"))?;
        c.execute("INSERT INTO group_state(group_id,state_json,updated_at,updated_by) VALUES(?1,?2,?3,?4) ON CONFLICT(group_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by",params![record.group_id,record.state.to_string(),record.updated_at,record.updated_by])?;
        Ok(record)
    }
    /// Read structured state from the caller's current group only.
    pub fn group_state(&self, caller: &Caller) -> Result<Option<GroupStateRecord>> {
        if caller.group_id.is_empty() { bail!("group state requires a current group"); }
        let c = self.store.connection.lock().map_err(|_| anyhow!("memory store lock poisoned"))?;
        let row = c.query_row("SELECT group_id,state_json,updated_at,updated_by FROM group_state WHERE group_id=?1",[&caller.group_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,String>(3)?))).optional()?;
        row.map(|(group_id,state,updated_at,updated_by)|Ok(GroupStateRecord{group_id,state:serde_json::from_str(&state).context("decoding group state")?,updated_at,updated_by})).transpose()
    }
    /// Start a runtime epoch for this invocation's room and agent instance.
    pub fn start_runtime_epoch(&self, caller: &Caller, runtime: &str, metadata: serde_json::Value) -> Result<RuntimeEpoch> {
        if caller.room_id.is_empty() || caller.instance_id.is_empty() || runtime.trim().is_empty() { bail!("runtime epoch requires room, instance, and runtime"); }
        let epoch = RuntimeEpoch { id:new_id(), room_id:caller.room_id.clone(), instance_id:caller.instance_id.clone(), runtime:runtime.into(), started_at:now(), ended_at:None, metadata };
        let c = self.store.connection.lock().map_err(|_| anyhow!("memory store lock poisoned"))?;
        c.execute("INSERT INTO rooms(id,name,updated_at) VALUES(?1,'',?2) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at",params![epoch.room_id,epoch.started_at])?;
        c.execute("INSERT INTO runtime_epochs(id,room_id,instance_id,runtime,started_at,ended_at,metadata_json) VALUES(?1,?2,?3,?4,?5,NULL,?6)",params![epoch.id,epoch.room_id,epoch.instance_id,epoch.runtime,epoch.started_at,epoch.metadata.to_string()])?;
        Ok(epoch)
    }
    /// Close an epoch only when it belongs to the caller's room and instance.
    pub fn end_runtime_epoch(&self, caller: &Caller, id: &str, ended_at: i64) -> Result<RuntimeEpoch> {
        let c = self.store.connection.lock().map_err(|_| anyhow!("memory store lock poisoned"))?;
        let mut epoch = load_runtime_epoch(&c,id)?.ok_or_else(||anyhow!("runtime epoch not found"))?;
        if epoch.room_id!=caller.room_id || epoch.instance_id!=caller.instance_id { bail!("unauthorized runtime epoch"); }
        if epoch.ended_at.is_some() || ended_at<epoch.started_at { bail!("runtime epoch is already closed or end time precedes start"); }
        let changed=c.execute("UPDATE runtime_epochs SET ended_at=?1 WHERE id=?2 AND ended_at IS NULL",params![ended_at,id])?;
        if changed!=1 { bail!("runtime epoch was concurrently closed"); }
        epoch.ended_at=Some(ended_at);
        Ok(epoch)
    }
    /// List only the caller's epochs, newest first, with an enforced bound.
    pub fn runtime_epochs(&self, caller: &Caller, limit: usize) -> Result<Vec<RuntimeEpoch>> {
        if caller.room_id.is_empty() || caller.instance_id.is_empty() { bail!("runtime epoch listing requires room and instance"); }
        let c=self.store.connection.lock().map_err(|_|anyhow!("memory store lock poisoned"))?;
        let mut q=c.prepare("SELECT id FROM runtime_epochs WHERE room_id=?1 AND instance_id=?2 ORDER BY started_at DESC,id DESC LIMIT ?3")?;
        let ids=q.query_map(params![caller.room_id,caller.instance_id,limit.min(100) as i64],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        ids.iter().map(|id|load_runtime_epoch(&c,id)?.ok_or_else(||anyhow!("runtime epoch disappeared during read"))).collect()
    }
    /// Append canonical L7 room messages. This does not create/promote a memory record.
    pub fn append_room_message(&self, caller: &Caller, message: ArchivedMessage) -> Result<()> {
        if !caller.trusted && message.room_id != caller.room_id {
            bail!("cannot append a message outside the caller's room");
        }
        if message.id.is_empty()
            || message.room_id.is_empty()
            || message.turn_id.is_empty()
            || message.content.trim().is_empty()
            || message.speaker.trim().is_empty()
        {
            bail!("archive message requires id, room, turn, speaker, and content");
        }
        self.store.archive_message(&message)
    }
    /// Insert or upsert a complete L7 turn, participants, and messages atomically.
    pub fn append_archive_turn(&self, caller: &Caller, turn: ArchivedTurn) -> Result<()> {
        if !caller.trusted && turn.room_id != caller.room_id {
            bail!("cannot append a turn outside the caller's room");
        }
        if turn.id.is_empty() || turn.room_id.is_empty() {
            bail!("archive turn requires id and room");
        }
        if turn
            .participants
            .iter()
            .any(|p| p.participant_id.trim().is_empty())
        {
            bail!("archive participants require an id");
        }
        for message in &turn.messages {
            if message.id.is_empty()
                || message.speaker.trim().is_empty()
                || message.content.trim().is_empty()
            {
                bail!("archive messages require id, speaker, and content");
            }
            if message.room_id != turn.room_id || message.turn_id != turn.id {
                bail!("each archived message must belong to the supplied turn");
            }
        }
        self.store.archive_turn(&turn)
    }
    pub fn archive_turn(
        &self,
        caller: &Caller,
        room_id: &str,
        turn_id: &str,
    ) -> Result<Option<ArchivedTurn>> {
        if !caller.trusted && room_id != caller.room_id {
            bail!("cannot read another room archive");
        }
        let c = self
            .store
            .connection
            .lock()
            .map_err(|_| anyhow!("memory store lock poisoned"))?;
        let row = c.query_row(
            "SELECT id,room_id,started_at,completed_at,metadata FROM archive_turns WHERE id=?1 AND room_id=?2",
            params![turn_id, room_id],
            |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,Option<i64>>(3)?,r.get::<_,String>(4)?)),
        ).optional()?;
        let Some((id, room_id, started_at, completed_at, metadata)) = row else {
            return Ok(None);
        };
        let metadata =
            serde_json::from_str(&metadata).context("decoding archived turn metadata")?;
        let mut q=c.prepare("SELECT participant_id,role FROM archive_participants WHERE turn_id=?1 ORDER BY participant_id")?;
        let participants = q
            .query_map([turn_id], |r| {
                Ok(ArchiveParticipant {
                    participant_id: r.get(0)?,
                    role: r.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut q=c.prepare("SELECT id,room_id,turn_id,speaker,content,created_at FROM archive_messages WHERE turn_id=?1 ORDER BY created_at,id")?;
        let messages = q
            .query_map([turn_id], |r| {
                Ok(ArchivedMessage {
                    id: r.get(0)?,
                    room_id: r.get(1)?,
                    turn_id: r.get(2)?,
                    speaker: r.get(3)?,
                    content: r.get(4)?,
                    created_at: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Some(ArchivedTurn {
            id,
            room_id,
            started_at,
            completed_at,
            metadata,
            participants,
            messages,
        }))
    }
    pub fn recent_messages(
        &self,
        caller: &Caller,
        room_id: &str,
        turn_limit: usize,
    ) -> Result<Vec<ArchivedMessage>> {
        if !caller.trusted && room_id != caller.room_id {
            bail!("cannot read another room archive");
        }
        let c = self
            .store
            .connection
            .lock()
            .map_err(|_| anyhow!("memory store lock poisoned"))?;
        let mut q=c.prepare("SELECT id,room_id,turn_id,speaker,content,created_at FROM archive_messages WHERE room_id=?1 ORDER BY created_at DESC,id DESC")?;
        let rows = q.query_map([room_id], |r| {
            Ok(ArchivedMessage {
                id: r.get(0)?,
                room_id: r.get(1)?,
                turn_id: r.get(2)?,
                speaker: r.get(3)?,
                content: r.get(4)?,
                created_at: r.get(5)?,
            })
        })?;
        let all = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut turns = Vec::new();
        let mut out = Vec::new();
        for message in all {
            if !turns.contains(&message.turn_id) {
                if turns.len() >= turn_limit {
                    break;
                }
                turns.push(message.turn_id.clone());
            }
            out.push(message);
        }
        out.reverse();
        Ok(out)
    }
}

fn upsert_archive_message(c: &Connection, message: &ArchivedMessage) -> Result<()> {
    let turn_room: Option<String> = c
        .query_row(
            "SELECT room_id FROM archive_turns WHERE id=?1",
            [&message.turn_id],
            |r| r.get(0),
        )
        .optional()?;
    if turn_room.as_deref() != Some(message.room_id.as_str()) {
        bail!("message turn does not belong to its room");
    }
    let existing_message_room: Option<String> = c
        .query_row(
            "SELECT room_id FROM archive_messages WHERE id=?1",
            [&message.id],
            |r| r.get(0),
        )
        .optional()?;
    if existing_message_room
        .as_deref()
        .is_some_and(|room| room != message.room_id)
    {
        bail!("message id is already owned by another room");
    }
    c.execute("DELETE FROM archive_fts WHERE id=?1", [&message.id])?;
    c.execute("INSERT INTO archive_messages(id,room_id,turn_id,speaker,content,created_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET room_id=excluded.room_id,turn_id=excluded.turn_id,speaker=excluded.speaker,content=excluded.content,created_at=excluded.created_at",params![message.id,message.room_id,message.turn_id,message.speaker,message.content,message.created_at])?;
    c.execute(
        "INSERT INTO archive_fts(id,room_id,turn_id,speaker,content) VALUES(?1,?2,?3,?4,?5)",
        params![
            message.id,
            message.room_id,
            message.turn_id,
            message.speaker,
            message.content
        ],
    )?;
    Ok(())
}

fn load_runtime_epoch(c: &Connection, id: &str) -> Result<Option<RuntimeEpoch>> {
    c.query_row(
        "SELECT id,room_id,instance_id,runtime,started_at,ended_at,metadata_json FROM runtime_epochs WHERE id=?1",
        [id],
        |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,i64>(4)?,r.get::<_,Option<i64>>(5)?,r.get::<_,String>(6)?)),
    ).optional()?
      .map(|(id,room_id,instance_id,runtime,started_at,ended_at,metadata)| Ok(RuntimeEpoch {
          id, room_id, instance_id, runtime, started_at, ended_at,
          metadata: serde_json::from_str(&metadata).context("decoding runtime epoch metadata")?,
      })).transpose()
}
fn ensure_can_access(caller: &Caller, scope: &Scope) -> Result<()> {
    let ok = caller.trusted
        || match scope {
            Scope::Group(x) => !caller.group_id.is_empty() && x == &caller.group_id,
            Scope::Archive(x) | Scope::Conversation(x) => x == &caller.room_id,
            Scope::AgentInstance(x) => x == &caller.instance_id,
            Scope::Persona(x) => x == &caller.persona_id,
            Scope::Hivemind => true,
        };
    if !ok {
        bail!("unauthorized memory scope");
    }
    Ok(())
}
fn validate_write(w: &MemoryWrite) -> Result<()> {
    if w.content.trim().is_empty() {
        bail!("memory content cannot be empty");
    }
    if w.content.chars().count() > 16_384 {
        bail!("memory content exceeds 16384 characters");
    }
    if w.kind.trim().is_empty() || w.kind.chars().count() > 100 {
        bail!("memory kind must contain 1 to 100 characters");
    }
    if w.id
        .as_ref()
        .is_some_and(|id| id.is_empty() || id.len() > 200)
    {
        bail!("memory id must contain 1 to 200 bytes");
    }
    Ok(())
}
fn validate_broad_proposal(caller: &Caller, scope: &Scope, w: &MemoryWrite) -> Result<()> {
    let text = w.content.to_lowercase();
    let transient = [
        "my task",
        "i am assigned",
        "i'm assigned",
        "in this room",
        "in our room",
        "today",
        "temporary",
        "private note",
        "secret",
        "password",
        "token",
        "api key",
    ];
    if transient.iter().any(|x| text.contains(x)) {
        bail!("proposal contains room-specific, transient, or sensitive content");
    }
    let global_user_authorized = matches!(scope, Scope::Hivemind)
        && caller.authorized_global_proposal.as_ref().is_some_and(|authorization| {
            authorization.exact_content.trim() == w.content.trim()
                && authorization.provenance.source_kind.as_deref() == Some("explicit_user_instruction")
        });
    let general = match scope {
        Scope::Persona(_) => [
            "prefer",
            "preference",
            "experienced",
            "familiar",
            "skill",
            "specialist",
            "knowledge",
            "style",
        ]
        .iter()
        .any(|x| text.contains(x)),
        Scope::Hivemind => {
            global_user_authorized
                || [
                    "project", "hivemind", "architecture", "system-wide", "global", "core",
                    "all agents", "runtime", "rust", "decision",
                ]
                .iter()
                .any(|x| text.contains(x))
        },
        _ => false,
    };
    if !general {
        bail!("proposal does not meet deterministic scope relevance policy");
    }
    let provenance = if matches!(scope, Scope::Hivemind) && !caller.trusted {
        global_user_authorized.then(|| &caller.authorized_global_proposal.as_ref().unwrap().provenance)
    } else {
        Some(&caller.provenance)
    };
    let provenance_ok = caller.trusted || provenance.is_some_and(|p| {
        p.source_room_id.is_some() || p.source_turn_id.is_some() || p.source_message_id.is_some()
    });
    let trusted_source = caller.trusted || match scope {
        Scope::Persona(_) => caller.provenance.source_kind.as_deref().is_some_and(|s| {
            matches!(s, "agent_proposal" | "explicit_user_instruction" | "configuration" | "structured_project_event" | "accepted_decision")
        }),
        Scope::Hivemind => global_user_authorized,
        _ => false,
    };
    if !trusted_source {
        bail!("broader-scope proposal lacks an allowed deterministic source");
    }
    if !provenance_ok {
        bail!("broader-scope proposals require canonical provenance");
    }
    if let Scope::Persona(id) = scope {
        if !caller.trusted && id != &caller.persona_id {
            bail!("cannot propose for another persona");
        }
    }
    Ok(())
}
fn effective_provenance(caller: &Caller, content: &str, supplied: Provenance) -> Provenance {
    if let Some(authorization) = caller.authorized_global_proposal.as_ref().filter(|authorization| {
        authorization.exact_content.trim() == content.trim()
            && authorization.provenance.source_kind.as_deref() == Some("explicit_user_instruction")
    }) {
        return authorization.provenance.clone();
    }
    operation_provenance(caller, supplied)
}
fn operation_provenance(caller: &Caller, mut supplied: Provenance) -> Provenance {
    let trusted = &caller.provenance;
    if trusted.source_room_id.is_some() {
        supplied.source_room_id.clone_from(&trusted.source_room_id);
    }
    if trusted.source_turn_id.is_some() {
        supplied.source_turn_id.clone_from(&trusted.source_turn_id);
    }
    if trusted.source_message_id.is_some() {
        supplied
            .source_message_id
            .clone_from(&trusted.source_message_id);
    }
    if trusted.source_actor.is_some() {
        supplied.source_actor.clone_from(&trusted.source_actor);
    }
    if trusted.source_kind.is_some() {
        supplied.source_kind.clone_from(&trusted.source_kind);
    }
    supplied
}

fn normalized_provenance(caller: &Caller, mut provenance: Provenance) -> Provenance {
    if provenance.source_actor.is_none() {
        provenance.source_actor = Some(caller.actor.clone());
    }
    provenance
}
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
fn load_record(c: &Connection, id: &str) -> Result<Option<MemoryRecord>> {
    c.query_row("SELECT id,layer,scope_type,scope_id,kind,content,source_room_id,source_turn_id,source_message_id,source_actor,source_kind,created_at,updated_at,status,importance,supersedes_memory_id FROM memories WHERE id=?1",[id],|r|{let layer:String=r.get(1)?;let st:String=r.get(2)?;let si:String=r.get(3)?;let status:String=r.get(13)?;Ok((r.get::<_,String>(0)?,layer,st,si,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,Option<String>>(6)?,r.get::<_,Option<String>>(7)?,r.get::<_,Option<String>>(8)?,r.get::<_,Option<String>>(9)?,r.get::<_,Option<String>>(10)?,r.get::<_,i64>(11)?,r.get::<_,i64>(12)?,status,r.get::<_,u8>(14)?,r.get::<_,Option<String>>(15)?))}).optional()?.map(|x|Ok(MemoryRecord{id:x.0,layer:parse_layer(&x.1)?,scope:Scope::from_parts(&x.2,x.3)?,kind:x.4,content:x.5,provenance:Provenance{source_room_id:x.6,source_turn_id:x.7,source_message_id:x.8,source_actor:x.9,source_kind:x.10},created_at:x.11,updated_at:x.12,status:parse_status(&x.13)?,importance:x.14,supersedes_memory_id:x.15})).transpose()
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
fn new_id() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    let sequence = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    // Time-first, fixed-width ids keep archive ordering deterministic and let
    // rows sort chronologically by id. The per-process sequence plus pid makes
    // ids unique across concurrent Hivemind processes, which previously
    // collided when either minted a runtime epoch within the same second.
    format!("memory-{nanos:020}-{sequence:06}-{}", std::process::id())
}
fn fts_query(query: &str) -> Result<String> {
    if query.chars().count() > 512 {
        bail!("search query exceeds 512 characters");
    }
    // OR-join every token so FTS5/bm25 can rank partial matches: a natural
    // question such as "what websocket authentication do you know?" must still
    // retrieve a record that only shares some of its terms, instead of
    // requiring every token to be present.
    Ok(query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|x| !x.is_empty())
        .map(|x| format!("\"{}\"", x.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" OR "))
}
fn rank_score(bm25: f64, r: &MemoryRecord) -> f64 {
    let relevance = (-bm25 * 1_000_000.0).clamp(0.0, 1.0);
    let age_days = ((now() - r.updated_at).max(0) as f64) / 86400.0;
    let recency = 1.0 / (1.0 + age_days / 30.0);
    let scope = match r.layer {
        Layer::Private => 0.45,
        Layer::Group => 0.4,
        Layer::Persona => 0.3,
        Layer::Global => 0.2,
        Layer::Archive => 0.1,
        Layer::RecentConversation => 0.5,
    };
    relevance
        + f64::from(r.importance) / 100.0
        + recency * 0.2
        + scope
        + if r.status == MemoryStatus::Active {
            0.2
        } else {
            0.0
        }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn agent() -> Caller {
        Caller::agent("group-a", "group-a", "group-a/maomao", "maomao", "maomao")
    }
    fn write(content: &str) -> MemoryWrite {
        MemoryWrite {
            id: None,
            kind: "note".into(),
            content: content.into(),
            provenance: Provenance::default(),
            importance: 50,
            supersedes_memory_id: None,
        }
    }
    fn req(q: &str, scopes: Vec<SearchScope>) -> SearchRequest {
        SearchRequest {
            query: q.into(),
            scopes,
            limit: 10,
            include_historical: false,
        }
    }
    #[test]
    fn persistence_reopen_fts_and_scope_isolation() {
        let path = std::env::temp_dir().join(format!(
            "hivemind-memory-{}-{}.sqlite",
            std::process::id(),
            now()
        ));
        let caller = agent();
        let id;
        {
            let s = MemoryService::open(&path).unwrap();
            let r = s
                .add_group(&caller, write("Websocket authentication uses JWT"))
                .unwrap();
            id = r.id;
            assert_eq!(
                s.search(&caller, &req("websocket JWT", vec![SearchScope::Group]))
                    .unwrap()[0]
                    .record
                    .id,
                id
            );
            let other = Caller::agent("group-b", "group-b", "group-b/maomao", "maomao", "maomao");
            assert!(s
                .search(&other, &req("websocket", vec![SearchScope::Group]))
                .unwrap()
                .is_empty());
            assert!(s.store().get(&other, &id).is_err());
        }
        {
            let s = MemoryService::open(&path).unwrap();
            assert_eq!(
                s.store().get(&agent(), &id).unwrap().unwrap().content,
                "Websocket authentication uses JWT"
            );
        }
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn provenance_supersession_and_archive_retention() {
        let s = MemoryService::new(MemoryStore::in_memory().unwrap());
        let c = agent();
        let old = s.add_group(&c, write("Frontend uses React")).unwrap();
        let mut next = write("Frontend uses Vue");
        next.supersedes_memory_id = Some(old.id.clone());
        let new = s.add_group(&c, next).unwrap();
        assert_eq!(
            s.store().get(&agent(), &old.id).unwrap().unwrap().status,
            MemoryStatus::Superseded
        );
        assert_eq!(new.supersedes_memory_id, Some(old.id));
        assert_eq!(new.provenance.source_actor.as_deref(), Some("maomao"));
        assert_eq!(
            s.search(&c, &req("React", vec![SearchScope::Group]))
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            s.search(
                &c,
                &SearchRequest {
                    include_historical: true,
                    ..req("React", vec![SearchScope::Group])
                }
            )
            .unwrap()
            .len(),
            1
        );
    }

    #[test]
    fn caller_provenance_overlays_write_metadata_and_keeps_unspecified_fields() {
        let service = MemoryService::new(MemoryStore::in_memory().unwrap());
        let caller = agent().with_provenance(Provenance {
            source_room_id: Some("server-room".into()),
            source_turn_id: None,
            source_message_id: Some("server-message".into()),
            source_actor: Some("server-actor".into()),
            source_kind: Some("server-kind".into()),
        });
        let mut write = write("Provenance merge");
        write.provenance = Provenance {
            source_room_id: Some("write-room".into()),
            source_turn_id: Some("write-turn".into()),
            source_message_id: Some("write-message".into()),
            source_actor: Some("write-actor".into()),
            source_kind: Some("write-kind".into()),
        };

        let stored = service.add_group(&caller, write).unwrap();
        assert_eq!(
            stored.provenance,
            Provenance {
                source_room_id: Some("server-room".into()),
                source_turn_id: Some("write-turn".into()),
                source_message_id: Some("server-message".into()),
                source_actor: Some("server-actor".into()),
                source_kind: Some("server-kind".into()),
            }
        );
    }
    #[test]
    fn proposals_and_authorization_reject_escalation() {
        let s = MemoryService::new(MemoryStore::in_memory().unwrap());
        let c = agent();
        assert!(s.propose_global(&c, write("I think this is good")).is_err());
        let unbound = agent().with_provenance(Provenance {
            source_turn_id: Some("turn-1".into()),
            source_kind: Some("accepted_decision".into()),
            ..Provenance::default()
        });
        assert!(s.propose_global(&unbound, write("Hivemind architecture: all agents use deterministic memory")).is_err());
        let caller = agent()
            .with_provenance(Provenance {
                source_room_id: Some("group-a".into()),
                source_turn_id: Some("turn-user-1".into()),
                source_kind: Some("agent_proposal".into()),
                ..Provenance::default()
            })
            .authorize_global_proposal_from_user_event(
                "Hivemind architecture: all agents use deterministic memory",
                Provenance {
                    source_room_id: Some("group-a".into()),
                    source_turn_id: Some("turn-user-1".into()),
                    source_message_id: Some("message-user-1".into()),
                    source_actor: Some("user".into()),
                    source_kind: Some("explicit_user_instruction".into()),
                },
            )
            .unwrap();
        let p = write("Hivemind architecture: all agents use deterministic memory");
        let accepted = s.propose_global(&caller, p).unwrap();
        assert_eq!(accepted.provenance.source_actor.as_deref(), Some("user"));
        assert!(s.propose_global(&caller, write("Hivemind global arbitrary assertion")).is_err());
        let no_keyword_fact = "Use XYZ stack";
        let user_authorized = agent()
            .with_provenance(Provenance {
                source_kind: Some("agent_proposal".into()),
                ..Provenance::default()
            })
            .authorize_global_proposal_from_user_event(
                no_keyword_fact,
                Provenance {
                    source_room_id: Some("group-a".into()),
                    source_turn_id: Some("turn-user-2".into()),
                    source_message_id: Some("message-user-2".into()),
                    source_actor: Some("user".into()),
                    source_kind: Some("explicit_user_instruction".into()),
                },
            )
            .unwrap();
        assert_eq!(
            s.propose_global(&user_authorized, write(no_keyword_fact)).unwrap().content,
            no_keyword_fact
        );
        let mut private = write("do not share");
        private.id = Some("private-1".into());
        let rec = s.add_private(&c, private).unwrap();
        let other = Caller::agent("group-a", "group-a", "group-a/other", "maomao", "other");
        assert!(s.archive(&other, &rec.id).is_err());
        assert!(s.search(&c, &req("anything", vec![])).is_err());
    }
    #[test]
    fn archive_messages_are_distinct_and_recent_is_bounded() {
        let s = MemoryService::new(MemoryStore::in_memory().unwrap());
        let c = agent();
        for (id, turn, content) in [
            ("m1", "t1", "First archive fact"),
            ("m2", "t2", "Second archive fact"),
            ("m3", "t3", "Third archive fact"),
        ] {
            s.append_room_message(
                &c,
                ArchivedMessage {
                    id: id.into(),
                    room_id: "group-a".into(),
                    turn_id: turn.into(),
                    speaker: "user".into(),
                    content: content.into(),
                    created_at: now(),
                },
            )
            .unwrap();
        }
        assert_eq!(s.recent_messages(&c, "group-a", 2).unwrap().len(), 2);
        assert_eq!(
            s.search(&c, &req("archive fact", vec![SearchScope::Archive]))
                .unwrap()
                .len(),
            3
        );
        assert!(s
            .append_room_message(
                &c,
                ArchivedMessage {
                    id: "x".into(),
                    room_id: "group-b".into(),
                    turn_id: "t".into(),
                    speaker: "user".into(),
                    content: "no".into(),
                    created_at: now()
                }
            )
            .is_err());
    }
    #[test]
    fn complete_archive_turn_upserts_participants_and_searchable_messages() {
        let service = MemoryService::new(MemoryStore::in_memory().unwrap());
        let caller = agent();
        let make_turn = |content: &str, participant: &str| ArchivedTurn {
            id: "turn-1".into(),
            room_id: "group-a".into(),
            started_at: 10,
            completed_at: Some(20),
            metadata: serde_json::json!({"mode":"broadcast"}),
            participants: vec![ArchiveParticipant {
                participant_id: participant.into(),
                role: Some("worker".into()),
            }],
            messages: vec![ArchivedMessage {
                id: "message-1".into(),
                room_id: "group-a".into(),
                turn_id: "turn-1".into(),
                speaker: "maomao".into(),
                content: content.into(),
                created_at: 20,
            }],
        };
        service
            .append_archive_turn(&caller, make_turn("Old archived answer", "maomao"))
            .unwrap();
        service
            .append_archive_turn(&caller, make_turn("Revised searchable answer", "marin"))
            .unwrap();
        let archived = service
            .archive_turn(&caller, "group-a", "turn-1")
            .unwrap()
            .unwrap();
        assert_eq!(archived.participants[0].participant_id, "marin");
        assert_eq!(archived.messages.len(), 1);
        assert_eq!(archived.messages[0].content, "Revised searchable answer");
        assert_eq!(
            service
                .search(
                    &caller,
                    &req("Revised searchable", vec![SearchScope::Archive])
                )
                .unwrap()
                .len(),
            1
        );
        assert!(service
            .search(&caller, &req("Old archived", vec![SearchScope::Archive]))
            .unwrap()
            .is_empty());
        let other = Caller::agent("group-b", "group-b", "group-b/agent", "other", "other");
        assert!(service.archive_turn(&other, "group-a", "turn-1").is_err());
    }
    #[test]
    fn archive_turns_and_participants_survive_reopen() {
        let path = std::env::temp_dir().join(format!(
            "hivemind-turn-{}-{}.sqlite",
            std::process::id(),
            now()
        ));
        let caller = agent();
        {
            let service = MemoryService::open(&path).unwrap();
            service
                .append_archive_turn(
                    &caller,
                    ArchivedTurn {
                        id: "persisted-turn".into(),
                        room_id: "group-a".into(),
                        started_at: 1,
                        completed_at: Some(2),
                        metadata: serde_json::json!({"canonical":true}),
                        participants: vec![ArchiveParticipant {
                            participant_id: "maomao".into(),
                            role: Some("owner".into()),
                        }],
                        messages: vec![ArchivedMessage {
                            id: "persisted-message".into(),
                            room_id: "group-a".into(),
                            turn_id: "persisted-turn".into(),
                            speaker: "maomao".into(),
                            content: "Durable SQLite transcript".into(),
                            created_at: 2,
                        }],
                    },
                )
                .unwrap();
        }
        {
            let service = MemoryService::open(&path).unwrap();
            let turn = service
                .archive_turn(&caller, "group-a", "persisted-turn")
                .unwrap()
                .unwrap();
            assert_eq!(turn.participants[0].participant_id, "maomao");
            assert_eq!(turn.messages[0].content, "Durable SQLite transcript");
            assert_eq!(
                service
                    .search(
                        &caller,
                        &req("Durable transcript", vec![SearchScope::Archive])
                    )
                    .unwrap()
                    .len(),
                1
            );
        }
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn solo_scope_context_and_global_archive_authorization() {
        let service = MemoryService::new(MemoryStore::in_memory().unwrap());
        let solo = Caller::agent("solo-room", "", "solo/maomao", "maomao", "maomao")
            .with_provenance(Provenance {
                source_room_id: Some("solo-room".into()),
                source_turn_id: Some("turn-1".into()),
                source_kind: Some("agent_proposal".into()),
                ..Provenance::default()
            });
        let private = service.add_private(&solo, write("Revisit local notes")).unwrap();
        assert_eq!(private.scope, Scope::AgentInstance("solo/maomao".into()));
        let persona = service.propose_persona(&solo, write("Prefers small service boundaries")).unwrap();
        assert_eq!(persona.scope, Scope::Persona("maomao".into()));
        assert!(service.add_group(&solo, write("Group only")).is_err());
        assert!(service.store().records_in_scope(&solo, &Scope::Group(String::new())).is_err());

        let trusted = Caller::trusted_user("operator");
        let global = service.propose_global(&trusted, write("Hivemind architecture uses Rust"));
        let global = global.unwrap();
        assert!(service.archive(&solo, &global.id).is_err());
        assert!(service.archive(&trusted, &global.id).is_ok());
    }

    #[test]
    fn group_state_and_runtime_epochs_are_durable_and_instance_scoped() {
        let path = std::env::temp_dir().join(format!("hivemind-state-{}-{}.sqlite", std::process::id(), now()));
        let caller = agent();
        let epoch_id;
        {
            let service = MemoryService::open(&path).unwrap();
            service.set_group_state(&caller, serde_json::json!({"goal":"ship API"})).unwrap();
            let epoch = service.start_runtime_epoch(&caller, "pi", serde_json::json!({"pid":42})).unwrap();
            epoch_id = epoch.id.clone();
            let other = Caller::agent("group-a", "group-a", "group-a/other", "maomao", "other");
            assert!(service.end_runtime_epoch(&other, &epoch.id, epoch.started_at + 1).is_err());
            service.end_runtime_epoch(&caller, &epoch.id, epoch.started_at + 1).unwrap();
        }
        {
            let service = MemoryService::open(&path).unwrap();
            assert_eq!(service.group_state(&caller).unwrap().unwrap().state["goal"], "ship API");
            let epochs = service.runtime_epochs(&caller, 10).unwrap();
            assert_eq!(epochs.len(), 1);
            assert_eq!(epochs[0].id, epoch_id);
            assert!(epochs[0].ended_at.is_some());
        }
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn new_ids_are_time_first_fixed_width_and_process_unique() {
        let first = new_id();
        let second = new_id();
        let parts: Vec<&str> = first.split('-').collect();
        assert_eq!(parts.len(), 4, "unexpected id shape: {first}");
        assert_eq!(parts[0], "memory");
        assert_eq!(parts[1].len(), 20, "time field must be fixed-width: {first}");
        assert!(parts[1].chars().all(|c| c.is_ascii_digit()));
        assert_eq!(parts[2].len(), 6, "sequence field must be fixed-width: {first}");
        assert!(parts[2].chars().all(|c| c.is_ascii_digit()));
        // The pid suffix is what keeps ids minted by concurrent processes distinct.
        assert_eq!(parts[3], std::process::id().to_string());
        assert_ne!(first, second);
        assert!(
            first < second,
            "ids must sort chronologically by creation order: {first} !< {second}"
        );
    }

    #[test]
    fn natural_language_question_retrieves_partial_matches_and_misses_without_overlap() {
        let service = MemoryService::new(MemoryStore::in_memory().unwrap());
        let caller = agent();
        let stored = service
            .add_group(&caller, write("Websocket authentication uses JWT"))
            .unwrap();
        // Every-token AND matching returned nothing here; partial matches must
        // still retrieve the record the question is asking about.
        let hits = service
            .search(
                &caller,
                &req("what websocket authentication do you know?", vec![SearchScope::Group]),
            )
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].record.id, stored.id);

        // A query sharing no token with any authorized record returns nothing.
        let unrelated = service
            .search(&caller, &req("unrelated zzzq", vec![SearchScope::Group]))
            .unwrap();
        assert!(unrelated.is_empty());
    }

    #[test]
    fn persona_memory_spans_instances_but_not_personas() {
        let service = MemoryService::new(MemoryStore::in_memory().unwrap());
        let author = Caller::agent("dev-room", "dev", "dev/maomao", "maomao", "maomao")
            .with_provenance(Provenance {
                source_room_id: Some("dev-room".into()),
                source_turn_id: Some("turn-1".into()),
                source_kind: Some("agent_proposal".into()),
                ..Provenance::default()
            });
        let stored = service
            .propose_persona(&author, write("Prefers small service boundaries"))
            .unwrap();
        assert_eq!(stored.scope, Scope::Persona("maomao".into()));

        // A different instance of the same persona still reads the record.
        let same_persona_other_instance =
            Caller::agent("security-room", "security", "security/maomao", "maomao", "maomao");
        let hits = service
            .search(
                &same_persona_other_instance,
                &req("service boundaries", vec![SearchScope::Persona]),
            )
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].record.id, stored.id);
        assert_eq!(
            service
                .store()
                .get(&same_persona_other_instance, &stored.id)
                .unwrap()
                .unwrap()
                .content,
            "Prefers small service boundaries"
        );

        // A different persona can neither search nor fetch it.
        let other_persona = Caller::agent("dev-room", "dev", "dev/marin", "marin", "marin");
        assert!(service
            .search(
                &other_persona,
                &req("service boundaries", vec![SearchScope::Persona])
            )
            .unwrap()
            .is_empty());
        assert!(service.store().get(&other_persona, &stored.id).is_err());
    }

    #[test]
    fn authorized_global_memory_is_retrievable_from_another_room_and_agent() {
        let service = MemoryService::new(MemoryStore::in_memory().unwrap());
        let fact = "Hivemind architecture: runtimes are disposable";
        let author = Caller::agent("dev-room", "dev", "dev/maomao", "maomao", "maomao")
            .with_provenance(Provenance {
                source_room_id: Some("dev-room".into()),
                source_turn_id: Some("turn-1".into()),
                source_kind: Some("agent_proposal".into()),
                ..Provenance::default()
            })
            .authorize_global_proposal_from_user_event(
                fact,
                Provenance {
                    source_room_id: Some("dev-room".into()),
                    source_turn_id: Some("turn-1".into()),
                    source_message_id: Some("message-1".into()),
                    source_actor: Some("user".into()),
                    source_kind: Some("explicit_user_instruction".into()),
                },
            )
            .unwrap();
        let stored = service.propose_global(&author, write(fact)).unwrap();
        assert_eq!(stored.scope, Scope::Hivemind);

        // Any authorized agent in any room may read global memory.
        let reader =
            Caller::agent("security-room", "security", "security/albedo", "albedo", "albedo");
        let hits = service
            .search(&reader, &req("runtimes disposable", vec![SearchScope::Global]))
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].record.id, stored.id);

        // Policy still gates writes: the reader cannot mint global memory.
        assert!(service
            .propose_global(&reader, write("Unrelated global claim"))
            .is_err());
    }

    #[test]
    fn equal_score_records_order_reproducibly_and_active_outranks_superseded() {
        let service = MemoryService::new(MemoryStore::in_memory().unwrap());
        let caller = agent();
        let record = |id: &str, status: MemoryStatus| MemoryRecord {
            id: id.into(),
            layer: Layer::Group,
            scope: Scope::Group("group-a".into()),
            kind: "note".into(),
            content: "Shared release checklist".into(),
            provenance: Provenance::default(),
            created_at: 1_000,
            updated_at: 1_000,
            status,
            importance: 50,
            supersedes_memory_id: None,
        };
        // Identical content, scope, and timestamps make the scores exactly
        // equal, so only the id tie-break decides the order.
        let older = new_id();
        let newer = new_id();
        assert!(older < newer);
        service
            .store()
            .insert(&record(&older, MemoryStatus::Active))
            .unwrap();
        service
            .store()
            .insert(&record(&newer, MemoryStatus::Active))
            .unwrap();
        let ranked = |include_historical: bool| {
            service
                .search(
                    &caller,
                    &SearchRequest {
                        include_historical,
                        ..req("release checklist", vec![SearchScope::Group])
                    },
                )
                .unwrap()
                .into_iter()
                .map(|result| result.record.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(ranked(false), vec![older.clone(), newer.clone()]);
        assert_eq!(ranked(false), ranked(false));

        // A superseded record for the same query ranks below both active ones.
        let superseded = new_id();
        service
            .store()
            .insert(&record(&superseded, MemoryStatus::Superseded))
            .unwrap();
        assert_eq!(ranked(true), vec![older, newer, superseded]);
    }
}
