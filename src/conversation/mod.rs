use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Weak},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::identity::AgentInstanceId;
use crate::memory::{
    ArchiveParticipant, ArchivedMessage, ArchivedTurn, Caller, Layer, MemoryService, MemoryStatus,
    MemoryWrite, Provenance, RoomArchive, Scope, SearchRequest, SearchResult, SearchScope,
    TurnAppend,
};
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::{
    sync::{Mutex, OnceCell},
    task::JoinSet,
};

use crate::config::{AgentConfig, ContextConfig, ConversationMode};
use crate::runtime::{
    InvokeReply, InvokeRequest, PromptDelta, PromptPhase, RuntimePool, SessionCursor, TurnView,
};

mod coordinator;
mod memory_tools;
mod state;
mod store;
#[cfg(test)]
mod tests;

pub use coordinator::*;
use memory_tools::*;
use state::*;
pub use store::*;

/// Extra host-bound tool surface offered beside the memory tools. Manifests
/// and executions are keyed by the room and persona Hivemind is running; a
/// model can never choose either.
pub trait ToolHost: Send + Sync {
    /// Manifest section for this room and persona; `None` offers nothing.
    fn manifest(&self, room: &str, persona: &str) -> Option<String>;
    /// One-line reminder for later turns of a live session.
    fn reminder(&self, _room: &str, _persona: &str) -> Option<String> {
        None
    }
    /// Tool actions allowed per invocation before a plain-text answer is required.
    fn max_actions(&self, _room: &str) -> usize {
        MAX_MEMORY_ACTIONS
    }
    /// Whether turn input in `room` is host/agent-generated rather than typed by
    /// the user, so it can never authorize `Global:` writes or state directives.
    fn agent_originated(&self, _room: &str) -> bool {
        false
    }
    /// Whether this host owns the tool name.
    fn handles(&self, name: &str) -> bool;
    fn execute(
        &self,
        room: &str,
        persona: &str,
        name: &str,
        args: &serde_json::Value,
    ) -> Result<String>;
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct RoomState {
    pub goal: Option<String>,
    pub decisions: Vec<String>,
    pub assignments: BTreeMap<String, String>,
    pub open_questions: Vec<String>,
    pub completed: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct MessageEvent {
    pub id: String,
    pub turn_id: String,
    pub speaker: String,
    pub agent_instance_id: Option<AgentInstanceId>,
    pub legacy_agent_instance_id: Option<String>,
    pub content: String,
    pub error: bool,
}

impl Serialize for MessageEvent {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;

        let typed_identity =
            self.legacy_agent_instance_id.is_none() && self.agent_instance_id.is_some();
        let encoded = self
            .legacy_agent_instance_id
            .clone()
            .or_else(|| self.agent_instance_id.as_ref().map(AgentInstanceId::encode));
        let mut state =
            serializer.serialize_struct("MessageEvent", if typed_identity { 7 } else { 6 })?;
        state.serialize_field("id", &self.id)?;
        state.serialize_field("turn_id", &self.turn_id)?;
        state.serialize_field("speaker", &self.speaker)?;
        state.serialize_field("agent_instance_id", &encoded)?;
        if typed_identity {
            state.serialize_field("agent_instance_identity_version", &1_u8)?;
        }
        state.serialize_field("content", &self.content)?;
        state.serialize_field("error", &self.error)?;
        state.end()
    }
}

#[derive(Deserialize)]
struct MessageEventData {
    id: String,
    turn_id: String,
    speaker: String,
    #[serde(default)]
    agent_instance_id: Option<String>,
    #[serde(default)]
    agent_instance_identity_version: u8,
    content: String,
    error: bool,
}

impl<'de> Deserialize<'de> for MessageEvent {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use serde::de::Error;

        let data = MessageEventData::deserialize(deserializer)?;
        let (agent_instance_id, legacy_agent_instance_id) =
            match (data.agent_instance_identity_version, data.agent_instance_id) {
                (0, raw) => (None, raw),
                (1, Some(encoded)) => (
                    Some(AgentInstanceId::decode(&encoded).ok_or_else(|| {
                        D::Error::custom("invalid versioned agent instance identity")
                    })?),
                    None,
                ),
                (1, None) => {
                    return Err(D::Error::custom(
                        "versioned agent instance identity is missing its encoded value",
                    ))
                }
                (version, _) => {
                    return Err(D::Error::custom(format!(
                        "unsupported agent instance identity version {version}"
                    )))
                }
            };
        Ok(Self {
            id: data.id,
            turn_id: data.turn_id,
            speaker: data.speaker,
            agent_instance_id,
            legacy_agent_instance_id,
            content: data.content,
            error: data.error,
        })
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct RoomHistory {
    pub room_id: String,
    pub events: Vec<MessageEvent>,
    pub state: RoomState,
    pub summary: String,
    pub completed_turns: Vec<String>,
    pub summarized_turn_count: usize,
    pub maintenance_errors: Vec<String>,
}

#[derive(Deserialize, Default)]
struct RoomHistoryData {
    #[serde(default)]
    room_id: String,
    #[serde(default)]
    events: Vec<MessageEvent>,
    #[serde(default)]
    state: RoomState,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    completed_turns: Vec<String>,
    #[serde(default)]
    summarized_turn_count: usize,
    #[serde(default)]
    maintenance_errors: Vec<String>,
}

impl<'de> Deserialize<'de> for RoomHistory {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let mut data = RoomHistoryData::deserialize(deserializer)?;
        if !data.room_id.is_empty() {
            for event in &mut data.events {
                if event.speaker != "user" && event.agent_instance_id.is_none() {
                    event.agent_instance_id =
                        Some(AgentInstanceId::new(&data.room_id, &event.speaker));
                }
            }
        }
        Ok(Self {
            room_id: data.room_id,
            events: data.events,
            state: data.state,
            summary: data.summary,
            completed_turns: data.completed_turns,
            summarized_turn_count: data.summarized_turn_count,
            maintenance_errors: data.maintenance_errors,
        })
    }
}

#[derive(Debug, Clone)]
pub struct Participant {
    pub agent: Arc<AgentConfig>,
    pub role: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TurnReply {
    pub name: String,
    pub result: Result<String, String>,
}

#[derive(Debug, Clone)]
pub struct TurnExecution {
    pub turn_id: String,
    pub room_id: String,
    pub replies: Vec<TurnReply>,
}

#[async_trait]
pub trait AgentInvoker: Send + Sync {
    async fn cursor(&self, agent_instance_id: &AgentInstanceId) -> Option<SessionCursor>;
    async fn invoke(&self, request: InvokeRequest<'_>) -> Result<InvokeReply>;
}

/// Routes a turn's invocations to the core-owned per-instance runtime pool.
pub struct RuntimeInvoker {
    pool: Arc<RuntimePool>,
    room_id: String,
    group_id: String,
}

impl RuntimeInvoker {
    pub fn new(pool: Arc<RuntimePool>, room_id: &str, group_id: &str) -> Self {
        Self {
            pool,
            room_id: room_id.to_owned(),
            group_id: group_id.to_owned(),
        }
    }
}

#[async_trait]
impl AgentInvoker for RuntimeInvoker {
    async fn cursor(&self, instance_id: &AgentInstanceId) -> Option<SessionCursor> {
        self.pool.cursor(instance_id).await
    }

    async fn invoke(&self, request: InvokeRequest<'_>) -> Result<InvokeReply> {
        let caller = Caller::agent(
            self.room_id.clone(),
            self.group_id.clone(),
            request.agent_instance_id.clone(),
            &request.agent.name,
            &request.agent.name,
        );
        self.pool.invoke(&caller, request).await
    }
}
