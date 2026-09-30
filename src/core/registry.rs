use std::sync::Arc;

use crate::config::AgentConfig;

/// Effective-order agent configs, shared so a turn hands out `Arc`s instead of
/// cloning every persona's configuration.
#[derive(Clone)]
pub struct AgentRegistry {
    pub(super) agents: Arc<Vec<Arc<AgentConfig>>>,
}

impl AgentRegistry {
    pub fn list(&self) -> Vec<Arc<AgentConfig>> {
        self.agents.as_ref().clone()
    }

    pub fn get(&self, id: &str) -> Option<Arc<AgentConfig>> {
        self.agents.iter().find(|agent| agent.name == id).cloned()
    }
}
