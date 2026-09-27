use std::{path::Path, process::Stdio};

use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use tokio::process::Command;

use crate::config::AgentConfig;

use super::HarnessAdapter;

#[derive(Debug, Clone)]
pub struct OmpAdapter {
    binary: String,
}

impl OmpAdapter {
    pub fn new(binary: String) -> Self {
        Self { binary }
    }

    fn args_for(&self, agent: &AgentConfig, input: &str) -> Vec<String> {
        let mut args = vec![
            "--mode".to_string(),
            "text".to_string(),
            "--append-system-prompt".to_string(),
            agent.system_prompt.clone(),
        ];

        if let Some(model) = agent
            .model
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            args.push("--model".into());
            args.push(model.into());
        }

        if let Some(thinking) = agent
            .thinking
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            args.push("--thinking".into());
            args.push(thinking.into());
        }

        args.push("-p".into());
        args.push(input.into());
        args
    }
}

#[async_trait]
impl HarnessAdapter for OmpAdapter {
    async fn invoke(&self, agent: &AgentConfig, input: &str) -> Result<String> {
        let workspace = Path::new(&agent.workspace);

        if !workspace.exists() {
            bail!(
                "workspace '{}' for agent '{}' does not exist",
                workspace.display(),
                agent.name
            );
        }

        let output = Command::new(&self.binary)
            .args(self.args_for(agent, input))
            .current_dir(workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .output()
            .await
            .with_context(|| {
                format!(
                    "failed to start OMP for '{}'; is '{}' installed and on PATH?",
                    agent.name, self.binary
                )
            })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let detail = if stderr.is_empty() {
                format!("exit status {}", output.status)
            } else {
                stderr
            };

            bail!("OMP failed for '{}': {detail}", agent.name);
        }

        let response = String::from_utf8(output.stdout)
            .context("OMP returned non-UTF-8 output")?
            .trim()
            .to_string();

        if response.is_empty() {
            bail!("OMP returned an empty response for '{}'", agent.name);
        }

        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent() -> AgentConfig {
        AgentConfig {
            name: "Maomao".into(),
            runtime: "omp".into(),
            system_prompt: "You are Maomao.".into(),
            workspace: ".".into(),
            model: Some("example-model".into()),
            thinking: Some("high".into()),
        }
    }

    #[test]
    fn omp_args_are_headless_and_agent_specific() {
        let adapter = OmpAdapter::new("omp".into());
        let args = adapter.args_for(&agent(), "hello");

        assert_eq!(
            args,
            vec![
                "--mode",
                "text",
                "--append-system-prompt",
                "You are Maomao.",
                "--model",
                "example-model",
                "--thinking",
                "high",
                "-p",
                "hello",
            ]
        );
    }
}
