mod omp;

use anyhow::{bail, Result};
use async_trait::async_trait;

use crate::config::{AgentConfig, RuntimeConfig};

pub use omp::OmpAdapter;

#[async_trait]
pub trait HarnessAdapter: Send + Sync {
    async fn invoke(&self, agent: &AgentConfig, input: &str) -> Result<String>;
}

pub async fn invoke_agent(
    runtime_config: &RuntimeConfig,
    agent: &AgentConfig,
    input: &str,
) -> Result<String> {
    match agent.runtime.as_str() {
        "omp" => {
            let adapter = OmpAdapter::new(runtime_config.omp_binary.clone());
            adapter.invoke(agent, input).await
        }
        other => bail!("unsupported runtime '{other}' for agent '{}'", agent.name),
    }
}
