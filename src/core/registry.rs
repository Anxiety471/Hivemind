use std::sync::Arc;

use crate::config::AgentConfig;

#[derive(Clone)]
pub struct AgentRegistry {
    pub(super) agents: Arc<Vec<AgentConfig>>,
}

impl AgentRegistry {
    pub fn list(&self) -> Vec<AgentConfig> {
        self.agents.as_ref().clone()
    }

    pub fn get(&self, id: &str) -> Option<AgentConfig> {
        self.agents.iter().find(|agent| agent.name == id).cloned()
    }
}
