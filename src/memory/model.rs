use std::borrow::Cow;

use crate::identity::AgentInstanceId;
use anyhow::{bail, Result};
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
    AgentInstance(AgentInstanceId),
    /// Opaque legacy value; its room/persona components are unknown.
    LegacyAgentInstance(String),
    Persona(String),
    Hivemind,
    Archive(String),
}
impl Scope {
    pub(super) fn kind_id(&self) -> (&'static str, Cow<'_, str>) {
        match self {
            Self::Conversation(id) => ("conversation", Cow::Borrowed(id)),
            Self::Group(id) => ("group", Cow::Borrowed(id)),
            Self::AgentInstance(id) => ("agent_instance_v1", Cow::Owned(id.encode())),
            Self::LegacyAgentInstance(id) => ("agent_instance", Cow::Borrowed(id)),
            Self::Persona(id) => ("persona", Cow::Borrowed(id)),
            Self::Hivemind => ("hivemind", Cow::Borrowed("hivemind")),
            Self::Archive(id) => ("archive", Cow::Borrowed(id)),
        }
    }
    pub(super) fn from_parts(kind: &str, id: String) -> Result<Self> {
        Ok(match kind {
            "conversation" => Self::Conversation(id),
            "group" => Self::Group(id),
            "agent_instance" => Self::LegacyAgentInstance(id),
            "agent_instance_v1" => Self::AgentInstance(
                AgentInstanceId::decode(&id)
                    .ok_or_else(|| anyhow::anyhow!("invalid versioned agent instance scope"))?,
            ),
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
    pub(super) fn as_str(self) -> &'static str {
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
    pub agent_instance_id: AgentInstanceId,
    pub persona_id: String,
    pub actor: String,
    pub trusted: bool,
    pub provenance: Provenance,
    pub(super) authorized_global_proposal: Option<UserAuthorizedGlobalProposal>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct UserAuthorizedGlobalProposal {
    pub(super) exact_content: String,
    pub(super) provenance: Provenance,
}
pub type AccessContext = Caller;
impl Caller {
    /// Build an invocation context from host-resolved room and agent identity.
    pub fn agent(
        room_id: impl Into<String>,
        group_id: impl Into<String>,
        agent_instance_id: AgentInstanceId,
        persona_id: impl Into<String>,
        actor: impl Into<String>,
    ) -> Self {
        Self {
            room_id: room_id.into(),
            group_id: group_id.into(),
            agent_instance_id,
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
            agent_instance_id: AgentInstanceId::new("", ""),
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
        self.authorized_global_proposal = Some(UserAuthorizedGlobalProposal {
            exact_content,
            provenance,
        });
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
    pub agent_instance_id: AgentInstanceId,
    pub runtime: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    /// Why the session ended: a runtime stop reason such as `context_budget`
    /// or `idle_timeout`. `None` while open or for epochs closed before
    /// reasons were recorded.
    pub end_reason: Option<String>,
    pub metadata: serde_json::Value,
}

/// Incremental write of one archive turn: upserts the turn row (an existing
/// `completed_at` is kept when `completed_at` is `None`), inserts or updates
/// only the supplied messages, and optionally rewrites the room-state turn's
/// metadata, all in one transaction.
#[derive(Debug, Clone)]
pub struct TurnAppend {
    pub room_id: String,
    pub turn_id: String,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub metadata: serde_json::Value,
    pub participants: Vec<ArchiveParticipant>,
    pub messages: Vec<ArchivedMessage>,
    /// `(turn id, metadata)` of a reserved room-level state turn to upsert.
    pub state_turn: Option<(String, serde_json::Value)>,
}

/// Turn row without its messages.
#[derive(Debug, Clone)]
pub struct ArchivedTurnMeta {
    pub id: String,
    pub completed_at: Option<i64>,
    pub metadata: serde_json::Value,
}

/// A user thread: a child room anchored to one message of its parent room.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ThreadRecord {
    pub id: String,
    pub parent_room_id: String,
    pub anchor_message_id: String,
    pub name: String,
    pub updated_at: i64,
    pub message_count: i64,
}

/// Everything archived for one room, in chronological order.
#[derive(Debug, Clone, Default)]
pub struct RoomArchive {
    pub messages: Vec<ArchivedMessage>,
    pub turns: Vec<ArchivedTurnMeta>,
}
