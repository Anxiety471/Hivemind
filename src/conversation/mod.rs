use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Weak},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::memory::{
    ArchiveParticipant, ArchivedMessage, ArchivedTurn, Caller, Layer, MemoryService, MemoryStatus,
    MemoryWrite, Provenance, Scope, SearchRequest, SearchScope,
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

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct RoomState {
    pub goal: Option<String>,
    pub decisions: Vec<String>,
    pub assignments: BTreeMap<String, String>,
    pub open_questions: Vec<String>,
    pub completed: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageEvent {
    pub id: String,
    pub turn_id: String,
    pub speaker: String,
    #[serde(default)]
    pub agent_instance_id: Option<String>,
    pub content: String,
    pub error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RoomHistory {
    #[serde(default)]
    pub room_id: String,
    #[serde(default)]
    pub events: Vec<MessageEvent>,
    #[serde(default)]
    pub state: RoomState,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub completed_turns: Vec<String>,
    #[serde(default)]
    pub summarized_turn_count: usize,
    #[serde(default)]
    pub maintenance_errors: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Participant {
    pub agent: AgentConfig,
    pub role: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TurnReply {
    pub name: String,
    pub result: Result<String, String>,
}

#[async_trait]
pub trait AgentInvoker: Send + Sync {
    /// Live continuable session state for this instance; None means the next prompt hydrates.
    async fn cursor(&self, instance_id: &str) -> Option<SessionCursor>;
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
    async fn cursor(&self, instance_id: &str) -> Option<SessionCursor> {
        self.pool.cursor(instance_id).await
    }

    async fn invoke(&self, request: InvokeRequest<'_>) -> Result<InvokeReply> {
        let caller = Caller::agent(
            self.room_id.clone(),
            self.group_id.clone(),
            request.instance_id,
            &request.agent.name,
            &request.agent.name,
        );
        self.pool.invoke(&caller, request).await
    }
}
